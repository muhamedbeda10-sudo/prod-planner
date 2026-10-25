"use server";

import { emitEvent } from "@/lib/server/events";
import { outputSentence } from "@/lib/domain/appEvents";
import { prisma } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { buildBomClassifier } from "@/lib/domain/normalizeBoms";
import { isItem, isDept } from "@/lib/domain/constants";
import { LV_ITEM, LV_STAGES } from "@/lib/domain/lv";
import { parseISODate } from "@/lib/domain/dates";
import { getKnownBoms } from "@/lib/server/handover";
import { importHandoverFile, type HandoverImportResult } from "@/lib/server/importHandover";
import { checkOutputChain } from "@/lib/server/outputGuard";
import { requireDeptEdit, requirePerm } from "@/lib/server/auth";
import { ledgerPermKey } from "@/lib/domain/permissions";
import { syncTanksToLedgerQty } from "@/lib/server/tanks";
import { TANKS_FROM_WORKLISTS, dailyLogAddsTanks } from "@/lib/domain/tanks";
import { getSettings } from "@/lib/server/data";
import { mirrorLedgerToOdoo, syncMirroredOdoo } from "@/lib/server/odooMirror";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** The log is the single source of truth — any change to it must refresh every
 *  screen that derives balances from it (worklists, tracker, dashboard, trace). */
function revalidateEverywhere() {
  for (const p of ["/handover", "/", "/worklist/cut", "/worklist/welding", "/worklist/painting", "/worklist/leak-test", "/barcode", "/tracker", "/trace", "/odoo"]) {
    revalidatePath(p);
  }
}

/** Thrown inside a transaction to roll it back with a message the user can act
 *  on, instead of a raw constraint error. */
class LedgerSyncError extends Error {}

export async function importHandoverAction(formData: FormData): Promise<HandoverImportResult> {
  const guard = await requirePerm("logs.import");
  if (guard.error) return { ok: false, error: guard.error };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose an Excel file." };
  const buffer = await file.arrayBuffer();
  const res = await importHandoverFile(buffer);
  if (res.ok) revalidateEverywhere();
  return res;
}

async function resolveBom(raw: string): Promise<
  | { ok: true; bom: string; bomRaw: string | null }
  | { ok: false; error: string }
> {
  const known = await getKnownBoms();
  const classify = buildBomClassifier(known);
  const c = classify(raw);
  switch (c.status) {
    case "known":
      return { ok: true, bom: c.clean, bomRaw: null };
    case "corrected":
      return { ok: true, bom: c.corrected!, bomRaw: c.clean };
    case "ambiguous":
      return { ok: false, error: `Ambiguous code "${c.clean}" — matches: ${c.candidates.join(", ")}. Fix the code.` };
    case "unknown":
      return { ok: false, error: `Unknown code "${c.clean}" — not found in any plan.` };
  }
}

