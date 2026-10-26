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
//                       the period's LAST day, up to that day. A per-worker
//                       number is times the headcount recorded for the
//                       window's month (the list as it stands for the running
//                       month, or before any was recorded) — and the dashboard
//                       says which;
//   no limit .......... a typed item, or a catalogue item handed out to a
//                       department none of its limits covers: "no limit", never
//                       "within the limit";
//   recorded over ..... the flag the recorder set when the hand-out was saved
//                       (warned, and gave the reason) — kept apart from the
//                       standing recomputed here; no flags is not proof that
//                       nothing went over.

import { addDaysISO, daysBetweenISO } from "./dateSlicer";
import { formatDayShort } from "./format";
import { departmentLabel, foldItemName, matchCatalogueItem } from "./consumables";
import { pctChange, previousPeriod, spanDays } from "./consumablesStats";
import { grade } from "./consumableMonthly";
import {
  ALL_DEPARTMENTS, coversDepartment, expandPerWorker, periodWindow, ruleLabel, usageIn, windowLabel,
  type HeadcountOf, type HeadcountSource, type LimitBasis, type LimitPeriod, type LimitRule, type LimitUse,
} from "./consumableLimits";
import type { CockpitAction } from "./kpis";

const round3 = (n: number) => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------- filters

export const LINK_FILTERS = ["linked", "unlinked"] as const;
export type LinkFilter = (typeof LINK_FILTERS)[number];
export const LINK_LABEL: Record<LinkFilter, string> = { linked: "In the catalogue", unlinked: "Not in the catalogue" };

/** Where an item × department stands against its limits at the period's end. */
export const ROW_STATUSES = ["over", "near", "within", "none"] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];
export const ROW_STATUS_LABEL: Record<RowStatus, string> = {
  over: "Over the limit",
  near: "Close to it (80–100%)",
  within: "Within the limit",
  none: "No limit",
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

const one = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? "") : typeof v === "string" ? v : "").trim();

/** The filters from the address (?dept=&item=&link=&status=) — anything that
 *  does not read is no filter, never an error. */
export function readDecisionFilters(sp: Record<string, unknown>): DecisionFilters {
  const department = one(sp.dept);
  const item = one(sp.item);
  const link = one(sp.link);
  const status = one(sp.status);
  return {
    department: department && department.length <= 80 ? department : null,
    item: /^c\d{1,9}$/.test(item) ? item : /^t:.{1,120}$/.test(item) ? `t:${foldItemName(item.slice(2))}` : null,
    link: (LINK_FILTERS as readonly string[]).includes(link) ? (link as LinkFilter) : null,
    status: (ROW_STATUSES as readonly string[]).includes(status) ? (status as RowStatus) : null,
  };
}

/** The filters as the address writes them — what the page's links carry. */
export function filterParams(f: DecisionFilters): [string, string][] {
  const out: [string, string][] = [];
  if (f.department) out.push(["dept", f.department]);
  if (f.item) out.push(["item", f.item]);
  if (f.link) out.push(["link", f.link]);
  if (f.status) out.push(["status", f.status]);
  return out;
}

export const hasFilters = (f: DecisionFilters) => !!(f.department || f.item || f.link || f.status);

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
export type PreviousIssue = Pick<DecisionIssue, "itemId" | "item" | "department" | "dayISO" | "hour">;

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
   *  back over all of it (the comparison is then not shown). */
  previous: readonly PreviousIssue[] | null;
  catalogue: readonly DecisionCatalogueItem[];
  /** The limits of active items as they are set (not yet made each department's). */
  rules: readonly LimitRule[];
  /** Catalogue hand-outs over every window that holds the period's last day. */
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
  /** The window runs past the period's end — counted up to that day. */
  toDate: boolean;
  limit: number;
  used: number;
  left: number;
  ratio: number;
  status: Exclude<RowStatus, "none">;
  /** A per-worker limit: whose headcount it is times. */
  headcount: HeadcountSource | null;
}

export interface CatalogueSuggestion {
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
  /** The limit that reads worst; null with no limit. */
  limit: RowLimit | null;
  /** Every limit that counts the row (each must hold), worst first. */
  limits: RowLimit[];
  /** A typed item: the catalogue item it may be, to review — never applied. */
  suggestion: CatalogueSuggestion | null;
  /** Its hand-outs, newest first (the latest ROW_ISSUES). */
  issues: DecisionIssue[];
  /** Every one of its hand-outs — what the log opens on (?ids=). */
  issueIds: number[];
}

export interface TrendBucket {
  key: string;
  label: string;
  issues: number;
  /** The same place in the period before; null when it is not comparable. */
  prev: number | null;
  /** The first day of the bucket (a day, or a week's first day); the hour's day for hours. */
  fromISO: string;
  toISO: string;
}

