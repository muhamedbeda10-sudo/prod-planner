// Daily report — port of modReport.ShowDailyReport.
// Groups by BomGroup (unlike the tracker). Two sections:
//   1) Department output today  (per item, complete sets, efficiency %, balance %)
//   2) Projects worked today    (per BOM+dept; completion = MIN painted — a
//      transformer only counts once it left Painting)

import { ITEMS, DEPTS, SHEET_ITEMS, DELIVERED_STAGE, sumItemTargets, isPaintExempt, type Item } from "./constants";

// The report's Section-1 output table covers the production departments PLUS
// the customer-receipt Delivered stage. Painting is the whole FINISHING stage:
// painted items are painted, the core (CF) is shot-blasted — both count here,
// so Shot Blast has no separate row (it lives inside Painting).
export const REPORT_STAGES = [...DEPTS, DELIVERED_STAGE] as const;
import type { BomGrouper } from "./bom";
import { dayNumber } from "./dates";

export interface ReportOrderRow {
  planNo: number;
  bom: string;
  mo: string;
  description?: string | null;
  item: string;
  requiredQty: number;
  targetQty: number;
}
export interface ReportLogRow {
  date: Date;
  dept: string;
  bom: string;
  item: string;
  qty: number;
  planNo: number;
}

export interface DeptOutput {
  dept: string; // Cut | Welding | Painting | ShotBlast | Delivered
  items: Record<Item, number>;
  total: number;
  target: number;
  sets: number; // MIN across the base components on every transformer
  efficiency: number; // total / (Σ per-item daily targets: base 27, AR/MB 20)
  balance: number | null; // (sets × base-item count) / base total, null when 0
}

export interface ProjectRow {
  bom: string;
  description: string;
  dept: string;
  items: Record<Item, number>;
  totalToday: number;
  required: number | null;
  completed: number | null;
  progress: number | null;
  status: "Closed" | "In progress" | "No plan data";
}

export interface DailyReport {
  deptOutputs: DeptOutput[];
  projects: ProjectRow[];
}

const g = (m: Map<string, number>, k: string) => m.get(k) ?? 0;
const inc = (m: Map<string, number>, k: string, q: number) => m.set(k, (m.get(k) ?? 0) + q);
const minOf = (arr: number[]) => arr.reduce((m, v) => (v < m ? v : m), arr[0] ?? 0);

