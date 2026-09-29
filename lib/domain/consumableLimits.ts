// CONSUMABLES limits — how much of a catalogue item may be handed out, to
// whom, over what period. Pure and tested; the reads are
// lib/server/consumableLimits.ts.
//
// A limit row belongs to one catalogue item and reads:
//
//   `qty` per `period` for `departments`, counted as a `basis`
//
//   period ..... day | week | month | quarter — FIXED windows on the factory's
//                calendar: the day; the work week Saturday → Friday; the
//                calendar month; the calendar quarter. The count starts again
//                at zero when a window starts.
//   departments  "*" = every department, else the departments (a worker
//                section's code, or a typed department) the limit covers.
//   basis ...... "pool": everything handed out to those departments counts
//                against the one number; "person": each worker has the number
//                to himself (the sheet's "Qty for one person").
//
// The sheet's weekly limit is split between the departments it names — a
// row each — unless it is smaller than the number of departments, when it
// stays one shared pool (1 helmet a month for two welding sections cannot be
// halved). "All", "All fabrication" and "All fabrication and welding" are one
// pool for the whole group.

import { addDaysISO } from "./dateSlicer";
import { WORKER_SECTIONS, sectionLabel } from "./tanks";

export const LIMIT_PERIODS = ["day", "week", "month", "quarter"] as const;
export type LimitPeriod = (typeof LIMIT_PERIODS)[number];
export const LIMIT_BASES = ["pool", "person"] as const;
export type LimitBasis = (typeof LIMIT_BASES)[number];

export const PERIOD_LABEL: Record<LimitPeriod, string> = { day: "a day", week: "a week", month: "a month", quarter: "3 months" };
export const PERIOD_NOUN: Record<LimitPeriod, string> = { day: "today", week: "this week", month: "this month", quarter: "this quarter" };
export const ALL_DEPARTMENTS = "*";

/** The fabrication sections — the sheet's "All fabrication". */
export const FABRICATION_SECTIONS: readonly string[] = WORKER_SECTIONS.filter((s) => ["Cut", "Punching", "Bending"].includes(s.dept)).map((s) => s.code);
/** …and with the welding sections — "All fabrication and welding". */
export const FAB_AND_WELD_SECTIONS: readonly string[] = [
  ...FABRICATION_SECTIONS,
  ...WORKER_SECTIONS.filter((s) => s.dept === "Welding" || s.dept === "WeldingLV").map((s) => s.code),
];

export interface LimitRule {
  id: number;
  itemId: number;
  /** "*" or the departments covered. */
  departments: typeof ALL_DEPARTMENTS | readonly string[];
  basis: LimitBasis;
  period: LimitPeriod;
  qty: number;
}

/** One hand-out as the limits read it. */
export interface LimitUse {
  itemId: number;
  department: string;
  workerId: number;
  dayISO: string;
  qty: number;
}

export function isLimitPeriod(x: string): x is LimitPeriod {
  return (LIMIT_PERIODS as readonly string[]).includes(x);
}
export function isLimitBasis(x: string): x is LimitBasis {
  return (LIMIT_BASES as readonly string[]).includes(x);
}

/** Stored form of the departments: "*" or a CSV of keys, deduplicated, in a
 *  stable order (worker sections first, in their list order; typed ones
 *  alphabetically after). */
export function serializeDepartments(d: typeof ALL_DEPARTMENTS | readonly string[]): string {
  if (d === ALL_DEPARTMENTS) return ALL_DEPARTMENTS;
  const set = new Set(d.map((x) => x.trim()).filter(Boolean));
  if (set.has(ALL_DEPARTMENTS)) return ALL_DEPARTMENTS;
  const sectionOrder = WORKER_SECTIONS.map((s) => s.code as string);
  const sections = sectionOrder.filter((c) => set.has(c));
  const typed = [...set].filter((x) => !sectionOrder.includes(x)).sort((a, b) => a.localeCompare(b));
  return [...sections, ...typed].join(",");
}

export function parseDepartments(csv: string): typeof ALL_DEPARTMENTS | string[] {
  const t = csv.trim();
  if (t === ALL_DEPARTMENTS) return ALL_DEPARTMENTS;
  return t.split(",").map((x) => x.trim()).filter(Boolean);
}

/** "All departments", "All fabrication", "Welding TX + Welding USS/LV" … */
export function departmentsLabel(d: typeof ALL_DEPARTMENTS | readonly string[]): string {
  if (d === ALL_DEPARTMENTS) return "All departments";
  const same = (group: readonly string[]) => group.length === d.length && group.every((g) => d.includes(g));
  if (same(FABRICATION_SECTIONS)) return "All fabrication";
  if (same(FAB_AND_WELD_SECTIONS)) return "All fabrication and welding";
  return d.map((x) => sectionLabel(x)).join(" + ");
}