export interface ItemTotal {
  itemKey: string;
  item: string;
  uom: string | null;
  handOuts: number;
  qty: number;
}

export interface DecisionKpis {
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
}

export interface DecisionOptions {
  departments: { value: string; label: string }[];
  items: { value: string; label: string }[];
}

export interface ConsumablesDecisions {
  fromISO: string;
  toISO: string;
  /** The period ends today: its standings are "now". */
  endsToday: boolean;
  filters: DecisionFilters;
  kpis: DecisionKpis;
  rows: DecisionRow[];
  trend: { unit: "hour" | "day" | "week"; buckets: TrendBucket[] };
  items: ItemTotal[];
  /** The catalogue units handed out — the items ranking can read one in quantity. */
  units: string[];
  /** Hand-outs flagged over a limit when saved, newest first (the latest RECORDED_OVER_SHOWN). */
  recordedOver: DecisionIssue[];
  recordedOverCount: number;
  /** The filters' choices: what the period holds, and what is picked. */
  options: DecisionOptions;
  quality: {
    /** Live hand-outs in the period, every filter aside. */
    total: number;
    unlinked: number;
    typedItems: number;
    /** …of which with a catalogue item suggested for review. */
    suggested: number;
    /** A limit was counted in a window already over — with today's limits. */
    pastWindows: boolean;
    /** Whose headcount the per-worker limits are times — one per window month
     *  counted (the period's last month when no per-worker limit is set). */
    headcount: HeadcountSource[];
  };
}

export const ROW_ISSUES = 50;
export const RECORDED_OVER_SHOWN = 50;
/** Longer than this, the trend reads week by week. */
export const TREND_DAYS_MAX = 45;

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

interface Counted {
  rule: LimitRule;
  source: LimitRule;
  window: { from: string; to: string };
  headcount: HeadcountSource | null;
}

/** Every limit as it is counted for the window that holds `dayISO`: an
 *  "each" or per-worker limit made each department's — the per-worker number
 *  times the headcount of the window's last month. */
function countedRules(rules: readonly LimitRule[], dayISO: string, headcountOf: HeadcountOf, sourceOf: (month: string) => HeadcountSource, seen: readonly string[]): Map<number, Counted[]> {
  const out = new Map<number, Counted[]>();
  for (const source of rules) {
    const window = periodWindow(source.period, dayISO);
    const month = window.to.slice(0, 7);
    const list = out.get(source.itemId) ?? [];
    for (const rule of expandPerWorker([source], headcountOf(month), seen)) {
      list.push({ rule, source, window, headcount: source.basis === "person" ? sourceOf(month) : null });
    }
    out.set(source.itemId, list);
  }
  return out;
}

function rowLimit(c: Counted, uses: readonly LimitUse[], toISO: string): RowLimit {
  const counted = { from: c.window.from, to: c.window.to < toISO ? c.window.to : toISO };
  const used = usageIn(c.rule, uses, counted);
  const limit = c.rule.qty;
  const g = grade(used, limit);
  return {
    ruleId: c.rule.id, sourceId: c.source.id, basis: c.source.basis, period: c.rule.period, qty: c.source.qty,
    perWorker: c.rule.perWorker ?? null,
    departmentsLabel: ruleLabel(c.rule),
    shared: c.rule.departments === ALL_DEPARTMENTS || c.rule.departments.length > 1,
    window: c.window, windowLabel: windowLabel(c.rule.period, c.window), toDate: c.window.to > toISO,
    limit, used, left: round3(limit - used), ratio: limit > 0 ? used / limit : used > 0 ? Number.MAX_SAFE_INTEGER : 0,
    status: g === "over" ? "over" : g === "near" ? "near" : "within",
    headcount: c.headcount,
  };
}

const LIMIT_RANK: Record<RowLimit["status"], number> = { over: 0, near: 1, within: 2 };

/** The headcounts the per-worker limits were counted with, each once. */
function headcountsUsed(counted: ReadonlyMap<number, readonly Counted[]>, otherwise: HeadcountSource): HeadcountSource[] {
  const seen = new Map<string, HeadcountSource>();
  for (const c of [...counted.values()].flat()) if (c.headcount) seen.set(JSON.stringify(c.headcount), c.headcount);
  return seen.size ? [...seen.values()] : [otherwise];
}

// ---------------------------------------------------------------- the trend

function hourLabel(h: number) {
  return `${String(h).padStart(2, "0")}:00`;
}

