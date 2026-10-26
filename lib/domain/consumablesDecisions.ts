// The CONSUMABLES dashboard read as decisions — what went out, to which
// department, and whether it is over the limits that are set. Pure and
// tested; the reads are lib/server/consumables.ts (getConsumablesDecisions).
//
// The rules it holds to, so a figure never says more than the log does:
//
//   a hand-out ........ one row of the log, however many workers it was for
//                       (a group or a whole department is ONE hand-out);
//   an item ........... a catalogue item (by its id), or a name typed by hand
//                       — the two are never merged, even when they read alike:
//                       a typed name is only SUGGESTED a catalogue item, for
//                       someone to review, and no limit counts it;
//   a quantity ........ only added up within one item, or one catalogue unit
//                       — gloves, litres and kilos never make one total;
//   a limit ........... the catalogue's limits as they are set now, counted
//                       as the record form counts them (expandPerWorker: an
//                       "each department" or per-worker limit is each
//                       department's own number), in the window that holds
//                       the day read, up to that day — the period's last day
//                       for the table, today for "now". A per-worker number is
//                       times the headcount recorded for the window's month
//                       (the list as it stands for the running month, or
//                       before any was recorded) — and the dashboard says which;
//   no limit .......... a typed item, or a catalogue item handed out to a
//                       department none of its limits covers: "no limit", never
//                       "within the limit";
//   recorded over ..... the flag the recorder set when the hand-out was saved
//                       (warned, and gave the reason) — kept apart from the
//                       standing recomputed here; no flags is not proof that
//                       nothing went over.

import { addDaysISO, daysBetweenISO } from "./dateSlicer";
import { formatDayShort } from "./format";
import { LOG_IDS_MAX, departmentLabel, foldItemName, matchCatalogueItem } from "./consumables";
import { commonestSpelling, hourLabel, hourSpan, pctChange, previousPeriod, spanDays } from "./consumablesStats";
import { MONTH_STATUS_LABEL, grade, monthBounds, shiftMonth } from "./consumableMonthly";
import {
  ALL_DEPARTMENTS, coversDepartment, exceedancesByMonth, expandPerWorker, periodWindow, round3, ruleLabel, usageIn, windowLabel,
  type HeadcountOf, type HeadcountSource, type LimitBasis, type LimitPeriod, type LimitRule, type LimitUse,
} from "./consumableLimits";
import type { CockpitAction } from "./kpis";

// ---------------------------------------------------------------- filters

export const LINK_FILTERS = ["linked", "unlinked"] as const;
export type LinkFilter = (typeof LINK_FILTERS)[number];
export const LINK_LABEL: Record<LinkFilter, string> = { linked: "In the catalogue", unlinked: "Not in the catalogue" };

/** Where an item × department stands against its limits at the period's end. */
export const ROW_STATUSES = ["over", "near", "within", "none"] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];
/** The monthly review's words for the same grades. */
export const ROW_STATUS_LABEL: Record<RowStatus, string> = {
  over: MONTH_STATUS_LABEL.over,
  near: MONTH_STATUS_LABEL.near,
  within: "Within the limit",
  none: MONTH_STATUS_LABEL.nolimit,
};
/** Worst first: what needs a decision opens the table. */
const STATUS_RANK: Record<RowStatus, number> = { over: 0, none: 1, near: 2, within: 3 };

export interface DecisionFilters {
  /** A department key (a worker section's code, or a typed department). */
  department: string | null;
  /** An item key: "c12" (catalogue item 12) or "t:gloves" (a typed name, folded). */
  item: string | null;
  link: LinkFilter | null;
  status: RowStatus | null;
}

export const NO_FILTERS: DecisionFilters = { department: null, item: null, link: null, status: null };
/** The address keys the filters are written under, in DecisionFilters' order. */
export const FILTER_KEYS = ["dept", "item", "link", "status"] as const;

/** A search parameter's one value ("" for none, the first of several). */
export const firstParam = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? "") : typeof v === "string" ? v : "").trim();

/** The filters from the address (?dept=&item=&link=&status=) — anything that
 *  does not read is no filter, never an error. */
