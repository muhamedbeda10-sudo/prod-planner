// ODOO dashboard — pure aggregation of the close-out log by day and product.
// The server fetches the rows; this module turns them into what the charts
// and the table draw, so the numbers can be tested without a database.

import { parseISODate, toISODate } from "./dates";
import { isDoneStatus, ODOO_PRODUCTS } from "./odoo";

/** A series is a product name. The sheet's six come first, in the fixed order
 *  the charts colour them; any other product logged is its own series after
 *  them, under the name it was typed — a new item closed on Odoo shows up by
 *  name, not as "Other". "Other" is only a row with no product at all. */
export type OdooSeries = string;
export const KNOWN_SERIES: readonly OdooSeries[] = ODOO_PRODUCTS;
export const OTHER_SERIES = "Other";

/** Fold a typed product onto its series — the sheet's names however cased or
 *  abbreviated, anything else tidied to Title Case so "radiator", "Radiator "
 *  and "RADIATOR" are one series. */
export function productSeries(product: string | null | undefined): OdooSeries {
  const clean = (product ?? "").replace(/\s+/g, " ").trim();
  const key = clean.toLowerCase();
  if (!key) return OTHER_SERIES;
  for (const p of ODOO_PRODUCTS) if (p.toLowerCase() === key) return p;
  if (key === "enclosure" || key === "enclouser") return "Encloser";
  if (key === "cb" || key === "cable-box") return "Cable Box";
  if (key === "tc" || key === "top-cover") return "Top Cover";
  if (key === "cf" || key === "core-frame") return "Core Frame";
  if (key === "tn") return "Tank";
  return clean.split(" ").map((w) => (w.length > 3 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w[0].toUpperCase() + w.slice(1))).join(" ");
}

/** The order series are drawn in: the sheet's products first (fixed), then the
 *  rest by quantity, then name — so a new product's colour is stable within a
 *  period and the biggest newcomer sits nearest the known ones. */
export function orderSeries(totals: ReadonlyMap<OdooSeries, { qty: number }>): OdooSeries[] {
  const known = KNOWN_SERIES.filter((s) => totals.has(s));
  const rest = [...totals.keys()]
    .filter((s) => !KNOWN_SERIES.includes(s) && s !== OTHER_SERIES)
    .sort((a, b) => totals.get(b)!.qty - totals.get(a)!.qty || a.localeCompare(b));
  return [...known, ...rest, ...(totals.has(OTHER_SERIES) ? [OTHER_SERIES] : [])];
}

export const ODOO_RANGES = ["today", "yesterday", "7d", "30d", "90d", "month", "all"] as const;
export type OdooRange = (typeof ODOO_RANGES)[number];
/** A preset, or a from/to typed by hand. */
export type OdooRangeKey = OdooRange | "custom";

export const ODOO_RANGE_LABEL: Record<OdooRangeKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  month: "This month",
  all: "All time",
  custom: "Custom",
};

/** Which day a row is counted on: the day it was logged, or the day its
 *  status went to Done. The charts, cards and table follow the basis; the
 *  other measure is kept beside it per day. */
export const ODOO_BASES = ["closed", "logged"] as const;
export type OdooBasis = (typeof ODOO_BASES)[number];
export const ODOO_BASIS_LABEL: Record<OdooBasis, string> = { closed: "Closed day", logged: "Logged day" };

/** Read the basis from the URL — closings by default: that is what the planner watches. */
export function resolveBasis(sp: { basis?: string }): OdooBasis {
  return sp.basis === "logged" ? "logged" : "closed";
}

/** The days a dashboard covers: [from, to] inclusive ISO dates; `null` from = unbounded. */
export interface OdooPeriod {
  range: OdooRangeKey;
  fromISO: string | null;
  toISO: string;
}

const isISO = (s: string | undefined): s is string => /^\d{4}-\d{2}-\d{2}$/.test(s ?? "");

function utcToday(today: Date): Date {
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
}

/** Read the period from the URL: a preset (`range=30d`, the default) or
 *  `range=custom&from=…&to=…`. A custom period with a bad or missing date
 *  falls back to the last 30 days; from/to the wrong way round are swapped. */
export function resolvePeriod(sp: { range?: string; from?: string; to?: string }, today: Date = new Date()): OdooPeriod {
  const t = utcToday(today);
  const toISO = toISODate(t);
  if (sp.range === "custom" && isISO(sp.from) && isISO(sp.to)) {
    const [a, b] = sp.from <= sp.to ? [sp.from, sp.to] : [sp.to, sp.from];
    return { range: "custom", fromISO: a, toISO: b };
  }
  const range: OdooRange = (ODOO_RANGES as readonly string[]).includes(sp.range ?? "") ? (sp.range as OdooRange) : "30d";
  if (range === "all") return { range, fromISO: null, toISO };
  if (range === "today") return { range, fromISO: toISO, toISO };
  if (range === "yesterday") {
    const y = toISODate(new Date(t.getTime() - 86_400_000));
    return { range, fromISO: y, toISO: y };
  }
  if (range === "month") return { range, fromISO: toISODate(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1))), toISO };
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return { range, fromISO: toISODate(new Date(t.getTime() - (days - 1) * 86_400_000)), toISO };
}

