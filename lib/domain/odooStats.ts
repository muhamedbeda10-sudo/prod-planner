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

export function parseOdooRange(raw: string | undefined): OdooRange {
  return (ODOO_RANGES as readonly string[]).includes(raw ?? "") ? (raw as OdooRange) : "30d";
}

export const ODOO_RANGE_LABEL: Record<OdooRange, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  month: "This month",
  all: "All time",
};

/** The [from, to] days (ISO, inclusive) a range covers; `null` from = unbounded. */
export function rangeBounds(range: OdooRange, today: Date = new Date()): { fromISO: string | null; toISO: string } {
  const t = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const toISO = toISODate(t);
  if (range === "all") return { fromISO: null, toISO };
  if (range === "month") return { fromISO: toISODate(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1))), toISO };
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return { fromISO: toISODate(new Date(t.getTime() - (days - 1) * 86_400_000)), toISO };
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
}

export interface OdooDashboardData {
  range: OdooRange;
  fromISO: string | null;
  toISO: string;
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
  };
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
 * Aggregate rows (already filtered to the range) into per-day points, per-product
 * totals and the headline numbers.
 */
export function buildOdooDashboard(rows: OdooStatRow[], range: OdooRange, bounds: { fromISO: string | null; toISO: string }): OdooDashboardData {
  const byDay = new Map<string, OdooDayPoint>();
  const totalsMap = new Map<OdooSeries, OdooSeriesTotal>(ODOO_SERIES.map((s) => [s, { series: s, qty: 0, rows: 0 }]));
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

  // the x-axis: every day of the range when it is short enough, else the logged days
  const loggedDays = [...byDay.keys()].sort();
  const firstISO = bounds.fromISO ?? loggedDays[0] ?? bounds.toISO;
  const first = parseISODate(firstISO)!;
  const last = parseISODate(bounds.toISO)!;
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
    range,
    fromISO: bounds.fromISO,
    toISO: bounds.toISO,
    days,
    totals: ODOO_SERIES.map((s) => totalsMap.get(s)!).filter((t) => t.rows > 0),
    kpi: {
      qty, rows: rows.length, doneRows, doneQty, activeDays,
      qtyPerActiveDay: activeDays > 0 ? Math.round((qty / activeDays) * 10) / 10 : 0,
    },
  };
}
