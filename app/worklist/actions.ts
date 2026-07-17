"use server";

import { prisma } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { mkdir, writeFile, rm } from "node:fs/promises";
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

const RETURN_UPSTREAM: Record<string, string> = { Welding: "Cut", Painting: "Welding" };

/** Send a piece BACK upstream: a "finished" piece turned out incomplete.
 *  Deducts the qty from the upstream ledger (negative entry, source "return")
 *  and opens a row in the upstream dept's Returns table until re-delivered. */
export async function returnToUpstream(formData: FormData): Promise<RecordResult> {
  try {
    const fromDept = String(formData.get("fromDept") ?? "");
    const bom = String(formData.get("bom") ?? "").trim();
    const mo = String(formData.get("mo") ?? "").trim();
    const item = String(formData.get("item") ?? "").trim().toUpperCase();
    const qty = Number(formData.get("qty"));
    const reason = String(formData.get("reason") ?? "").trim();

    const toDept = RETURN_UPSTREAM[fromDept];
    if (!toDept) return { ok: false, error: "Invalid department." };
    if (!bom || !isItem(item)) return { ok: false, error: "Invalid line." };
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: "Enter a quantity greater than zero." };
    if (!reason) return { ok: false, error: "Write the reason — the upstream dept needs to know what to fix." };

    // can only return what is actually WAITING in this queue (upstream − consumed)
    const scope = mo ? { mo, item } : { bom, item };
    const sums = await prisma.handoverEntry.groupBy({ by: ["dept"], where: scope, _sum: { qty: true } });
    const tot = (d: string) => sums.find((s) => s.dept === d)?._sum.qty ?? 0;
    const available = tot(toDept) - tot(fromDept);
    if (qty > available) {
      return { ok: false, error: `Only ${Math.max(0, available)} pcs are waiting in this queue — cannot return ${qty}.` };
    }

    const date = new Date();
    await prisma.plan.upsert({ where: { planNo: 0 }, create: { planNo: 0, startDate: date }, update: {} });
    await prisma.$transaction(async (tx) => {
      const ledger = await tx.handoverEntry.create({
        data: { date, dept: toDept, bom, mo: mo || null, item, qty: -qty, planNo: 0, source: "return", note: reason },
      });
      await tx.returnEntry.create({
        data: { date, fromDept, toDept, bom, mo: mo || null, item, qty, reason, handoverId: ledger.id },
      });
    });
    for (const p of ["/worklist/cut", "/worklist/welding", "/worklist/painting", "/handover", "/", "/tracker", "/trace", "/report"]) {
      revalidatePath(p);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Failed to return: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The return was fixed: put the qty BACK on this dept's ledger (positive
 *  entry) so it reappears downstream immediately, and close the return. */
export async function redeliverReturn(formData: FormData): Promise<RecordResult> {
  try {
    const id = Number(formData.get("id"));
    if (!Number.isInteger(id)) return { ok: false, error: "Invalid id." };
    const ret = await prisma.returnEntry.findUnique({ where: { id } });
    if (!ret) return { ok: false, error: "Return not found." };
    if (ret.status !== "open") return { ok: false, error: "Already re-delivered." };

    const date = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.handoverEntry.create({
        data: {
          date, dept: ret.toDept, bom: ret.bom, mo: ret.mo, item: ret.item,
          qty: ret.qty, planNo: 0, source: "return", note: `re-delivered (was: ${ret.reason})`,
        },
      });
      await tx.returnEntry.update({ where: { id }, data: { status: "resolved" } });
    });
    for (const p of ["/worklist/cut", "/worklist/welding", "/worklist/painting", "/handover", "/", "/tracker", "/trace", "/report"]) {
      revalidatePath(p);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB per photo
const MAX_PHOTOS = 6;
// extensions the /uploads/notes route can serve with a real image MIME —
// anything else is stored as .jpg so no foreign extension ever hits disk
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

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
    if (!isDept(dept)) return { ok: false, error: "Invalid department." };

    const files = formData.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
    if (!text && files.length === 0) return { ok: false, error: "Write a note or attach a photo." };
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
        const rawExt = path.extname(f.name).toLowerCase();
        const ext = IMAGE_EXTENSIONS.has(rawExt) ? rawExt : ".jpg";
        const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
        await writeFile(path.join(dir, name), Buffer.from(await f.arrayBuffer()));
        urls.push(`/uploads/notes/${name}`);
      }
    }

    await prisma.queueNote.create({
      data: { bom, mo: mo || null, item, dept, text, photos: urls.length > 0 ? JSON.stringify(urls) : null },
    });
    revalidatePath("/worklist/cut");
  revalidatePath("/worklist/welding");
    revalidatePath("/worklist/painting");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Failed to save note: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Edit a note's text (photos stay as they are). */
export async function updateQueueNote(formData: FormData): Promise<RecordResult> {
  const id = Number(formData.get("id"));
  const text = String(formData.get("text") ?? "").trim();
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid id." };
  const note = await prisma.queueNote.findUnique({ where: { id } });
  if (!note) return { ok: false, error: "Note not found." };
  const photos: string[] = note.photos ? JSON.parse(note.photos) : [];
  if (!text && photos.length === 0) return { ok: false, error: "A note needs text or a photo." };
  await prisma.queueNote.update({ where: { id }, data: { text } });
  revalidatePath("/worklist/cut");
  revalidatePath("/worklist/welding");
  revalidatePath("/worklist/painting");
  return { ok: true };
}

/** Delete a note permanently, including its photo files. */
export async function deleteQueueNote(formData: FormData): Promise<RecordResult> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid id." };
  const note = await prisma.queueNote.findUnique({ where: { id } });
  if (!note) return { ok: false, error: "Note not found." };
  for (const p of note.photos ? (JSON.parse(note.photos) as string[]) : []) {
    try {
      await rm(path.join(process.cwd(), p));
    } catch {
      /* photo file already gone — fine */
    }
  }
  await prisma.queueNote.delete({ where: { id } });
  revalidatePath("/worklist/cut");
  revalidatePath("/worklist/welding");
  revalidatePath("/worklist/painting");
  return { ok: true };
}

/** Resolve / reopen a queue note once the issue is checked. */
export async function setQueueNoteStatus(formData: FormData): Promise<RecordResult> {
  const id = Number(formData.get("id"));
  const status = String(formData.get("status") ?? "");
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid id." };
  if (status !== "open" && status !== "resolved") return { ok: false, error: "Invalid status." };
  const note = await prisma.queueNote.findUnique({ where: { id } });
  if (!note) return { ok: false, error: "Note not found." };
  await prisma.queueNote.update({ where: { id }, data: { status } });
  revalidatePath("/worklist/cut");
  revalidatePath("/worklist/welding");
  revalidatePath("/worklist/painting");
  return { ok: true };
}
