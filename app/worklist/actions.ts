"use server";

import { prisma } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { put, del } from "@vercel/blob";
import { isItem, isDept, deptLabel } from "@/lib/domain/constants";
import { factoryDayISO, parseISODate, toISODate } from "@/lib/domain/dates";
import { findPlanForDate } from "@/lib/domain/findPlan";
import { getPlanWindows, getSettings } from "@/lib/server/data";
import { checkOutputChain, recheckLvChainLocked } from "@/lib/server/outputGuard";
import { requireDeptEdit, requireAdmin, requirePerm } from "@/lib/server/auth";
import { ledgerPermKey, trackerPermKey } from "@/lib/domain/permissions";
import { DELIVERED_STAGE, SHOTBLAST_STAGE, stageItemError } from "@/lib/domain/constants";
import { TANK_ITEM } from "@/lib/domain/tanks";
import { mintTankSerials, unmintTankSerials } from "@/lib/server/tanks";
import { resolveWorker } from "@/lib/server/workers";
import { mirrorLedgerToOdoo } from "@/lib/server/odooMirror";
import { writeCorrection } from "@/lib/server/corrections";
import { loadGroupMembers, groupTotal, groupShownTotal, spreadGroupChange, memberAt } from "@/lib/server/groupRecord";
import { readBase, shownStageTotal, staleTotalError } from "@/lib/domain/trackerEdit";
import { LV_ITEM, LV_STAGES, lvStageAt } from "@/lib/domain/lv";
import { emitEvent } from "@/lib/server/events";
import { outputSentence } from "@/lib/domain/appEvents";
import { UserError, userMessage } from "@/lib/server/errors";
import { orderLineError } from "@/lib/server/returns";

export interface RecordResult {
  ok: boolean;
  error?: string;
  /** Welding a batch of tanks mints their serials — the worklist shows them
   *  straight away so the technician can write them on the steel. */
  serials?: string[];
  /** The Daily log row the recording made. */
  ledgerId?: number;
  /** The row the action made: a queue note (addQueueNote), a return
   *  (returnToUpstream). */
  id?: number;
}

/** Thrown inside a tank transaction to roll it back with a message the shop
 *  floor can act on, instead of a raw constraint error. */
class TankSyncError extends UserError {}


// Every screen a production record moves. TANK_PATHS adds the two the
// per-piece layer feeds: the leak-test stage and the barcode sheet.
// /odoo is on the list because a painting (or shot-blast) record writes its
// own row on the ODOO log.
const RECORD_PATHS = ["/worklist/cut", "/worklist/welding", "/worklist/painting", "/handover", "/", "/tracker", "/trace", "/odoo"];
const TANK_PATHS = [...RECORD_PATHS, "/worklist/leak-test", "/barcode"];

/** Painting a tank now means naming WHICH tank and WHO painted it, and only a
 *  tank that passed the leak test may go. The quantity boxes elsewhere (the
 *  Plan Tracker's Paint cell, a BOM group row, the weekly plan) cannot express
 *  either, so they hand the job to the painting worklist instead of silently
 *  recording a quantity no tank backs. */
const PAINT_TANKS_ELSEWHERE =
  "Tanks are painted from the Painting worklist — pick the tanks themselves and who painted them there. A tank cannot be painted until it passes the leak test.";

/** An LV order's panels are recorded on the LV tracker, never through a transformer write. */
const panelOrderRefusal = (mo: string) => `${mo} is an LV panel order — panels are recorded on the LV tracker.`;

/** Record output against a plan order line (MO × item) from the execution sheet.
 *  Creates a dated HandoverEntry — the analytics log stays the single source of truth. */