export async function addHandover(formData: FormData): Promise<ActionResult> {
  const dateStr = String(formData.get("date") ?? "");
  const dept = String(formData.get("dept") ?? "");
  const bomRaw = String(formData.get("bom") ?? "").trim();
  const item = String(formData.get("item") ?? "").trim().toUpperCase();
  const qty = Number(formData.get("qty"));
  const planNo = Number(formData.get("planNo"));

  const date = parseISODate(dateStr);
  if (!date) return { ok: false, error: "Invalid date." };

  // An LV panel's row: one item, a stage of the panel's chain, and the MO it
  // was done on — the tracker reads a panel's stages per MO, so a row with
  // no MO would count for nothing.
  if (item === LV_ITEM) {
    const mo = String(formData.get("mo") ?? "").trim().toUpperCase();
    if (!(LV_STAGES as readonly string[]).includes(dept)) return { ok: false, error: "Choose the stage: Punching, Bending, Welding or Painting." };
    const guard = await requirePerm(ledgerPermKey(dept, item));
    if (guard.error) return { ok: false, error: guard.error };
    if (!Number.isInteger(qty) || qty <= 0) return { ok: false, error: "Enter a whole number of panels greater than zero." };
    if (!Number.isInteger(planNo) || planNo <= 0) return { ok: false, error: "Invalid plan number." };
    if (!mo) return { ok: false, error: "Pick the panel order (MO)." };
    const order = await prisma.masterOrder.findUnique({ where: { mo }, select: { bom: true, line: true } });
    if (!order || order.line !== "LV") return { ok: false, error: `${mo} is not an LV panel order.` };
    const plan = await prisma.plan.findUnique({ where: { planNo } });
    if (!plan) return { ok: false, error: `Plan ${planNo} does not exist.` };
    const chainError = await checkOutputChain({ dept, bom: order.bom, mo, item, qty });
    if (chainError) return { ok: false, error: chainError };
    await prisma.$transaction(async (tx) => {
      const ledger = await tx.handoverEntry.create({
        data: { date, dept, bom: order.bom, mo, item, qty, planNo, source: "manual", createdBy: guard.user?.name ?? null },
      });
      await mirrorLedgerToOdoo(tx, ledger, guard.user?.name ?? null);
    });
    revalidateEverywhere();
    await emitEvent({ type: "output.recorded", subject: mo, summary: outputSentence({ qty, item, on: mo, stage: dept }), data: { dept, mo, item, qty, source: "daily log" } });
    return { ok: true };
  }

  if (!isDept(dept)) return { ok: false, error: "Choose a department (Cut/Welding)." };
  const guard = await requireDeptEdit(dept);
  if (guard.error) return { ok: false, error: guard.error };
  if (!item || !isItem(item)) return { ok: false, error: "Choose a valid component (CF/TC/TN/CB)." };
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: "Enter a positive quantity." };
  if (!Number.isInteger(planNo) || planNo <= 0) return { ok: false, error: "Invalid plan number." };
  if (!bomRaw) return { ok: false, error: "Enter a BOM code." };
  if (dailyLogAddsTanks((await getSettings()).tankTracking, dept, item)) return { ok: false, error: TANKS_FROM_WORKLISTS };

  const resolved = await resolveBom(bomRaw);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const plan = await prisma.plan.findUnique({ where: { planNo } });
  if (!plan) return { ok: false, error: `Plan ${planNo} does not exist.` };

  // physical chain guard: painted ≤ welded ≤ cut ≤ order qty
  const chainError = await checkOutputChain({ dept, bom: resolved.bom, item, qty });
  if (chainError) return { ok: false, error: chainError };

  await prisma.$transaction(async (tx) => {
    const ledger = await tx.handoverEntry.create({
      data: { date, dept, bom: resolved.bom, bomRaw: resolved.bomRaw, item, qty, planNo, source: "manual", createdBy: guard.user?.name ?? null },
    });
    // a painting row typed here is a closing like any other — ODOO tab too
    await mirrorLedgerToOdoo(tx, ledger, guard.user?.name ?? null);
  });
  revalidateEverywhere();
  await emitEvent({ type: "output.recorded", subject: resolved.bom, summary: outputSentence({ qty, item, on: resolved.bom, stage: dept }), data: { dept, bom: resolved.bom, item, qty, source: "daily log" } });
  return { ok: true };
}

