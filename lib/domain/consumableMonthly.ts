// CONSUMABLES — the month against the limits. The store reviews consumption
// month by month: each catalogue item's hand-outs in a calendar month against
// its limits, graded over / near / under / none, with the month before and
// the last six months.
//
// A monthly limit is the month's number. A limit of several months is not
// cut into slices — one tin of glue a quarter handed out in July is not
// "300% over" — it is counted over its window so far (the window's first day
// to the month's last) against its whole number. Pure and tested; the reads
// are lib/server/consumableMonthly.ts.

import {
  coversDepartment, isMultiMonth, periodWindow, ruleLabel, usageIn, windowLabel, windowsOverlapping,
  type LimitBasis, type LimitPeriod, type LimitRule, type LimitUse,
} from "./consumableLimits";

export const NEAR_RATIO = 0.8;

export type MonthStatus = "over" | "near" | "under" | "unused" | "nolimit";
export const MONTH_STATUS_LABEL: Record<MonthStatus, string> = {
  over: "Over the limit",
  near: "Close to it (80–100%)",
  under: "Under the limit",
  unused: "Not issued",
  nolimit: "No limit",
};
/** Worst first — an item takes the worst of its limits. */
const SEVERITY: Record<MonthStatus, number> = { over: 4, near: 3, under: 2, unused: 1, nolimit: 0 };

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function grade(used: number, allowance: number): Exclude<MonthStatus, "nolimit"> {
  if (used <= 0) return "unused";
  if (used > allowance + 1e-9) return "over";
  if (used >= allowance * NEAR_RATIO - 1e-9) return "near";
  return "under";
}

/** What the month is held to: a monthly limit's number; a limit of several
 *  months, its whole number over its window to date. */
export function monthlyAllowance(rule: Pick<LimitRule, "qty" | "period">): number {
  return round3(rule.qty);
}

// ---------------------------------------------------------------- months

/** "2026-09" → its first and last day. */
export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { from, to };
}

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthShort = (month: string) => `${MON[Number(month.slice(5, 7)) - 1]} ${month.slice(2, 4)}`;
export const monthLong = (month: string) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