export async function recordOutput(formData: FormData): Promise<RecordResult> {
  try {
    const dateStr = String(formData.get("date") ?? "");
    let dept = String(formData.get("dept") ?? "");
    let bom = String(formData.get("bom") ?? "").trim();
    const mo = String(formData.get("mo") ?? "").trim();
    const item = String(formData.get("item") ?? "").trim().toUpperCase();
    const qty = Number(formData.get("qty"));
    const planNo = Number(formData.get("planNo"));
    // tanks only: who welded this batch (a Worker row, not an app account)
    const rawWorker = String(formData.get("workerId") ?? "").trim();
    const workerId = rawWorker ? Number(rawWorker) : null;
    // the machine it was finished on, when the record came off a machine card
    const rawMachine = String(formData.get("machineId") ?? "").trim();
    const machineId = rawMachine && Number.isInteger(Number(rawMachine)) ? Number(rawMachine) : null;

    const date = parseISODate(dateStr);
    if (!date) return { ok: false, error: "Invalid date." };
    // An LV panel off a machine card: the fabrication bay's punches punch it,
    // so a panel recorded under "Cut" is punching; the other bays keep their
    // names. The row's own key records it — a panel's the LV stage's, never
    // the transformer bay's whose machine it ran on.
    const lvPanel = item === LV_ITEM;
    if (lvPanel) dept = lvStageAt(dept) ?? dept;
    if (lvPanel ? !(LV_STAGES as readonly string[]).includes(dept) : !isDept(dept)) return { ok: false, error: "Invalid department." };
    const guard = await requirePerm(ledgerPermKey(dept, item));
    if (guard.error) return { ok: false, error: guard.error };
    if (!bom) return { ok: false, error: "Missing BOM." };
    if (!lvPanel && !isItem(item)) return { ok: false, error: "Invalid component." };
    if (!lvPanel) {
      const stageRule = stageItemError(dept, item);
      if (stageRule) return { ok: false, error: stageRule };
    }
    if (lvPanel && !mo) return { ok: false, error: "A panel is recorded on its MO." };
    if (lvPanel && !Number.isInteger(qty)) return { ok: false, error: "Panels are recorded by the piece — enter a whole number." };
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: "Enter a quantity greater than zero." };
    if (!Number.isInteger(planNo) || planNo < 0) return { ok: false, error: "Invalid plan number." };

    // Welding a TANK mints one serial per piece, so the quantity has to be a
    // whole number of tanks and the batch has to say who welded them — unless
    // per-piece tracking is switched off, when a tank is just a quantity again.
    const tankTracking = (await getSettings()).tankTracking;
    if (tankTracking && dept === "Painting" && item === TANK_ITEM) return { ok: false, error: PAINT_TANKS_ELSEWHERE };
    const mintsTanks = tankTracking && dept === "Welding" && item === TANK_ITEM;
    if (mintsTanks && !Number.isInteger(qty)) {
      return { ok: false, error: "Tanks are recorded by the piece — enter a whole number." };
    }
    if (mintsTanks && !mo) {
      return { ok: false, error: "A tank needs an MO to carry its serial." };
    }
    if (mintsTanks && workerId === null) {
      return { ok: false, error: "Pick who welded these tanks." };
    }
    if (workerId !== null && !Number.isInteger(workerId)) {
      return { ok: false, error: "Invalid worker selection." };
    }
    const welder = mintsTanks ? await resolveWorker(workerId, "Welding") : {};
    if (welder.error) return { ok: false, error: welder.error };

    // lines come from real orders, never free text. The master registry (monthly
    // plan) is the source of truth; weekly schedule/plan lines and prior log
    // entries (setup balances) are accepted as fallbacks.
    if (mo) {
      const order = await prisma.masterOrder.findFirst({ where: { mo }, select: { bom: true, line: true } });
      // a panel is the LV order's and is filed under ITS plan's BOM; a
      // transformer component never goes on a panel order
      if (order?.line === "LV" && !lvPanel) return { ok: false, error: panelOrderRefusal(mo) };
      if (lvPanel) {
        if (!order || order.line !== "LV") return { ok: false, error: `${mo} is not an LV panel order.` };
        bom = order.bom;
      } else {
        const line =
          order ??
          (await prisma.planSchedule.findFirst({ where: { bom, mo, item } })) ??
          (await prisma.planOrder.findFirst({ where: { bom, mo, item } })) ??
          (await prisma.handoverEntry.findFirst({ where: { bom, mo } }));
        if (!line) return { ok: false, error: "This MO is not in the orders registry or any plan." };
      }
    } else {
      const known = await prisma.handoverEntry.findFirst({ where: { bom } });
      if (!known) return { ok: false, error: "This code has no history." };
    }

    // physical chain guard: painted ≤ welded ≤ cut ≤ order qty
    const chainError = await checkOutputChain({ dept, bom, mo, item, qty });
    if (chainError) return { ok: false, error: chainError };

    // queue recordings land in the global bucket (plan 0) — make sure it
    // exists; any other plan has to be one that was imported
    if (planNo === 0) {
      await prisma.plan.upsert({ where: { planNo: 0 }, create: { planNo: 0, startDate: date }, update: {} });
    } else if (!(await prisma.plan.findUnique({ where: { planNo }, select: { planNo: true } }))) {
      return { ok: false, error: `Plan ${planNo} does not exist — refresh the page.` };
    }

    // the ledger row and the tanks' serials are ONE write: a serial must never
    // survive a welding record that failed to save, nor the other way round
    const made = await prisma.$transaction(async (tx) => {
      // a panel waits on its order's lock and is judged again under it — the
      // LV tracker may be recording on the same MO this very moment
      await recheckLvChainLocked(tx, { dept, bom, mo, item, qty });
      const ledger = await tx.handoverEntry.create({
        data: { date, dept, bom, mo: mo || null, item, qty, planNo, source: "worklist", machineId, createdBy: guard.user?.name ?? null },
      });
      // a painting record is a closing — it gets its row on the ODOO log
      await mirrorLedgerToOdoo(tx, ledger, guard.user?.name ?? null);
      if (!mintsTanks) return { ledgerId: ledger.id, serials: [] as string[] };
      const minted = await mintTankSerials(tx, {
        bom, mo, planNo, count: qty, date, ledgerId: ledger.id,
        workerId: welder.worker?.id ?? null,
        workerName: welder.worker?.name ?? null,
        workerStamp: welder.worker?.stamp ?? null,
        byUser: guard.user?.name ?? null,
      });
      return { ledgerId: ledger.id, serials: minted.map((m) => m.serial) };
    });
    for (const p of TANK_PATHS) revalidatePath(p);
    await emitEvent({ type: "output.recorded", subject: mo || bom, summary: outputSentence({ qty, item, on: mo || bom, stage: dept }), data: { dept, mo, bom, item, qty } });
    return { ok: true, serials: made.serials.length > 0 ? made.serials : undefined, ledgerId: made.ledgerId };
  } catch (e) {
    return { ok: false, error: userMessage(e, "save the output") };
  }
}

