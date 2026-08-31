import "server-only";
import { prisma } from "@/lib/db";
import { requiredHoursForLines, tierForOrder, itemHoursFor } from "@/lib/domain/stdEngine";
import { projectPace } from "@/lib/domain/eta";
import { getStdData, getStageCapacity } from "./standardTimes";
import { countWorkingDays } from "./report";
import { toISODate } from "@/lib/domain/dates";
import { owedAcrossDays, promiseCeiling } from "@/lib/domain/planPromises";

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
    prisma.masterOrder.findMany({ select: { mo: true, fgCode: true, kva: true, planQty: true, excludedItems: true } }),
    getStdData(),
    getStageCapacity(),
    prisma.holiday.findMany(),
  ]);
  if (schedules.length === 0) return null;

  const byMo = new Map(orders.map((o) => [o.mo, o]));

  // A plan that asks for the same pieces twice does not need twice the hours.
  // Walk each order+component's promises in date order and keep only what the
  // order can still owe — the repeats carry no work (see lib/domain/planPromises).
  const owedQty = new Map<number, number>(); // index into `schedules` -> pcs really owed
  const byOrderItem = new Map<string, number[]>(); // "mo|item" -> indexes, date order
  const ordered = schedules.map((s, i) => i).sort((a, b) => +schedules[a].ovenDate - +schedules[b].ovenDate);
  for (const i of ordered) {
    const k = `${schedules[i].mo}|${schedules[i].item}`;
    if (!byOrderItem.has(k)) byOrderItem.set(k, []);
    byOrderItem.get(k)!.push(i);
  }
  for (const [k, idx] of byOrderItem) {
    const [mo, item] = k.split("|");
    const owed = owedAcrossDays(idx.map((i) => schedules[i].qty), promiseCeiling(byMo.get(mo), item));
    idx.forEach((i, n) => owedQty.set(i, owed[n]));
  }

  const { byStage, uncoveredPcs, totalPcs } = requiredHoursForLines(
    std,
    schedules
      .map((s, i) => ({ item: s.item, qty: owedQty.get(i) ?? s.qty, order: byMo.get(s.mo) ?? null }))
      .filter((l) => l.qty > 0)
  );

  // the plan's own span decides how much capacity it gets to spend
  let min = schedules[0].ovenDate;
  let max = schedules[0].ovenDate;
  for (const s of schedules) {
    if (s.ovenDate < min) min = s.ovenDate;
    if (s.ovenDate > max) max = s.ovenDate;
  }
  const workingDays = await countWorkingDays(min, max);

  // ---- mid-window pace: at the run-rate so far, where does the week close? ----
  // "actual" = std hours EARNED on the plan's own orders since the window
  // opened; each stage projected on its own, the headline on the total.
  let pace: PlanCapacityCheck["pace"] = null;
  const today = new Date(Math.floor(Date.now() / 86400000) * 86400000);
  if (today >= min && today <= max) {
    const off = new Set(holidays.map((h) => toISODate(h.date)));
    // elapsed FULL working days — today is still being worked, so it doesn't count
    let elapsedWd = 0;
    for (let d = new Date(min); d < today; d = new Date(d.getTime() + 86400000)) {
      if (d.getUTCDay() !== 5 && !off.has(toISODate(d))) elapsedWd++;
    }
    if (elapsedWd >= 1) {
      const planMos = [...new Set(schedules.map((sc) => sc.mo))];
      const done = await prisma.handoverEntry.findMany({
        where: { mo: { in: planMos }, date: { gte: min } },
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
      return {
        dept,
        required: byStage[dept],
        available,
        load: available ? byStage[dept] / available : null,
      };
    }),
    uncoveredPcs,
    totalPcs,
    pace,
  };
}