export async function updateHandover(formData: FormData): Promise<ActionResult> {
  const id = Number(formData.get("id"));
  const qty = Number(formData.get("qty"));
  const dateStr = String(formData.get("date") ?? "").trim();
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid id." };
  if (!Number.isFinite(qty) || qty < 0) return { ok: false, error: "Invalid quantity." };

  const entry = await prisma.handoverEntry.findUnique({ where: { id } });
  if (!entry) return { ok: false, error: "Record not found." };
  const guard = await requirePerm(ledgerPermKey(entry.dept, entry.item));
  if (guard.error) return { ok: false, error: guard.error };
  // a tank row may be lowered (its tanks follow it) but not raised here
  if (qty > entry.qty && dailyLogAddsTanks((await getSettings()).tankTracking, entry.dept, entry.item)) {
    return { ok: false, error: TANKS_FROM_WORKLISTS };
  }

  // the note keeps the audit trail of WHO changed the row
  const data: { qty: number; note: string; date?: Date } = {
    qty,
    note: guard.user?.name ? `edited by ${guard.user.name}` : "edited",
  };
  if (dateStr) {
    const date = parseISODate(dateStr);
    if (!date) return { ok: false, error: "Invalid date." };
    data.date = date;
  }

  // physical chain guard: painted ≤ welded ≤ cut ≤ order qty (edit included)
  const chainError = await checkOutputChain({
    dept: entry.dept, bom: entry.bom, mo: entry.mo, item: entry.item, qty, excludeId: id,
  });
  if (chainError) return { ok: false, error: chainError };

  // TANKS are tracked per piece, so a smaller quantity has to give pieces back
  // too — otherwise the barcode tab keeps listing tanks this row no longer
  // accounts for.
  const failure = await prisma
    .$transaction(async (tx) => {
      await tx.handoverEntry.update({ where: { id }, data });
      // the row's Odoo row follows it while nobody has worked that row yet
      await syncMirroredOdoo(tx, id, { qty, date: data.date });
      const sync = await syncTanksToLedgerQty(tx, entry, qty);
      if (sync.error) throw new LedgerSyncError(sync.error);
    })
    .catch((e) => {
      if (e instanceof LedgerSyncError) return e.message;
      throw e;
    });
  if (failure) return { ok: false, error: failure };
  revalidateEverywhere();
  return { ok: true };
}

/** Bulk re-date: move MANY selected log rows to a new date in one go.
 *  Permission is checked per department present in the selection (same dept
 *  rules as single-row edits). A date-only change can never break the
 *  physical chain — totals are all-time — so no chain re-check is needed. */
