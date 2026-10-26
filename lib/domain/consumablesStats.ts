// The CONSUMABLES dashboard's numbers, from the hand-outs of a period. Pure,
// tested; the reads are lib/server/consumables.ts (getConsumablesDashboard).
//
// Items are free text, so the same thing typed twice in different case or
// spacing is one item here, named the way it was typed most often. Quantities
// are only ever added up within one item — the store hands out kilos of wire
// and pairs of gloves, and a grand total across items would mean nothing.

import { addDaysISO } from "./dateSlicer";
import { round3 } from "./consumableLimits";

export interface StatsRow {
  item: string;
  qty: number;
  department: string;
  departmentLabel: string;
  workerId: number;
  workerName: string;
  empId: string;
  dayISO: string; // factory day
  hour: number; // factory hour 0..23
}

export interface ItemStat { item: string; issues: number; qty: number; workers: number }
export interface DeptStat {
  department: string; label: string; issues: number; items: number; workers: number;
  /** The department's workers on the workers list (0 when it has none, or unknown). */
  people: number;
  /** Hand-outs per worker in the period; null when the department has no one on the list. */
  perPerson: number | null;
}
export interface WorkerStat { workerId: number; name: string; empId: string; issues: number; items: number; departments: string }
export interface TimeBucket { key: string; label: string; issues: number }

export interface ConsumablesStats {
  fromISO: string;
  toISO: string;
  totals: { issues: number; items: number; workers: number; departments: number };
  /** Hand-outs in the period of the same length just before — for the
   *  change; null when the log does not go back over all of it. */
  previousIssues: number | null;
  /** One bucket per day of the period, or per hour when it is a single day. */
  timeline: { unit: "day" | "hour"; buckets: TimeBucket[] };
  items: ItemStat[];
  departments: DeptStat[];
  workers: WorkerStat[];
  /** Where each item goes: the top items × the top departments (the rest in
   *  one "Other" column), by quantity. */
  matrix: { items: string[]; departments: { department: string; label: string }[]; qty: number[][] };

  // ---- the richer dashboard ----
  /** One point per day of the period (always days, even for a single day) —
   *  the sparklines, and the trend with its 7-day moving average. */
  daily: DailyPoint[];
  /** Headline figures beyond the four counts. */
  kpis: ConsumablesKpis;
  /** Hand-outs by factory weekday (0 = Sunday … 6 = Saturday) × hour: when
   *  the store is busy. `hours` is the span shown (the working day at least). */
  weekHour: { hours: number[]; counts: number[][] };
  /** Part-to-whole by department: the top five and the rest folded into
   *  "Other", so the donut never needs a seventh colour. */
  departmentShare: ShareSlice[];
  /** The same departments over time — per day, or per week for a long period. */
  departmentTrend: { unit: "day" | "week"; series: { key: string; label: string }[]; buckets: StackBucket[] };
  /** Items in the 80/20 sense: share of hand-outs and the running total, the
   *  heaviest first. `vitalFew` = how many items make up 80%. */
  pareto: { rows: ParetoRow[]; vitalFew: number };
  /** Every item with the department that takes it most — the treemap's tiles. */
  itemTiles: ItemTile[];
  /** Every worker served: how often and how varied — the scatter. */
  workerPoints: WorkerPoint[];
}

export interface DailyPoint { dayISO: string; label: string; issues: number; avg7: number | null }
export interface ConsumablesKpis {
  /** Days of the period with at least one hand-out. */
  activeDays: number;
  /** Hand-outs per active day. */
  perActiveDay: number;
  /** Hand-outs per worker served. */
  perWorker: number;
  /** The top department's share of hand-outs, 0..1. */
  topDepartmentShare: number;
  /** Items that make up 80% of hand-outs. */
  vitalFew: number;
  /** The weekday × hour with the most hand-outs (null when none). */
  busiestSlot: { weekday: number; hour: number; issues: number } | null;
}
export interface ShareSlice { key: string; label: string; issues: number; share: number }
export interface StackBucket { key: string; label: string; total: number; values: Record<string, number> }
export interface ParetoRow { item: string; issues: number; share: number; cumulative: number }
export interface ItemTile { item: string; issues: number; qty: number; department: string; departmentLabel: string }
export interface WorkerPoint { workerId: number; name: string; empId: string; issues: number; items: number; departments: number }