export function readDecisionFilters(sp: Record<string, unknown>): DecisionFilters {
  const department = firstParam(sp.dept);
  const item = firstParam(sp.item);
  const link = firstParam(sp.link);
  const status = firstParam(sp.status);
  return {
    department: department && department.length <= 80 ? department : null,
    item: /^c\d{1,9}$/.test(item) ? item : /^t:.{1,120}$/.test(item) ? `t:${foldItemName(item.slice(2))}` : null,
    link: (LINK_FILTERS as readonly string[]).includes(link) ? (link as LinkFilter) : null,
    status: (ROW_STATUSES as readonly string[]).includes(status) ? (status as RowStatus) : null,
  };
}

/** The filters as the address writes them — what the page's links carry. */
export function filterParams(f: DecisionFilters): [string, string][] {
  const values = [f.department, f.item, f.link, f.status];
  return FILTER_KEYS.flatMap((k, i) => (values[i] ? [[k, values[i]!] as [string, string]] : []));
}

export const hasFilters = (f: DecisionFilters) => filterParams(f).length > 0;

/** An item's key: the catalogue id, or the typed name folded. */
export function itemKeyOf(itemId: number | null, name: string): string {
  return itemId !== null ? `c${itemId}` : `t:${foldItemName(name)}`;
}

/** Does a limit fall inside the filters? A typed item has none, so "not in
 *  the catalogue" leaves every limit out. The limit status is the table's
 *  reading at the period's end and is not applied to the limits' own boards. */
export function ruleInScope(f: DecisionFilters, itemId: number, departments: typeof ALL_DEPARTMENTS | readonly string[]): boolean {
  if (f.link === "unlinked") return false;
  if (f.item && f.item !== `c${itemId}`) return false;
  if (f.department && !coversDepartment({ departments }, f.department)) return false;
  return true;
}

// ---------------------------------------------------------------- input

export type IssueRecipient =
  | { kind: "worker"; name: string; empId: string }
  /** A group or a whole department: its label and how many workers it was for. */
  | { kind: "group"; label: string; count: number };

/** One live hand-out of the period, as the dashboard reads it. */
export interface DecisionIssue {
  id: number;
  dayISO: string;
  /** Factory hour, 0..23. */
  hour: number;
  item: string;
  itemId: number | null;
  qty: number;
  department: string;
  recipient: IssueRecipient;
  overLimit: boolean;
  overLimitReason: string | null;
  recordedBy: string;
}

/** A hand-out of the period before, for the like-for-like comparison. */
type PreviousIssue = Pick<DecisionIssue, "itemId" | "item" | "department" | "dayISO" | "hour">;

export interface DecisionCatalogueItem {
  id: number;
  code: string | null;
  name: string;
  uom: string;
  active: boolean;
}

export interface DecisionInput {
  fromISO: string;
  toISO: string;
  todayISO: string;
  /** The period's live hand-outs, every one (the filters are applied here). */
  issues: readonly DecisionIssue[];
  /** The period before, of the same length — null when the log does not go
   *  back over all of it, or it is not needed (the comparison is not shown). */
  previous: readonly PreviousIssue[] | null;
  catalogue: readonly DecisionCatalogueItem[];
  /** The limits of active items as they are set (not yet made each department's). */
  rules: readonly LimitRule[];
  /** Catalogue hand-outs over usesSpan(rules, toISO, todayISO). */
  uses: readonly LimitUse[];
  headcountOf: HeadcountOf;
  headcountSourceOf: (month: string) => HeadcountSource;
  /** Every department a live hand-out went to — an "every department" limit covers them. */
  seen: readonly string[];
}

// ---------------------------------------------------------------- output

export interface RowLimit {
  /** The counted limit's id (a department's share of a limit has a made-up negative one). */
  ruleId: number;
  /** The limit as it is set on the Limits tab. */
  sourceId: number;
  basis: LimitBasis;
  period: LimitPeriod;
  /** The number as set (per worker for a per-worker limit). */
  qty: number;
  perWorker: { qty: number; workers: number } | null;
  /** Who it is counted for: the department, or the departments sharing one number. */
  departmentsLabel: string;
  /** One number shared with other departments: `used` is theirs together. */
  shared: boolean;
  window: { from: string; to: string };
  windowLabel: string;
  /** The window runs past the day read — counted up to that day. */
  toDate: boolean;
  limit: number;
  used: number;
  /** What is still free (0 once over). */
  left: number;
  /** How far past the limit (0 within it). */
  over: number;
  ratio: number;
  status: Exclude<RowStatus, "none">;
  /** A per-worker limit: whose headcount it is times. */
  headcount: HeadcountSource | null;
}

