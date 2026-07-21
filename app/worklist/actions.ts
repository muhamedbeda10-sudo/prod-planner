"use server";

import { prisma } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { put, del } from "@vercel/blob";
import { isItem, isDept } from "@/lib/domain/constants";
import { parseISODate, toISODate } from "@/lib/domain/dates";
import { findPlanForDate } from "@/lib/domain/findPlan";
import { getPlanWindows, getSettings } from "@/lib/server/data";
import { checkOutputChain } from "@/lib/server/outputGuard";
import { requireDeptEdit, requireAdmin, requirePerm } from "@/lib/server/auth";
import { trackerPermKey } from "@/lib/domain/permissions";
import { DELIVERED_STAGE, SHOTBLAST_STAGE, isPaintExempt } from "@/lib/domain/constants";

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
    const guard = await requireDeptEdit(dept);
    if (guard.error) return { ok: false, error: guard.error };
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

/** Plan-tracker inline edit: the user types the NEW cumulative total for one
 *  MO × item × their own dept — the DIFFERENCE is recorded as a daily-log
 *  entry dated today, so it shows up in Daily Logs and the dept's worklist
 *  immediately. A HIGHER total logs work done ahead of the plan; a LOWER
 *  total records a NEGATIVE correction entry. Either way the physical chain
 *  (painted ≤ welded ≤ cut ≤ order qty) is re-checked as a whole, so the
 *  numbers can never end up contradicting each other. */
