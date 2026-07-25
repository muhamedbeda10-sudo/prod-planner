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

  const [settings, schedules, entries, holidays] = await Promise.all([
    getSettings(),
    // every plan: supersession needs the older ones to know which are dead
    prisma.planSchedule.findMany({ select: { planNo: true, bom: true, mo: true, item: true, ovenDate: true, qty: true } }),
    prisma.handoverEntry.findMany({
      where: { date: { gte: dateFromDayNumber(fromD), lt: dateFromDayNumber(toD + 1) } },
      select: { date: true, dept: true, bom: true, mo: true, item: true, qty: true },
    }),
    prisma.holiday.findMany(),
  ]);

  return computePlanVsActual({
    schedules,
    entries,
    fromDay: fromD,
    toDay: toD,
    isoOf: (d) => toISODate(dateFromDayNumber(d)),
    holidays: new Map(holidays.map((h) => [dayNumber(h.date), h.name])),
    leadCut: settings.leadCut,
    leadWeld: settings.leadWeld,
    stages,
  });
}