interface CatalogueSuggestion {
  id: number;
  name: string;
  code: string | null;
  /** "same": the typed name or code is the catalogue item's (folded); "similar": most words match. */
  match: "same" | "similar";
}

export interface DecisionRow {
  key: string;
  itemKey: string;
  itemId: number | null;
  item: string;
  code: string | null;
  /** The catalogue unit; null for a typed item (none was recorded). */
  uom: string | null;
  department: string;
  departmentLabel: string;
  /** Handed out in the period — one item, one unit. */
  qty: number;
  handOuts: number;
  lastDayISO: string;
  /** Hand-outs flagged over a limit when they were saved, and the latest reason. */
  recordedOver: number;
  lastReason: string | null;
  status: RowStatus;
  /** Every limit that counts the row (each must hold), the worst first; none with no limit. */
  limits: RowLimit[];
  /** A typed item: the catalogue item it may be, to review — never applied. */
  suggestion: CatalogueSuggestion | null;
  /** Its hand-outs, newest first (the latest ROW_ISSUES). */
  issues: DecisionIssue[];
  /** The latest LOG_IDS_MAX of its hand-outs — what the log opens on (?ids=). */
  logIds: number[];
}

/** A limit as the decisions list reads it — over now, or a window that closed over. */
export interface LimitAlarm {
  ruleId: number;
  item: string;
  uom: string;
  departmentsLabel: string;
  windowLabel: string;
  used: number;
  limit: number;
}

export interface ConsumablesDecisions {
  fromISO: string;
  toISO: string;
  /** The period ends today: its standings are "now". */
  endsToday: boolean;
  filters: DecisionFilters;
  kpis: {
    handOuts: number;
    /** The period before, under the same filters; null when it is not comparable. */
    previousHandOuts: number | null;
    /** % change; null with no comparison or nothing before (N/A). */
    change: number | null;
    /** Why there is no comparison, when there is none. */
    noComparison: string | null;
    items: number;
    departments: number;
    /** Hand-outs and items no limit counts. */
    uncovered: { handOuts: number; items: number };
    /** Hand-outs of catalogue items. */
    linked: number;
    /** linked / handOuts; null with no hand-out. */
    linkedShare: number | null;
    /** The quantity, only when one item (one unit) is picked. */
    quantity: { qty: number; uom: string | null } | null;
  };
  rows: DecisionRow[];
  trend: {
    unit: "hour" | "day" | "week";
    /** `prev`: the same place in the period before; null when not comparable.
     *  `fromISO`..`toISO`: the bucket's days (the period's one day for hours). */
    buckets: { key: string; label: string; issues: number; prev: number | null; fromISO: string; toISO: string }[];
  };
  /** Each item in its own unit, most hand-outs first. */
  items: { itemKey: string; item: string; uom: string | null; handOuts: number; qty: number }[];
  /** The catalogue units handed out — the items ranking can read one in quantity. */
  units: string[];
  /** The latest hand-out flagged over a limit when saved, and how many were. */
  latestRecordedOver: DecisionIssue | null;
  recordedOverCount: number;
  /** The limits over NOW (today's reading, whatever the period), and the
   *  windows of the last EXCEEDANCE_MONTHS finished months that closed over —
   *  both in the filters' scope. */
  limits: { overNow: LimitAlarm[]; closedOver: LimitAlarm[]; closedSpan: { from: string; to: string } };
  /** The filters' choices: what the period holds, and what is picked. */
  options: {
    departments: { value: string; label: string }[];
    items: { value: string; label: string }[];
  };
  quality: {
    /** Live hand-outs in the period, every filter aside. */
    total: number;
    /** …of which typed by hand. */
    unlinked: number;
    /** A limit was counted in a window already over — with today's limits. */
    pastWindows: boolean;
    /** Whose headcount the per-worker limits were counted with — each once
     *  (the period's last month when no per-worker limit is set). */
    headcount: HeadcountSource[];
  };
}

export const ROW_ISSUES = 50;
/** Longer than this, the trend reads week by week. */
const TREND_DAYS_MAX = 45;
/** How many finished months "closed over a limit" looks back over. */
export const EXCEEDANCE_MONTHS = 3;

// ---------------------------------------------------------------- suggestions

const words = (s: string) => foldItemName(s).split(/[^\p{L}\p{N}.]+/u).filter((w) => w.length >= 2);

/**
 * The catalogue item a typed name may be: the same name or code once case,
 * spacing and × are set aside, or else the active item that shares most of
 * its words (half of them at least, one of three letters or more). Only a
 * suggestion — the hand-out keeps its typed name and no limit counts it
 * until someone links it.
 */