export function isMonthKey(s: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/** The days the report needs counted: six months back — or the year's
 *  start, where every multi-month window of the month begins — to the
 *  month's end. */
export function reportSpan(month: string, trendMonths = 6): { from: string; to: string } {
  const { from, to } = monthBounds(month);
  const first = monthBounds(shiftMonth(month, -(trendMonths - 1))).from;
  return { from: [first, periodWindow("year", from).from].sort()[0], to };
}

// ---------------------------------------------------------------- the report

export interface ItemInput {
  id: number;
  code: string | null;
  name: string;
  uom: string;
  active: boolean;
  rules: LimitRule[];
}

export interface WorkerOver { workerId: number; used: number }

export interface LimitMonthRow {
  ruleId: number;
  departmentsLabel: string;
  basis: LimitBasis;
  period: LimitPeriod;
  qty: number;
  /** The monthly allowance (per worker for a per-person limit); for a
   *  quarterly limit its whole number, counted over the quarter to date. */
  allowance: number;
  /** A quarterly limit: the window counted ("Q3 to date"); null otherwise. */
  toDate: string | null;
  /** Pool: everything handed out to its departments in the month; person:
   *  the worker who took the most. */
  used: number;
  /** Per-person limits: all the workers together. */
  usedAll: number;
  ratio: number;
  status: Exclude<MonthStatus, "nolimit">;
  prevUsed: number;
  /** A per-person limit: the workers over their monthly allowance. */
  workersOver: WorkerOver[];
}

export interface ItemMonthRow {
  itemId: number;
  code: string | null;
  name: string;
  uom: string;
  active: boolean;
  /** Sum of the shared limits' monthly allowances; null when the item has
   *  none (no limit, or only per-person limits). */
  allowance: number | null;
  /** Everything handed out of the item in the month, any department. */
  used: number;
  /** …of which to departments no limit of the item covers. */
  outside: number;
  /** Covered use / allowance, or for per-person items the worst worker's. */
  ratio: number | null;
  status: MonthStatus;
  prevUsed: number;
  /** used − prevUsed as a share of prevUsed; null when there was none before. */
  change: number | null;
  /** The last six months, oldest first. */
  trend: { month: string; used: number }[];
  limits: LimitMonthRow[];
}

export interface MonthlyReport {
  month: string;
  prevMonth: string;
  trendMonths: string[];
  rows: ItemMonthRow[];
  counts: Record<MonthStatus, number>;
  /** Items over, near, under and not issued, month by month (the trend's
   *  months, graded against the limits as they stand today). */
  countsByMonth: { month: string; over: number; near: number; under: number; unused: number }[];
  handOuts: { month: number; prev: number };
}

function inMonth(uses: readonly LimitUse[], month: string): LimitUse[] {
  const { from, to } = monthBounds(month);
  return uses.filter((u) => u.dayISO >= from && u.dayISO <= to);
}

function perWorker(rule: LimitRule, uses: readonly LimitUse[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const u of uses) {
    if (u.itemId !== rule.itemId || !coversDepartment(rule, u.department)) continue;
    m.set(u.workerId, round3((m.get(u.workerId) ?? 0) + u.qty));
  }
  return m;
}

/** One limit over one month. */
function limitMonth(rule: LimitRule, allUses: readonly LimitUse[], month: string, prevMonth: string): LimitMonthRow {
  const allowance = monthlyAllowance(rule);
  const { from, to } = monthBounds(month);
  const prevBounds = monthBounds(prevMonth);
  // a quarterly limit counts the quarter so far; every other the month
  const quarterly = isMultiMonth(rule.period);
  const monthWindow = quarterly ? { from: periodWindow(rule.period, from).from, to } : { from, to };
  const prevWindow = quarterly ? { from: periodWindow(rule.period, prevBounds.from).from, to: prevBounds.to } : prevBounds;
  const between = (w: { from: string; to: string }) => allUses.filter((u) => u.dayISO >= w.from && u.dayISO <= w.to);
  const cur = between(monthWindow);
  const prev = between(prevWindow);

  let used: number;
  let usedAll: number;
  let prevUsed: number;
  let workersOver: WorkerOver[] = [];
  if (rule.basis === "person") {
    const per = perWorker(rule, cur);
    const sorted = [...per.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    used = sorted[0]?.[1] ?? 0;
    usedAll = round3(sorted.reduce((n, [, q]) => n + q, 0));
    workersOver = sorted.filter(([, q]) => q > allowance + 1e-9).map(([workerId, q]) => ({ workerId, used: q }));
    prevUsed = Math.max(0, ...perWorker(rule, prev).values());
  } else {
    used = usageIn(rule, cur, monthWindow);
    usedAll = used;
    prevUsed = usageIn(rule, prev, prevWindow);
  }

  return {
    ruleId: rule.id, departmentsLabel: ruleLabel(rule), basis: rule.basis, period: rule.period, qty: rule.qty,
    allowance, toDate: quarterly ? `${windowLabel(rule.period, monthWindow)} to date` : null, used, usedAll, ratio: allowance > 0 ? used / allowance : 0, status: grade(used, allowance), prevUsed,
    workersOver,
  };
}

function itemMonth(item: ItemInput, allUses: readonly LimitUse[], month: string, prevMonth: string, trendMonths: string[]): ItemMonthRow {
  const mine = allUses.filter((u) => u.itemId === item.id);
  const cur = inMonth(mine, month);
  const used = round3(cur.reduce((n, u) => n + u.qty, 0));
  const prevUsed = round3(inMonth(mine, prevMonth).reduce((n, u) => n + u.qty, 0));
  const covered = (u: LimitUse) => item.rules.some((r) => coversDepartment(r, u.department));
  const outside = round3(cur.filter((u) => !covered(u)).reduce((n, u) => n + u.qty, 0));
  const limits = item.rules.map((r) => limitMonth(r, mine, month, prevMonth));

  // the item's monthly allowance adds its shared limits — a quarterly one
  // stands on its own over the quarter, so it grades the item through its row
  const pools = item.rules.filter((r) => r.basis === "pool" && !isMultiMonth(r.period));
  const allowance = pools.length ? round3(pools.reduce((n, r) => n + monthlyAllowance(r), 0)) : null;
  const poolUsed = round3(cur.filter((u) => pools.some((r) => coversDepartment(r, u.department))).reduce((n, u) => n + u.qty, 0));

  let status: MonthStatus;
  let ratio: number | null;
  if (limits.length === 0) {
    status = "nolimit";
    ratio = null;
  } else {
    // the item takes the worst of its limits
    status = limits.reduce<MonthStatus>((w, l) => (SEVERITY[l.status] > SEVERITY[w] ? l.status : w), "unused");
    ratio = allowance !== null && allowance > 0 ? poolUsed / allowance : Math.max(...limits.map((l) => l.ratio));
  }

  return {
    itemId: item.id, code: item.code, name: item.name, uom: item.uom, active: item.active,
    allowance, used, outside, ratio, status, prevUsed,
    change: prevUsed > 0 ? (used - prevUsed) / prevUsed : null,
    trend: trendMonths.map((m) => ({ month: m, used: round3(inMonth(mine, m).reduce((n, u) => n + u.qty, 0)) })),
    limits,
  };
}

/**
 * The month's report. Every active item is on it (a retired one only if it
 * was handed out in the month); items without a limit but handed out show as
 * "No limit". Sorted worst first, then by how far over.
 */
export function buildMonthlyReport(items: readonly ItemInput[], uses: readonly LimitUse[], month: string, trendCount = 6): MonthlyReport {
  const prevMonth = shiftMonth(month, -1);
  const trendMonths = Array.from({ length: trendCount }, (_, i) => shiftMonth(month, i - (trendCount - 1)));
  const handed = new Set(inMonth(uses, month).map((u) => u.itemId));

  const rows = items
    .filter((i) => i.active || handed.has(i.id))
    .filter((i) => i.rules.length > 0 || handed.has(i.id))
    .map((i) => itemMonth(i, uses, month, prevMonth, trendMonths))
    .sort((a, b) => SEVERITY[b.status] - SEVERITY[a.status] || (b.ratio ?? 0) - (a.ratio ?? 0) || a.name.localeCompare(b.name));

  const counts: Record<MonthStatus, number> = { over: 0, near: 0, under: 0, unused: 0, nolimit: 0 };
  for (const r of rows) counts[r.status] += 1;

  const countsByMonth = trendMonths.map((m) => {
    const c = { month: m, over: 0, near: 0, under: 0, unused: 0 };
    for (const i of items) {
      if (!i.active || i.rules.length === 0) continue;
      const st = itemMonth(i, uses, m, shiftMonth(m, -1), []).status;
      if (st !== "nolimit") c[st] += 1;
    }
    return c;
  });

  return {
    month, prevMonth, trendMonths, rows, counts, countsByMonth,
    handOuts: { month: inMonth(uses, month).length, prev: inMonth(uses, prevMonth).length },
  };
}
