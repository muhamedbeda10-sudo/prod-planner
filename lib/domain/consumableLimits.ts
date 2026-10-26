// CONSUMABLES limits — how much of a catalogue item may be handed out, to
// whom, over what period. Pure and tested; the reads are
// lib/server/consumableLimits.ts.
//
// A limit row belongs to one catalogue item and reads:
//
//   `qty` per `period` for `departments`, counted as a `basis`
//
//   period ..... month | every 2, 3, 4 or 6 months | a year — FIXED
//                windows of whole calendar months (Jan–Mar, Apr–Jun … for
//                3 months). The count starts again at zero when a window
//                starts. Nothing shorter than a month: the store is tracked
//                month by month, and draws stock in bulk.
//   departments  "*" = every department, else the departments (a worker
//                section's code, or a typed department) the limit covers.
//   basis ...... "pool": everything handed out to those departments counts
//                against the one number; "person": the number is per worker
//                (the sheet's "Qty for one person"). Hand-outs are recorded to
//                a department, never to a worker, so a per-person number is
//                turned into each department's own limit — the number times
//                the department's workers (expandPerWorker) — and counted
//                like any shared limit.
//
// The sheet's weekly limit is split between the departments it names — a
// row each — unless it is smaller than the number of departments, when it
// stays one shared pool (1 helmet a month for two welding sections cannot be
// halved). "All", "All fabrication" and "All fabrication and welding" are one
// pool for the whole group.

import { addDaysISO } from "./dateSlicer";
import { WORKER_SECTIONS, sectionLabel } from "./tanks";

export const LIMIT_PERIODS = ["month", "bimonth", "quarter", "fourmonth", "halfyear", "year"] as const;
export type LimitPeriod = (typeof LIMIT_PERIODS)[number];
/** The calendar months a period spans — the windows run from January in steps of it. */
export const PERIOD_MONTHS: Partial<Record<LimitPeriod, number>> = { month: 1, bimonth: 2, quarter: 3, fourmonth: 4, halfyear: 6, year: 12 };
/** A period of more than one month: counted whole over the window to date, never cut into months. */
export const isMultiMonth = (p: LimitPeriod) => (PERIOD_MONTHS[p] ?? 0) > 1;
/** pool: one number shared by the departments picked; each: every department
 *  picked has the number to itself; person: the number per worker, times each
 *  department's workers. */
export const LIMIT_BASES = ["pool", "each", "person"] as const;
export type LimitBasis = (typeof LIMIT_BASES)[number];

/** A limit's basis as the Excel exports spell it. */
export const BASIS_EXPORT = { pool: "shared", each: "each department", person: "per worker" } as const;

export const PERIOD_LABEL: Record<LimitPeriod, string> = {
  month: "a month", bimonth: "every 2 months", quarter: "every 3 months",
  fourmonth: "every 4 months", halfyear: "every 6 months", year: "a year",
};
export const PERIOD_NOUN: Record<LimitPeriod, string> = {
  month: "this month", bimonth: "these 2 months", quarter: "this quarter",
  fourmonth: "these 4 months", halfyear: "this half-year", year: "this year",
};
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
  /** A department's limit made from a per-person rule: the rule it came from
   *  (its own id is a made-up, negative one). */
  sourceId?: number;
  /** A per-person rule made a department's: the number per worker and the workers. */
  perWorker?: { qty: number; workers: number };
  /** What the rule reads as — the departments, and for a per-person one the
   *  sum ("Welding TX (2 per worker × 12)"). */
  label?: string;
  itemId: number;
  /** "*" or the departments covered. */
  departments: typeof ALL_DEPARTMENTS | readonly string[];
  basis: LimitBasis;
  period: LimitPeriod;
  qty: number;
}

/** One hand-out as the limits read it — for a hand-out to several workers
 *  (or a whole department), one per worker, each his equal share. */
export interface LimitUse {
  itemId: number;
  department: string;
  workerId: number;
  dayISO: string;
  qty: number;
}

/** A hand-out as stored, before the limits read it: to one worker, or to a
 *  group of them (the department's workers as they were on the day). */
export interface IssueForLimits {
  itemId: number;
  department: string;
  dayISO: string;
  qty: number;
  workerId: number | null;
  recipientIds: readonly number[];
}

/** The uses a hand-out counts as: the whole quantity against its worker, or
 *  an equal share against each worker of a group — so a per-person limit
 *  sees 20 gloves for a department of ten as 2 each. A group whose workers
 *  were not kept (none in the snapshot) still counts, whole, against the
 *  shared limits — under no worker (id 0). */