export function suggestCatalogueItem(text: string, catalogue: readonly DecisionCatalogueItem[]): CatalogueSuggestion | null {
  const offered = catalogue.filter((c) => c.active);
  const same = matchCatalogueItem(text, offered);
  if (same) return { id: same.id, name: same.name, code: same.code, match: "same" };
  const mine = new Set(words(text));
  if (mine.size === 0) return null;
  let best: { c: DecisionCatalogueItem; score: number } | null = null;
  for (const c of offered) {
    const theirs = new Set(words(c.name));
    const shared = [...mine].filter((w) => theirs.has(w));
    if (!shared.some((w) => w.length >= 3)) continue;
    const score = shared.length / new Set([...mine, ...theirs]).size;
    if (score >= 0.5 && (!best || score > best.score || (score === best.score && c.name.localeCompare(best.c.name) < 0))) best = { c, score };
  }
  return best ? { id: best.c.id, name: best.c.name, code: best.c.code, match: "similar" } : null;
}

// ---------------------------------------------------------------- the limits

/** The finished months "closed over a limit" looks back over. */
export function closedSpan(todayISO: string): { from: string; to: string } {
  const thisMonth = todayISO.slice(0, 7);
  return { from: monthBounds(shiftMonth(thisMonth, -EXCEEDANCE_MONTHS)).from, to: monthBounds(shiftMonth(thisMonth, -1)).to };
}

/** The days the hand-outs must be read over for the dashboard: every window
 *  that holds the period's last day or today, and every window of the months
 *  looked back over — up to today. Null with no limit. */
export function usesSpan(rules: readonly Pick<LimitRule, "period">[], toISO: string, todayISO: string): { from: string; to: string } | null {
  if (rules.length === 0) return null;
  const past = closedSpan(todayISO);
  const froms = rules.flatMap((r) => [periodWindow(r.period, toISO).from, periodWindow(r.period, todayISO).from, periodWindow(r.period, past.from).from]);
  return { from: froms.sort()[0], to: todayISO };
}

interface Counted {
  rule: LimitRule;
  source: LimitRule;
  window: { from: string; to: string };
  headcount: HeadcountSource | null;
}

/** Every limit as it is counted for the window that holds `dayISO`: an
 *  "each" or per-worker limit made each department's — the per-worker number
 *  times the headcount of the window's last month. */
function countedRules(rules: readonly LimitRule[], dayISO: string, headcountOf: HeadcountOf, sourceOf: (month: string) => HeadcountSource, seen: readonly string[]): Counted[] {
  return rules.flatMap((source) => {
    const window = periodWindow(source.period, dayISO);
    const month = window.to.slice(0, 7);
    const headcount = source.basis === "person" ? sourceOf(month) : null;
    return expandPerWorker([source], headcountOf(month), seen).map((rule) => ({ rule, source, window, headcount }));
  });
}

/** A counted limit's standing up to `dayISO`; `uses`: the item's own. */
function rowLimit(c: Counted, uses: readonly LimitUse[], dayISO: string): RowLimit {
  const used = usageIn(c.rule, uses, { from: c.window.from, to: c.window.to < dayISO ? c.window.to : dayISO });
  const limit = c.rule.qty;
  const g = grade(used, limit);
  return {
    ruleId: c.rule.id, sourceId: c.source.id, basis: c.source.basis, period: c.rule.period, qty: c.source.qty,
    perWorker: c.rule.perWorker ?? null,
    departmentsLabel: ruleLabel(c.rule),
    shared: c.rule.departments === ALL_DEPARTMENTS || c.rule.departments.length > 1,
    window: c.window, windowLabel: windowLabel(c.rule.period, c.window), toDate: c.window.to > dayISO,
    limit, used, left: Math.max(0, round3(limit - used)), over: Math.max(0, round3(used - limit)),
    // a limit of nothing with something used reads fullest of all
    ratio: limit > 0 ? used / limit : used > 0 ? Number.MAX_SAFE_INTEGER : 0,
    status: g === "over" ? "over" : g === "near" ? "near" : "within",
    headcount: c.headcount,
  };
}

const LIMIT_RANK: Record<RowLimit["status"], number> = { over: 0, near: 1, within: 2 };

// ---------------------------------------------------------------- the trend