/** The same number of days immediately before the period — what "vs previous
 *  period" compares against. None for an unbounded period. */
export function previousPeriod(p: OdooPeriod): { fromISO: string; toISO: string } | null {
  if (!p.fromISO) return null;
  const from = parseISODate(p.fromISO)!;
  const to = parseISODate(p.toISO)!;
  const span = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  return {
    fromISO: toISODate(new Date(from.getTime() - span * 86_400_000)),
    toISO: toISODate(new Date(from.getTime() - 86_400_000)),
  };
}

/** How a period reads in a title: "9 Aug – 7 Sep 2026", or "up to 7 Sep 2026". */
export function periodLabel(p: OdooPeriod): string {
  const to = parseISODate(p.toISO)!;
  const year = to.getUTCFullYear();
  if (!p.fromISO) return `up to ${shortDayLabel(p.toISO)} ${year}`;
  const from = parseISODate(p.fromISO)!;
  const fy = from.getUTCFullYear();
  return fy === year ? `${shortDayLabel(p.fromISO)} – ${shortDayLabel(p.toISO)} ${year}` : `${shortDayLabel(p.fromISO)} ${fy} – ${shortDayLabel(p.toISO)} ${year}`;
}

export interface OdooStatRow {
  /** The day the row was logged. */
  dateISO: string;
  product: string;
  qty: number;
  status: string;
  /** The day its status was moved to Done — the day the close counts on.
   *  Null (or absent) while it is not done. */
  doneISO?: string | null;
}

export interface OdooDayPoint {
  dateISO: string;
  /** Short axis label, e.g. "6 Sep". */
  label: string;
  /** On the basis: logged that day, or closed that day. */
  qty: number;
  rows: number;
  bySeries: Record<OdooSeries, number>;
  /** Logged that day. */
  loggedQty: number;
  loggedRows: number;
  /** Closed that day (status moved to Done), whatever day the rows were logged. */
  doneQty: number;
  doneRows: number;
}

export interface OdooSeriesTotal {
  series: OdooSeries;
  qty: number;
  rows: number;
  /** Share of the period's quantity, 0–100. */
  share: number;
  /** The same product's quantity in the previous period; null when there is none to compare. */
  prevQty: number | null;
}

export interface OdooDashboardData {
  period: OdooPeriod;
  basis: OdooBasis;
  /** The comparison window, when the period is bounded. */
  previous: { fromISO: string; toISO: string } | null;
  /** Every product counted in the period on the basis, in drawing order —
   *  every day point carries a number for each of these. */
  series: OdooSeries[];
  days: OdooDayPoint[];
  totals: OdooSeriesTotal[];
  kpi: {
    /** On the basis, in the period. */
    qty: number;
    rows: number;
    /** Logged in the period. */
    loggedQty: number;
    loggedRows: number;
    /** Closed in the period — rows whose Done day falls in it, logged whenever. */
    doneQty: number;
    doneRows: number;
    /** Of the rows logged in the period, how many are Done by now. */
    doneNowRows: number;
    /** Days with at least one row on the basis. */
    activeDays: number;
    /** Mean qty per active day. */
    qtyPerActiveDay: number;
    /** The previous period's quantity and rows on the basis; null when there is none. */
    prevQty: number | null;
    prevRows: number | null;
  };
}