export async function recordTrackerTotal(formData: FormData): Promise<RecordResult> {
  try {
    const dept = String(formData.get("dept") ?? "");
    const bom = String(formData.get("bom") ?? "").trim();
    const mo = String(formData.get("mo") ?? "").trim();
    const item = String(formData.get("item") ?? "").trim().toUpperCase();
    const newTotal = Number(formData.get("total"));

    if (!isDept(dept) && dept !== DELIVERED_STAGE && dept !== SHOTBLAST_STAGE) return { ok: false, error: "Invalid department." };
    // each tracker column has ITS OWN permission — deliberately separate from
    // the dept's worklist permission (tracker.cut / .weld / .paint / .shp / .delivered)
    const guard = await requirePerm(trackerPermKey(dept));
    if (guard.error) return { ok: false, error: guard.error };
    if (!bom || !mo) return { ok: false, error: "Missing MO / BOM." };
    if (!isItem(item)) return { ok: false, error: "Invalid component." };
    if (dept === SHOTBLAST_STAGE && !isPaintExempt(item)) {
      return { ok: false, error: `${item} is painted, not shot blasted — SHB applies to the core (CF) only.` };
    }
    if (!Number.isInteger(newTotal) || newTotal < 0) return { ok: false, error: "Enter a whole number ≥ 0." };

    const agg = await prisma.handoverEntry.aggregate({ where: { mo, item, dept }, _sum: { qty: true } });
    const current = agg._sum.qty ?? 0;
    const delta = newTotal - current;
    if (delta === 0) return { ok: false, error: "Nothing changed — the total is already " + current + "." };

    // physical chain guard, checked AFTER the proposed change in BOTH
    // directions: an increase can't out-run upstream/order qty, and a
    // decrease can't leave downstream output hanging (e.g. cut below welded)
    const chainError = await checkOutputChain({ dept, bom, mo, item, qty: delta });
    if (chainError) return { ok: false, error: chainError };

    // date = today; plan = whichever plan covers today (ahead-of-plan work
    // falls back to the newest plan, then the setup bucket 0)
    const today = parseISODate(toISODate(new Date()))!;
    const [windows, settings] = await Promise.all([getPlanWindows(), getSettings()]);
    const planNo =
      findPlanForDate(windows, today, settings.leadCut) ??
      (windows.length ? Math.max(...windows.map((w) => w.planNo)) : 0);
    await prisma.plan.upsert({
      where: { planNo },
      create: { planNo, startDate: today },
      update: {},
    });

    await prisma.handoverEntry.create({
      data: {
        date: today, dept, bom, mo, item, qty: delta, planNo, source: "tracker",
        // negative corrections say exactly what happened for the audit trail
        note: delta < 0 ? `tracker correction: total ${current} → ${newTotal}` : null,
        createdBy: guard.user?.name ?? null,
      },
    });
    for (const p of ["/worklist/cut", "/worklist/welding", "/worklist/painting", "/handover", "/", "/tracker", "/trace", "/report"]) {
      revalidatePath(p);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Failed to save: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** ADMIN ONLY — re-date a fabrication-worklist line, or schedule a PART of a
 *  date-less one (origISO ""): pick the date AND a quantity from the open
 *  pool; several parts on different dates are fine — the rest stays in the
 *  pool. Stored as overrides on top of the plan; the plan itself is never
 *  touched, so reverting always restores the original state.
 *  `fromISO` moves an already-scheduled part to another date (same qty). */
export async function setWorklistDate(formData: FormData): Promise<RecordResult> {
  try {
    const guard = await requireAdmin();
    if (guard.error) return { ok: false, error: guard.error };
    const bom = String(formData.get("bom") ?? "").trim();
    const mo = String(formData.get("mo") ?? "").trim();
    const item = String(formData.get("item") ?? "").trim().toUpperCase();
    const origISO = String(formData.get("origISO") ?? "").trim(); // "" = the line had no date
    const newDate = parseISODate(String(formData.get("date") ?? ""));
    if (!bom || !mo) return { ok: false, error: "Missing MO / BOM." };
    if (!isItem(item)) return { ok: false, error: "Invalid component." };
    if (origISO && !parseISODate(origISO)) return { ok: false, error: "Invalid original date." };
    if (!newDate) return { ok: false, error: "Pick the new date." };
    const by = guard.user?.name ?? null;

    // a real plan tranche moves WHOLESALE — one override per original date
    if (origISO !== "") {
      await prisma.$transaction(async (tx) => {
        await tx.worklistDateOverride.deleteMany({ where: { bom, mo, item, origISO } });
        await tx.worklistDateOverride.create({ data: { bom, mo, item, origISO, newDate, createdBy: by } });
      });
      revalidatePath("/worklist/cut");
      return { ok: true };
    }

    // date-less line: schedule a PART (qty) of the pool on the chosen date,
    // or move an existing part (fromISO) keeping its quantity
    const fromISO = String(formData.get("fromISO") ?? "").trim();
    const parts = await prisma.worklistDateOverride.findMany({ where: { bom, mo, item, origISO: "" } });

    if (fromISO) {
      const src = parts.find((p) => toISODate(p.newDate) === fromISO);
      if (!src) return { ok: false, error: "That scheduled part no longer exists — refresh the page." };
      await prisma.$transaction(async (tx) => {
        await tx.worklistDateOverride.deleteMany({ where: { id: src.id } });
        await tx.worklistDateOverride.upsert({
          where: { bom_mo_item_origISO_newDate: { bom, mo, item, origISO: "", newDate } },
          // moving onto a date that already has a part merges the quantities
          create: { bom, mo, item, origISO: "", newDate, qty: src.qty, baseDone: src.baseDone, createdBy: by },
          update: { qty: { increment: src.qty ?? 0 }, createdBy: by },
        });
      });
      revalidatePath("/worklist/cut");
      return { ok: true };
    }

    const qty = Number(formData.get("qty"));
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: "Enter the quantity to schedule (> 0)." };

    // the pool = what the order still needs minus what other parts already
    // claimed — mirrors exactly what the worklist shows as available
    const [order, agg] = await Promise.all([
      prisma.masterOrder.findUnique({ where: { mo } }),
      prisma.handoverEntry.aggregate({ where: { mo, item, dept: "Cut" }, _sum: { qty: true } }),
    ]);
    const done = agg._sum.qty ?? 0;
    if (order) {
      const osp = { CF: order.ospCF, TC: order.ospTC, TN: order.ospTN, CB: order.ospCB } as const;
      const open = Math.max(0, order.planQty - (osp[item as keyof typeof osp] ?? 0) - done);
      // other parts' still-open share (same FIFO math the worklist displays)
      const others = parts.filter((p) => p.qty != null).sort((a, b) => (a.newDate < b.newDate ? -1 : 1));
      const base = others.length > 0 ? Math.min(...others.map((p) => p.baseDone)) : done;
      let consumed = Math.max(0, done - base);
      let claimed = 0;
      for (const p of others) {
        const used = Math.min(consumed, p.qty!);
        consumed -= used;
        claimed += Math.max(0, p.qty! - used);
      }
      const free = Math.max(0, open - claimed);
      if (qty > free) {
        return { ok: false, error: `Only ${free} pcs are still unscheduled on this line (${open} open − ${claimed} already scheduled).` };
      }
    }

    await prisma.worklistDateOverride.upsert({
      where: { bom_mo_item_origISO_newDate: { bom, mo, item, origISO: "", newDate } },
      create: { bom, mo, item, origISO: "", newDate, qty, baseDone: done, createdBy: by },
      // scheduling the same date again REPLACES that day's quantity
      update: { qty, createdBy: by },
    });
    revalidatePath("/worklist/cut");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Failed to save: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** ADMIN ONLY — revert a re-dated line: back to its original plan date, or
 *  back into the date-less pool for an admin-scheduled part (origISO "" —
 *  `date` picks WHICH part when the line was scheduled in several parts). */
export async function clearWorklistDate(formData: FormData): Promise<RecordResult> {
  try {
    const guard = await requireAdmin();
    if (guard.error) return { ok: false, error: guard.error };
    const bom = String(formData.get("bom") ?? "").trim();
    const mo = String(formData.get("mo") ?? "").trim();
    const item = String(formData.get("item") ?? "").trim().toUpperCase();
    const origISO = String(formData.get("origISO") ?? "").trim();
    const dateISO = String(formData.get("date") ?? "").trim(); // the part's current date ("" = all)
    if (!bom || !mo || !isItem(item)) return { ok: false, error: "Invalid line." };
    const date = dateISO ? parseISODate(dateISO) : null;
    await prisma.worklistDateOverride.deleteMany({
      where: { bom, mo, item, origISO, ...(origISO === "" && date ? { newDate: date } : {}) },
    });
    revalidatePath("/worklist/cut");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const ALL_WORKLIST_PATHS = ["/worklist/cut", "/worklist/welding", "/worklist/painting", "/tracker", "/"];

/** ADMIN ONLY — remove a line from a dept's worklist view. Plans, logs and the
 *  registry are untouched; the hidden line can be restored from the same page. */
export async function hideWorklistLine(formData: FormData): Promise<RecordResult> {
  try {
    const guard = await requireAdmin();
    if (guard.error) return { ok: false, error: guard.error };
    const dept = String(formData.get("dept") ?? "");
    const bom = String(formData.get("bom") ?? "").trim();
    const mo = String(formData.get("mo") ?? "").trim(); // "" for BOM-level queue lines
    const item = String(formData.get("item") ?? "").trim().toUpperCase();
    if (!isDept(dept)) return { ok: false, error: "Invalid department." };
    if (!bom || !isItem(item)) return { ok: false, error: "Invalid line." };
    await prisma.worklistLineHide.upsert({
      where: { dept_bom_mo_item: { dept, bom, mo, item } },
      create: { dept, bom, mo, item, createdBy: guard.user?.name ?? null },
      update: {},
    });
    for (const p of ALL_WORKLIST_PATHS) revalidatePath(p);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** ADMIN ONLY — bring a hidden line back to the dept's worklist. */
export async function unhideWorklistLine(formData: FormData): Promise<RecordResult> {
  try {
    const guard = await requireAdmin();
    if (guard.error) return { ok: false, error: guard.error };
    const dept = String(formData.get("dept") ?? "");
    const bom = String(formData.get("bom") ?? "").trim();
    const mo = String(formData.get("mo") ?? "").trim();
    const item = String(formData.get("item") ?? "").trim().toUpperCase();
    if (!isDept(dept) || !bom || !isItem(item)) return { ok: false, error: "Invalid line." };
    await prisma.worklistLineHide.deleteMany({ where: { dept, bom, mo, item } });
    for (const p of ALL_WORKLIST_PATHS) revalidatePath(p);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** ADMIN ONLY — take a tracker-pushed line off a dept's worklist. */
export async function removeWorklistPush(formData: FormData): Promise<RecordResult> {
  try {
    const guard = await requireAdmin();
    if (guard.error) return { ok: false, error: guard.error };
    const dept = String(formData.get("dept") ?? "");
    const mo = String(formData.get("mo") ?? "").trim();
    const item = String(formData.get("item") ?? "").trim().toUpperCase();
    if (!isDept(dept) || !mo || !isItem(item)) return { ok: false, error: "Invalid line." };
    await prisma.worklistPush.deleteMany({ where: { dept, mo, item } });
    for (const p of ALL_WORKLIST_PATHS) revalidatePath(p);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Failed: ${e instanceof Error ? e.message : String(e)}` };
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
    const guard = await requireDeptEdit(fromDept);
    if (guard.error) return { ok: false, error: guard.error };
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
    // re-delivering writes to the UPSTREAM dept's ledger — that dept's permission
    const guard = await requireDeptEdit(ret.toDept);
    if (guard.error) return { ok: false, error: guard.error };

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
    const guard = await requireDeptEdit(dept);
    if (guard.error) return { ok: false, error: guard.error };

    const files = formData.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
    if (!text && files.length === 0) return { ok: false, error: "Write a note or attach a photo." };
    if (files.length > MAX_PHOTOS) return { ok: false, error: `Max ${MAX_PHOTOS} photos per note.` };

    const urls: string[] = [];
    const useBlob = !!process.env.BLOB_READ_WRITE_TOKEN; // Vercel Blob (cloud + any machine with the token)
    if (files.length > 0 && !useBlob && process.env.VERCEL) {
      // ephemeral filesystem and no blob token — refuse clearly instead of losing files
      return { ok: false, error: "Photo storage is not configured — ask the admin." };
    }
    if (files.length > 0) {
      const dir = path.join(process.cwd(), "uploads", "notes");
      if (!useBlob) await mkdir(dir, { recursive: true });
      for (const f of files) {
        if (!f.type.startsWith("image/")) return { ok: false, error: `"${f.name}" is not an image.` };
        if (f.size > MAX_PHOTO_BYTES) return { ok: false, error: `"${f.name}" is larger than 10 MB.` };
        const rawExt = path.extname(f.name).toLowerCase();
        const ext = IMAGE_EXTENSIONS.has(rawExt) ? rawExt : ".jpg";
        const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
        if (useBlob) {
          const blob = await put(`notes/${name}`, Buffer.from(await f.arrayBuffer()), {
            access: "public",
            contentType: f.type,
            addRandomSuffix: true, // unguessable URL — the app itself stays behind login
          });
          urls.push(blob.url);
        } else {
          // local fallback: outside public/ — production only serves public assets
          // snapshotted at build time, so these go through the /uploads/notes route
          await writeFile(path.join(dir, name), Buffer.from(await f.arrayBuffer()));
          urls.push(`/uploads/notes/${name}`);
        }
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
  const guard = await requireDeptEdit(note.dept);
  if (guard.error) return { ok: false, error: guard.error };
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
  const guard = await requireDeptEdit(note.dept);
  if (guard.error) return { ok: false, error: guard.error };
  for (const p of note.photos ? (JSON.parse(note.photos) as string[]) : []) {
    try {
      if (p.startsWith("http")) {
        await del(p); // Vercel Blob photo
      } else {
        await rm(path.join(process.cwd(), p)); // legacy local-disk photo
      }
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
  const guard = await requireDeptEdit(note.dept);
  if (guard.error) return { ok: false, error: guard.error };
  await prisma.queueNote.update({ where: { id }, data: { status } });
  revalidatePath("/worklist/cut");
  revalidatePath("/worklist/welding");
  revalidatePath("/worklist/painting");
  return { ok: true };
}