function trendOf(issues: readonly PreviousIssue[], previous: readonly PreviousIssue[] | null, fromISO: string, toISO: string, now: Date): ConsumablesDecisions["trend"] {
  if (fromISO === toISO) {
    const per = new Array<number>(24).fill(0);
    const prev = new Array<number>(24).fill(0);
    for (const i of issues) per[i.hour] += 1;
    for (const i of previous ?? []) prev[i.hour] += 1;
    const { first, last } = hourSpan([...issues, ...(previous ?? [])].map((i) => i.hour));
    const buckets: ConsumablesDecisions["trend"]["buckets"] = [];
    for (let h = first; h <= last; h++) {
      buckets.push({ key: String(h), label: hourLabel(h), issues: per[h], prev: previous ? prev[h] : null, fromISO, toISO });
    }
    return { unit: "hour", buckets };
  }
  const days = spanDays(fromISO, toISO);
  const unit = days > TREND_DAYS_MAX ? "week" : "day";
  const size = unit === "week" ? 7 : 1;
  const prevFrom = previousPeriod(fromISO, toISO).fromISO;
  const buckets: ConsumablesDecisions["trend"]["buckets"] = [];
  for (let i = 0; i < days && buckets.length < 400; i += size) {
    const a = addDaysISO(fromISO, i);
    const b = addDaysISO(fromISO, Math.min(days, i + size) - 1);
    buckets.push({ key: a, label: unit === "week" ? `wk ${formatDayShort(a, now)}` : formatDayShort(a, now), issues: 0, prev: previous ? 0 : null, fromISO: a, toISO: b });
  }
  const at = (dayISO: string, start: string) => Math.floor(daysBetweenISO(start, dayISO) / size);
  for (const i of issues) {
    const b = buckets[at(i.dayISO, fromISO)];
    if (b) b.issues += 1;
  }
  // the period before lines up day for day (week for week) from its own start
  for (const i of previous ?? []) {
    const b = buckets[at(i.dayISO, prevFrom)];
    if (b && b.prev !== null) b.prev += 1;
  }
  return { unit, buckets };
}

// ---------------------------------------------------------------- the dashboard

function matches(f: DecisionFilters, i: Pick<DecisionIssue, "itemId" | "item" | "department">): boolean {
  if (f.department && i.department !== f.department) return false;
  if (f.link === "linked" && i.itemId === null) return false;
  if (f.link === "unlinked" && i.itemId !== null) return false;
  if (f.item && itemKeyOf(i.itemId, i.item) !== f.item) return false;
  return true;
}

