// The CONSUMABLES dashboard's numbers, from the hand-outs of a period. Pure,
// tested; the reads are lib/server/consumables.ts (getConsumablesDashboard).
//
// Items are free text, so the same thing typed twice in different case or
// spacing is one item here, named the way it was typed most often. Quantities
// are only ever added up within one item — the store hands out kilos of wire
// and pairs of gloves, and a grand total across items would mean nothing.

import { addDaysISO } from "./dateSlicer";

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
export interface DeptStat { department: string; label: string; issues: number; items: number; workers: number }
export interface WorkerStat { workerId: number; name: string; empId: string; issues: number; items: number; departments: string }
export interface TimeBucket { key: string; label: string; issues: number }

export interface ConsumablesStats {
  fromISO: string;
  toISO: string;
  totals: { issues: number; items: number; workers: number; departments: number };
  /** Hand-outs in the period of the same length just before — for the change. */
  previousIssues: number;
  /** One bucket per day of the period, or per hour when it is a single day. */
  timeline: { unit: "day" | "hour"; buckets: TimeBucket[] };
  items: ItemStat[];
  departments: DeptStat[];
  workers: WorkerStat[];
  /** Where each item goes: the top items × the top departments, by quantity. */
  matrix: { items: string[]; departments: { department: string; label: string }[]; qty: number[][] };
}

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

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function consumablesStats(
  rows: readonly StatsRow[],
  fromISO: string,
  toISO: string,
  previousIssues: number,
  opts: { topItems?: number; topDepartments?: number; topWorkers?: number } = {},
): ConsumablesStats {
  const topItems = opts.topItems ?? 12;
  const topDepts = opts.topDepartments ?? 6;
  const topWorkers = opts.topWorkers ?? 10;

  // ---- items: grouped by the folded name, shown in the commonest spelling
  const spellings = new Map<string, Map<string, number>>();
  const itemAgg = new Map<string, { issues: number; qty: number; workers: Set<number> }>();
  for (const r of rows) {
    const k = fold(r.item);
    const sp = spellings.get(k) ?? new Map<string, number>();
    sp.set(r.item.trim(), (sp.get(r.item.trim()) ?? 0) + 1);
    spellings.set(k, sp);
    const a = itemAgg.get(k) ?? { issues: 0, qty: 0, workers: new Set<number>() };
    a.issues += 1;
    a.qty += r.qty;
    a.workers.add(r.workerId);
    itemAgg.set(k, a);
  }
  const nameOf = (k: string) => [...(spellings.get(k) ?? new Map()).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? k;
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
    .map(([department, a]) => ({ department, label: a.label, issues: a.issues, items: a.items.size, workers: a.workers.size }))
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
    const used = perHour.map((n, h) => (n > 0 ? h : -1)).filter((h) => h >= 0);
    // the working day at least, widened to any hand-out outside it
    const first = Math.min(7, ...used);
    const last = Math.max(17, ...used);
    const buckets: TimeBucket[] = [];
    for (let h = first; h <= last; h++) buckets.push({ key: String(h), label: `${String(h).padStart(2, "0")}:00`, issues: perHour[h] });
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
  const mDepts = departments.slice(0, topDepts);
  const itemIndex = new Map(mItems.map((it, i) => [fold(it.item), i]));
  const deptIndex = new Map(mDepts.map((d, i) => [d.department, i]));
  const qty = mItems.map(() => mDepts.map(() => 0));
  for (const r of rows) {
    const i = itemIndex.get(fold(r.item));
    const j = deptIndex.get(r.department);
    if (i !== undefined && j !== undefined) qty[i][j] += r.qty;
  }

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
      departments: mDepts.map((d) => ({ department: d.department, label: d.label })),
      qty: qty.map((row) => row.map(round3)),
    },
  };
}