function trendOf(issues: readonly PreviousIssue[], previous: readonly PreviousIssue[] | null, fromISO: string, toISO: string, now: Date): ConsumablesDecisions["trend"] {
  if (fromISO === toISO) {
    const per = new Array<number>(24).fill(0);
    const prev = new Array<number>(24).fill(0);
    for (const i of issues) per[i.hour] += 1;
    for (const i of previous ?? []) prev[i.hour] += 1;
    const used = [...issues, ...(previous ?? [])].map((i) => i.hour);
    const first = Math.min(7, ...used);
    const last = Math.max(17, ...used);
    const buckets: TrendBucket[] = [];
    for (let h = first; h <= last; h++) {
      buckets.push({ key: String(h), label: hourLabel(h), issues: per[h], prev: previous ? prev[h] : null, fromISO, toISO });
    }
    return { unit: "hour", buckets };
  }
  const days = spanDays(fromISO, toISO);
  const unit = days > TREND_DAYS_MAX ? "week" : "day";
  const size = unit === "week" ? 7 : 1;
  const prevFrom = previousPeriod(fromISO, toISO).fromISO;
  const buckets: TrendBucket[] = [];
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

/** The commonest way a typed item was written (the first, alphabetically, on a tie). */
function commonest(names: readonly string[]): string {
  const n = new Map<string, number>();
  for (const x of names) n.set(x.trim(), (n.get(x.trim()) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
}

export function buildConsumablesDecisions(input: DecisionInput, filters: DecisionFilters): ConsumablesDecisions {
  const { fromISO, toISO, todayISO } = input;
  const now = new Date(`${todayISO}T12:00:00Z`);
  const catalogueOf = new Map(input.catalogue.map((c) => [c.id, c]));
  const counted = countedRules(input.rules, toISO, input.headcountOf, input.headcountSourceOf, input.seen);
  const suggestionOf = new Map<string, CatalogueSuggestion | null>();
  const suggest = (key: string, name: string) => {
    if (!suggestionOf.has(key)) suggestionOf.set(key, suggestCatalogueItem(name, input.catalogue));
    return suggestionOf.get(key)!;
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
    const limits = first.itemId === null ? [] : (counted.get(first.itemId) ?? [])
      .filter((c) => coversDepartment(c.rule, first.department))
      .map((c) => rowLimit(c, input.uses, toISO))
      .sort((a, b) => LIMIT_RANK[a.status] - LIMIT_RANK[b.status] || b.ratio - a.ratio || a.departmentsLabel.localeCompare(b.departmentsLabel));
    const item = cat?.name ?? commonest(list.map((i) => i.item));
    return {
      key, itemKey, itemId: first.itemId, item, code: cat?.code ?? null, uom: cat?.uom ?? null,
      department: first.department, departmentLabel: departmentLabel(first.department),
      qty: round3(list.reduce((n, i) => n + i.qty, 0)), handOuts: list.length, lastDayISO: sorted[0].dayISO,
      recordedOver: flagged.length, lastReason: flagged.find((i) => i.overLimitReason)?.overLimitReason ?? null,
      status: limits[0]?.status ?? "none",
      limit: limits[0] ?? null,
      limits,
      suggestion: first.itemId === null ? suggest(itemKey, item) : null,
      issues: sorted.slice(0, ROW_ISSUES),
      issueIds: sorted.map((i) => i.id),
    };
  });
  if (filters.status) rows = rows.filter((r) => r.status === filters.status);
  rows.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || (b.limit?.ratio ?? 0) - (a.limit?.ratio ?? 0) || b.handOuts - a.handOuts || a.item.localeCompare(b.item) || a.departmentLabel.localeCompare(b.departmentLabel));

  // what the rows hold, hand-out by hand-out — the cards and the trend count these
  const kept = new Set(rows.map((r) => r.key));
  const shown = input.issues.filter((i) => matches(filters, i) && kept.has(`${itemKeyOf(i.itemId, i.item)}|${i.department}`));

  // ---- the comparison: the period before, under the same filters — not
  // under a limit status, which is this period's own reading
  let previous: PreviousIssue[] | null = null;
  let noComparison: string | null = null;
  if (input.previous === null) noComparison = "The log does not go back over the whole period before";
  else if (filters.status) noComparison = "A limit status is this period's own reading — the period before is not compared under it";
  else previous = input.previous.filter((i) => matches(filters, i));

  // ---- items, in their own unit
  const totals = new Map<string, ItemTotal>();
  for (const r of rows) {
    const t = totals.get(r.itemKey) ?? { itemKey: r.itemKey, item: r.item, uom: r.uom, handOuts: 0, qty: 0 };
    t.handOuts += r.handOuts;
    t.qty = round3(t.qty + r.qty);
    totals.set(r.itemKey, t);
  }
  const items = [...totals.values()].sort((a, b) => b.handOuts - a.handOuts || b.qty - a.qty || a.item.localeCompare(b.item));

  const none = rows.filter((r) => r.status === "none");
  const linked = shown.filter((i) => i.itemId !== null).length;
  const quantity = filters.item && items.length === 1 ? { qty: items[0].qty, uom: items[0].uom } : null;
  const prevCount = previous ? previous.length : null;

  const flagged = shown.filter((i) => i.overLimit).sort((a, b) => b.dayISO.localeCompare(a.dayISO) || b.id - a.id);

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
  const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);

  // every typed name in the period, each with its spellings — the strip's counts
  const typedNames = new Map<string, string[]>();
  for (const i of input.issues) {
    if (i.itemId !== null) continue;
    const k = itemKeyOf(null, i.item);
    const names = typedNames.get(k);
    if (names) names.push(i.item);
    else typedNames.set(k, [i.item]);
  }

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
      quantity,
    },
    rows,
    trend: trendOf(shown, previous, fromISO, toISO, now),
    items,
    units: [...new Set(items.map((i) => i.uom).filter((u): u is string => u !== null))].sort(),
    recordedOver: flagged.slice(0, RECORDED_OVER_SHOWN),
    recordedOverCount: flagged.length,
    options: {
      departments: [...deptOpts.entries()].map(([value, label]) => ({ value, label })).sort(byLabel),
      items: [...itemOpts.entries()].map(([value, label]) => ({ value, label })).sort(byLabel),
    },
    quality: {
      total: input.issues.length,
      unlinked: [...typedNames.values()].reduce((n, names) => n + names.length, 0),
      typedItems: typedNames.size,
      suggested: [...typedNames.entries()].filter(([k, names]) => suggest(k, commonest(names)) !== null).length,
      pastWindows: [...counted.values()].flat().some((c) => c.window.to < todayISO),
      headcount: headcountsUsed(counted, input.headcountSourceOf(toISO.slice(0, 7))),
    },
  };
}