/** Signed change from `prev` to `cur` as a percentage, or null when there is nothing to compare. */
export function pctChange(cur: number, prev: number | null): number | null {
  if (prev === null) return null;
  if (prev === 0) return cur === 0 ? 0 : null;
  return Math.round(((cur - prev) / prev) * 100);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function shortDayLabel(dateISO: string): string {
  const d = parseISODate(dateISO);
  if (!d) return dateISO;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function emptySeries(series: readonly OdooSeries[]): Record<OdooSeries, number> {
  return Object.fromEntries(series.map((s) => [s, 0]));
}

/** Gaps are filled with zero days so a quiet day shows as quiet, not missing —
 *  up to this many days; past it (long "all time" spans) only logged days show. */
const FILL_GAPS_UP_TO = 120;

const inWindow = (iso: string, w: { fromISO: string | null; toISO: string }) => (w.fromISO === null || iso >= w.fromISO) && iso <= w.toISO;

/** The day a row counts on for a basis; null when it does not count at all
 *  (not Done, on the closed basis). */
function basisDay(r: OdooStatRow, basis: OdooBasis): string | null {
  if (basis === "logged") return r.dateISO;
  return r.doneISO && isDoneStatus(r.status) ? r.doneISO : null;
}

interface Tally {
  byDay: Map<string, { qty: number; rows: number; bySeries: Record<OdooSeries, number> }>;
  totals: Map<OdooSeries, { qty: number; rows: number }>;
  qty: number;
  rows: number;
}

/** Sum the rows that fall in the window on the basis, per day and per product. */
function tally(rows: readonly OdooStatRow[], window: { fromISO: string | null; toISO: string }, basis: OdooBasis): Tally {
  const t: Tally = { byDay: new Map(), totals: new Map(), qty: 0, rows: 0 };
  for (const r of rows) {
    const day = basisDay(r, basis);
    if (!day || !inWindow(day, window)) continue;
    const s = productSeries(r.product);
    let d = t.byDay.get(day);
    if (!d) t.byDay.set(day, (d = { qty: 0, rows: 0, bySeries: {} }));
    d.qty += r.qty;
    d.rows += 1;
    d.bySeries[s] = (d.bySeries[s] ?? 0) + r.qty;
    let tot = t.totals.get(s);
    if (!tot) t.totals.set(s, (tot = { qty: 0, rows: 0 }));
    tot.qty += r.qty;
    tot.rows += 1;
    t.qty += r.qty;
    t.rows += 1;
  }
  return t;
}

/**
 * Aggregate rows into per-day points, per-product totals and the headline
 * numbers, on a basis: by the day a row was LOGGED, or by the day its status
 * went to Done (CLOSED). Rows may come from a little outside the period —
 * a row logged in August and closed in September is one of September's
 * closings. Both measures are kept per day whatever the basis, so logged
 * and closed can sit side by side. `prevRows` are the previous period's
 * rows, for the comparisons; pass null when there is no previous period.
 */
export function buildOdooDashboard(rows: OdooStatRow[], period: OdooPeriod, prevRows: OdooStatRow[] | null = null, basis: OdooBasis = "logged"): OdooDashboardData {
  const main = tally(rows, period, basis);
  const logged = basis === "logged" ? main : tally(rows, period, "logged");
  const closed = basis === "closed" ? main : tally(rows, period, "closed");
  const doneNowRows = rows.filter((r) => inWindow(r.dateISO, period) && isDoneStatus(r.status)).length;

  const series = orderSeries(main.totals);

  // the previous period, per product, for the comparisons — on the same basis
  const prevWindow = previousPeriod(period);
  const prev = prevRows && prevWindow ? tally(prevRows, prevWindow, basis) : null;

  const point = (iso: string): OdooDayPoint => {
    const m = main.byDay.get(iso);
    const l = logged.byDay.get(iso);
    const c = closed.byDay.get(iso);
    return {
      dateISO: iso, label: shortDayLabel(iso),
      qty: m?.qty ?? 0, rows: m?.rows ?? 0, bySeries: { ...emptySeries(series), ...(m?.bySeries ?? {}) },
      loggedQty: l?.qty ?? 0, loggedRows: l?.rows ?? 0,
      doneQty: c?.qty ?? 0, doneRows: c?.rows ?? 0,
    };
  };

  // the x-axis: every day of the period when it is short enough, else the days that have anything
  const touched = [...new Set([...main.byDay.keys(), ...logged.byDay.keys(), ...closed.byDay.keys()])].sort();
  const firstISO = period.fromISO ?? touched[0] ?? period.toISO;
  const first = parseISODate(firstISO)!;
  const last = parseISODate(period.toISO)!;
  const span = Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1;
  let days: OdooDayPoint[];
  if (span > 0 && span <= FILL_GAPS_UP_TO) {
    days = [];
    for (let i = 0; i < span; i++) days.push(point(toISODate(new Date(first.getTime() + i * 86_400_000))));
  } else {
    days = touched.map(point);
  }

  const activeDays = main.byDay.size;
  return {
    period,
    basis,
    previous: prevRows ? prevWindow : null,
    series,
    days,
    totals: series.map((s) => {
      const t = main.totals.get(s)!;
      return {
        series: s, qty: t.qty, rows: t.rows,
        share: main.qty > 0 ? Math.round((t.qty / main.qty) * 1000) / 10 : 0,
        prevQty: prev ? (prev.totals.get(s)?.qty ?? 0) : null,
      };
    }),
    kpi: {
      qty: main.qty, rows: main.rows,
      loggedQty: logged.qty, loggedRows: logged.rows,
      doneQty: closed.qty, doneRows: closed.rows,
      doneNowRows, activeDays,
      qtyPerActiveDay: activeDays > 0 ? Math.round((main.qty / activeDays) * 10) / 10 : 0,
      prevQty: prev ? prev.qty : null,
      prevRows: prev ? prev.rows : null,
    },
  };
}