export async function bulkSetHandoverDate(formData: FormData): Promise<ActionResult & { updated?: number }> {
  const dateStr = String(formData.get("date") ?? "").trim();
  const ids = String(formData.get("ids") ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  const date = parseISODate(dateStr);
  if (!date) return { ok: false, error: "Choose a valid date." };
  if (ids.length === 0) return { ok: false, error: "No rows selected." };
  if (ids.length > 500) return { ok: false, error: "Too many rows at once — max 500." };

  const entries = await prisma.handoverEntry.findMany({ where: { id: { in: ids } }, select: { id: true, dept: true, item: true, qty: true } });
  if (entries.length === 0) return { ok: false, error: "Records not found." };
  let by: string | null = null;
  for (const k of [...new Set(entries.map((e) => ledgerPermKey(e.dept, e.item)))]) {
    const guard = await requirePerm(k);
    if (guard.error) return { ok: false, error: guard.error };
    by = guard.user?.name ?? null;
  }

  // the rows' ODOO closings move to the new day with them, as a single
  // row's edit already does
  const res = await prisma.$transaction(async (tx) => {
    const moved = await tx.handoverEntry.updateMany({
      where: { id: { in: entries.map((e) => e.id) } },
      data: { date, note: by ? `edited by ${by}` : "edited" },
    });
    for (const e of entries) await syncMirroredOdoo(tx, e.id, { qty: e.qty, date });
    return moved;
  });
  revalidateEverywhere();
  return { ok: true, updated: res.count };
}

/** The rows a return took off its department. Deleting one of an OPEN return
 *  takes the return back with it (cancelReturn's rule); one whose pieces were
 *  re-delivered since is refused, or the re-delivery would credit pieces that
 *  were never taken off. */
async function returnRowsRefusal(ids: readonly number[]): Promise<string | null> {
  const done = await prisma.returnEntry.findMany({ where: { handoverId: { in: [...ids] }, status: { not: "open" } }, select: { mo: true, bom: true, item: true, qty: true } });
  if (done.length === 0) return null;
  const r = done[0];
  return `That row is the return of ${r.qty} × ${r.item} on ${r.mo || r.bom}, and those pieces were re-delivered since — it stays, or the re-delivery would count pieces that were never taken off.`;
}

/** Delete SEVERAL log rows at once — the ticked rows on the Daily Log.
 *
 *  The batch is judged as a batch: the chain is re-checked once per affected
 *  scope with every selected row already gone, so deleting a cut row together
 *  with the weld row it fed passes, while deleting the cut row on its own
 *  still refuses. Nothing is deleted unless the whole batch is legal — a
 *  half-applied delete would leave the balances telling a story that never
 *  happened. */
export async function bulkDeleteHandover(formData: FormData): Promise<ActionResult & { deleted?: number }> {
  const ids = String(formData.get("ids") ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return { ok: false, error: "No rows selected." };
  if (ids.length > 200) return { ok: false, error: "Too many rows at once — max 200." };

  const entries = await prisma.handoverEntry.findMany({ where: { id: { in: ids } } });
  if (entries.length === 0) return { ok: false, error: "Records not found." };
  for (const k of [...new Set(entries.map((e) => ledgerPermKey(e.dept, e.item)))]) {
    const guard = await requirePerm(k);
    if (guard.error) return { ok: false, error: guard.error };
  }

  const leaving = entries.map((e) => e.id);
  const returnRefusal = await returnRowsRefusal(leaving);
  if (returnRefusal) return { ok: false, error: returnRefusal };
  // one check per scope the batch touches: an MO's item, or a BOM's item for
  // the rows that carry no MO
  const scopes = new Map<string, (typeof entries)[number]>();
  for (const e of entries) scopes.set(`${(e.mo ?? "").trim() || `bom:${e.bom}`}|${e.item}`, e);
  for (const e of scopes.values()) {
    const chainError = await checkOutputChain({
      dept: e.dept, bom: e.bom, mo: e.mo, item: e.item, qty: 0, excludeIds: leaving,
    });
    if (chainError) return { ok: false, error: chainError };
  }

  const failure = await prisma
    .$transaction(async (tx) => {
      for (const e of entries) {
        const sync = await syncTanksToLedgerQty(tx, e, 0);
        if (sync.error) throw new LedgerSyncError(sync.error);
        await syncMirroredOdoo(tx, e.id, "delete");
      }
      // a return's own row deleted is the return taken back
      await tx.returnEntry.deleteMany({ where: { handoverId: { in: leaving }, status: "open" } });
      await tx.handoverEntry.deleteMany({ where: { id: { in: leaving } } });
    })
    .catch((e) => {
      if (e instanceof LedgerSyncError) return e.message;
      throw e;
    });
  if (failure) return { ok: false, error: failure };
  revalidateEverywhere();
  return { ok: true, deleted: entries.length };
}

export async function deleteHandover(formData: FormData): Promise<ActionResult> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid id." };

  const entry = await prisma.handoverEntry.findUnique({ where: { id } });
  if (!entry) return { ok: false, error: "Record not found." };
  const guard = await requirePerm(ledgerPermKey(entry.dept, entry.item));
  if (guard.error) return { ok: false, error: guard.error };

  // deleting upstream output must not leave downstream hanging (weld > cut …)
  const chainError = await checkOutputChain({
    dept: entry.dept, bom: entry.bom, mo: entry.mo, item: entry.item, qty: 0, excludeId: id,
  });
  if (chainError) return { ok: false, error: chainError };
  const returnRefusal = await returnRowsRefusal([id]);
  if (returnRefusal) return { ok: false, error: returnRefusal };

  // deleting the row takes its tanks with it: a welding row's tanks stop
  // existing, a painting row's tanks go back to "passed the leak test" and
  // leave the barcode tab
  const failure = await prisma
    .$transaction(async (tx) => {
      const sync = await syncTanksToLedgerQty(tx, entry, 0);
      if (sync.error) throw new LedgerSyncError(sync.error);
      await syncMirroredOdoo(tx, id, "delete");
      // a return's own row deleted is the return taken back
      await tx.returnEntry.deleteMany({ where: { handoverId: id, status: "open" } });
      await tx.handoverEntry.delete({ where: { id } });
    })
    .catch((e) => {
      if (e instanceof LedgerSyncError) return e.message;
      throw e;
    });
  if (failure) return { ok: false, error: failure };
  revalidateEverywhere();
  return { ok: true };
}

