import "server-only";
import { prisma } from "@/lib/db";
import { makeBomGrouper, type BomGrouper } from "@/lib/domain/bom";
import type { PlanWindow } from "@/lib/domain/findPlan";
import { DEFAULTS } from "@/lib/domain/constants";

export async function getSettings() {
  const s = await prisma.settings.findUnique({ where: { id: 1 } });
  return {
    leadCut: s?.leadCut ?? DEFAULTS.leadCut,
    leadWeld: s?.leadWeld ?? DEFAULTS.leadWeld,
    capacityPerItem: s?.capacityPerItem ?? DEFAULTS.capacityPerItem,
    dailyTarget: s?.dailyTarget ?? DEFAULTS.dailyTarget,
  };
}

export async function getPlanWindows(): Promise<PlanWindow[]> {
  const plans = await prisma.plan.findMany({ orderBy: { planNo: "asc" } });
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

/**
 * Handover rows for a plan, plus synthetic adjustment rows for APPROVED
 * reallocation moves (donor -qty, receiver +qty). Raw entries stay immutable.
 */
export async function getEffectiveLogs(planNo: number): Promise<EffectiveLog[]> {
  const [entries, moves] = await Promise.all([
    prisma.handoverEntry.findMany({ where: { planNo } }),
    prisma.reallocationMove.findMany({ where: { planNo, status: "approved" } }),
  ]);
  const logs: EffectiveLog[] = entries.map((e) => ({
    dept: e.dept,
    bom: e.bom,
    item: e.item,
    qty: e.qty,
    date: e.date,
  }));
  for (const m of moves) {
    logs.push({ dept: m.dept, bom: m.fromBom, item: m.item, qty: -m.qty, date: m.date });
    logs.push({ dept: m.dept, bom: m.toBom, item: m.item, qty: m.qty, date: m.date });
  }
  return logs;
}
