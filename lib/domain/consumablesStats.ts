// The consumables helpers the dashboard (lib/domain/consumablesDecisions.ts)
// and the Material dashboard share, and the by-item summary the AI's
// consumables_summary sheet reads (lib/server/consumables.ts,
// getConsumablesDashboard). Pure, tested.
//
// Items are free text, so the same thing typed twice in different case or
// spacing is one item here, named the way it was typed most often. Quantities
// are only ever added up within one item — the store hands out kilos of wire
// and pairs of gloves, and a grand total across items would mean nothing.

import { addDaysISO } from "./dateSlicer";
import { round3 } from "./consumableLimits";
import { cleanText } from "./consumables";

export interface StatsRow {
  item: string;
  qty: number;
  department: string;
  /** Handed out of the catalogue; false for a name typed by hand. */
  catalogued: boolean;
}

/** `departments`: the departments it went to — a hand-out is its
 *  department's, so a group of a department counts once, not once per man.
 *  `catalogued`: a catalogue item, or a name typed by hand — never merged,
 *  as the dashboard keeps them apart. */
export interface ItemStat { item: string; catalogued: boolean; issues: number; qty: number; departments: number }

const fold = (s: string) => cleanText(s).toLowerCase();

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

/** The commonest way a name was written — the first, alphabetically, on a tie. */
export function commonestSpelling(names: Iterable<string>): string {
  const n = new Map<string, number>();
  for (const x of names) n.set(x.trim(), (n.get(x.trim()) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
}

/** The hours a single day's chart spans: the working day (07–17) at least,
 *  widened to any hour something happened in. */
export function hourSpan(used: readonly number[]): { first: number; last: number } {
  return { first: Math.min(7, ...used), last: Math.max(17, ...used) };
}
export const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

/** The period's hand-outs item by item, the most handed out first. */
export function consumablesStats(rows: readonly StatsRow[]): ItemStat[] {
  // grouped by the folded name — a catalogue item apart from the same name
  // typed by hand — shown in the commonest spelling
  const agg = new Map<string, { names: string[]; catalogued: boolean; issues: number; qty: number; departments: Set<string> }>();
  for (const r of rows) {
    const k = `${r.catalogued ? "c" : "t"}|${fold(r.item)}`;
    const a = agg.get(k) ?? { names: [], catalogued: r.catalogued, issues: 0, qty: 0, departments: new Set<string>() };
    a.names.push(r.item);
    a.issues += 1;
    a.qty += r.qty;
    a.departments.add(r.department);
    agg.set(k, a);
  }
  return [...agg.values()]
    .map((a) => ({ item: commonestSpelling(a.names), catalogued: a.catalogued, issues: a.issues, qty: round3(a.qty), departments: a.departments.size }))
    .sort((a, b) => b.issues - a.issues || b.qty - a.qty || a.item.localeCompare(b.item));
}
