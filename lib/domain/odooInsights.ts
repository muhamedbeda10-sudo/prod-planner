// The ODOO dashboard's second half: how the close-out itself is going, beyond
// what was logged per product. Pure and tested; the reads are
// lib/server/odoo.ts (getOdooDashboard) and the drawing
// components/OdooDashboard.tsx.
//
//   funnel ...... rows logged in the period (a cancelled row is void, not
//                 logged) → those that carry Odoo's MO → those Done by now
//   status mix .. the rows of the period by their status right now, the
//                 cancelled ones included
//   lead time ... logged → closed, in days, for the rows closed in the period
//   aging ....... the logged rows still open, by how long they have waited
//   burn-up ..... cumulative logged against cumulative closed, day by day —
//                 the gap between the lines is the open backlog
//   BOM mix ..... the quantity logged per BOM, split by product

import { addDaysISO, daysBetweenISO } from "./dateSlicer";
import { statusTone, type OdooTone } from "./odoo";
import { isVoidRow, matchesBom, matchesProduct, productSeries, shortDayLabel, type OdooPeriod, type OdooSeries, type OdooStatRow } from "./odooStats";

export interface OdooInsightRow extends OdooStatRow {
  /** Odoo's MO is on the row. */
  hasMo?: boolean;
}

export interface StatusSlice { status: string; rows: number; qty: number; tone: OdooTone }
export interface LeadBucket { label: string; min: number; max: number; rows: number }
export interface AgeBucket { label: string; min: number; max: number; rows: number; qty: number }
export interface BurnPoint { dateISO: string; label: string; logged: number; closed: number; open: number }
export interface BomMixRow { bom: string; qty: number; bySeries: Record<OdooSeries, number> }

export interface OdooInsights {
  funnel: { logged: number; withMo: number; done: number };
  /** Share of the rows logged in the period that are Done by now, 0..1. */
  closeRate: number;
  statusMix: StatusSlice[];
  leadTime: {
    buckets: LeadBucket[];
    /** Rows closed in the period with a known logged day. */
    rows: number;
    medianDays: number | null;
    avgDays: number | null;
    p90Days: number | null;
    byProduct: { product: OdooSeries; avgDays: number; rows: number }[];
  };
  aging: { buckets: AgeBucket[]; openRows: number; openQty: number; oldestDays: number | null };
  burnUp: BurnPoint[];
  bomMix: { series: OdooSeries[]; rows: BomMixRow[] };
}

export const LEAD_BUCKETS: readonly Omit<LeadBucket, "rows">[] = [
  { label: "Same day", min: 0, max: 0 },
  { label: "1 day", min: 1, max: 1 },
  { label: "2 days", min: 2, max: 2 },
  { label: "3–5 days", min: 3, max: 5 },
  { label: "6–10 days", min: 6, max: 10 },
  { label: "11+ days", min: 11, max: Infinity },
];

export const AGE_BUCKETS: readonly Omit<AgeBucket, "rows" | "qty">[] = [
  { label: "0–1 days", min: 0, max: 1 },
  { label: "2–3 days", min: 2, max: 3 },
  { label: "4–7 days", min: 4, max: 7 },
  { label: "8–14 days", min: 8, max: 14 },
  { label: "15+ days", min: 15, max: Infinity },
];

/** Statuses shown by name in the mix; the rest are folded into "Other". */
const STATUS_SLOTS = 5;
/** BOMs shown in the mix, heaviest first. */
const BOM_SLOTS = 8;

const inWindow = (d: string, from: string | null, to: string) => (from === null || d >= from) && d <= to;

/** The value at a fraction of a sorted list, by the nearest-rank method. */
function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1];
}

