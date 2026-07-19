import "server-only";
import { prisma } from "@/lib/db";
import { ITEMS, type Item } from "@/lib/domain/constants";
import { dayNumber, dateFromDayNumber, toISODate } from "@/lib/domain/dates";
import {
  sortInsights,
  forecastDept,
  trendInsight,
  bottleneckInsight,
  agingInsight,
  overdueInsight,
  atRiskInsight,
  setBalanceInsight,
  idleDeptInsight,
  type Insight,
} from "@/lib/domain/insights";
import { getSettings } from "./data";
import { getCutSheet, getWeldingQueue, getPaintingQueue } from "./execution";

export interface SmartInsightsData {
  todayISO: string;
  insights: Insight[];
  analyzedEntries: number; // handover rows fed into the engine
  analyzedLines: number; // queue lines assessed for risk/aging
}

const emptyItems = (): Record<Item, number> => ({ CF: 0, TC: 0, TN: 0, CB: 0 });
const isItem = (x: string): x is Item => (ITEMS as readonly string[]).includes(x);

// dayNumber 0 = 1970-01-01 (Thursday): 0=Thu, 1=Fri, 2=Sat, ...
const dowOf = (d: number) => ((d % 7) + 7) % 7;
const isFridayD = (d: number) => dowOf(d) === 1;
const weekStartOf = (d: number) => d - ((dowOf(d) - 2 + 7) % 7); // most recent Saturday

const DEPTS = [
  { key: "Cut", label: "Fabrication" },
  { key: "Welding", label: "Welding" },
  { key: "Painting", label: "Painting" },
] as const;

/** Gather everything the rule engine needs and generate the insight list.
 *  Entirely local computation — no external service, works offline. */
export async function getSmartInsights(): Promise<SmartInsightsData> {
  const today = new Date();
  const todayD = dayNumber(today);
  const todayISO = toISODate(dateFromDayNumber(todayD));
  const weekStart = weekStartOf(todayD);

  const [settings, holidayRows, entries, cutSheet, weldQueue, paintQueue] = await Promise.all([
    getSettings(),
    prisma.holiday.findMany(),
    prisma.handoverEntry.findMany({
      where: { date: { gte: dateFromDayNumber(weekStart - 21) } }, // week + 3 weeks back for trends
      select: { date: true, dept: true, item: true, qty: true },
    }),
    getCutSheet(),
    getWeldingQueue(today),
    getPaintingQueue(today),
  ]);

  const target = settings.dailyTarget || 27;
  const capacity = settings.capacityPerItem || 27;
  const holidayDays = new Set(holidayRows.map((h) => dayNumber(h.date)));
  const holidayISO = new Set(holidayRows.map((h) => toISODate(h.date)));
  const isWorking = (d: number) => !isFridayD(d) && !holidayDays.has(d);

  // ---- per-dept daily totals + this week's per-item cumulative ----
  const dayTotals = new Map<string, number>(); // dept|dayNumber -> pcs
  const weekItems: Record<string, Record<Item, number>> = { Cut: emptyItems(), Welding: emptyItems(), Painting: emptyItems() };
  for (const e of entries) {
    if (!isItem(e.item) || !(e.dept in weekItems)) continue;
    const d = dayNumber(e.date);
    const k = `${e.dept}|${d}`;
    dayTotals.set(k, (dayTotals.get(k) ?? 0) + e.qty);
    if (d >= weekStart && d <= todayD) weekItems[e.dept][e.item] += e.qty;
  }
  const totalOn = (dept: string, d: number) => dayTotals.get(`${dept}|${d}`) ?? 0;

  // working days in the current week / elapsed so far (incl. today)
  let workingDays = 0;
  let paceDays = 0;
  for (let d = weekStart; d <= weekStart + 5; d++) {
    if (!isWorking(d)) continue;
    workingDays++;
    if (d <= todayD) paceDays++;
  }

  // the last N elapsed working days (newest last), for momentum + idle checks
  const elapsedWorkingDays: number[] = [];
  for (let d = todayD; elapsedWorkingDays.length < 6 && d > todayD - 30; d--) {
    if (isWorking(d)) elapsedWorkingDays.unshift(d);
  }

  const insights: Insight[] = [];

  for (const { key, label } of DEPTS) {
    const items = weekItems[key];
    const weekTotal = ITEMS.reduce((s, it) => s + items[it], 0);

    insights.push(...compact(forecastDept({ dept: label, weekTotal, targetPerItem: target, workingDays, paceDays })));

    // momentum: last 3 elapsed working days (excluding today — it's incomplete)
    // vs the 3 before them
    const done = elapsedWorkingDays.filter((d) => d < todayD);
    const recent = done.slice(-3).map((d) => totalOn(key, d));
    const prev = done.slice(-6, -3).map((d) => totalOn(key, d));
    insights.push(...compact(trendInsight(label, recent, prev)));

    // idle: the most recent FULL working day logged nothing at all
    const lastFull = done[done.length - 1];
    if (lastFull !== undefined) {
      const label2 = lastFull === todayD - 1 ? "yesterday" : `on ${toISODate(dateFromDayNumber(lastFull))}`;
      insights.push(...compact(idleDeptInsight(label, label2, totalOn(key, lastFull))));
    }
  }

  // pipeline bottleneck
  const weldWaiting = weldQueue.reduce((s, r) => s + r.available, 0);
  const paintWaiting = paintQueue.reduce((s, r) => s + r.available, 0);
  insights.push(...compact(bottleneckInsight({ weldWaiting, paintWaiting, targetPerDeptDay: target * ITEMS.length })));

  // overdue cut commitments
  const overdueQty = cutSheet.overdue.reduce((s, r) => s + r.remaining, 0);
  const oldestISO = cutSheet.overdue.reduce<string | null>(
    (m, r) => (m === null || r.deliveryISO < m ? r.deliveryISO : m),
    null
  );
  insights.push(...compact(overdueInsight({ lines: cutSheet.overdue.length, qty: overdueQty, oldestISO })));

  // early warning: deliveries that will slip unless output rises today
  insights.push(...compact(atRiskInsight("Welding", "/worklist/welding", weldQueue, todayISO, capacity, holidayISO)));
  insights.push(...compact(atRiskInsight("Painting", "/worklist/painting", paintQueue, todayISO, capacity, holidayISO)));

  // stuck WIP
  insights.push(...compact(agingInsight("Welding", "/worklist/welding", weldQueue)));
  insights.push(...compact(agingInsight("Painting", "/worklist/painting", paintQueue)));

  // component starving complete sets (painting = finished transformers)
  insights.push(...compact(setBalanceInsight("Painting", weekItems.Painting)));

  return {
    todayISO,
    insights: sortInsights(insights),
    analyzedEntries: entries.length,
    analyzedLines: weldQueue.length + paintQueue.length + cutSheet.overdue.length + cutSheet.cascade.length,
  };
}

const compact = (i: Insight | null): Insight[] => (i ? [i] : []);
