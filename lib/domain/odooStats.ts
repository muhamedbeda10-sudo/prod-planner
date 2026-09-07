// ODOO dashboard — pure aggregation of the close-out log by day and product.
// The server fetches the rows; this module turns them into what the charts
// and the table draw, so the numbers can be tested without a database.

import { parseISODate, toISODate } from "./dates";
import { isDoneStatus, ODOO_PRODUCTS } from "./odoo";

/** The series, in the fixed order the charts colour them. "Other" gathers any
 *  product typed that is not one of the sheet's names. */
export const ODOO_SERIES = [...ODOO_PRODUCTS, "Other"] as const;
export type OdooSeries = (typeof ODOO_SERIES)[number];

/** Fold a typed product onto one of the series — case and spacing forgiven. */
export function productSeries(product: string | null | undefined): OdooSeries {
  const key = (product ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  for (const p of ODOO_PRODUCTS) if (p.toLowerCase() === key) return p;
  if (key === "enclosure" || key === "enclouser") return "Encloser";
  if (key === "cb" || key === "cable-box") return "Cable Box";
  if (key === "tc" || key === "top-cover") return "Top Cover";
  if (key === "cf" || key === "core-frame") return "Core Frame";
  if (key === "tn") return "Tank";
  return "Other";
}

export const ODOO_RANGES = ["7d", "30d", "90d", "month", "all"] as const;
export type OdooRange = (typeof ODOO_RANGES)[number];
/** A preset, or a from/to typed by hand. */
export type OdooRangeKey = OdooRange | "custom";

export const ODOO_RANGE_LABEL: Record<OdooRangeKey, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  month: "This month",
  all: "All time",
  custom: "Custom",
};

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
  dateISO: string;
  product: string;
  qty: number;
  status: string;
}

export interface OdooDayPoint {
  dateISO: string;
  /** Short axis label, e.g. "6 Sep". */
  label: string;
  qty: number;
  rows: number;
  doneQty: number;
  bySeries: Record<OdooSeries, number>;
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
  /** The comparison window, when the period is bounded. */
  previous: { fromISO: string; toISO: string } | null;
  days: OdooDayPoint[];
  totals: OdooSeriesTotal[];
  kpi: {
    qty: number;
    rows: number;
    doneRows: number;
    doneQty: number;
    activeDays: number;
    /** Mean qty per day that had at least one row. */
    qtyPerActiveDay: number;
    /** The previous period's quantity and rows; null when there is none. */
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

function emptySeries(): Record<OdooSeries, number> {
  return Object.fromEntries(ODOO_SERIES.map((s) => [s, 0])) as Record<OdooSeries, number>;
}

/** Gaps are filled with zero days so a quiet day shows as quiet, not missing —
 *  up to this many days; past it (long "all time" spans) only logged days show. */
const FILL_GAPS_UP_TO = 120;

/**
 * Aggregate rows (already filtered to the period) into per-day points,
 * per-product totals and the headline numbers. `prevRows` are the previous
 * period's rows, for the comparisons; pass null when there is no previous period.
 */
export function buildOdooDashboard(rows: OdooStatRow[], period: OdooPeriod, prevRows: OdooStatRow[] | null = null): OdooDashboardData {
  const byDay = new Map<string, OdooDayPoint>();
  const totalsMap = new Map<OdooSeries, { qty: number; rows: number }>(ODOO_SERIES.map((s) => [s, { qty: 0, rows: 0 }]));
  let qty = 0, doneRows = 0, doneQty = 0;

  for (const r of rows) {
    const s = productSeries(r.product);
    let day = byDay.get(r.dateISO);
    if (!day) {
      day = { dateISO: r.dateISO, label: shortDayLabel(r.dateISO), qty: 0, rows: 0, doneQty: 0, bySeries: emptySeries() };
      byDay.set(r.dateISO, day);
    }
    day.qty += r.qty;
    day.rows += 1;
    day.bySeries[s] += r.qty;
    const t = totalsMap.get(s)!;
    t.qty += r.qty;
    t.rows += 1;
    qty += r.qty;
    if (isDoneStatus(r.status)) {
      doneRows += 1;
      doneQty += r.qty;
      day.doneQty += r.qty;
    }
  }

  // the previous period, per product, for the comparisons
  const prevBySeries = prevRows ? emptySeries() : null;
  let prevQty = 0;
  if (prevRows && prevBySeries) {
    for (const r of prevRows) {
      prevBySeries[productSeries(r.product)] += r.qty;
      prevQty += r.qty;
    }
  }

  // the x-axis: every day of the period when it is short enough, else the logged days
  const loggedDays = [...byDay.keys()].sort();
  const firstISO = period.fromISO ?? loggedDays[0] ?? period.toISO;
  const first = parseISODate(firstISO)!;
  const last = parseISODate(period.toISO)!;
  const span = Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1;
  let days: OdooDayPoint[];
  if (span > 0 && span <= FILL_GAPS_UP_TO) {
    days = [];
    for (let i = 0; i < span; i++) {
      const iso = toISODate(new Date(first.getTime() + i * 86_400_000));
      days.push(byDay.get(iso) ?? { dateISO: iso, label: shortDayLabel(iso), qty: 0, rows: 0, doneQty: 0, bySeries: emptySeries() });
    }
  } else {
    days = loggedDays.map((iso) => byDay.get(iso)!);
  }

  const activeDays = loggedDays.length;
  return {
    period,
    previous: prevRows ? previousPeriod(period) : null,
    days,
    totals: ODOO_SERIES
      .map((s) => ({ series: s, ...totalsMap.get(s)! }))
      .filter((t) => t.rows > 0)
      .map((t) => ({
        ...t,
        share: qty > 0 ? Math.round((t.qty / qty) * 1000) / 10 : 0,
        prevQty: prevBySeries ? prevBySeries[t.series] : null,
      })),
    kpi: {
      qty, rows: rows.length, doneRows, doneQty, activeDays,
      qtyPerActiveDay: activeDays > 0 ? Math.round((qty / activeDays) * 10) / 10 : 0,
      prevQty: prevRows ? prevQty : null,
      prevRows: prevRows ? prevRows.length : null,
    },
  };
}