export function buildConsumablesDecisions(input: DecisionInput, filters: DecisionFilters): ConsumablesDecisions {
  const { fromISO, toISO, todayISO } = input;
  const now = new Date(`${todayISO}T12:00:00Z`);
  const catalogueOf = new Map(input.catalogue.map((c) => [c.id, c]));
  // the limits count an item's own hand-outs only
  const usesOf = new Map<number, LimitUse[]>();
  for (const u of input.uses) {
    const list = usesOf.get(u.itemId);
    if (list) list.push(u);
    else usesOf.set(u.itemId, [u]);
  }
  const counted = countedRules(input.rules, toISO, input.headcountOf, input.headcountSourceOf, input.seen);
  const countedOf = new Map<number, Counted[]>();
  for (const c of counted) countedOf.set(c.rule.itemId, [...(countedOf.get(c.rule.itemId) ?? []), c]);
  // a shared limit stands the same for every department row it covers
  const standing = new Map<number, RowLimit>();
  const standingOf = (c: Counted) => {
    if (!standing.has(c.rule.id)) standing.set(c.rule.id, rowLimit(c, usesOf.get(c.rule.itemId) ?? [], toISO));
    return standing.get(c.rule.id)!;
  };

  // ---- an item × department per row, over the hand-outs the filters keep
  const groups = new Map<string, DecisionIssue[]>();
  for (const i of input.issues) {
    if (!matches(filters, i)) continue;
    const k = `${itemKeyOf(i.itemId, i.item)}|${i.department}`;
    const g = groups.get(k);
    if (g) g.push(i);
    else groups.set(k, [i]);
  }

  let rows: DecisionRow[] = [...groups.entries()].map(([key, list]) => {
    const first = list[0];
    const itemKey = itemKeyOf(first.itemId, first.item);
    const cat = first.itemId !== null ? catalogueOf.get(first.itemId) : undefined;
    const sorted = [...list].sort((a, b) => b.dayISO.localeCompare(a.dayISO) || b.id - a.id);
    const flagged = sorted.filter((i) => i.overLimit);
    const limits = first.itemId === null ? [] : (countedOf.get(first.itemId) ?? [])
      .filter((c) => coversDepartment(c.rule, first.department))
      .map(standingOf)
      .sort((a, b) => LIMIT_RANK[a.status] - LIMIT_RANK[b.status] || b.ratio - a.ratio || a.departmentsLabel.localeCompare(b.departmentsLabel));
    const item = cat?.name ?? commonestSpelling(list.map((i) => i.item));
    return {
      key, itemKey, itemId: first.itemId, item, code: cat?.code ?? null, uom: cat?.uom ?? null,
      department: first.department, departmentLabel: departmentLabel(first.department),
      qty: round3(list.reduce((n, i) => n + i.qty, 0)), handOuts: list.length, lastDayISO: sorted[0].dayISO,
      recordedOver: flagged.length, lastReason: flagged.find((i) => i.overLimitReason)?.overLimitReason ?? null,
      status: limits[0]?.status ?? "none",
      limits,
      suggestion: first.itemId === null ? suggestCatalogueItem(item, input.catalogue) : null,
      issues: sorted.slice(0, ROW_ISSUES),
      logIds: sorted.slice(0, LOG_IDS_MAX).map((i) => i.id),
    };
  });
  if (filters.status) rows = rows.filter((r) => r.status === filters.status);
  rows.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || (b.limits[0]?.ratio ?? 0) - (a.limits[0]?.ratio ?? 0) || b.handOuts - a.handOuts || a.item.localeCompare(b.item) || a.departmentLabel.localeCompare(b.departmentLabel));

  // what the rows hold, hand-out by hand-out — the cards and the trend count these
  const shown = rows.flatMap((r) => groups.get(r.key)!);

  // ---- the comparison: the period before, under the same filters — not
  // under a limit status, which is this period's own reading
  let previous: PreviousIssue[] | null = null;
  let noComparison: string | null = null;
  if (filters.status) noComparison = "A limit status is this period's own reading — the period before is not compared under it";
  else if (input.previous === null) noComparison = "The log does not go back over the whole period before";
  else previous = input.previous.filter((i) => matches(filters, i));

  // ---- items, in their own unit
  const totals = new Map<string, ConsumablesDecisions["items"][number]>();
  for (const r of rows) {
    const t = totals.get(r.itemKey) ?? { itemKey: r.itemKey, item: r.item, uom: r.uom, handOuts: 0, qty: 0 };
    t.handOuts += r.handOuts;
    t.qty = round3(t.qty + r.qty);
    totals.set(r.itemKey, t);
  }
  const items = [...totals.values()].sort((a, b) => b.handOuts - a.handOuts || b.qty - a.qty || a.item.localeCompare(b.item));

  const none = rows.filter((r) => r.status === "none");
  const linked = shown.filter((i) => i.itemId !== null).length;
  const prevCount = previous ? previous.length : null;
  const flagged = shown.filter((i) => i.overLimit).sort((a, b) => b.dayISO.localeCompare(a.dayISO) || b.id - a.id);

  // ---- the limits now (the same counting, at today) and the windows that closed over
  const nowCounted = countedRules(input.rules, todayISO, input.headcountOf, input.headcountSourceOf, input.seen);
  const alarm = (itemId: number, x: { ruleId: number; departmentsLabel: string; windowLabel: string; used: number; limit: number }): LimitAlarm => {
    const it = catalogueOf.get(itemId);
    return { ruleId: x.ruleId, item: it?.name ?? "?", uom: it?.uom ?? "", departmentsLabel: x.departmentsLabel, windowLabel: x.windowLabel, used: x.used, limit: x.limit };
  };
  const overNow = nowCounted
    .filter((c) => ruleInScope(filters, c.rule.itemId, c.rule.departments))
    .map((c) => ({ c, l: rowLimit(c, usesOf.get(c.rule.itemId) ?? [], todayISO) }))
    .filter(({ l }) => l.status === "over")
    .sort((a, b) => b.l.ratio - a.l.ratio)
    .map(({ c, l }) => alarm(c.rule.itemId, l));
  const past = closedSpan(todayISO);
  const closedOver = exceedancesByMonth(input.rules, input.uses, past.from, past.to, input.headcountOf, input.seen)
    .filter((e) => e.window.to >= past.from && e.window.to <= past.to && ruleInScope(filters, e.itemId, e.departments))
    .map((e) => alarm(e.itemId, e));

  // ---- the filters' choices, from the whole period (and what is picked)
  const deptOpts = new Map<string, string>();
  const itemOpts = new Map<string, string>();
  for (const i of input.issues) {
    deptOpts.set(i.department, departmentLabel(i.department));
    const k = itemKeyOf(i.itemId, i.item);
    if (!itemOpts.has(k)) itemOpts.set(k, i.itemId !== null ? catalogueOf.get(i.itemId)?.name ?? i.item : `${i.item.trim()} (typed)`);
  }
  if (filters.department && !deptOpts.has(filters.department)) deptOpts.set(filters.department, departmentLabel(filters.department));
  if (filters.item && !itemOpts.has(filters.item)) {
    const id = filters.item.startsWith("c") ? Number(filters.item.slice(1)) : null;
    itemOpts.set(filters.item, id !== null ? catalogueOf.get(id)?.name ?? `Item ${id}` : `${filters.item.slice(2)} (typed)`);
  }
  const options = (m: Map<string, string>) => [...m.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));

  // the headcounts the per-worker limits were counted with, each once
  const headcounts = new Map(counted.filter((c) => c.headcount).map((c) => [JSON.stringify(c.headcount), c.headcount!]));

  return {
    fromISO, toISO, endsToday: toISO === todayISO, filters,
    kpis: {
      handOuts: shown.length,
      previousHandOuts: prevCount,
      change: prevCount === null ? null : pctChange(shown.length, prevCount),
      noComparison: noComparison ?? (prevCount === 0 ? "Nothing was handed out in the period before" : null),
      items: totals.size,
      departments: new Set(rows.map((r) => r.department)).size,
      uncovered: { handOuts: none.reduce((n, r) => n + r.handOuts, 0), items: new Set(none.map((r) => r.itemKey)).size },
      linked,
      linkedShare: shown.length ? linked / shown.length : null,
      quantity: filters.item && items.length === 1 ? { qty: items[0].qty, uom: items[0].uom } : null,
    },
    rows,
    trend: trendOf(shown, previous, fromISO, toISO, now),
    items,
    units: [...new Set(items.map((i) => i.uom).filter((u): u is string => u !== null))].sort(),
    latestRecordedOver: flagged[0] ?? null,
    recordedOverCount: flagged.length,
    limits: { overNow, closedOver, closedSpan: past },
    options: { departments: options(deptOpts), items: options(itemOpts) },
    quality: {
      total: input.issues.length,
      unlinked: input.issues.filter((i) => i.itemId === null).length,
      pastWindows: counted.some((c) => c.window.to < todayISO),
      headcount: headcounts.size ? [...headcounts.values()] : [input.headcountSourceOf(toISO.slice(0, 7))],
    },
  };
}