export function coversDepartment(rule: Pick<LimitRule, "departments">, department: string): boolean {
  return rule.departments === ALL_DEPARTMENTS || rule.departments.includes(department);
}

// ---------------------------------------------------------------- windows

function ymd(iso: string): [number, number, number] {
  const [y, m, d] = iso.split("-").map(Number);
  return [y, m, d];
}
const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);

/** The fixed window of a period that holds a factory day, both ends included. */
export function periodWindow(period: LimitPeriod, dayISO: string): { from: string; to: string } {
  const [y, m, d] = ymd(dayISO);
  switch (period) {
    case "day":
      return { from: dayISO, to: dayISO };
    case "week": {
      // the work week starts on Saturday (getUTCDay 6)
      const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      const back = (dow + 1) % 7;
      const from = addDaysISO(dayISO, -back);
      return { from, to: addDaysISO(from, 6) };
    }
    case "month":
      return { from: iso(y, m, 1), to: iso(y, m + 1, 0) };
    case "quarter": {
      const q0 = Math.floor((m - 1) / 3) * 3 + 1;
      return { from: iso(y, q0, 1), to: iso(y, q0 + 3, 0) };
    }
  }
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "28 Sep", "week of 26 Sep", "Sep 2026", "Q3 2026". */
export function windowLabel(period: LimitPeriod, w: { from: string; to: string }): string {
  const [y, m, d] = ymd(w.from);
  if (period === "day") return `${d} ${MON[m - 1]}`;
  if (period === "week") return `week of ${d} ${MON[m - 1]}`;
  if (period === "month") return `${MON[m - 1]} ${y}`;
  return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
}

/** Every window of a period that overlaps from..to, in order. */
export function windowsOverlapping(period: LimitPeriod, fromISO: string, toISO: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  let w = periodWindow(period, fromISO);
  while (w.from <= toISO && out.length < 800) {
    out.push(w);
    w = periodWindow(period, addDaysISO(w.to, 1));
  }
  return out;
}

// ---------------------------------------------------------------- counting

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** What counts against a rule in one window (and, for a per-person rule, for one worker). */
export function usageIn(rule: LimitRule, uses: readonly LimitUse[], w: { from: string; to: string }, workerId?: number): number {
  let sum = 0;
  for (const u of uses) {
    if (u.itemId !== rule.itemId || u.dayISO < w.from || u.dayISO > w.to || !coversDepartment(rule, u.department)) continue;
    if (rule.basis === "person" && u.workerId !== workerId) continue;
    sum += u.qty;
  }
  return round3(sum);
}

export interface LimitBreach {
  ruleId: number;
  period: LimitPeriod;
  basis: LimitBasis;
  departmentsLabel: string;
  window: { from: string; to: string };
  windowLabel: string;
  /** Already handed out in the window, before this one. */
  used: number;
  /** This hand-out. */
  adding: number;
  limit: number;
}

/** One line for the warning and the record: "Welding TX · a week (week of
 *  26 Sep): 12 already + 5 now = 17 of 15". */
export function describeBreach(b: LimitBreach): string {
  const who = b.basis === "person" ? `${b.departmentsLabel}, per person` : b.departmentsLabel;
  return `${who} · ${PERIOD_LABEL[b.period]} (${b.windowLabel}): ${b.used} already + ${b.adding} now = ${round3(b.used + b.adding)} of ${b.limit}`;
}

/** The windows a set of rules needs counted for a day — the query's range. */
export function windowsSpan(rules: readonly Pick<LimitRule, "period">[], dayISO: string): { from: string; to: string } | null {
  if (rules.length === 0) return null;
  const ws = rules.map((r) => periodWindow(r.period, dayISO));
  return { from: ws.map((w) => w.from).sort()[0], to: ws.map((w) => w.to).sort().at(-1)! };
}

/**
 * Would this hand-out take a rule over its limit? Every rule of the item that
 * covers the department is checked in its own window around the day; `uses`
 * are the other hand-outs (the one being edited left out).
 */
export function checkAgainstLimits(rules: readonly LimitRule[], uses: readonly LimitUse[], candidate: LimitUse): LimitBreach[] {
  const out: LimitBreach[] = [];
  for (const rule of rules) {
    if (rule.itemId !== candidate.itemId || !coversDepartment(rule, candidate.department)) continue;
    const w = periodWindow(rule.period, candidate.dayISO);
    const used = usageIn(rule, uses, w, candidate.workerId);
    if (round3(used + candidate.qty) > rule.qty + 1e-9) {
      out.push({
        ruleId: rule.id, period: rule.period, basis: rule.basis, departmentsLabel: departmentsLabel(rule.departments),
        window: w, windowLabel: windowLabel(rule.period, w), used, adding: candidate.qty, limit: rule.qty,
      });
    }
  }
  return out;
}

export interface LimitStanding {
  ruleId: number;
  itemId: number;
  period: LimitPeriod;
  basis: LimitBasis;
  departmentsLabel: string;
  windowLabel: string;
  limit: number;
  /** Pool: everything in the window; person: the worker who took the most. */
  used: number;
  /** used / limit. */
  ratio: number;
  /** Person rules: the workers over their number, heaviest first. */
  over: { workerId: number; used: number }[];
  topWorkerId: number | null;
}

/** Where every rule stands in the window that holds a day — the alarm board. */
export function standings(rules: readonly LimitRule[], uses: readonly LimitUse[], dayISO: string): LimitStanding[] {
  return rules.map((rule) => {
    const w = periodWindow(rule.period, dayISO);
    let used: number;
    let over: { workerId: number; used: number }[] = [];
    let topWorkerId: number | null = null;
    if (rule.basis === "person") {
      const per = new Map<number, number>();
      for (const u of uses) {
        if (u.itemId !== rule.itemId || u.dayISO < w.from || u.dayISO > w.to || !coversDepartment(rule, u.department)) continue;
        per.set(u.workerId, round3((per.get(u.workerId) ?? 0) + u.qty));
      }
      const sorted = [...per.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      used = sorted[0]?.[1] ?? 0;
      topWorkerId = sorted[0]?.[0] ?? null;
      over = sorted.filter(([, q]) => q > rule.qty + 1e-9).map(([workerId, q]) => ({ workerId, used: q }));
    } else {
      used = usageIn(rule, uses, w);
    }
    return {
      ruleId: rule.id, itemId: rule.itemId, period: rule.period, basis: rule.basis, departmentsLabel: departmentsLabel(rule.departments),
      windowLabel: windowLabel(rule.period, w), limit: rule.qty, used, ratio: rule.qty > 0 ? used / rule.qty : 0, over, topWorkerId,
    };
  });
}

export interface LimitExceedance {
  ruleId: number;
  itemId: number;
  period: LimitPeriod;
  basis: LimitBasis;
  departmentsLabel: string;
  window: { from: string; to: string };
  windowLabel: string;
  limit: number;
  used: number;
  /** Per-person rules: the worker. */
  workerId: number | null;
}

/** Every window overlapping from..to in which a rule ended up over its
 *  limit (per worker for a per-person rule) — the dashboard's alarm history. */
export function exceedances(rules: readonly LimitRule[], uses: readonly LimitUse[], fromISO: string, toISO: string): LimitExceedance[] {
  const out: LimitExceedance[] = [];
  for (const rule of rules) {
    const mine = uses.filter((u) => u.itemId === rule.itemId && coversDepartment(rule, u.department));
    if (mine.length === 0) continue;
    for (const w of windowsOverlapping(rule.period, fromISO, toISO)) {
      const inW = mine.filter((u) => u.dayISO >= w.from && u.dayISO <= w.to);
      if (inW.length === 0) continue;
      const base = { ruleId: rule.id, itemId: rule.itemId, period: rule.period, basis: rule.basis, departmentsLabel: departmentsLabel(rule.departments), window: w, windowLabel: windowLabel(rule.period, w), limit: rule.qty };
      if (rule.basis === "person") {
        const per = new Map<number, number>();
        for (const u of inW) per.set(u.workerId, round3((per.get(u.workerId) ?? 0) + u.qty));
        for (const [workerId, used] of per) if (used > rule.qty + 1e-9) out.push({ ...base, used, workerId });
      } else {
        const used = round3(inW.reduce((n, u) => n + u.qty, 0));
        if (used > rule.qty + 1e-9) out.push({ ...base, used, workerId: null });
      }
    }
  }
  return out.sort((a, b) => b.window.from.localeCompare(a.window.from) || b.used / b.limit - a.used / a.limit);
}

// ---------------------------------------------------------------- the sheet's split

/**
 * The sheet's one number for several departments, as limit rows: split
 * equally (the remainder to the first departments), unless the number is
 * smaller than the departments, when it stays one pool. A group ("All …")
 * is always one pool; a per-person number is never split.
 */
export function splitSheetLimit(
  qty: number,
  departments: typeof ALL_DEPARTMENTS | readonly string[],
  opts: { group?: boolean; basis?: LimitBasis } = {},
): { departments: typeof ALL_DEPARTMENTS | string[]; qty: number }[] {
  if (departments === ALL_DEPARTMENTS || opts.group || opts.basis === "person" || departments.length <= 1 || qty < departments.length) {
    return [{ departments: departments === ALL_DEPARTMENTS ? ALL_DEPARTMENTS : [...departments], qty }];
  }
  const n = departments.length;
  const base = Math.floor(qty / n);
  const rest = qty - base * n;
  return departments.map((d, i) => ({ departments: [d], qty: base + (i < rest ? 1 : 0) }));
}
