import "server-only";
import { prisma } from "@/lib/db";
import { getSettings } from "./data";
import { dayNumber, dateFromDayNumber, toISODate } from "@/lib/domain/dates";
import { computePlanVsActual, PVA_STAGES, type PlanVsActual } from "@/lib/domain/planVsActual";

/** Plan vs actual over an inclusive day range, optionally scoped to a subset of
 *  stages (the report's Dept filter). Loads the rows; the maths lives in the
 *  pure domain function so it can be tested. */
export async function getPlanVsActual(
  from: Date,
  to: Date,
  stages: readonly string[] = PVA_STAGES
): Promise<PlanVsActual> {
  const fromD = dayNumber(from);
  const toD = dayNumber(to);
  const periodEnd = dateFromDayNumber(toD + 1); // exclusive

  const [settings, schedules, entries, cumulative, holidays] = await Promise.all([
    getSettings(),
    // every plan: supersession needs the older ones to know which are dead
    prisma.planSchedule.findMany({ select: { planNo: true, bom: true, mo: true, item: true, ovenDate: true, qty: true } }),
    // inside the period — what was actually recorded on each day
    prisma.handoverEntry.findMany({
      where: { date: { gte: dateFromDayNumber(fromD), lt: periodEnd } },
      select: { date: true, dept: true, bom: true, item: true, qty: true },
    }),
    // ALL-TIME up to the period end — the credit that fills the promises
    prisma.handoverEntry.groupBy({
      by: ["bom", "item", "dept"],
      where: { date: { lt: periodEnd } },
      _sum: { qty: true },
    }),
    prisma.holiday.findMany(),
  ]);

  return computePlanVsActual({
    schedules,
    entries,
    cumulative: cumulative.map((c) => ({ bom: c.bom, item: c.item, dept: c.dept, qty: c._sum.qty ?? 0 })),
    fromDay: fromD,
    toDay: toD,
    isoOf: (d) => toISODate(dateFromDayNumber(d)),
    holidays: new Map(holidays.map((h) => [dayNumber(h.date), h.name])),
    leadCut: settings.leadCut,
    leadWeld: settings.leadWeld,
    stages,
  });
}