/** How a counted limit reads: "60 PC shared · Welding TX + Welding USS/LV",
 *  "2 PC per worker × 12 workers". */
export function limitBasisText(l: Pick<RowLimit, "basis" | "perWorker" | "qty" | "shared" | "departmentsLabel">, uom: string | null): string {
  const u = uom ? ` ${uom}` : "";
  if (l.perWorker) {
    const n = l.perWorker.workers;
    return `${l.perWorker.qty}${u} per worker × ${n > 0 ? `${n} worker${n === 1 ? "" : "s"}` : "1 (no one on the list)"}`;
  }
  if (l.basis === "each") return `${l.qty}${u} each department`;
  return l.shared ? `${l.qty}${u} shared · ${l.departmentsLabel}` : `${l.qty}${u} for the department`;
}

/** Whose headcount a per-worker limit is times, in words. */
export function headcountText(h: HeadcountSource): string {
  switch (h.kind) {
    case "live": return "the workers list as it stands";
    case "recorded": return `the headcount recorded for ${h.month}`;
    case "carried": return `the headcount last recorded, ${h.month}`;
    case "fallback": return "the workers list as it stands (no headcount was recorded then)";
  }
}

// ---------------------------------------------------------------- what needs a decision

/** How many of each kind the list names one by one before it sums the rest. */
const NAMED = 4;

/**
 * What needs someone at the store, worst first — the Decisions button's
 * list: the limits over NOW (today's reading, whatever the period), the rows
 * over at the period's end (when it ended before today), what no limit
 * counts (typed items, departments a limit does not cover), the windows that
 * closed over, and the hand-outs recorded over a limit when saved. `notes`
 * are lines that need no one (the powder scrap weighed; no flag is not
 * proof) — said under the list, not counted. `href` keeps the page's period
 * and filters; `closedLabel` names the months looked back over.
 */
