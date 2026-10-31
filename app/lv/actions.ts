"use server";

import { emitEvent } from "@/lib/server/events";
import { outputSentence } from "@/lib/domain/appEvents";
import { prisma } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { requirePerm } from "@/lib/server/auth";
import { factoryDayISO, parseISODate } from "@/lib/domain/dates";
import { findPlanForDate } from "@/lib/domain/findPlan";
import { getPlanWindows, getSettings } from "@/lib/server/data";
import { spreadOverGroup } from "@/lib/domain/groupSpread";
import { mirrorLedgerToOdoo } from "@/lib/server/odooMirror";
import { writeCorrection } from "@/lib/server/corrections";
import { readBase, shownStageTotal, staleTotalError } from "@/lib/domain/trackerEdit";
import { LV_ITEM, LV_STAGES, isLvChainStage, lvChainError, lvDeptPermKey, lvGroupMembers, lvPermKey, lvStageOf, type LvChainStage, type LvStage, type LvState } from "@/lib/domain/lv";
import { UserError, userMessage } from "@/lib/server/errors";
import { lockLvOrder } from "@/lib/server/outputGuard";

// Recording an LV panel's stages from its tracker. The same shape as the
// transformer tracker's cells: type the NEW total, the difference lands in
// today's daily log under the stage's name and the panel's item code, a
// lower total is a negative correction, and the chain guard refuses what
// the stages before or after would contradict. The guard reads and judges
// inside the transaction that writes, behind a lock on the order, so two
// records on one MO at once cannot both pass against the same totals.

const PATHS = ["/tracker", "/handover", "/", "/worklist/punching", "/worklist/bending", "/worklist/welding", "/worklist/painting", "/odoo"];

interface Result { ok: boolean; error?: string }

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** A refusal judged inside the transaction — the sentence the person sees.
 *  Thrown to roll the transaction back, caught to hand the sentence out. */
class LvRefused extends UserError {}

/** One panel order's chain position, from the ledger — all-time totals, read
 *  through the transaction that holds the order's lock. */
async function stateOf(tx: Tx, mo: string): Promise<{ state: LvState; bom: string } | null> {
  const [order, sums] = await Promise.all([
    tx.masterOrder.findUnique({ where: { mo }, select: { bom: true, planQty: true, line: true } }),
    tx.handoverEntry.groupBy({ by: ["dept"], where: { mo, item: LV_ITEM }, _sum: { qty: true } }),
  ]);
  if (!order || order.line !== "LV") return null;
  const g = (d: string) => sums.find((s) => s.dept === d)?._sum.qty ?? 0;
  return {
    bom: order.bom,
    state: { required: order.planQty, punch: g("Punching"), bend: g("Bending"), weld: g("Welding"), paint: g("Painting"), delivered: g("Delivered") },
  };
}

/** Today's plan bucket, the way every tracker record is filed. */
async function todaysPlan(): Promise<{ today: Date; planNo: number }> {
  const today = parseISODate(factoryDayISO(new Date()))!;
  const [windows, settings] = await Promise.all([getPlanWindows(), getSettings()]);
  const planNo = findPlanForDate(windows, today, settings.leadCut) ?? (windows.length ? Math.max(...windows.map((w) => w.planNo)) : 0);
  await prisma.plan.upsert({ where: { planNo }, create: { planNo, startDate: today }, update: {} });
  return { today, planNo };
}

/** A stage's change on one order: output today, or — a total lowered — a
 *  correction dated on the days of the work it takes back (writeCorrection).
 *  The row written for output, for its ODOO closing; null for a correction. */
