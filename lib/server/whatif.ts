import "server-only";
import { prisma } from "@/lib/db";
import { toISODate } from "@/lib/domain/dates";
import { requiredHoursForLines } from "@/lib/domain/stdEngine";
import { etaQueueOrder } from "@/lib/domain/eta";
import type { WhatIfInputs, WhatIfJob } from "@/lib/domain/whatif";
import { getStdData, getStageCapacity } from "./standardTimes";
import { getEtaBase } from "./eta";

/** One snapshot of reality for the simulator: the open orders with their
 *  baseline forecast, the current weekly plan's requirements, and the
 *  capacity figures — the browser turns the knobs from there. */
export async function getWhatIfInputs(): Promise<WhatIfInputs> {
  const [base, capacity, std, latest] = await Promise.all([
    getEtaBase(),
    getStageCapacity(),
    getStdData(),
    prisma.planSchedule.aggregate({ _max: { planNo: true } }),
  ]);

  // the latest weekly plan's window and required hours (same pricing as the
  // capacity check card)
  const planNo = latest._max.planNo;
  let plan: WhatIfInputs["plan"] = null;
  if (planNo) {
    const [schedules, orders] = await Promise.all([
      prisma.planSchedule.findMany({ where: { planNo }, select: { mo: true, item: true, ovenDate: true, qty: true } }),
      prisma.masterOrder.findMany({ select: { mo: true, fgCode: true, kva: true } }),
    ]);
    if (schedules.length > 0) {
      const byMo = new Map(orders.map((o) => [o.mo, o]));
      const { byStage } = requiredHoursForLines(
        std,
        schedules.map((s) => ({ item: s.item, qty: s.qty, order: byMo.get(s.mo) ?? null }))
      );
      let min = schedules[0].ovenDate;
      let max = schedules[0].ovenDate;
      for (const s of schedules) {
        if (s.ovenDate < min) min = s.ovenDate;
        if (s.ovenDate > max) max = s.ovenDate;
      }
      plan = { planNo, minISO: toISODate(min), maxISO: toISODate(max), requiredByStage: byStage };
    }
  }

  // jobs in baseline queue order (FIFO by due) so the on-screen list IS the
  // queue the user then rearranges
  const resultById = new Map(base.results.map((r) => [r.id, r]));
  const jobs: WhatIfJob[] = [...base.jobs].sort(etaQueueOrder).map((j) => {
    const r = resultById.get(j.id)!;
    return {
      id: j.id,
      mo: j.mo,
      bom: j.bom,
      item: j.item,
      dueISO: j.dueISO,
      left: j.left,
      perPc: j.perPc,
      baselineDays: r.days,
      blockedBy: r.blockedBy,
    };
  });

  return {
    todayISO: base.todayISO,
    holidayISOs: base.holidayISOs,
    rates: base.rates,
    rateSigma: base.sigma,
    rateWindowDays: base.windowDays,
    capacity,
    jobs,
    plan,
  };
}