/** Departments shown by name in the share and the trend; the rest are "Other". */
export const SHARE_SLOTS = 5;
export const OTHER_KEY = "__other__";
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const fold = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayLabel(iso: string, long: boolean): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return long ? `${DOW[dt.getUTCDay()]} ${d} ${MON[m - 1]}` : `${d} ${MON[m - 1]}`;
}

/** Number of days from..to, both included. */
export function spanDays(fromISO: string, toISO: string): number {
  let n = 1;
  for (let d = fromISO; d < toISO && n < 4000; d = addDaysISO(d, 1)) n += 1;
  return n;
}

/** The period of the same length that ends the day before `fromISO`. */
export function previousPeriod(fromISO: string, toISO: string): { fromISO: string; toISO: string } {
  const n = spanDays(fromISO, toISO);
  return { fromISO: addDaysISO(fromISO, -n), toISO: addDaysISO(fromISO, -1) };
}

/** Percentage change, or null when there is nothing to compare with. */
export function pctChange(now: number, before: number): number | null {
  if (before <= 0) return null;
  return Math.round(((now - before) / before) * 100);
}

/** The commonest way a name was written — the first, alphabetically, on a tie. */
export function commonestSpelling(names: Iterable<string>): string {
  const n = new Map<string, number>();
  for (const x of names) n.set(x.trim(), (n.get(x.trim()) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
}

/** The hours a single day's chart spans: the working day (07–17) at least,
 *  widened to any hour something happened in. */
export function hourSpan(used: readonly number[]): { first: number; last: number } {
  return { first: Math.min(7, ...used), last: Math.max(17, ...used) };
}
export const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

export function consumablesStats(
  rows: readonly StatsRow[],
  fromISO: string,
  toISO: string,
  previousIssues: number | null,
  opts: { topItems?: number; topDepartments?: number; topWorkers?: number; headcount?: ReadonlyMap<string, number> } = {},
): ConsumablesStats {
  const topItems = opts.topItems ?? 12;
  const topDepts = opts.topDepartments ?? 6;
  const topWorkers = opts.topWorkers ?? 10;

  // ---- items: grouped by the folded name, shown in the commonest spelling
  const spellings = new Map<string, string[]>();
  const itemAgg = new Map<string, { issues: number; qty: number; workers: Set<number> }>();
  for (const r of rows) {
    const k = fold(r.item);
    const sp = spellings.get(k);
    if (sp) sp.push(r.item);
    else spellings.set(k, [r.item]);
    const a = itemAgg.get(k) ?? { issues: 0, qty: 0, workers: new Set<number>() };
    a.issues += 1;
    a.qty += r.qty;
    a.workers.add(r.workerId);
    itemAgg.set(k, a);
  }
  const nameOf = (k: string) => commonestSpelling(spellings.get(k) ?? []) || k;
  const items: ItemStat[] = [...itemAgg.entries()]
    .map(([k, a]) => ({ item: nameOf(k), issues: a.issues, qty: round3(a.qty), workers: a.workers.size }))
    .sort((a, b) => b.issues - a.issues || b.qty - a.qty || a.item.localeCompare(b.item));

  // ---- departments
  const deptAgg = new Map<string, { label: string; issues: number; items: Set<string>; workers: Set<number> }>();
  for (const r of rows) {
    const a = deptAgg.get(r.department) ?? { label: r.departmentLabel, issues: 0, items: new Set<string>(), workers: new Set<number>() };
    a.issues += 1;
    a.items.add(fold(r.item));
    a.workers.add(r.workerId);
    deptAgg.set(r.department, a);
  }
  const departments: DeptStat[] = [...deptAgg.entries()]
    .map(([department, a]) => {
      const people = opts.headcount?.get(department) ?? 0;
      return { department, label: a.label, issues: a.issues, items: a.items.size, workers: a.workers.size, people, perPerson: people > 0 ? round3(a.issues / people) : null };
    })
    .sort((a, b) => b.issues - a.issues || a.label.localeCompare(b.label));

  // ---- workers
  const workerAgg = new Map<number, { name: string; empId: string; issues: number; items: Set<string>; depts: Set<string> }>();
  for (const r of rows) {
    const a = workerAgg.get(r.workerId) ?? { name: r.workerName, empId: r.empId, issues: 0, items: new Set<string>(), depts: new Set<string>() };
    a.issues += 1;
    a.items.add(fold(r.item));
    a.depts.add(r.departmentLabel);
    workerAgg.set(r.workerId, a);
  }
  const workers: WorkerStat[] = [...workerAgg.entries()]
    .map(([workerId, a]) => ({ workerId, name: a.name, empId: a.empId, issues: a.issues, items: a.items.size, departments: [...a.depts].sort().join(", ") }))
    .sort((a, b) => b.issues - a.issues || b.items - a.items || a.name.localeCompare(b.name))
    .slice(0, topWorkers);

  // ---- timeline: days, or hours for a single day
  let timeline: ConsumablesStats["timeline"];
  if (fromISO === toISO) {
    const perHour = new Array<number>(24).fill(0);
    for (const r of rows) perHour[r.hour] += 1;
    const { first, last } = hourSpan(perHour.map((n, h) => (n > 0 ? h : -1)).filter((h) => h >= 0));
    const buckets: TimeBucket[] = [];
    for (let h = first; h <= last; h++) buckets.push({ key: String(h), label: hourLabel(h), issues: perHour[h] });
    timeline = { unit: "hour", buckets };
  } else {
    const perDay = new Map<string, number>();
    for (const r of rows) perDay.set(r.dayISO, (perDay.get(r.dayISO) ?? 0) + 1);
    const long = spanDays(fromISO, toISO) <= 14;
    const buckets: TimeBucket[] = [];
    for (let d = fromISO; d <= toISO && buckets.length < 400; d = addDaysISO(d, 1)) {
      buckets.push({ key: d, label: dayLabel(d, long), issues: perDay.get(d) ?? 0 });
    }
    timeline = { unit: "day", buckets };
  }

  // ---- matrix: top items × top departments, quantity handed out
  const mItems = items.slice(0, topItems);
  // the departments past the top ones share one "Other" column, so an item's
  // row always adds up to everything handed out of it
  const mDepts: { department: string; label: string }[] = departments.slice(0, topDepts).map((d) => ({ department: d.department, label: d.label }));
  if (departments.length > topDepts) mDepts.push({ department: OTHER_KEY, label: `Other (${departments.length - topDepts})` });
  const itemIndex = new Map(mItems.map((it, i) => [fold(it.item), i]));
  const deptIndex = new Map(mDepts.map((d, i) => [d.department, i]));
  const otherCol = deptIndex.get(OTHER_KEY);
  const qty = mItems.map(() => mDepts.map(() => 0));
  for (const r of rows) {
    const i = itemIndex.get(fold(r.item));
    const j = deptIndex.get(r.department) ?? otherCol;
    if (i !== undefined && j !== undefined) qty[i][j] += r.qty;
  }

  // ---- daily series + 7-day moving average (the trailing week, days before
  // the period count as unknown rather than zero)
  const perDayAll = new Map<string, number>();
  for (const r of rows) perDayAll.set(r.dayISO, (perDayAll.get(r.dayISO) ?? 0) + 1);
  const longLabels = spanDays(fromISO, toISO) <= 14;
  const daily: DailyPoint[] = [];
  for (let d = fromISO; d <= toISO && daily.length < 400; d = addDaysISO(d, 1)) {
    daily.push({ dayISO: d, label: dayLabel(d, longLabels), issues: perDayAll.get(d) ?? 0, avg7: null });
  }
  for (let i = 6; i < daily.length; i++) {
    let sum = 0;
    for (let k = i - 6; k <= i; k++) sum += daily[k].issues;
    daily[i].avg7 = Math.round((sum / 7) * 10) / 10;
  }

  // ---- weekday × hour
  const weekdayOf = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  };
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const r of rows) grid[weekdayOf(r.dayISO)][r.hour] += 1;
  const usedHours = [...new Set(rows.map((r) => r.hour))];
  const hFirst = Math.min(7, ...usedHours);
  const hLast = Math.max(17, ...usedHours);
  const hours: number[] = [];
  for (let h = hFirst; h <= hLast; h++) hours.push(h);
  const weekHour = { hours, counts: grid.map((row) => hours.map((h) => row[h])) };
  // the busiest hour of the week: one weekday × hour cell (the first in the
  // week's order on a tie) — not the busiest hour and busiest weekday picked
  // apart, which can name a slot nobody came in
  let busiestSlot: ConsumablesKpis["busiestSlot"] = null;
  grid.forEach((row, weekday) => row.forEach((n, hour) => {
    if (n > (busiestSlot?.issues ?? 0)) busiestSlot = { weekday, hour, issues: n };
  }));

  // ---- department share: top SHARE_SLOTS + Other
  const named = departments.slice(0, SHARE_SLOTS);
  const restIssues = departments.slice(SHARE_SLOTS).reduce((n, d) => n + d.issues, 0);
  const total = rows.length || 1;
  const departmentShare: ShareSlice[] = [
    ...named.map((d) => ({ key: d.department, label: d.label, issues: d.issues, share: d.issues / total })),
    ...(restIssues > 0 ? [{ key: OTHER_KEY, label: `Other (${departments.length - SHARE_SLOTS})`, issues: restIssues, share: restIssues / total }] : []),
  ];

  // ---- departments over time: days, or weeks from the period's first day
  const span = spanDays(fromISO, toISO);
  const trendUnit: "day" | "week" = span > 31 ? "week" : "day";
  const seriesKeys = new Set(named.map((d) => d.department));
  const series = [...named.map((d) => ({ key: d.department, label: d.label })), ...(restIssues > 0 ? [{ key: OTHER_KEY, label: "Other" }] : [])];
  const buckets: StackBucket[] = [];
  const bucketOf = new Map<string, StackBucket>();
  for (let d = fromISO, i = 0; d <= toISO && i < 400; d = addDaysISO(d, 1), i++) {
    const start = trendUnit === "day" ? d : addDaysISO(fromISO, Math.floor(i / 7) * 7);
    let b = bucketOf.get(start);
    if (!b) {
      b = { key: start, label: trendUnit === "day" ? dayLabel(start, longLabels) : `wk ${dayLabel(start, false)}`, total: 0, values: Object.fromEntries(series.map((x) => [x.key, 0])) };
      bucketOf.set(start, b);
      buckets.push(b);
    }
    bucketOf.set(d, b);
  }
  for (const r of rows) {
    const b = bucketOf.get(r.dayISO);
    if (!b) continue;
    const k = seriesKeys.has(r.department) ? r.department : OTHER_KEY;
    b.values[k] = (b.values[k] ?? 0) + 1;
    b.total += 1;
  }

  // ---- pareto
  let running = 0;
  const pareto: ParetoRow[] = items.map((it) => {
    running += it.issues;
    return { item: it.item, issues: it.issues, share: it.issues / total, cumulative: running / total };
  });
  const vitalFew = rows.length === 0 ? 0 : pareto.findIndex((p) => p.cumulative >= 0.8 - 1e-9) + 1;

  // ---- item tiles: each item's heaviest department (by hand-outs)
  const itemDept = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const k = fold(r.item);
    const m = itemDept.get(k) ?? new Map<string, number>();
    m.set(r.department, (m.get(r.department) ?? 0) + 1);
    itemDept.set(k, m);
  }
  const deptLabelOf = new Map(departments.map((d) => [d.department, d.label]));
  const itemTiles: ItemTile[] = items.map((it) => {
    const m = itemDept.get(fold(it.item)) ?? new Map<string, number>();
    const top = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
    return { item: it.item, issues: it.issues, qty: it.qty, department: top, departmentLabel: deptLabelOf.get(top) ?? top };
  });

  // ---- every worker, for the scatter
  const workerPoints: WorkerPoint[] = [...workerAgg.entries()]
    .map(([workerId, a]) => ({ workerId, name: a.name, empId: a.empId, issues: a.issues, items: a.items.size, departments: a.depts.size }))
    .sort((a, b) => b.issues - a.issues || a.name.localeCompare(b.name));

  const activeDays = daily.filter((d) => d.issues > 0).length;
  const kpis: ConsumablesKpis = {
    activeDays,
    perActiveDay: activeDays ? Math.round((rows.length / activeDays) * 10) / 10 : 0,
    perWorker: workerAgg.size ? Math.round((rows.length / workerAgg.size) * 10) / 10 : 0,
    topDepartmentShare: departments[0] ? departments[0].issues / total : 0,
    vitalFew,
    busiestSlot,
  };

  return {
    fromISO,
    toISO,
    totals: { issues: rows.length, items: items.length, workers: workerAgg.size, departments: departments.length },
    previousIssues,
    timeline,
    items,
    departments,
    workers,
    matrix: {
      items: mItems.map((i) => i.item),
      departments: mDepts,
      qty: qty.map((row) => row.map(round3)),
    },
    daily,
    kpis,
    weekHour,
    departmentShare,
    departmentTrend: { unit: trendUnit, series, buckets },
    pareto: { rows: pareto, vitalFew },
    itemTiles,
    workerPoints,
  };
}
