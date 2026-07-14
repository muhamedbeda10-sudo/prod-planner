// Smart Insights — rule-based analysis engine over the production data.
// Pure functions: forecasting (linear pace projection), momentum detection,
// bottleneck ranking, WIP aging, delivery-risk assessment and set balance.
// All copy is generated here in English; no external service is involved.

import { ITEMS, type Item } from "./constants";
import { dayNumber, parseISODate } from "./dates";

export type Severity = "critical" | "warn" | "good" | "info";

export interface Insight {
  id: string;
  severity: Severity;
  icon: string;
  title: string;
  detail: string;
  /** where the user can act on it */
  href?: string;
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warn: 1, good: 2, info: 3 };

export function sortInsights(list: Insight[]): Insight[] {
  return [...list].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const pctOf = (v: number, t: number) => (t > 0 ? Math.round((v / t) * 100) : 0);
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

// dayNumber 0 = 1970-01-01 (Thursday): 0=Thu, 1=Fri, 2=Sat, ...
const dowOf = (d: number) => ((d % 7) + 7) % 7;
const isFridayD = (d: number) => dowOf(d) === 1;

/** Working days from `fromISO` to `toISO` INCLUSIVE (Fridays and listed
 *  holidays carry no capacity). Returns 0 when the range is inverted. */
export function workingDaysInclusive(fromISO: string, toISO: string, holidays?: Set<string>): number {
  const from = parseISODate(fromISO);
  const to = parseISODate(toISO);
  if (!from || !to) return 0;
  const a = dayNumber(from);
  const b = dayNumber(to);
  if (b < a) return 0;
  let n = 0;
  for (let d = a; d <= b; d++) {
    if (isFridayD(d)) continue;
    if (holidays) {
      const iso = new Date(d * 86400000).toISOString().slice(0, 10);
      if (holidays.has(iso)) continue;
    }
    n++;
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Delivery risk — shared by the worklist badges and the insights panel */
/* ------------------------------------------------------------------ */

export type DeliveryRisk = "late" | "at-risk" | null;

/**
 * Early-warning assessment for a queue line that carries a due date:
 *  - "late"    — the due date already passed with open quantity;
 *  - "at-risk" — still on time, but the open quantity exceeds what the
 *    department can physically produce before the due date at full capacity
 *    (capacityPerItem pcs/item/working day), i.e. it WILL slip unless
 *    something changes today.
 */
export function assessDeliveryRisk(
  row: { dueISO: string | null; dueQty: number | null },
  todayISO: string,
  capacityPerItem: number,
  holidays?: Set<string>
): DeliveryRisk {
  if (!row.dueISO || row.dueQty === null || row.dueQty <= 0) return null;
  if (row.dueISO < todayISO) return "late";
  const daysLeft = workingDaysInclusive(todayISO, row.dueISO, holidays);
  const capacityWindow = Math.max(1, daysLeft) * capacityPerItem;
  return row.dueQty > capacityWindow ? "at-risk" : null;
}

/* --------------------------------------------------- */
/* Weekly pace forecast (linear projection to week end) */
/* --------------------------------------------------- */

export interface DeptWeekInput {
  dept: string;
  weekTotal: number; // period output so far (all items)
  weekItems: Record<Item, number>;
}

export function forecastDept(opts: {
  dept: string;
  weekTotal: number;
  targetPerItem: number; // per working day
  workingDays: number; // in the shown week
  paceDays: number; // elapsed working days (incl. today)
}): Insight | null {
  const { dept, weekTotal, targetPerItem, workingDays, paceDays } = opts;
  if (paceDays <= 0 || workingDays <= 0) return null;
  const weekTarget = targetPerItem * ITEMS.length * workingDays;
  const rate = weekTotal / paceDays;
  const remaining = Math.max(0, workingDays - paceDays);
  const projected = Math.round(weekTotal + rate * remaining);
  const pct = pctOf(projected, weekTarget);

  if (pct >= 100) {
    return {
      id: `forecast-${dept}`,
      severity: "good",
      icon: "📈",
      title: `${dept} is on track this week`,
      detail: `Projected ≈${projected} of ${weekTarget} pcs (${pct}%) by week end at the current rate of ${r1(rate)} pcs/day.`,
    };
  }
  const shortfall = weekTarget - projected;
  const neededRate = remaining > 0 ? Math.ceil((weekTarget - weekTotal) / remaining) : null;
  const closing =
    neededRate !== null
      ? ` Lifting output to ≈${neededRate} pcs/day for the remaining ${remaining} working day${remaining === 1 ? "" : "s"} would close the gap.`
      : ` The week ends today — the gap can no longer be recovered.`;
  return {
    id: `forecast-${dept}`,
    severity: pct >= 85 ? "warn" : "critical",
    icon: pct >= 85 ? "⏱️" : "🚨",
    title: `${dept} is forecast to miss the weekly target by ≈${shortfall} pcs`,
    detail: `Current rate is ${r1(rate)} pcs/day → projected ≈${projected} of ${weekTarget} pcs (${pct}%).${closing}`,
  };
}

/* ------------------------------------ */
/* Momentum — recent days vs prior days */
/* ------------------------------------ */

export function trendInsight(dept: string, recent: number[], prev: number[]): Insight | null {
  if (recent.length < 2 || prev.length < 2) return null;
  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const a = avg(prev);
  const b = avg(recent);
  if (a <= 0) return null;
  const change = (b - a) / a;
  if (Math.abs(change) < 0.15) return null; // noise — not worth a headline
  const pct = Math.round(Math.abs(change) * 100);
  if (change > 0) {
    return {
      id: `trend-${dept}`,
      severity: "good",
      icon: "🚀",
      title: `${dept} output is accelerating (+${pct}%)`,
      detail: `The last ${recent.length} working days averaged ${r1(b)} pcs/day vs ${r1(a)} in the days before — momentum is up.`,
    };
  }
  return {
    id: `trend-${dept}`,
    severity: change <= -0.35 ? "critical" : "warn",
    icon: "📉",
    title: `${dept} output is slowing (−${pct}%)`,
    detail: `The last ${recent.length} working days averaged ${r1(b)} pcs/day vs ${r1(a)} in the days before. Worth checking for a blocker.`,
  };
}

/* ------------------------------------------ */
/* Bottleneck — biggest buildup in the pipeline */
/* ------------------------------------------ */

export function bottleneckInsight(opts: {
  weldWaiting: number; // pcs cut but not yet welded
  paintWaiting: number; // pcs welded but not yet painted
  targetPerDeptDay: number;
}): Insight | null {
  const { weldWaiting, paintWaiting, targetPerDeptDay } = opts;
  if (targetPerDeptDay <= 0) return null;
  const stages = [
    { dept: "Welding", waiting: weldWaiting, href: "/worklist/welding" },
    { dept: "Painting", waiting: paintWaiting, href: "/worklist/painting" },
  ].sort((x, y) => y.waiting - x.waiting);
  const top = stages[0];
  const days = top.waiting / targetPerDeptDay;
  if (days < 2) return null; // a queue under ~2 days of work is healthy WIP
  return {
    id: "bottleneck",
    severity: days >= 4 ? "critical" : "warn",
    icon: "🚧",
    title: `${top.dept} is the current bottleneck`,
    detail: `≈${Math.round(top.waiting)} pcs are waiting for ${top.dept} — about ${r1(days)} working days of work at full capacity. Clearing this queue first unblocks the most downstream flow.`,
    href: top.href,
  };
}

/* ------------------------- */
/* WIP aging — stuck pieces  */
/* ------------------------- */

export function agingInsight(
  dept: string,
  href: string,
  rows: { ageDays: number | null; available: number; bom: string }[],
  thresholdDays = 7
): Insight | null {
  const stuck = rows.filter((r) => r.available > 0 && r.ageDays !== null && r.ageDays >= thresholdDays);
  if (stuck.length === 0) return null;
  const qty = Math.round(stuck.reduce((s, r) => s + r.available, 0));
  const oldest = stuck.reduce((m, r) => (r.ageDays! > (m?.ageDays ?? -1) ? r : m), stuck[0]);
  return {
    id: `aging-${dept}`,
    severity: (oldest.ageDays ?? 0) >= 14 ? "critical" : "warn",
    icon: "🕸️",
    title: `${stuck.length} line${stuck.length === 1 ? "" : "s"} stuck in the ${dept} queue for ${thresholdDays}+ days`,
    detail: `${qty} pcs have been waiting ${thresholdDays} days or more. Oldest: ${oldest.bom} (${oldest.ageDays} days). Long-waiting WIP usually signals missing parts or a disputed handover.`,
    href,
  };
}

/* ---------------------------------- */
/* Overdue commitments (cut backlog)  */
/* ---------------------------------- */

export function overdueInsight(opts: { lines: number; qty: number; oldestISO: string | null }): Insight | null {
  const { lines, qty, oldestISO } = opts;
  if (lines === 0 || qty <= 0) return null;
  return {
    id: "overdue-cut",
    severity: "critical",
    icon: "🔥",
    title: `${Math.round(qty)} pcs are past their promised delivery date`,
    detail: `${lines} line${lines === 1 ? "" : "s"} in the Cut backlog missed their dates${oldestISO ? ` — the oldest promise was ${ddmm(oldestISO)}` : ""}. These should be prioritized before new scheduled work.`,
    href: "/worklist/cut",
  };
}

/* ----------------------------------------------- */
/* At-risk deliveries — the early-warning forecast */
/* ----------------------------------------------- */

export function atRiskInsight(
  dept: string,
  href: string,
  rows: { bom: string; mo: string; item: string; dueISO: string | null; dueQty: number | null }[],
  todayISO: string,
  capacityPerItem: number,
  holidays?: Set<string>
): Insight | null {
  const risky = rows.filter((r) => assessDeliveryRisk(r, todayISO, capacityPerItem, holidays) === "at-risk");
  if (risky.length === 0) return null;
  const qty = Math.round(risky.reduce((s, r) => s + (r.dueQty ?? 0), 0));
  const examples = risky
    .slice(0, 3)
    .map((r) => `${r.bom} ${r.item} (${r.dueQty} due ${ddmm(r.dueISO!)})`)
    .join(", ");
  return {
    id: `risk-${dept}`,
    severity: "warn",
    icon: "⚠️",
    title: `${risky.length} ${dept} deliver${risky.length === 1 ? "y is" : "ies are"} likely to slip`,
    detail: `${qty} pcs are due sooner than the daily capacity can produce them: ${examples}${risky.length > 3 ? ", …" : ""}. They are still on time — acting today can save them.`,
    href,
  };
}

/* ------------------------------------------ */
/* Set balance — the limiting component        */
/* ------------------------------------------ */

export function setBalanceInsight(dept: string, weekItems: Record<Item, number>): Insight | null {
  const values = ITEMS.map((it) => ({ it, v: weekItems[it] }));
  const min = values.reduce((m, x) => (x.v < m.v ? x : m), values[0]);
  const others = values.filter((x) => x.it !== min.it);
  const avgOthers = others.reduce((s, x) => s + x.v, 0) / others.length;
  if (avgOthers <= 0 || min.v >= avgOthers * 0.7) return null;
  return {
    id: `balance-${dept}`,
    severity: "warn",
    icon: "⚖️",
    title: `${min.it} is limiting complete sets in ${dept}`,
    detail: `This week ${dept} produced ${Math.round(min.v)} × ${min.it} vs an average of ${Math.round(avgOthers)} for the other components. Complete transformers are capped by the slowest item — rebalancing capacity toward ${min.it} raises finished sets.`,
  };
}

/* ------------------------------- */
/* Idle department (working day)   */
/* ------------------------------- */

export function idleDeptInsight(dept: string, dayLabel: string, total: number): Insight | null {
  if (total > 0) return null;
  return {
    id: `idle-${dept}`,
    severity: "warn",
    icon: "😴",
    title: `No ${dept} output recorded ${dayLabel}`,
    detail: `${dayLabel === "today" ? "Nothing has been logged so far today" : `A full working day passed with zero logged output`} for ${dept}. If work happened, the handover log is falling behind reality.`,
    href: "/handover",
  };
}
