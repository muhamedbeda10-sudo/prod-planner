import "server-only";
import { prisma } from "@/lib/db";
import { makeBomGrouper, type BomGrouper } from "@/lib/domain/bom";
import type { PlanWindow } from "@/lib/domain/findPlan";
import { DEFAULTS } from "@/lib/domain/constants";
import { DEFAULT_SHIFT_HOURS, type ShiftHours } from "@/lib/domain/shifts";
import { loadPlans, loadSettingsRow } from "./loads";

export async function getSettings() {
  const s = await loadSettingsRow();
  return {
    leadCut: s?.leadCut ?? DEFAULTS.leadCut,
    leadWeld: s?.leadWeld ?? DEFAULTS.leadWeld,
    capacityPerItem: s?.capacityPerItem ?? DEFAULTS.capacityPerItem,
    dailyTarget: s?.dailyTarget ?? DEFAULTS.dailyTarget,
    tankTracking: s?.tankTracking ?? DEFAULTS.tankTracking,
    machinePlanning: s?.machinePlanning ?? DEFAULTS.machinePlanning,
    shiftShortH: s?.shiftShortH ?? DEFAULT_SHIFT_HOURS.short,
    shiftLongH: s?.shiftLongH ?? DEFAULT_SHIFT_HOURS.long,
    overtimeH: s?.overtimeH ?? DEFAULT_SHIFT_HOURS.overtime,
  };
}

/** What a shift and the "+OT" button are worth — every man-hour the app
 *  counts is measured with these. */
export async function getShiftHours(): Promise<ShiftHours> {
  const s = await getSettings();
  return { short: s.shiftShortH, long: s.shiftLongH, overtime: s.overtimeH };
}

/** The master switch on its own — the many places that only need to know
 *  whether tanks are tracked per piece. */
export async function isTankTrackingOn(): Promise<boolean> {
  return (await getSettings()).tankTracking;
}

/** Whether work is planned onto machines — the board, the Machine column
 *  and the Floor view show only while it is on. */
export async function isMachinePlanningOn(): Promise<boolean> {
  return (await getSettings()).machinePlanning;
}

export async function getPlanWindows(): Promise<PlanWindow[]> {
  const plans = await loadPlans();
  return plans.map((p) => ({ planNo: p.planNo, startDate: p.startDate }));
}

export async function getPlanNos(): Promise<number[]> {
  // planNo 0 is the synthetic "setup balances" bucket — never a pickable plan
  const plans = await prisma.plan.findMany({
    where: { planNo: { gt: 0 } },
    orderBy: { planNo: "desc" },
    select: { planNo: true },
  });
  return plans.map((p) => p.planNo);
}

export async function getLatestPlanNo(): Promise<number | null> {
  const p = await prisma.plan.findFirst({
    where: { planNo: { gt: 0 } },
    orderBy: { planNo: "desc" },
    select: { planNo: true },
  });
  return p?.planNo ?? null;
}

/** BomGroup function seeded from a plan's Plan Orders (first occurrence per key). */
export async function getGrouperForPlan(planNo: number): Promise<BomGrouper> {
  const boms = await prisma.planOrder.findMany({
    where: { planNo },
    orderBy: { id: "asc" },
    select: { bom: true },
  });
  return makeBomGrouper(boms.map((b) => b.bom));
}

/** BomGroup across ALL plans (order registry used by the legacy EnsureRepMap). */
export async function getGlobalGrouper(): Promise<BomGrouper> {
  const boms = await prisma.planOrder.findMany({ orderBy: { id: "asc" }, select: { bom: true } });
  return makeBomGrouper(boms.map((b) => b.bom));
}

export interface EffectiveLog {
  dept: string;
  bom: string;
  item: string;
  qty: number;
  date: Date;
}

/** The handover rows for a plan. (It once folded in synthetic rows for
 *  approved excess-reallocation moves; the BOM Review that proposed them was
 *  removed unused, so a plan's logs are simply its entries.) */
export async function getEffectiveLogs(planNo: number): Promise<EffectiveLog[]> {
  const entries = await prisma.handoverEntry.findMany({ where: { planNo } });
  return entries.map((e) => ({
    dept: e.dept,
    bom: e.bom,
    item: e.item,
    qty: e.qty,
    date: e.date,
  }));
}
