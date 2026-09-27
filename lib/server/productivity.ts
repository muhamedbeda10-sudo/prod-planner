import "server-only";
import { prisma } from "@/lib/db";
import { toISODate } from "@/lib/domain/dates";
import { LV_ITEM } from "@/lib/domain/lv";
import { isShiftDept, type RosterDept } from "@/lib/domain/shifts";
import { OUTPUT_SOURCE, productivityOf, type ProdDay, type ProdStat } from "@/lib/domain/productivity";
import { earnedOnDays } from "./calibration";
import { getStdData } from "./standardTimes";
import { loadMasterOrdersOf } from "./loads";

// The shift log's rates: each department's recorded man-hours against the
// pieces the daily log has it making on the same days, on the day on screen
// and over the last recorded days.

export const PRODUCTIVITY_WINDOW = 7; // recorded days the steadier figure covers

export interface DeptProductivity {
  dept: RosterDept;
  day: ProdStat | null; // the day on screen; null when it was not recorded
  window: ProdStat;
}

export interface ShiftProductivity {
  rows: DeptProductivity[];
  /** The recorded days the window covers, oldest first. */
  windowDates: string[];
}

export async function getShiftProductivity(dayISO: string, depts: readonly RosterDept[]): Promise<ShiftProductivity> {
  const end = new Date(`${dayISO}T00:00:00.000Z`);
  const hoursRows = await prisma.deptDayHours.findMany({
    where: { dept: { in: [...depts] }, date: { lte: end } },
    orderBy: { date: "desc" },
    // enough to find the last few recorded days of every department asked for
    take: PRODUCTIVITY_WINDOW * depts.length * 3,
  });
  const dates = [...new Set(hoursRows.map((h) => toISODate(h.date)))].sort().slice(-PRODUCTIVITY_WINDOW);
  if (dates.length === 0) return { rows: depts.map((dept) => ({ dept, day: null, window: productivityOf([]) })), windowDates: [] };
  const inWindow = new Set(dates);

  const dayStart = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const [ledger, std, orders] = await Promise.all([
    prisma.handoverEntry.groupBy({
      by: ["date", "dept", "item"],
      where: { OR: dates.map((iso) => ({ date: { gte: dayStart(iso), lt: new Date(dayStart(iso).getTime() + 86400000) } })) },
      _sum: { qty: true },
    }),
    getStdData(),
    loadMasterOrdersOf("TR"),
  ]);
  const earned = depts.some(isShiftDept) ? await earnedOnDays(dates, std, orders) : new Map();

  // pieces per day and roster department
  const pieces = new Map<string, number>(); // iso|dept → pcs
  for (const g of ledger) {
    const iso = toISODate(g.date);
    const lv = g.item === LV_ITEM;
    for (const d of depts) {
      const src = OUTPUT_SOURCE[d];
      if ((src.line === "LV") !== lv || !src.depts.includes(g.dept)) continue;
      const k = `${iso}|${d}`;
      pieces.set(k, (pieces.get(k) ?? 0) + (g._sum.qty ?? 0));
    }
  }

  const rows = depts.map((dept) => {
    const days: ProdDay[] = hoursRows
      .filter((h) => h.dept === dept && inWindow.has(toISODate(h.date)))
      .map((h) => {
        const iso = toISODate(h.date);
        return {
          dateISO: iso,
          hours: h.hours,
          people: h.people ?? 0,
          pieces: pieces.get(`${iso}|${dept}`) ?? 0,
          earned: isShiftDept(dept) ? (earned.get(iso)?.[dept] ?? 0) : null,
        };
      });
    const today = days.filter((d) => d.dateISO === dayISO);
    return { dept, day: today.length ? productivityOf(today) : null, window: productivityOf(days) };
  });
  return { rows, windowDates: dates };
}