async function writeDelta(tx: Tx, a: { mo: string; bom: string; stage: LvChainStage; delta: number; from: number; today: Date; planNo: number; by: string | null }) {
  if (a.delta < 0) {
    await writeCorrection(tx, {
      dept: a.stage, bom: a.bom, mo: a.mo, item: LV_ITEM, take: -a.delta, today: a.today, fallbackPlan: a.planNo, source: "tracker",
      note: `tracker correction: total ${a.from} → ${a.from + a.delta}`, by: a.by,
    });
    return null;
  }
  return tx.handoverEntry.create({
    data: { date: a.today, dept: a.stage, bom: a.bom, mo: a.mo, item: LV_ITEM, qty: a.delta, planNo: a.planNo, source: "tracker", note: null, createdBy: a.by },
  });
}

/** One panel order, one stage: the new cumulative total. */
export async function recordLvTotal(formData: FormData): Promise<Result> {
  try {
    const stage = String(formData.get("stage") ?? "");
    const mo = String(formData.get("mo") ?? "").trim();
    const newTotal = Number(formData.get("total"));
    if (!isLvChainStage(stage)) return { ok: false, error: "Invalid stage." };
    const guard = await requirePerm(lvPermKey(stage));
    if (guard.error) return { ok: false, error: guard.error };
    if (!mo) return { ok: false, error: "Missing MO." };
    if (!Number.isInteger(newTotal) || newTotal < 0) return { ok: false, error: "Enter a whole number ≥ 0." };

    const { today, planNo } = await todaysPlan();
    await prisma.$transaction(async (tx) => {
      await lockLvOrder(tx, mo);
      const cur = await stateOf(tx, mo);
      if (!cur) throw new LvRefused(`${mo} is not an LV panel order — refresh the page.`);
      const from = lvStageOf(cur.state, stage);
      const stale = staleTotalError(readBase(formData.get("base")), shownStageTotal(from, cur.state.required));
      if (stale) throw new LvRefused(stale);
      const delta = newTotal - from;
      if (delta === 0) throw new LvRefused(`Nothing changed — the total is already ${from}.`);
      const chain = lvChainError(cur.state, stage, delta, mo);
      if (chain) throw new LvRefused(chain);

      const ledger = await writeDelta(tx, { mo, bom: cur.bom, stage, delta, from, today, planNo, by: guard.user?.name ?? null });
      if (ledger) await mirrorLedgerToOdoo(tx, ledger, guard.user?.name ?? null);
    });
    for (const p of PATHS) revalidatePath(p);
    return { ok: true };
  } catch (e) {
    if (e instanceof LvRefused) return { ok: false, error: e.message };
    return { ok: false, error: userMessage(e, "save the total") };
  }
}

/** A merged BOM row: the new group total, spread over its MOs in the order
 *  shown — each filled to its own room before the next, a reduction off the
 *  last first — and refused whole when it does not fit. */
