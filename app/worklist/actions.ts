"use server";

import { prisma } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isItem, isDept } from "@/lib/domain/constants";
import { parseISODate } from "@/lib/domain/dates";
import { checkOutputChain } from "@/lib/server/outputGuard";

export interface RecordResult {
  ok: boolean;
  error?: string;
}

/** Record output against a plan order line (MO × item) from the execution sheet.
 *  Creates a dated HandoverEntry — the analytics log stays the single source of truth. */
export async function recordOutput(formData: FormData): Promise<RecordResult> {
  try {
    const dateStr = String(formData.get("date") ?? "");
    const dept = String(formData.get("dept") ?? "");
    const bom = String(formData.get("bom") ?? "").trim();
    const mo = String(formData.get("mo") ?? "").trim();
    const item = String(formData.get("item") ?? "").trim().toUpperCase();
    const qty = Number(formData.get("qty"));
    const planNo = Number(formData.get("planNo"));

    const date = parseISODate(dateStr);
    if (!date) return { ok: false, error: "Invalid date." };
    if (!isDept(dept)) return { ok: false, error: "Invalid department." };
    if (!bom) return { ok: false, error: "Missing BOM." };
    if (!isItem(item)) return { ok: false, error: "Invalid component." };
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: "Enter a quantity greater than zero." };
    if (!Number.isInteger(planNo) || planNo < 0) return { ok: false, error: "Invalid plan number." };

    // lines come from real orders, never free text. The master registry (monthly
    // plan) is the source of truth; weekly schedule/plan lines and prior log
    // entries (setup balances) are accepted as fallbacks.
    if (mo) {
      const line =
        (await prisma.masterOrder.findFirst({ where: { mo } })) ??
        (await prisma.planSchedule.findFirst({ where: { bom, mo, item } })) ??
        (await prisma.planOrder.findFirst({ where: { bom, mo, item } })) ??
        (await prisma.handoverEntry.findFirst({ where: { bom, mo } }));
      if (!line) return { ok: false, error: "This MO is not in the orders registry or any plan." };
    } else {
      const known = await prisma.handoverEntry.findFirst({ where: { bom } });
      if (!known) return { ok: false, error: "This code has no history." };
    }

    // physical chain guard: painted ≤ welded ≤ cut ≤ order qty
    const chainError = await checkOutputChain({ dept, bom, mo, item, qty });
    if (chainError) return { ok: false, error: chainError };

    // queue recordings land in the global bucket (plan 0) — make sure it exists
    await prisma.plan.upsert({
      where: { planNo },
      create: { planNo, startDate: date },
      update: {},
    });

    await prisma.handoverEntry.create({
      data: { date, dept, bom, mo: mo || null, item, qty, planNo, source: "worklist" },
    });
    for (const p of ["/worklist/cut", "/worklist/welding", "/worklist/painting", "/handover", "/", "/tracker", "/trace", "/report"]) {
      revalidatePath(p);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Failed to save: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB per photo
const MAX_PHOTOS = 6;

/** Attach a note (text + optional photos) to a queue line — documents the real
 *  state of an order: missing parts, defects, disputed "done" claims. */
export async function addQueueNote(formData: FormData): Promise<RecordResult> {
  try {
    const bom = String(formData.get("bom") ?? "").trim();
    const mo = String(formData.get("mo") ?? "").trim();
    const item = String(formData.get("item") ?? "").trim().toUpperCase();
    const dept = String(formData.get("dept") ?? "");
    const text = String(formData.get("text") ?? "").trim();

    if (!bom) return { ok: false, error: "Missing BOM." };
    if (!isItem(item)) return { ok: false, error: "Invalid component." };
    if (dept !== "Welding" && dept !== "Painting") return { ok: false, error: "Invalid department." };
    if (!text) return { ok: false, error: "Write the note first." };

    const files = formData.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length > MAX_PHOTOS) return { ok: false, error: `Max ${MAX_PHOTOS} photos per note.` };

    const urls: string[] = [];
    if (files.length > 0) {
      // outside public/ — production only serves public assets snapshotted at
      // build time, so runtime uploads go through the /uploads/notes route
      const dir = path.join(process.cwd(), "uploads", "notes");
      await mkdir(dir, { recursive: true });
      for (const f of files) {
        if (!f.type.startsWith("image/")) return { ok: false, error: `"${f.name}" is not an image.` };
        if (f.size > MAX_PHOTO_BYTES) return { ok: false, error: `"${f.name}" is larger than 10 MB.` };
        const ext = path.extname(f.name) || ".jpg";
        const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
        await writeFile(path.join(dir, name), Buffer.from(await f.arrayBuffer()));
        urls.push(`/uploads/notes/${name}`);
      }
    }

    await prisma.queueNote.create({
      data: { bom, mo: mo || null, item, dept, text, photos: urls.length > 0 ? JSON.stringify(urls) : null },
    });
    revalidatePath("/worklist/welding");
    revalidatePath("/worklist/painting");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Failed to save note: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Resolve / reopen a queue note once the issue is checked. */
export async function setQueueNoteStatus(formData: FormData): Promise<RecordResult> {
  const id = Number(formData.get("id"));
  const status = String(formData.get("status") ?? "");
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid id." };
  if (status !== "open" && status !== "resolved") return { ok: false, error: "Invalid status." };
  await prisma.queueNote.update({ where: { id }, data: { status } });
  revalidatePath("/worklist/welding");
  revalidatePath("/worklist/painting");
  return { ok: true };
}