export function issueUses(i: IssueForLimits): LimitUse[] {
  const base = { itemId: i.itemId, department: i.department, dayISO: i.dayISO };
  if (i.workerId !== null) return [{ ...base, workerId: i.workerId, qty: i.qty }];
  const ids = [...new Set(i.recipientIds)];
  if (ids.length === 0) return [{ ...base, workerId: 0, qty: i.qty }];
  const share = i.qty / ids.length;
  return ids.map((workerId) => ({ ...base, workerId, qty: share }));
}

/** The hand-out a limit check weighs: to one worker, or to several at once. */
export interface LimitCandidate {
  itemId: number;
  department: string;
  dayISO: string;
  qty: number;
  /** One id for a single worker; every recipient for a group. */
  workerIds: readonly number[];
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

/** How a rule is named on screen. */
export function ruleLabel(rule: Pick<LimitRule, "departments" | "label">): string {
  return rule.label ?? departmentsLabel(rule.departments);
}

/**
 * Hand-outs name a department, not a worker — so a per-person rule becomes
 * one limit per department it covers: the number times the department's
 * workers (`workers`, the workers registered in it). A department with no
 * one on the workers list counts as one worker. "Every department" covers
 * the worker sections with people and any other department `seen` in the
 * hand-outs. Shared ("pool") rules pass through unchanged.
 */
export function expandPerWorker(rules: readonly LimitRule[], workers: ReadonlyMap<string, number>, seen: Iterable<string> = []): LimitRule[] {
  const out: LimitRule[] = [];
  for (const rule of rules) {
    if (rule.basis === "pool") { out.push(rule); continue; }
    const depts = rule.departments === ALL_DEPARTMENTS
      ? [...new Set([...WORKER_SECTIONS.map((x) => x.code as string).filter((c) => (workers.get(c) ?? 0) > 0), ...seen])]
      : [...rule.departments];
    depts.forEach((d, i) => {
      if (rule.basis === "each") {
        // every department its own number, whole
        out.push({ ...rule, id: -(rule.id * 1000 + i + 1), sourceId: rule.id, departments: [d], basis: "pool", label: sectionLabel(d) });
        return;
      }
      const n = workers.get(d) ?? 0;
      out.push({
        ...rule,
        id: -(rule.id * 1000 + i + 1),
        sourceId: rule.id,
        departments: [d],
        basis: "pool",
        qty: round3(rule.qty * Math.max(1, n)),
        perWorker: { qty: rule.qty, workers: n },
        label: `${sectionLabel(d)} (${rule.qty} per worker × ${n > 0 ? `${n} worker${n === 1 ? "" : "s"}` : "1 — no one on the workers list"})`,
      });
    });
  }
  return out;
}

// ---------------------------------------------------------------- headcount by month

/** The total row of a month's headcount record. */
export const HEADCOUNT_TOTAL = "*";
/** The workers each department had in a month ("2026-09"). */
export type HeadcountOf = (month: string) => ReadonlyMap<string, number>;

/**
 * The headcount a month is held to, from the monthly records: the current
 * month (or later) the list as it stands now (`live`); an earlier month its
 * own record, or the latest one before it (nothing changed in between), or —
 * before any was kept — the list as it stands.
 */
export function headcountResolver(
  rows: readonly { month: string; department: string; workers: number }[],
  live: ReadonlyMap<string, number>,
  currentMonth: string,
): HeadcountOf {
  const byMonth = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const m = byMonth.get(r.month) ?? new Map<string, number>();
    if (r.department !== HEADCOUNT_TOTAL) m.set(r.department, r.workers);
    byMonth.set(r.month, m);
  }
  const months = [...byMonth.keys()].sort();
  return (month) => {
    if (month >= currentMonth) return live;
    let found: string | undefined;
    for (const m of months) {
      if (m > month) break;
      found = m;
    }
    return found ? byMonth.get(found)! : live;
  };
}

/** Do two limits count any department twice (an "every department" limit
 *  overlaps every other)? Both then hold — a hand-out must fit each. */