/** Plan-tracker inline edit: the user types the NEW cumulative total for one
 *  MO × item × their own dept — the DIFFERENCE is recorded in the Daily log,
 *  so it shows up there and on the dept's worklist immediately. A HIGHER
 *  total logs work done today; a LOWER total records NEGATIVE correction
 *  entries, dated on the days of the work they take back (writeCorrection). Either way the physical chain
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
    // the dept's own permission (cut.edit / welding.edit / painting.edit / tracker.shp / tracker.delivered)
    const guard = await requirePerm(trackerPermKey(dept));
    if (guard.error) return { ok: false, error: guard.error };
    if (!bom || !mo) return { ok: false, error: "Missing MO / BOM." };
    if (!isItem(item)) return { ok: false, error: "Invalid component." };
    const stageRule = stageItemError(dept, item);
    if (stageRule) return { ok: false, error: stageRule };
    if (!Number.isInteger(newTotal) || newTotal < 0) return { ok: false, error: "Enter a whole number ≥ 0." };
    const tankTracking = (await getSettings()).tankTracking;
    if (tankTracking && item === TANK_ITEM && dept === "Painting") return { ok: false, error: PAINT_TANKS_ELSEWHERE };

    const [agg, order] = await Promise.all([
      prisma.handoverEntry.aggregate({ where: { mo, item, dept }, _sum: { qty: true } }),
      prisma.masterOrder.findUnique({ where: { mo }, select: { planQty: true, line: true } }),
    ]);
    if (order?.line === "LV") return { ok: false, error: panelOrderRefusal(mo) };
    const current = agg._sum.qty ?? 0;
    // the total was typed from the figure on the page; if the ledger moved
    // since, the difference below would be counted from the wrong figure
    const shown = shownStageTotal(current, order?.planQty ?? 0);
    const stale = staleTotalError(readBase(formData.get("base")), shown);
    if (stale) return { ok: false, error: stale };
    const delta = newTotal - current;
    if (delta === 0) return { ok: false, error: "Nothing changed — the total is already " + current + "." };
    // the cell shows the ledger capped at the order quantity; when the ledger
    // already stands above it, only a correction downwards can be typed —
    // adding to a figure the page does not show would record from the wrong base
    if (current > shown && newTotal > shown) {
      return { ok: false, error: `${mo} has ${current} recorded at ${deptLabel(dept)} but the order is for ${order?.planQty} — lower the total or correct the order quantity first.` };
    }

    // physical chain guard, checked AFTER the proposed change in BOTH
    // directions: an increase can't out-run upstream/order qty, and a
    // decrease can't leave downstream output hanging (e.g. cut below welded)
    const chainError = await checkOutputChain({ dept, bom, mo, item, qty: delta });
    if (chainError) return { ok: false, error: chainError };

    // date = today; plan = whichever plan covers today (ahead-of-plan work
    // falls back to the newest plan, then the setup bucket 0)
    const today = parseISODate(factoryDayISO(new Date()))!;
    const [windows, settings] = await Promise.all([getPlanWindows(), getSettings()]);
    const planNo =
      findPlanForDate(windows, today, settings.leadCut) ??
      (windows.length ? Math.max(...windows.map((w) => w.planNo)) : 0);
    await prisma.plan.upsert({
      where: { planNo },
      create: { planNo, startDate: today },
      update: {},
    });

    // a Weld cell on TANKS moves the per-piece layer too, so the serials and
    // the ledger can never disagree about how many tanks exist
    const syncsTanks = tankTracking && item === TANK_ITEM && dept === "Welding";
    const failure = await prisma.$transaction(async (tx) => {
      if (delta < 0) {
        // a correction is dated on the days of the work it takes back, not
        // today; its note says exactly what happened, for the audit trail
        await writeCorrection(tx, {
          dept, bom, mo, item, take: -delta, today, fallbackPlan: planNo, source: "tracker",
          note: `tracker correction: total ${current} → ${newTotal}`, by: guard.user?.name ?? null,
        });
      } else {
        const ledger = await tx.handoverEntry.create({
          data: { date: today, dept, bom, mo, item, qty: delta, planNo, source: "tracker", note: null, createdBy: guard.user?.name ?? null },
        });
        // a higher Paint / SHB total is a closing
        await mirrorLedgerToOdoo(tx, ledger, guard.user?.name ?? null);
        if (syncsTanks) {
          // the cell has no room to name a welder — the tank page and the
          // welding worklist can fill it in afterwards
          await mintTankSerials(tx, { bom, mo, planNo, count: delta, date: today, ledgerId: ledger.id, byUser: guard.user?.name ?? null });
        }
        return null;
      }
      if (!syncsTanks) return null;
      const { short } = await unmintTankSerials(tx, { bom, mo, count: -delta });
      if (short > 0) {
        throw new TankSyncError(
          `The total cannot go that low: ${short} of those tanks have already been tested or painted. Undo the later stage first.`
        );
      }
      return null;
    }).catch((e) => {
      if (e instanceof TankSyncError) return e.message;
      throw e;
    });
    if (failure) return { ok: false, error: failure };
    for (const p of TANK_PATHS) revalidatePath(p);
    await emitEvent({ type: "output.recorded", subject: mo, summary: outputSentence({ qty: delta, item, on: mo, stage: dept, total: newTotal }), data: { dept, mo, bom, item, qty: delta } });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: userMessage(e, "save the total") };
  }
}

/** Record output on a BOM group row (the "cascade" summary) and DISTRIBUTE it
 *  across the member MOs in the order they are listed: each MO absorbs up to
 *  its own chain headroom (upstream − done, and the order qty for Cut), the
 *  rest flows to the next MO. All-or-nothing: if the quantity doesn't fit the
 *  whole group, nothing is saved and the error says how much fits.
 *  Three callers:
 *  - worklists (source "worklist"): `qty` = pieces to ADD (> 0);
 *  - tracker (source "tracker"): `total` = the NEW cumulative group total —
 *    the delta may be negative (correction), which is taken back from the
 *    LAST MOs first, never below what downstream already consumed;
 *  - weekly plan (source "weekly"): `qty` = pieces to ADD against ONE delivery
 *    day's promise, over the orders that day owes. ADD, not a total: a weekly
 *    cell shows a day's SLICE of the order's output (capped and waterfalled),
 *    so "set it to N" would be ambiguous while "add N pcs" never is. Its own
 *    permission (weekly.record), and the ledger row says it came from the
 *    weekly plan. */