export function computeDailyReport(
  orders: ReportOrderRow[],
  handover: ReportLogRow[],
  day: Date,
  target: number,
  grouper: BomGrouper,
  /** Range mode: the FIRST day counted (defaults to `day` — a single day).
   *  Cumulative stage totals still run up to `day`, the range END. */
  from?: Date,
  /** Working days the range spans — scales the capacity used for efficiency
   *  (1 for a single day). AR/MB carry their own daily target, so the whole
   *  capacity sum is scaled here rather than the per-item base. */
  days = 1
): DailyReport {
  const dt = dayNumber(day);
  const dFrom = from ? dayNumber(from) : dt;

  // ---- read log (up to and including the range END) ----
  const deptItem = new Map<string, number>(); // dept|item within the range
  const paintCum = new Map<string, number>(); // bg|item painting cumulative <= day
  const weldCum = new Map<string, number>(); // bg|item welding cumulative <= day
  const shpCum = new Map<string, number>(); // bg|item shot-blast cumulative <= day (final stage for CF)
  const bomDept = new Map<string, Map<string, number>>(); // bg|dept -> item -> qty today
  const bomWeek = new Map<string, number>(); // bg -> planNo (first today entry)

  for (const l of handover) {
    if (dayNumber(l.date) > dt) continue;
    const dtl = dayNumber(l.date);
    const dp = l.dept;
    const bg = grouper(l.bom);
    const itm = l.item;
    const q = l.qty || 0;
    // NEGATIVE rows (corrections / returns) count too — every other screen sums
    // the full ledger, so skipping them here made the report's totals disagree
    // with the daily log and the worked-on table
    if (!bg || !itm || q === 0) continue;
    if (dp === "Painting") inc(paintCum, `${bg}|${itm}`, q);
    if (dp === "Welding") inc(weldCum, `${bg}|${itm}`, q);
    if (dp === "ShotBlast") inc(shpCum, `${bg}|${itm}`, q);
    if (dtl >= dFrom && dtl <= dt) {
      inc(deptItem, `${dp}|${itm}`, q);
      const bk = `${bg}|${dp}`;
      if (!bomDept.has(bk)) bomDept.set(bk, new Map());
      inc(bomDept.get(bk)!, itm, q);
      if (!bomWeek.has(bg)) bomWeek.set(bg, l.planNo);
    }
  }

  // ---- Plan Orders: required & targets per week|bg ----
  const reqD = new Map<string, number>(); // wk|bg -> required (deduped per mo)
  const tgtD = new Map<string, number>(); // wk|bg|item -> target
  const moSeen = new Set<string>();
  const descOf = new Map<string, string>();
  const bomWeeksAll = new Map<string, Set<string>>();
  for (const o of orders) {
    const wk = o.planNo;
    const bg = grouper(o.bom);
    if (!wk || !bg) continue;
    const mk = `${wk}|${bg}|${o.mo}`;
    if (!moSeen.has(mk)) {
      moSeen.add(mk);
      inc(reqD, `${wk}|${bg}`, o.requiredQty || 0);
    }
    inc(tgtD, `${wk}|${bg}|${o.item}`, o.targetQty || 0);
    if (o.description && !descOf.has(bg)) descOf.set(bg, String(o.description));
    if (!bomWeeksAll.has(bg)) bomWeeksAll.set(bg, new Set());
    bomWeeksAll.get(bg)!.add(String(wk));
  }

  // ---- section 1: department output ----
  const deptOutputs: DeptOutput[] = REPORT_STAGES.map((dept) => {
    const items = {} as Record<Item, number>;
    let total = 0;
    for (const it of ITEMS) {
      // Painting is the finishing stage: the core (CF) is SHOT-BLASTED, every
      // other component is painted — so CF reads from the ShotBlast ledger
      const src = dept === "Painting" && isPaintExempt(it) ? "ShotBlast" : dept;
      items[it] = g(deptItem, `${src}|${it}`);
      total += items[it];
    }
    // Efficiency counts every component the stage handles at its OWN daily target
    // (base 27, AR/MB 20). "Sets" and balance use only the components on EVERY
    // transformer (base sheet items) so the conditional AR/MB don't skew them.
    const deptItems = ITEMS;
    const baseItems = SHEET_ITEMS;
    const targetSum = sumItemTargets(deptItems, target) * days;
    const sets = minOf(baseItems.map((it) => items[it]));
    const baseTotal = baseItems.reduce((s, it) => s + items[it], 0);
    return {
      dept,
      items,
      total,
      target,
      sets,
      efficiency: targetSum > 0 ? total / targetSum : 0,
      balance: baseTotal > 0 ? (sets * baseItems.length) / baseTotal : null,
    };
  });

  // ---- section 2: projects worked today ----
  const keys = [...bomDept.keys()].sort();
  const projects: ProjectRow[] = [];
  for (const key of keys) {
    const [bg, dep] = key.split("|") as [string, string];
    const m = bomDept.get(key)!;
    const items = {} as Record<Item, number>;
    let totalToday = 0;
    for (const it of ITEMS) {
      items[it] = g(m, it);
      totalToday += items[it];
    }
    // resolve week
    let wkB = bomWeek.get(bg) ?? 0;
    if (g(reqD, `${wkB}|${bg}`) === 0 && bomWeeksAll.has(bg)) {
      for (const wkc of bomWeeksAll.get(bg)!) {
        if (g(reqD, `${wkc}|${bg}`) > 0) wkB = Number(wkc);
      }
    }
    const RQ = g(reqD, `${wkB}|${bg}`);
    let completed = 0;
    let first = true;
    for (const it of ITEMS) {
      const TT = g(tgtD, `${wkB}|${bg}|${it}`);
      let pre = RQ - TT;
      if (pre < 0) pre = 0;
      // final stage = SHOT BLAST for the paint-exempt core (CF), Painting otherwise
      const cum = isPaintExempt(it) ? g(shpCum, `${bg}|${it}`) : g(paintCum, `${bg}|${it}`);
      let eff = pre + cum;
      if (eff > RQ) eff = RQ;
      if (first) { completed = eff; first = false; }
      else if (eff < completed) completed = eff;
    }
    projects.push({
      bom: bg,
      description: descOf.get(bg) ?? "",
      dept: dep,
      items,
      totalToday,
      required: RQ > 0 ? RQ : null,
      completed: RQ > 0 ? completed : null,
      progress: RQ > 0 ? completed / RQ : null,
      status: RQ > 0 ? (completed >= RQ ? "Closed" : "In progress") : "No plan data",
    });
  }

  return { deptOutputs, projects };
}