export function rulesOverlap(a: Pick<LimitRule, "departments">, b: Pick<LimitRule, "departments">): boolean {
  if (a.departments === ALL_DEPARTMENTS || b.departments === ALL_DEPARTMENTS) return true;
  return a.departments.some((d) => (b.departments as readonly string[]).includes(d));
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
  const [y, m] = ymd(dayISO);
  // a run of whole calendar months, stepping from January
  const n = PERIOD_MONTHS[period] ?? 1;
  const m0 = Math.floor((m - 1) / n) * n + 1;
  return { from: iso(y, m0, 1), to: iso(y, m0 + n, 0) };
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Sep 2026", "Q3 2026", "Jul–Dec 2026", "2026". */
export function windowLabel(period: LimitPeriod, w: { from: string; to: string }): string {
  const [y, m] = ymd(w.from);
  if (period === "month") return `${MON[m - 1]} ${y}`;
  if (period === "quarter") return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  if (period === "year") return String(y);
  const last = ymd(w.to)[1];
  return `${MON[m - 1]}–${MON[last - 1]} ${y}`;
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
  /** Already handed out in the window, before this one — for a per-person
   *  rule and a group, what the group's workers had between them. */
  used: number;
  /** This hand-out. */
  adding: number;
  /** The number it went over — for a per-person rule and a group, the
   *  per-person number times the workers. */
  limit: number;
  /** The workers a per-person limit was multiplied by (1 otherwise). */
  people: number;
}

/** One line for the warning and the record: "Welding TX · a week (week of
 *  26 Sep): 12 already + 5 now = 17 of 15". */
export function describeBreach(b: LimitBreach): string {
  const who = b.basis === "person" ? `${b.departmentsLabel}, per person${b.people > 1 ? ` × ${b.people} workers` : ""}` : b.departmentsLabel;
  return `${who} · ${PERIOD_LABEL[b.period]} (${b.windowLabel}): ${b.used} already + ${b.adding} now = ${round3(b.used + b.adding)} of ${b.limit}`;
}

/** The windows a set of rules needs counted for a day — the query's range. */
export function windowsSpan(rules: readonly Pick<LimitRule, "period">[], dayISO: string): { from: string; to: string } | null {
  if (rules.length === 0) return null;
  const ws = rules.map((r) => periodWindow(r.period, dayISO));
  return { from: ws.map((w) => w.from).sort()[0], to: ws.map((w) => w.to).sort().at(-1)! };
}

/** Where a rule stands, in the window around the day, for a hand-out to these
 *  workers: a shared rule counts everything; a per-person rule counts what
 *  the workers had between them, against its number times the workers. */
export function candidateStanding(rule: LimitRule, uses: readonly LimitUse[], dayISO: string, workerIds: readonly number[]): { window: { from: string; to: string }; used: number; limit: number; people: number } {
  const w = periodWindow(rule.period, dayISO);
  if (rule.basis !== "person") return { window: w, used: usageIn(rule, uses, w), limit: rule.qty, people: 1 };
  const ids = [...new Set(workerIds)];
  const people = Math.max(1, ids.length);
  const used = round3(ids.reduce((n, id) => n + usageIn(rule, uses, w, id), 0));
  return { window: w, used, limit: round3(rule.qty * people), people };
}

/**
 * Would this hand-out take a rule over its limit? Every rule of the item that
 * covers the department is checked in its own window around the day; `uses`
 * are the other hand-outs (the one being edited left out). A per-person rule
 * and a hand-out to several workers: the number times the workers, against
 * what they had between them plus this one.
 */
export function checkAgainstLimits(rules: readonly LimitRule[], uses: readonly LimitUse[], candidate: LimitCandidate): LimitBreach[] {
  const out: LimitBreach[] = [];
  for (const rule of rules) {
    if (rule.itemId !== candidate.itemId || !coversDepartment(rule, candidate.department)) continue;
    const { window: w, used, limit, people } = candidateStanding(rule, uses, candidate.dayISO, candidate.workerIds);
    if (round3(used + candidate.qty) > limit + 1e-9) {
      out.push({
        ruleId: rule.id, period: rule.period, basis: rule.basis, departmentsLabel: ruleLabel(rule),
        window: w, windowLabel: windowLabel(rule.period, w), used, adding: candidate.qty, limit, people,
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
      ruleId: rule.id, itemId: rule.itemId, period: rule.period, basis: rule.basis, departmentsLabel: ruleLabel(rule),
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
      const base = { ruleId: rule.id, itemId: rule.itemId, period: rule.period, basis: rule.basis, departmentsLabel: ruleLabel(rule), window: w, windowLabel: windowLabel(rule.period, w), limit: rule.qty };
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

/**
 * The windows overlapping from..to that ended over a limit, each counted with
 * the headcount of its own last month — a per-worker limit for September is
 * the number times September's workers. `rules` are the limits as set (not
 * yet made each department's); `seen`: the departments hand-outs went to.
 */
export function exceedancesByMonth(
  rules: readonly LimitRule[], uses: readonly LimitUse[], fromISO: string, toISO: string,
  headcountOf: HeadcountOf, seen: Iterable<string> = [],
): LimitExceedance[] {
  const seenList = [...seen];
  const out: LimitExceedance[] = [];
  for (const rule of rules) {
    for (const w of windowsOverlapping(rule.period, fromISO, toISO)) {
      const counted = expandPerWorker([rule], headcountOf(w.to.slice(0, 7)), seenList);
      out.push(...exceedances(counted, uses, w.from, w.to));
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