export async function recordLvGroupTotal(formData: FormData): Promise<Result> {
  try {
    const stage = String(formData.get("stage") ?? "");
    const bom = String(formData.get("bom") ?? "").trim();
    const mos = [...new Set(String(formData.get("mos") ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
    const newTotal = Number(formData.get("total"));
    if (!isLvChainStage(stage)) return { ok: false, error: "Invalid stage." };
    const guard = await requirePerm(lvPermKey(stage));
    if (guard.error) return { ok: false, error: guard.error };
    if (!bom || mos.length === 0) return { ok: false, error: "The group has no MOs to distribute over." };
    if (!Number.isInteger(newTotal) || newTotal < 0) return { ok: false, error: "Enter a whole number ≥ 0." };

    const { today, planNo } = await todaysPlan();
    await prisma.$transaction(async (tx) => {
      // every MO's lock, always in the same order — two groups that share MOs
      // then queue behind each other instead of deadlocking
      for (const mo of [...mos].sort()) await lockLvOrder(tx, mo);
      const states: { mo: string; cur: Awaited<ReturnType<typeof stateOf>> }[] = [];
      for (const mo of mos) states.push({ mo, cur: await stateOf(tx, mo) });
      if (states.some((s) => !s.cur || s.cur.bom !== bom)) throw new LvRefused("An MO in the group is no longer on this BOM — refresh the page.");
      const rows = states.map((s) => ({ mo: s.mo, state: s.cur!.state }));
      const current = rows.reduce((sum, r) => sum + lvStageOf(r.state, stage), 0);
      const shown = rows.reduce((sum, r) => sum + shownStageTotal(lvStageOf(r.state, stage), r.state.required), 0);
      const stale = staleTotalError(readBase(formData.get("base")), shown);
      if (stale) throw new LvRefused(stale);
      const delta = newTotal - current;
      if (delta === 0) throw new LvRefused(`Nothing changed — the group total is already ${current}.`);

      const spread = spreadOverGroup(lvGroupMembers(rows, stage), delta);
      if (spread.left > 0) {
        throw new LvRefused(delta > 0
          ? `Only ${current + spread.fits} fit — the ${rows.length} MOs have no more room at ${stage.toLowerCase()} (the stage before it, or the order quantity, is the limit).`
          : `Only ${current - spread.fits} can be taken back — the rest already went on to the next stage.`);
      }

      for (const a of spread.alloc) {
        const r = rows.find((x) => x.mo === a.mo)!;
        const ledger = await writeDelta(tx, { mo: a.mo, bom, stage, delta: a.qty, from: lvStageOf(r.state, stage), today, planNo, by: guard.user?.name ?? null });
        if (ledger) await mirrorLedgerToOdoo(tx, ledger, guard.user?.name ?? null);
      }
    }, { timeout: 30_000 }); // a merged row locks and reads every member first
    for (const p of PATHS) revalidatePath(p);
    return { ok: true };
  } catch (e) {
    if (e instanceof LvRefused) return { ok: false, error: e.message };
    return { ok: false, error: userMessage(e, "save the total") };
  }
}

/** From a stage's worklist: panels done on one order on a day — a quantity,
 *  not a total. The department's own permission records it, and the chain
 *  guard refuses more than the stage before has finished. */
export async function recordLvOutput(formData: FormData): Promise<Result> {
  try {
    const stage = String(formData.get("stage") ?? "");
    const mo = String(formData.get("mo") ?? "").trim();
    const qty = Number(formData.get("qty"));
    const date = parseISODate(String(formData.get("date") ?? ""));
    if (!(LV_STAGES as readonly string[]).includes(stage)) return { ok: false, error: "Invalid stage." };
    const guard = await requirePerm(lvDeptPermKey(stage as LvStage));
    if (guard.error) return { ok: false, error: guard.error };
    if (!mo) return { ok: false, error: "Missing MO." };
    if (!date) return { ok: false, error: "Invalid date." };
    if (!Number.isInteger(qty) || qty <= 0) return { ok: false, error: "Enter a whole number of panels greater than zero." };

    const { planNo } = await todaysPlan();
    await prisma.$transaction(async (tx) => {
      await lockLvOrder(tx, mo);
      const cur = await stateOf(tx, mo);
      if (!cur) throw new LvRefused(`${mo} is not an LV panel order — refresh the page.`);
      const chain = lvChainError(cur.state, stage as LvStage, qty, mo);
      if (chain) throw new LvRefused(chain);

      const ledger = await tx.handoverEntry.create({
        data: { date, dept: stage, bom: cur.bom, mo, item: LV_ITEM, qty, planNo, source: "worklist", createdBy: guard.user?.name ?? null },
      });
      // a panel's painting is its closing — it gets its row on the ODOO log
      await mirrorLedgerToOdoo(tx, ledger, guard.user?.name ?? null);
    });
    for (const p of PATHS) revalidatePath(p);
    await emitEvent({ type: "output.recorded", subject: mo, summary: outputSentence({ qty, item: "panels", on: mo, stage }), data: { dept: stage, mo, item: LV_ITEM, qty } });
    return { ok: true };
  } catch (e) {
    if (e instanceof LvRefused) return { ok: false, error: e.message };
    return { ok: false, error: userMessage(e, "save the output") };
  }
}
