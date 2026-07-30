import "server-only";
import { prisma } from "@/lib/db";
import { requiredHoursForLines } from "@/lib/domain/stdEngine";
import { getStdData, getStageCapacity } from "./standardTimes";
import { countWorkingDays } from "./report";

/** The capacity check for ONE weekly plan: the standard hours the plan's
 *  promises require per stage, against the stage's available man-hours over
 *  the plan's own working days (Admin → Standard Times sets both sides). */
export interface PlanCapacityCheck {
  planNo: number;
  workingDays: number; // Sat–Thu minus factory holidays, across the plan's date span
  stages: {
    dept: "Cut" | "Welding" | "ShotBlast" | "Painting";
    required: number; // std man-hours the plan needs
    available: number | null; // capacity over the window; null = no figure set
    load: number | null; // required / available
  }[];
  uncoveredPcs: number; // pcs whose order resolves to no KVA class (hours undercounted)
  totalPcs: number;
}

export async function getPlanCapacity(planNo: number | null): Promise<PlanCapacityCheck | null> {
  if (!planNo) return null;
  const [schedules, orders, std, capacity] = await Promise.all([
    prisma.planSchedule.findMany({
      where: { planNo },
      select: { mo: true, item: true, ovenDate: true, qty: true },
    }),
    prisma.masterOrder.findMany({ select: { mo: true, fgCode: true, kva: true } }),
    getStdData(),
    getStageCapacity(),
  ]);
  if (schedules.length === 0) return null;

  const byMo = new Map(orders.map((o) => [o.mo, o]));
  const { byStage, uncoveredPcs, totalPcs } = requiredHoursForLines(
    std,
    schedules.map((s) => ({ item: s.item, qty: s.qty, order: byMo.get(s.mo) ?? null }))
  );

  // the plan's own span decides how much capacity it gets to spend
  let min = schedules[0].ovenDate;
  let max = schedules[0].ovenDate;
  for (const s of schedules) {
    if (s.ovenDate < min) min = s.ovenDate;
    if (s.ovenDate > max) max = s.ovenDate;
  }
  const workingDays = await countWorkingDays(min, max);

  return {
    planNo,
    workingDays,
    stages: (["Cut", "Welding", "ShotBlast", "Painting"] as const).map((dept) => {
      const perDay = capacity[dept];
      const available = perDay !== undefined ? perDay * workingDays : null;
      return {
        dept,
        required: byStage[dept],
        available,
        load: available ? byStage[dept] / available : null,
      };
    }),
    uncoveredPcs,
    totalPcs,
  };
}