export function consumablesActions(
  d: Pick<ConsumablesDecisions, "rows" | "endsToday" | "toISO" | "latestRecordedOver" | "recordedOverCount" | "quality" | "limits">,
  powder: { scope: "painting" | "other"; kg: number; weighings: number; sections: readonly { label: string; kg: number }[] },
  periodLabel: string,
  closedLabel: string,
  href: (set: Record<string, string | null>, hash?: string) => string,
): { actions: CockpitAction[]; notes: string[] } {
  const actions: CockpitAction[] = [];
  const notes: string[] = [];
  const limitsView = "/consumables?view=limits";
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const { overNow, closedOver } = d.limits;

  for (const a of overNow.slice(0, NAMED)) {
    actions.push({ tone: "bad", text: `Now: ${a.item} · ${a.departmentsLabel} — ${a.used} of ${a.limit} ${a.uom} (${a.windowLabel}), ${round3(a.used - a.limit)} over`, href: limitsView });
  }
  if (overNow.length > NAMED) actions.push({ tone: "bad", text: `Now: ${n(overNow.length - NAMED, "more limit")} over`, href: limitsView });

  const overAtEnd = d.rows.filter((r) => r.status === "over");
  if (!d.endsToday && overAtEnd.length > 0) {
    actions.push({ tone: "bad", text: `${n(overAtEnd.length, "item × department row")} over the limit on ${d.toISO}${d.quality.pastWindows ? " — recomputed using current limits" : ""}`, href: href({ status: "over" }, "detail") });
  }

  const typed = d.rows.filter((r) => r.itemId === null);
  if (typed.length > 0) {
    const handOuts = typed.reduce((s, r) => s + r.handOuts, 0);
    const items = new Set(typed.map((r) => r.itemKey));
    const suggested = new Set(typed.filter((r) => r.suggestion).map((r) => r.itemKey)).size;
    actions.push({
      tone: "warn",
      text: `${n(handOuts, "hand-out")} of ${n(items.size, "item")} not in the catalogue ${periodLabel} — no limit counts them${suggested ? `; ${suggested} with a catalogue item suggested to review` : ""}`,
      href: href({ link: "unlinked", status: null }, "detail"),
    });
  }
  const uncovered = d.rows.filter((r) => r.itemId !== null && r.status === "none");
  if (uncovered.length > 0) {
    actions.push({
      tone: "warn",
      text: `${n(uncovered.reduce((s, r) => s + r.handOuts, 0), "catalogue hand-out")} to a department none of the item's limits covers (${n(uncovered.length, "row")})`,
      href: href({ link: "linked", status: "none" }, "detail"),
    });
  }

  for (const e of closedOver.slice(0, NAMED)) {
    actions.push({ tone: "warn", text: `Closed over: ${e.item} · ${e.departmentsLabel} — ${e.windowLabel} ended at ${e.used} of ${e.limit} ${e.uom}`.trimEnd(), href: limitsView });
  }
  if (closedOver.length > NAMED) actions.push({ tone: "warn", text: `Closed over: ${n(closedOver.length - NAMED, "more window")} (${closedLabel})`, href: limitsView });

  const last = d.latestRecordedOver;
  if (last) {
    actions.push({
      tone: "info",
      text: `${n(d.recordedOverCount, "hand-out")} recorded over a limit when saved ${periodLabel} — latest ${last.dayISO}, ${last.item}: “${last.overLimitReason ?? "no reason"}”`,
      href: href({}, "detail"),
    });
  } else {
    notes.push(`No hand-out was flagged over a limit when saved ${periodLabel} — on its own that does not show the limits were kept; the standings do.`);
  }

  if (powder.scope === "other") notes.push("Powder scrap is weighed for the painting sections only.");
  else if (powder.weighings === 0) notes.push(`No powder scrap recorded ${periodLabel}.`);
  else notes.push(`Powder scrap ${periodLabel}: ${powder.kg} kg recorded (${powder.sections.map((s) => `${s.label} ${s.kg} kg`).join(" · ")}) — as weighed, not a waste rate.`);
  if (closedOver.length === 0) notes.push(`No finished window in scope ended over a limit (${closedLabel}).`);

  return { actions, notes };
}
