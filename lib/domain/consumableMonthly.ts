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
//
// The limits are counted exactly as the record form and the alarms count
// them: an "each department" or "per worker" limit is first made into each
// department's own (expandPerWorker) — the number, or the number times the
// department's workers — because a hand-out is recorded to a department, not
// to the worker who collected it.

import {
  coversDepartment, departmentsLabel, expandPerWorker, isMultiMonth, periodWindow, usageIn, windowLabel,
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

/** The days the report needs counted: from the first day of the year of the
 *  earliest month it grades (the trend's first month, or the month before)
 *  — where every multi-month window of those months begins, a yearly one
 *  included — to the month's end. */
export function reportSpan(month: string, trendMonths = 6): { from: string; to: string } {
  const { to } = monthBounds(month);
  const earliest = [shiftMonth(month, -(Math.max(1, trendMonths) - 1)), shiftMonth(month, -1)].sort()[0];
  return { from: periodWindow("year", monthBounds(earliest).from).from, to };
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

export interface LimitMonthRow {
  /** The counted limit's id — a department's share of an "each" or "per
   *  worker" limit has a made-up negative one. */
  ruleId: number;
  /** The limit as it is set on the Limits tab. */
  sourceId: number;
  departmentsLabel: string;
  /** How the limit is set: shared, each department its own, or per worker. */
  basis: LimitBasis;
  period: LimitPeriod;
  /** The number as set (per worker for a per-worker limit). */
  qty: number;
  /** A per-worker limit: the number per worker and the workers it is times. */
  perWorker: { qty: number; workers: number } | null;
  /** What the department(s) may draw in the month — for a limit of several
   *  months its whole number, counted over its months so far. */
  allowance: number;
  /** A limit of several months: the window counted ("Q3 2026 to date"); null otherwise. */
  toDate: string | null;
  /** Everything handed out to its departments in the month (or the window so far). */
  used: number;
  /** allowance − used; negative when over. */
  left: number;
  ratio: number;
  status: Exclude<MonthStatus, "nolimit">;
  prevUsed: number;
}

export interface ItemMonthRow {
  itemId: number;
  code: string | null;
  name: string;
  uom: string;
  active: boolean;
  /** Sum of the monthly limits' allowances (every department's share);
   *  null when the item has none (no limit, or only limits of several months). */
  allowance: number | null;
  /** Everything handed out of the item in the month, any department. */
  used: number;
  /** …of which to the departments its monthly limits cover — what the
   *  allowance is held against. */
  covered: number;
  /** …of which to departments no limit of the item covers. */
  outside: number;
  /** covered / allowance; with no monthly limit, the worst limit's ratio. */
  ratio: number | null;
  status: MonthStatus;
  prevUsed: number;
  /** used − prevUsed as a share of prevUsed; null when there was none before. */
  change: number | null;
  /** The last six months, oldest first. */
  trend: { month: string; used: number }[];
  limits: LimitMonthRow[];
}

export interface MonthlyReportOptions {
  /** The workers each department has — a per-worker limit is times this. */
  headcount?: ReadonlyMap<string, number>;
  trendCount?: number;
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

const sum = (uses: readonly LimitUse[]) => round3(uses.reduce((n, u) => n + u.qty, 0));

/** One counted limit over one month. `rule` is a department's own or a
 *  shared one (expandPerWorker has run); `source` is the limit as set. */
function limitMonth(rule: LimitRule, source: LimitRule, allUses: readonly LimitUse[], month: string, prevMonth: string): LimitMonthRow {
  const allowance = monthlyAllowance(rule);
  const bounds = monthBounds(month);
  const prevBounds = monthBounds(prevMonth);
  // a limit of several months counts its window so far; a monthly one the month
  const multi = isMultiMonth(rule.period);
  const window = (b: { from: string; to: string }) => (multi ? { from: periodWindow(rule.period, b.from).from, to: b.to } : b);
  const monthWindow = window(bounds);
  const used = usageIn(rule, allUses, monthWindow);
  const prevUsed = usageIn(rule, allUses, window(prevBounds));
  return {
    ruleId: rule.id, sourceId: rule.sourceId ?? rule.id, departmentsLabel: departmentsLabel(rule.departments), basis: source.basis, period: rule.period, qty: source.qty,
    perWorker: rule.perWorker ?? null,
    allowance, toDate: multi ? `${windowLabel(rule.period, monthWindow)} to date` : null,
    used, left: round3(allowance - used), ratio: allowance > 0 ? used / allowance : 0, status: grade(used, allowance), prevUsed,
  };
}

/** An item's limits as they are counted: each department's own share of an
 *  "each" or "per worker" limit, shared ones as they are. `seen`: the
 *  departments the item went to — an "every department" limit covers them. */
function countedRules(item: ItemInput, mine: readonly LimitUse[], headcount: ReadonlyMap<string, number>): { rule: LimitRule; source: LimitRule }[] {
  const seen = [...new Set(mine.map((u) => u.department))];
  const sourceOf = new Map(item.rules.map((r) => [r.id, r]));
  return expandPerWorker(item.rules, headcount, seen).map((rule) => ({ rule, source: sourceOf.get(rule.sourceId ?? rule.id) ?? rule }));
}

function itemMonth(item: ItemInput, allUses: readonly LimitUse[], month: string, prevMonth: string, trendMonths: string[], headcount: ReadonlyMap<string, number>): ItemMonthRow {
  const mine = allUses.filter((u) => u.itemId === item.id);
  const cur = inMonth(mine, month);
  const used = sum(cur);
  const prevUsed = sum(inMonth(mine, prevMonth));
  const counted = countedRules(item, mine, headcount);
  const outside = sum(cur.filter((u) => !counted.some(({ rule }) => coversDepartment(rule, u.department))));
  // worst first, then the fullest, so the item opens on what matters
  const limits = counted
    .map(({ rule, source }) => limitMonth(rule, source, mine, month, prevMonth))
    .sort((a, b) => SEVERITY[b.status] - SEVERITY[a.status] || b.ratio - a.ratio || a.departmentsLabel.localeCompare(b.departmentsLabel));

  // the item's monthly allowance adds its monthly limits (every department's
  // share); one of several months stands on its own over its window, so it
  // grades the item through its row
  const monthly = counted.filter(({ rule }) => !isMultiMonth(rule.period)).map(({ rule }) => rule);
  const allowance = monthly.length ? round3(monthly.reduce((n, r) => n + monthlyAllowance(r), 0)) : null;
  const covered = sum(cur.filter((u) => monthly.some((r) => coversDepartment(r, u.department))));

  let status: MonthStatus;
  let ratio: number | null;
  if (limits.length === 0) {
    status = "nolimit";
    ratio = null;
  } else {
    // the item takes the worst of its limits
    status = limits.reduce<MonthStatus>((w, l) => (SEVERITY[l.status] > SEVERITY[w] ? l.status : w), "unused");
    ratio = allowance !== null && allowance > 0 ? covered / allowance : Math.max(...limits.map((l) => l.ratio));
  }

  return {
    itemId: item.id, code: item.code, name: item.name, uom: item.uom, active: item.active,
    allowance, used, covered, outside, ratio, status, prevUsed,
    change: prevUsed > 0 ? (used - prevUsed) / prevUsed : null,
    trend: trendMonths.map((m) => ({ month: m, used: sum(inMonth(mine, m)) })),
    limits,
  };
}

/**
 * The month's report. Every active item is on it (a retired one only if it
 * was handed out in the month); items without a limit but handed out show as
 * "No limit". Sorted worst first, then by how far over.
 */
export function buildMonthlyReport(items: readonly ItemInput[], uses: readonly LimitUse[], month: string, opts: MonthlyReportOptions = {}): MonthlyReport {
  const headcount = opts.headcount ?? new Map<string, number>();
  const trendCount = opts.trendCount ?? 6;
  const prevMonth = shiftMonth(month, -1);
  const trendMonths = Array.from({ length: trendCount }, (_, i) => shiftMonth(month, i - (trendCount - 1)));
  const handed = new Set(inMonth(uses, month).map((u) => u.itemId));

  const rows = items
    .filter((i) => i.active || handed.has(i.id))
    .filter((i) => i.rules.length > 0 || handed.has(i.id))
    .map((i) => itemMonth(i, uses, month, prevMonth, trendMonths, headcount))
    .sort((a, b) => SEVERITY[b.status] - SEVERITY[a.status] || (b.ratio ?? 0) - (a.ratio ?? 0) || a.name.localeCompare(b.name));

  const counts: Record<MonthStatus, number> = { over: 0, near: 0, under: 0, unused: 0, nolimit: 0 };
  for (const r of rows) counts[r.status] += 1;

  const countsByMonth = trendMonths.map((m) => {
    const c = { month: m, over: 0, near: 0, under: 0, unused: 0 };
    for (const i of items) {
      if (!i.active || i.rules.length === 0) continue;
      const st = itemMonth(i, uses, m, shiftMonth(m, -1), [], headcount).status;
      if (st !== "nolimit") c[st] += 1;
    }
    return c;
  });

  return {
    month, prevMonth, trendMonths, rows, counts, countsByMonth,
    handOuts: { month: inMonth(uses, month).length, prev: inMonth(uses, prevMonth).length },
  };
}
