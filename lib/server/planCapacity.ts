import "server-only";
import { prisma } from "@/lib/db";
import { requiredHoursForLines, tierForOrder, itemHoursFor } from "@/lib/domain/stdEngine";
import { projectPace } from "@/lib/domain/eta";
import { workingDaysInclusive } from "@/lib/domain/insights";
import { getStdData, getStageCapacity } from "./standardTimes";
import { loadHolidays, loadMasterOrders } from "./loads";
import { factoryToday, toISODate } from "@/lib/domain/dates";
import { owedPlanQtys } from "@/lib/domain/planPromises";

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
  /** Mid-window only: what the week CLOSES at if the run-rate so far holds. */
  pace: {
    elapsedWd: number;
    projectedCoverage: number; // projected earned / required, whole plan
    worstStage: { dept: string; coverage: number } | null;
  } | null;
}

export async function getPlanCapacity(planNo: number | null): Promise<PlanCapacityCheck | null> {
  if (!planNo) return null;
  const [schedules, orders, std, capacity, holidays] = await Promise.all([
    prisma.planSchedule.findMany({
      where: { planNo },
      select: { mo: true, item: true, ovenDate: true, qty: true },
    }),
    loadMasterOrders(),
    getStdData(),
    getStageCapacity(),
    loadHolidays(),
  ]);
  if (schedules.length === 0) return null;

  const byMo = new Map(orders.map((o) => [o.mo, o]));

  // A plan that asks for the same pieces twice does not need twice the hours.
  // Walk each order+component's promises in date order and keep only what the
  // order can still owe — the repeats carry no work (see lib/domain/planPromises).
  const owedQty = owedPlanQtys(schedules, (mo) => byMo.get(mo));

  const { byStage, uncoveredPcs, totalPcs } = requiredHoursForLines(
    std,
    schedules
      .map((s, i) => ({ item: s.item, qty: owedQty[i], order: byMo.get(s.mo) ?? null }))
      .filter((l) => l.qty > 0)
  );

  // the plan's own span decides how much capacity it gets to spend
  let min = schedules[0].ovenDate;
  let max = schedules[0].ovenDate;
  for (const s of schedules) {
    if (s.ovenDate < min) min = s.ovenDate;
    if (s.ovenDate > max) max = s.ovenDate;
  }
  // the working days (Sat–Thu, the calendar's days off out) the plan's man-hours a day are scaled by — never zero
  const workingDays = Math.max(1, workingDaysInclusive(toISODate(min), toISODate(max), new Set(holidays.map((h) => toISODate(h.date)))));

  // ---- mid-window pace: at the run-rate so far, where does the week close? ----
  // "actual" = std hours EARNED on the plan's own orders since the window
  // opened; each stage projected on its own, the headline on the total.
  let pace: PlanCapacityCheck["pace"] = null;
  const today = factoryToday(); // the factory's day, not the UTC date
  if (today >= min && today <= max) {
    const off = new Set(holidays.map((h) => toISODate(h.date)));
    // elapsed FULL working days — today is still being worked, so it doesn't count
    let elapsedWd = 0;
    for (let d = new Date(min); d < today; d = new Date(d.getTime() + 86400000)) {
      if (d.getUTCDay() !== 5 && !off.has(toISODate(d))) elapsedWd++;
    }
    if (elapsedWd >= 1) {
      const planMos = [...new Set(schedules.map((sc) => sc.mo))];
      // the elapsed FULL days' output: today's rows would be divided over the
      // days before it and read as a faster pace than the plant has
      const done = await prisma.handoverEntry.findMany({
        where: { mo: { in: planMos }, date: { gte: min, lt: today } },
        select: { mo: true, dept: true, item: true, qty: true },
      });
      const moOrder = new Map(orders.map((o) => [o.mo, o]));
      const actualByStage: Record<string, number> = { Cut: 0, Welding: 0, ShotBlast: 0, Painting: 0 };
      for (const e of done) {
        const tier = tierForOrder(std, moOrder.get(e.mo!) ?? {});
        if (tier === null) continue;
        const per = itemHoursFor(std, tier)[e.item];
        if (!per) continue; // AR / MB
        // bucket the actual EXACTLY like "required" is bucketed: a painted
        // piece's shb pass belongs to the ShotBlast station even though the
        // ledger records it inside the Painting entry
        if (e.dept === "Cut") actualByStage.Cut += per.cut * e.qty;
        else if (e.dept === "Welding") actualByStage.Welding += per.weld * e.qty;
        else if (e.dept === "ShotBlast") actualByStage.ShotBlast += per.shb * e.qty;
        else if (e.dept === "Painting") {
          actualByStage.ShotBlast += per.shb * e.qty;
          actualByStage.Painting += per.paint * e.qty;
        }
      }
      const requiredTotal = byStage.Cut + byStage.Welding + byStage.ShotBlast + byStage.Painting;
      const actualTotal = Object.values(actualByStage).reduce((a, b) => a + b, 0);
      const overall = projectPace(requiredTotal, actualTotal, elapsedWd, workingDays);
      if (overall) {
        // worst stage by projected coverage (stages the plan actually needs)
        let worstStage: { dept: string; coverage: number } | null = null;
        for (const dept of ["Cut", "Welding", "ShotBlast", "Painting"] as const) {
          const req = byStage[dept];
          if (req <= 0) continue;
          const p = projectPace(req, actualByStage[dept], elapsedWd, workingDays);
          if (p && (!worstStage || p.coverage < worstStage.coverage)) worstStage = { dept, coverage: p.coverage };
        }
        pace = { elapsedWd, projectedCoverage: overall.coverage, worstStage };
      }
    }
  }

  return {
    planNo,
    workingDays,
    stages: (["Cut", "Welding", "ShotBlast", "Painting"] as const).map((dept) => {
      const perDay = capacity[dept];
      const available = perDay !== undefined ? perDay * workingDays : null;
      // a stage the admin set to 0 h/day has a figure — none at all — so
      // work owed there is an overload, not an unconfigured stage
      const load = available === null ? null : available > 0 ? byStage[dept] / available : byStage[dept] > 0 ? Infinity : 0;
      return {
        dept,
        required: byStage[dept],
        available,
        load,
      };
    }),
    uncoveredPcs,
    totalPcs,
    pace,
  };
}