export async function recordGroupOutput(formData: FormData): Promise<RecordResult> {
  try {
    const source = String(formData.get("source") ?? "worklist");
    const dept = String(formData.get("dept") ?? "");
    const bom = String(formData.get("bom") ?? "").trim();
    const item = String(formData.get("item") ?? "").trim().toUpperCase();
    const mos = [...new Set(String(formData.get("mos") ?? "").split(",").map((s) => s.trim()).filter(Boolean))];

    // permissions mirror the single-row actions exactly: worklist recording
    // uses the dept edit permission, tracker cells use the tracker permissions
    let by: string | null = null;
    if (source === "tracker") {
      if (!isDept(dept) && dept !== DELIVERED_STAGE && dept !== SHOTBLAST_STAGE) return { ok: false, error: "Invalid department." };
      const guard = await requirePerm(trackerPermKey(dept));
      if (guard.error) return { ok: false, error: guard.error };
      by = guard.user?.name ?? null;
    } else if (source === "weekly") {
      // ONE permission covers the whole weekly sheet — it is a single screen a
      // planner either records on or does not, not five separate columns
      if (!isDept(dept) && dept !== DELIVERED_STAGE && dept !== SHOTBLAST_STAGE) return { ok: false, error: "Invalid department." };
      const guard = await requirePerm("weekly.record");
      if (guard.error) return { ok: false, error: guard.error };
      by = guard.user?.name ?? null;
    } else {
      if (!isDept(dept)) return { ok: false, error: "Invalid department." };
      const guard = await requireDeptEdit(dept);
      if (guard.error) return { ok: false, error: guard.error };
      by = guard.user?.name ?? null;
    }
    if (!bom) return { ok: false, error: "Missing BOM." };
    if (!isItem(item)) return { ok: false, error: "Invalid component." };
    const stageRule = stageItemError(dept, item);
    if (stageRule) return { ok: false, error: stageRule };
    const tankTracking = (await getSettings()).tankTracking;
    if (tankTracking && item === TANK_ITEM && dept === "Painting") return { ok: false, error: PAINT_TANKS_ELSEWHERE };
    if (mos.length === 0) return { ok: false, error: "The group has no MOs to distribute over." };

    // the member orders + their per-dept ledger totals for this component,
    // per MO in the GIVEN order (the order shown on screen)
    const list = await loadGroupMembers(bom, item, mos);
    if (!list) return { ok: false, error: `An MO in the group is not on ${bom}, or is in no plan or log — refresh the page.` };
    const panelOrder = list.find((m) => m.o?.line === "LV");
    if (panelOrder) return { ok: false, error: panelOrderRefusal(panelOrder.mo) };
    // the page shows each member capped at its order quantity; an order whose
    // ledger already stands above it (the quantity was lowered after the work
    // was recorded) cannot be typed over as a group — the difference would be
    // taken from a figure the page never showed
    const over = source === "tracker" ? list.find((m) => m.o && m.o.planQty > 0 && memberAt(m, dept) > m.o.planQty) : undefined;
    if (over) return { ok: false, error: `${over.mo} has ${memberAt(over, dept)} recorded at ${deptLabel(dept)} but the order is for ${over.o!.planQty} — correct that order's own cell or its quantity first.` };
    const current = groupTotal(list, dept);

    // the requested change
    let delta: number;
    let newTotal: number | null = null;
    if (source === "tracker") {
      newTotal = Number(formData.get("total"));
      if (!Number.isInteger(newTotal) || newTotal < 0) return { ok: false, error: "Enter a whole number ≥ 0." };
      const stale = staleTotalError(readBase(formData.get("base")), groupShownTotal(list, dept));
      if (stale) return { ok: false, error: stale };
      delta = newTotal - current;
      if (delta === 0) return { ok: false, error: "Nothing changed — the group total is already " + current + "." };
    } else {
      delta = Number(formData.get("qty"));
      if (!Number.isInteger(delta) || delta <= 0) return { ok: false, error: "Enter a whole quantity greater than zero." };
    }
    // welding a group row of TANKS mints serials for every member MO — same
    // rules as a single line: whole pieces, and a named welder
    const groupMintsTanks = tankTracking && item === TANK_ITEM && dept === "Welding" && delta > 0;
    const rawWorker = String(formData.get("workerId") ?? "").trim();
    const groupWorkerId = rawWorker ? Number(rawWorker) : null;
    if (groupMintsTanks && source === "worklist") {
      if (groupWorkerId === null) return { ok: false, error: "Pick who welded these tanks." };
      if (!Number.isInteger(groupWorkerId)) return { ok: false, error: "Invalid worker selection." };
    }
    const groupWelder = groupMintsTanks ? await resolveWorker(groupWorkerId, "Welding") : {};
    if (groupWelder.error) return { ok: false, error: groupWelder.error };

    // what the weekly cell says it was recorded against — for the ledger note
    // (the weekly sheet on the Plan Tracker, or under the fabrication machines)
    const dayISO = source !== "tracker" ? String(formData.get("dayISO") ?? "").trim().slice(0, 10) : "";
    const planLabel = source !== "tracker" ? String(formData.get("planLabel") ?? "").trim().slice(0, 20) : "";
    const fromWeekly = source === "weekly" || !!dayISO;

    // Per-MO headroom and the fill order are ONE rule, shared with the
    // tracker's own preview and the assistant's — see lib/server/groupRecord
    // and lib/domain/groupSpread.
    const spread = spreadGroupChange(list, dept, item, delta);
    if (spread.left > 0) {
      return {
        ok: false,
        error: delta > 0
          ? `Only ${spread.fits} pcs fit across this group (chain limits: upstream done / order quantities) — nothing was saved.`
          : `Only ${spread.fits} pcs can be deducted (downstream already consumed the rest) — nothing was saved.`,
      };
    }
    const alloc = new Map(spread.alloc.map((a) => [a.mo, a.qty]));

    // date = today; plan = whichever plan covers today (same as tracker cells)
    const today = parseISODate(factoryDayISO(new Date()))!;
    const [windows, settings] = await Promise.all([getPlanWindows(), getSettings()]);
    const planNo =
      findPlanForDate(windows, today, settings.leadCut) ??
      (windows.length ? Math.max(...windows.map((w) => w.planNo)) : 0);
    await prisma.plan.upsert({ where: { planNo }, create: { planNo, startDate: today }, update: {} });

    const syncsTanks = tankTracking && item === TANK_ITEM && dept === "Welding";
    const outcome = await prisma.$transaction(async (tx) => {
      const minted: string[] = [];
      for (const [mo, q] of alloc) {
        if (q < 0) {
          // a correction is dated on the days of the work it takes back, not today
          await writeCorrection(tx, {
            dept, bom, mo, item, take: -q, today, fallbackPlan: planNo,
            source: source === "tracker" ? "tracker" : source === "weekly" ? "weekly" : "worklist",
            note: `group correction: ${bom} ${item} total ${current} → ${newTotal}`, by,
          });
          if (syncsTanks) {
            const { short } = await unmintTankSerials(tx, { bom, mo, count: -q });
            if (short > 0) {
              throw new TankSyncError(
                `The total cannot go that low: ${short} tanks on ${mo} have already been tested or painted. Undo the later stage first.`
              );
            }
          }
          continue;
        }
        const ledger = await tx.handoverEntry.create({
          data: {
            date: today, dept, bom, mo, item, qty: q, planNo,
            source: source === "tracker" ? "tracker" : source === "weekly" ? "weekly" : "worklist",
            note:
              fromWeekly
                ? `recorded on the weekly plan${planLabel ? ` ${planLabel}` : ""}${dayISO ? ` · ${dayISO} delivery` : ""}${alloc.size > 1 ? ` · split over ${alloc.size} MOs` : ""}`
                : alloc.size > 1 ? `group record on ${bom}` : null,
            createdBy: by,
          },
        });
        await mirrorLedgerToOdoo(tx, ledger, by);
        if (!syncsTanks) continue;
        if (q > 0) {
          const batch = await mintTankSerials(tx, {
            bom, mo, planNo, count: q, date: today, ledgerId: ledger.id,
            workerId: groupWelder.worker?.id ?? null,
            workerName: groupWelder.worker?.name ?? null,
            workerStamp: groupWelder.worker?.stamp ?? null,
            byUser: by,
          });
          minted.push(...batch.map((m) => m.serial));
        }
      }
      return minted;
    }).catch((e) => {
      if (e instanceof TankSyncError) return e.message;
      throw e;
    });
    if (typeof outcome === "string") return { ok: false, error: outcome };
    for (const p of TANK_PATHS) revalidatePath(p);
    const on = mos.length === 1 ? mos[0] : `${bom} (${mos.length} orders)`;
    await emitEvent({ type: "output.recorded", subject: on, summary: outputSentence({ qty: delta, item, on, stage: dept, total: newTotal }), data: { dept, bom, mos, item, qty: delta } });
    return { ok: true, serials: outcome.length > 0 ? outcome : undefined };
  } catch (e) {
    return { ok: false, error: userMessage(e, "save the output") };
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
      // other parts' still-open share (same FIFO math the worklist displays);
      // the part already on the chosen date is REPLACED below, so its old
      // quantity neither claims nor consumes
      const others = parts
        .filter((p) => p.qty != null && toISODate(p.newDate) !== toISODate(newDate))
        .sort((a, b) => (a.newDate < b.newDate ? -1 : 1));
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
    return { ok: false, error: userMessage(e, "save the date") };
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
    return { ok: false, error: userMessage(e, "clear the date") };
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
    return { ok: false, error: userMessage(e, "hide the line") };
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
    return { ok: false, error: userMessage(e, "show the line again") };
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
    return { ok: false, error: userMessage(e, "remove the line") };
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
    if (item === TANK_ITEM && fromDept === "Painting" && (await getSettings()).tankTracking) {
      // a tank has an identity — sending "3 pieces" back would leave the ledger
      // and the serials disagreeing about which three
      return { ok: false, error: "A tank goes back to welding by name — open the tank list, find it by serial and use \"Send back to welding\"." };
    }
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: "Enter a quantity greater than zero." };
    if (!reason) return { ok: false, error: "Write the reason — the upstream dept needs to know what to fix." };
    const lineError = await orderLineError(bom, mo || null);
    if (lineError) return { ok: false, error: lineError };

    // can only return what is actually WAITING in this queue (upstream − consumed)
    const scope = mo ? { mo, item } : { bom, item };
    const sums = await prisma.handoverEntry.groupBy({ by: ["dept"], where: scope, _sum: { qty: true } });
    const tot = (d: string) => sums.find((s) => s.dept === d)?._sum.qty ?? 0;
    const available = tot(toDept) - tot(fromDept);
    if (qty > available) {
      return { ok: false, error: `Only ${Math.max(0, available)} pcs are waiting in this queue — cannot return ${qty}.` };
    }

    const date = parseISODate(factoryDayISO(new Date()))!;
    await prisma.plan.upsert({ where: { planNo: 0 }, create: { planNo: 0, startDate: date }, update: {} });
    const made = await prisma.$transaction(async (tx) => {
      const ledger = await tx.handoverEntry.create({
        data: { date, dept: toDept, bom, mo: mo || null, item, qty: -qty, planNo: 0, source: "return", note: reason, createdBy: guard.user?.name ?? null },
      });
      const ret = await tx.returnEntry.create({
        data: { date, fromDept, toDept, bom, mo: mo || null, item, qty, reason, handoverId: ledger.id },
      });
      return { id: ret.id, ledgerId: ledger.id };
    });
    for (const p of ["/worklist/cut", "/worklist/welding", "/worklist/painting", "/handover", "/", "/tracker", "/trace"]) {
      revalidatePath(p);
    }
    await emitEvent({
      type: "work.returned",
      subject: mo || bom,
      summary: `Returned ${qty} × ${item} on ${mo || bom} from ${deptLabel(fromDept)} to ${deptLabel(toDept)} — ${reason}`,
      data: { fromDept, toDept, mo, bom, item, qty, reason },
    });
    return { ok: true, ...made };
  } catch (e) {
    return { ok: false, error: userMessage(e, "return it") };
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

    const date = parseISODate(factoryDayISO(new Date()))!;
    const ledgerId = await prisma.$transaction(async (tx) => {
      // closed first, and only while still open: a second tap (or a second
      // screen) re-delivering the same return credits the department once
      const closed = await tx.returnEntry.updateMany({ where: { id, status: "open" }, data: { status: "resolved" } });
      if (closed.count === 0) return null;
      const ledger = await tx.handoverEntry.create({
        data: {
          date, dept: ret.toDept, bom: ret.bom, mo: ret.mo, item: ret.item,
          qty: ret.qty, planNo: 0, source: "return", note: `re-delivered (was: ${ret.reason})`,
          createdBy: guard.user?.name ?? null,
        },
      });
      return ledger.id;
    });
    if (ledgerId === null) return { ok: false, error: "Already re-delivered." };
    for (const p of ["/worklist/cut", "/worklist/welding", "/worklist/painting", "/handover", "/", "/tracker", "/trace"]) {
      revalidatePath(p);
    }
    return { ok: true, ledgerId };
  } catch (e) {
    return { ok: false, error: userMessage(e, "deliver it again") };
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

    const note = await prisma.queueNote.create({
      data: { bom, mo: mo || null, item, dept, text, photos: urls.length > 0 ? JSON.stringify(urls) : null },
    });
    revalidatePath("/worklist/cut");
    revalidatePath("/worklist/welding");
    revalidatePath("/worklist/painting");
    return { ok: true, id: note.id };
  } catch (e) {
    return { ok: false, error: userMessage(e, "save the note") };
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
        // legacy local-disk photo; the hint keeps the bundler from tracing the
        // whole project into every function that imports these actions
        await rm(path.join(/*turbopackIgnore: true*/ process.cwd(), p));
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
