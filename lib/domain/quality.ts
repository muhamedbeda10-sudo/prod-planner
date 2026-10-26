// Quality and rework on the transformers — pure, so the Production
// dashboard's figures are tested without a database:
//   - the leak test passed FIRST time: of the tanks whose first attempt fell
//     in the period, those whose first verdict was a pass (every attempt is
//     kept in TankEvent, so a re-test never flatters the rate);
//   - the days a tank waited between welding, its (latest) test and painting,
//     over the tanks that reached that step in the period — the median, a
//     single slow tank being noise;
//   - the pieces sent back upstream (ReturnEntry): open now, filed in the
//     period, by reason.
// Nothing here is the panels': they are recorded as quantities, with no
// serial, test or return of their own.

import { daysBetweenISO, weekStartISO } from "./dateSlicer";

export interface LeakAttempt {
  tankId: number;
  kind: "leak-pass" | "leak-repair";
  atISO: string;
}

export interface FirstPass {
  /** Tanks whose first leak test fell in the period. */
  units: number;
  passed: number;
  rate: number | null;
}

/** The first-time pass rate over the tanks first tested in the period. */
export function firstPassRate(attempts: readonly LeakAttempt[], fromISO: string, toISO: string): FirstPass {
  const first = new Map<number, LeakAttempt>();
  for (const a of attempts) {
    const cur = first.get(a.tankId);
    if (!cur || a.atISO < cur.atISO) first.set(a.tankId, a);
  }
  let units = 0, passed = 0;
  for (const a of first.values()) {
    const day = a.atISO.slice(0, 10);
    if (day < fromISO || day > toISO) continue;
    units += 1;
    if (a.kind === "leak-pass") passed += 1;
  }
  return { units, passed, rate: units > 0 ? passed / units : null };
}

export interface TankTimes {
  weldedISO: string;
  testedISO: string | null;
  paintedISO: string | null;
}

export interface CycleStat {
  /** Tanks that reached the step in the period. */
  n: number;
  medianDays: number | null;
  maxDays: number | null;
}

const days = (a: string, b: string) => Math.max(0, daysBetweenISO(a.slice(0, 10), b.slice(0, 10)));
const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stat = (xs: number[]): CycleStat => ({ n: xs.length, medianDays: median(xs), maxDays: xs.length ? Math.max(...xs) : null });

/** How long tanks waited: welding → test over the tanks tested in the
 *  period, test → painting over those painted in it. Whole days, the
 *  factory's. */
export function cycleDays(tanks: readonly TankTimes[], fromISO: string, toISO: string): { weldToTest: CycleStat; testToPaint: CycleStat } {
  const inPeriod = (iso: string | null) => !!iso && iso.slice(0, 10) >= fromISO && iso.slice(0, 10) <= toISO;
  const w2t: number[] = [], t2p: number[] = [];
  for (const t of tanks) {
    if (t.testedISO && inPeriod(t.testedISO)) w2t.push(days(t.weldedISO, t.testedISO));
    if (t.paintedISO && t.testedISO && inPeriod(t.paintedISO)) t2p.push(days(t.testedISO, t.paintedISO));
  }
  return { weldToTest: stat(w2t), testToPaint: stat(t2p) };
}

export interface ReturnRow {
  dateISO: string;
  qty: number;
  reason: string;
  status: string;
  /** The order it is on is flagged urgent. */
  urgent?: boolean;
}

export interface ReturnsSummary {
  open: { count: number; qty: number };
  /** Filed in the period, whatever their status now. */
  filed: { count: number; qty: number };
  /** Open rows on urgent orders. */
  openOnUrgent: number;
  /** The reasons of the period's returns and the open ones, most pieces first. */
  byReason: { reason: string; qty: number; count: number }[];
}

export function returnsSummary(rows: readonly ReturnRow[], fromISO: string, toISO: string, top = 5): ReturnsSummary {
  const out: ReturnsSummary = { open: { count: 0, qty: 0 }, filed: { count: 0, qty: 0 }, openOnUrgent: 0, byReason: [] };
  const reasons = new Map<string, { qty: number; count: number }>();
  for (const r of rows) {
    const open = r.status === "open";
    const filed = r.dateISO >= fromISO && r.dateISO <= toISO;
    if (open) {
      out.open.count += 1;
      out.open.qty += r.qty;
      if (r.urgent) out.openOnUrgent += 1;
    }
    if (filed) {
      out.filed.count += 1;
      out.filed.qty += r.qty;
    }
    if (open || filed) {
      const key = r.reason.trim() || "Not given";
      const cur = reasons.get(key) ?? { qty: 0, count: 0 };
      cur.qty += r.qty;
      cur.count += 1;
      reasons.set(key, cur);
    }
  }
  out.byReason = [...reasons.entries()].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.qty - a.qty || b.count - a.count).slice(0, top);
  return out;
}

/** The returns filed per week of the period (the Saturday each week starts), oldest first. */
export function returnsByWeek(rows: readonly ReturnRow[], fromISO: string, toISO: string): { weekISO: string; qty: number; count: number }[] {
  const byWeek = new Map<string, { qty: number; count: number }>();
  for (const r of rows) {
    if (r.dateISO < fromISO || r.dateISO > toISO) continue;
    const w = weekStartISO(r.dateISO);
    const cur = byWeek.get(w) ?? { qty: 0, count: 0 };
    cur.qty += r.qty;
    cur.count += 1;
    byWeek.set(w, cur);
  }
  return [...byWeek.entries()].map(([weekISO, v]) => ({ weekISO, ...v })).sort((a, b) => a.weekISO.localeCompare(b.weekISO));
}