/** How a counted limit reads: "60 PC a month · shared by Welding TX + Welding
 *  USS/LV", "2 PC per worker × 12 workers a month". */
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

/** A limit as the decisions list reads it — now, or a window that closed. */
export interface LimitAlarm {
  item: string;
  departmentsLabel: string;
  windowLabel: string;
  used: number;
  limit: number;
  uom: string;
}

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
 * and filters.
 */
export function consumablesActions(
  d: Pick<ConsumablesDecisions, "rows" | "endsToday" | "toISO" | "recordedOver" | "recordedOverCount" | "quality">,
  limits: { overNow: readonly LimitAlarm[]; closedOver: readonly LimitAlarm[]; closedSpan: string } | null,
  powder: { scope: "painting" | "other"; kg: number; weighings: number; sections: readonly { label: string; kg: number }[] },
  periodLabel: string,
  href: (set: Record<string, string | null>, hash?: string) => string,
): { actions: CockpitAction[]; notes: string[] } {
  const actions: CockpitAction[] = [];
  const notes: string[] = [];
  const limitsView = "/consumables?view=limits";
  const over = (a: LimitAlarm) => round3(a.used - a.limit);
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

  if (limits === null) actions.push({ tone: "bad", text: "The limits could not load — reload the page to see which are over.", href: limitsView });
  else {
    for (const a of limits.overNow.slice(0, NAMED)) {
      actions.push({ tone: "bad", text: `Now: ${a.item} · ${a.departmentsLabel} — ${a.used} of ${a.limit} ${a.uom} (${a.windowLabel}), ${over(a)} over`, href: limitsView });
    }
    if (limits.overNow.length > NAMED) actions.push({ tone: "bad", text: `Now: ${n(limits.overNow.length - NAMED, "more limit")} over`, href: limitsView });
  }

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

  if (limits) {
    for (const e of limits.closedOver.slice(0, NAMED)) {
      actions.push({ tone: "warn", text: `Closed over: ${e.item} · ${e.departmentsLabel} — ${e.windowLabel} ended at ${e.used} of ${e.limit}`, href: limitsView });
    }
    if (limits.closedOver.length > NAMED) actions.push({ tone: "warn", text: `Closed over: ${n(limits.closedOver.length - NAMED, "more window")} (${limits.closedSpan})`, href: limitsView });
  }

  if (d.recordedOverCount > 0) {
    const last = d.recordedOver[0];
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
  if (limits && limits.closedOver.length === 0) notes.push(`No finished window in scope ended over a limit (${limits.closedSpan}).`);

  return { actions, notes };
}