export function buildOdooInsights(all: readonly OdooInsightRow[], period: OdooPeriod, bom: string | null = null, product: OdooSeries | null = null): OdooInsights {
  const rows = all.filter((r) => matchesBom(r, bom) && matchesProduct(r, product));
  const from = period.fromISO;
  const to = period.toISO;
  // the rows logged in the period — a void (cancelled) row is not one
  // (odooStats' isVoidRow); the status mix alone still shows them, so the
  // cancellations stay in sight
  const inPeriod = rows.filter((r) => inWindow(r.dateISO, from, to));
  const logged = inPeriod.filter((r) => !isVoidRow(r));
  const closedIn = rows.filter((r) => r.doneISO && inWindow(r.doneISO, from, to) && statusTone(r.status) === "ok");

  // ---- funnel + close rate
  const withMo = logged.filter((r) => r.hasMo).length;
  const done = logged.filter((r) => statusTone(r.status) === "ok").length;
  const funnel = { logged: logged.length, withMo, done };

  // ---- status mix (now), the commonest first, the tail folded
  const byStatus = new Map<string, StatusSlice>();
  for (const r of inPeriod) {
    const key = r.status.trim() || "—";
    const s = byStatus.get(key) ?? { status: key, rows: 0, qty: 0, tone: statusTone(key) };
    s.rows += 1;
    s.qty += r.qty;
    byStatus.set(key, s);
  }
  const sortedStatus = [...byStatus.values()].sort((a, b) => b.rows - a.rows || a.status.localeCompare(b.status));
  const statusMix = sortedStatus.slice(0, STATUS_SLOTS);
  const tail = sortedStatus.slice(STATUS_SLOTS);
  if (tail.length > 0) statusMix.push({ status: `Other (${tail.length})`, rows: tail.reduce((n, s) => n + s.rows, 0), qty: tail.reduce((n, s) => n + s.qty, 0), tone: "muted" });

  // ---- lead time: logged → closed, for rows closed in the period
  const leads: { days: number; product: OdooSeries }[] = [];
  for (const r of closedIn) {
    const days = daysBetweenISO(r.dateISO, r.doneISO!);
    if (days >= 0) leads.push({ days, product: productSeries(r.product) });
  }
  const sortedLeads = leads.map((l) => l.days).sort((a, b) => a - b);
  const buckets = LEAD_BUCKETS.map((b) => ({ ...b, rows: leads.filter((l) => l.days >= b.min && l.days <= b.max).length }));
  const prodLead = new Map<OdooSeries, { sum: number; n: number }>();
  for (const l of leads) {
    const a = prodLead.get(l.product) ?? { sum: 0, n: 0 };
    a.sum += l.days;
    a.n += 1;
    prodLead.set(l.product, a);
  }
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const leadTime = {
    buckets,
    rows: leads.length,
    medianDays: quantile(sortedLeads, 0.5),
    avgDays: leads.length ? round1(sortedLeads.reduce((a, b) => a + b, 0) / leads.length) : null,
    p90Days: quantile(sortedLeads, 0.9),
    byProduct: [...prodLead.entries()].map(([product, a]) => ({ product, avgDays: round1(a.sum / a.n), rows: a.n })).sort((a, b) => b.avgDays - a.avgDays || a.product.localeCompare(b.product)),
  };

  // ---- aging: logged in the period, still open (not done), age at the period's end
  const open = logged.filter((r) => statusTone(r.status) !== "ok");
  const ages = open.map((r) => ({ days: Math.max(0, daysBetweenISO(r.dateISO, to)), qty: r.qty }));
  const aging = {
    buckets: AGE_BUCKETS.map((b) => {
      const inB = ages.filter((a) => a.days >= b.min && a.days <= b.max);
      return { ...b, rows: inB.length, qty: inB.reduce((n, a) => n + a.qty, 0) };
    }),
    openRows: open.length,
    openQty: open.reduce((n, r) => n + r.qty, 0),
    oldestDays: ages.length ? Math.max(...ages.map((a) => a.days)) : null,
  };

  // ---- burn-up, from the period's first day (or the first logged day for "all")
  const start = from ?? logged.reduce<string | null>((m, r) => (m === null || r.dateISO < m ? r.dateISO : m), null);
  const burnUp: BurnPoint[] = [];
  if (start !== null) {
    const loggedOn = new Map<string, number>();
    for (const r of logged) loggedOn.set(r.dateISO, (loggedOn.get(r.dateISO) ?? 0) + 1);
    const closedOn = new Map<string, number>();
    for (const r of closedIn) closedOn.set(r.doneISO!, (closedOn.get(r.doneISO!) ?? 0) + 1);
    let L = 0;
    let C = 0;
    for (let d = start; d <= to && burnUp.length < 400; d = addDaysISO(d, 1)) {
      L += loggedOn.get(d) ?? 0;
      C += closedOn.get(d) ?? 0;
      burnUp.push({ dateISO: d, label: shortDayLabel(d), logged: L, closed: C, open: Math.max(0, L - C) });
    }
  }

  // ---- BOM mix: quantity logged per BOM, split by product
  const bomAgg = new Map<string, BomMixRow>();
  const seriesSeen = new Map<OdooSeries, number>();
  for (const r of logged) {
    const b = (r.bom ?? "").trim().toUpperCase() || "(no BOM)";
    const s = productSeries(r.product);
    const row = bomAgg.get(b) ?? { bom: b, qty: 0, bySeries: {} };
    row.qty += r.qty;
    row.bySeries[s] = (row.bySeries[s] ?? 0) + r.qty;
    bomAgg.set(b, row);
    seriesSeen.set(s, (seriesSeen.get(s) ?? 0) + r.qty);
  }
  const bomRows = [...bomAgg.values()].sort((a, b) => b.qty - a.qty || a.bom.localeCompare(b.bom)).slice(0, BOM_SLOTS);
  const series = [...seriesSeen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
  for (const row of bomRows) for (const s of series) row.bySeries[s] = row.bySeries[s] ?? 0;

  return {
    funnel,
    closeRate: logged.length ? done / logged.length : 0,
    statusMix,
    leadTime,
    aging,
    burnUp,
    bomMix: { series, rows: bomRows },
  };
}
