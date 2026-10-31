// The Production dashboard (/dashboards/production): what did we make, at
// what efficiency, and where is the gap between the effort and the output —
// for the transformers, the LV panels or the whole plant, over one period.
// Pure, so every figure is tested without a database; lib/server/
// productionDashboard.ts reads each line's days (the same reads as
// getFloorPeriod / getLvFloorPeriod) and hands them here.
//
// The rules the page lives by:
//   - Efficiency = Σ standard hours earned ÷ Σ man-hours booked, over the
//     unit-days that booked hours — never the mean of the parts' rates. Output
//     recorded on a day nobody booked hours is shown in the volume chart and
//     counted in the coverage bar, never in the efficiency.
//   - Hours add across the lines; pieces never do (a panel is not a tank, and
//     a piece passing four stages is not four products). Output is shown per
//     stage, in its own unit.
//   - The one shot-blast crew is booked on the transformers' side and earns
//     the panels' blasting there too, and the machines' stops are the
//     transformers' read — so the plant's sums count each once.
//   - Nothing missing turns into a zero or a 100%: a ratio with no base is
//     null, a day nobody recorded is grey, a comparison with no valid base is N/A.
//   - The shift log records a shift for each person; the Daily log does not.
//     So Day / Night splits the attendance and the hours only — never the output.

import { addDaysISO, daysBetweenISO } from "./dateSlicer";
import { previousPeriod as stretchBefore } from "./consumablesStats";
import { parseISODate, toISODate } from "./dates";
import type { DowntimeCode } from "./downtime";
import { FLOOR_HISTORY_DAYS, FLOOR_TREND_WINDOW, floorDeptOf, floorRequest, floorStat, recordedDates, efficiencyGrid, productivityTrend, type FloorDept, type HeatRow, type ProductivityPoint } from "./floorKpis";
import { OUTPUT_GROUPS, OUTPUT_GROUP_LABEL, groupOfCentre, workingDaysFrom, type CentreDay, type OutputGroup } from "./kpis";
import { LINE_LABEL, PRODUCT_LINES, hrefWithLine, type ProductLine } from "./lines";
import { lossWaterfall, explainChange, biggestLoss, type LossChange, type LossWaterfall } from "./losses";
import { LV_FLOOR_DEPTS, LV_FLOOR_DEPT_LABEL, isLvFloorDept, lvFloorDeptOf, type LvFloorFilter } from "./lvKpis";
import { LV_STAGES } from "./lv";
import { SHIFT_DEPTS, WORK_CENTRES, WORK_CENTRE_LABEL, isWorkCentre, rosterDeptName, round1, type WorkCentre } from "./shifts";
import { UNUSUAL_EFFICIENCY } from "./productivity";
import { TOTAL_LABEL } from "./sheetLayout";

// ---------------------------------------------------------------- the request

export const PRODUCTION_SCOPES = ["all", "TR", "LV"] as const;
export type ProductionScope = (typeof PRODUCTION_SCOPES)[number];
export const SCOPE_LABEL: Record<ProductionScope, string> = { all: "All", TR: "TR", LV: "LV" };

/** The attendance card's shift: both, or the day or the night shift only. */
export const SHIFT_FILTERS = ["both", "day", "night"] as const;
export type ShiftFilter = (typeof SHIFT_FILTERS)[number];

/** The figures a tile opens the rows of. */
export const PRODUCTION_FOCUS = ["earned", "booked", "efficiency", "stdpd", "attendance", "overtime"] as const;
export type ProductionFocus = (typeof PRODUCTION_FOCUS)[number];
/** The tiles read over the priced departments only — the rest over every unit-day. */
export const PRICED_FOCUS: ReadonlySet<ProductionFocus> = new Set(["earned", "efficiency", "stdpd"]);

export { UNUSUAL_EFFICIENCY } from "./productivity";
/** How many unit-days the gaps list shows. */
export const GAP_ROWS = 6;

export interface ProductionRequest {
  fromISO: string;
  toISO: string;
  clamped: boolean;
  isDefault: boolean;
  scope: ProductionScope;
  /** The transformers' department (on TR and All). */
  trDept: FloorDept;
  /** The panels' department (on LV and All). */
  lvDept: LvFloorFilter;
  /** One transformers' work centre, or every centre of the department. */
  centre: WorkCentre | null;
  shift: ShiftFilter;
  /** A tile's rows, open over the page. */
  focus: ProductionFocus | null;
  /** A day's rows, open over the page (a click on the daily chart). */
  focusDay: string | null;
}

type Search = Record<string, string | string[] | undefined>;
const one = (sp: Search, k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
const isOneOf = <T extends string>(list: readonly T[], x: string | undefined): x is T => x !== undefined && (list as readonly string[]).includes(x);

/** The page's URL (or the assistant's input) as one request. A department
 *  names its line, so it settles the scope; a centre names its department.
 *  An older link that set both lines' departments (`dept` and `lvDept`)
 *  keeps each on All. */
export function productionRequest(sp: Search, todayISO: string): ProductionRequest {
  const range = floorRequest({ from: one(sp, "from"), to: one(sp, "to") }, todayISO);
  const dept = one(sp, "dept");
  const lvRaw = one(sp, "lvDept");
  let scope: ProductionScope = isOneOf(PRODUCTION_SCOPES, one(sp, "scope")) ? (one(sp, "scope") as ProductionScope) : "all";
  let trDept: FloorDept = "all";
  let lvDept: LvFloorFilter = "all";
  // on the panels a stage's name is their department's ("Welding" → WeldingLV); elsewhere the
  // floor's names or the roster's ("Cut" → Fabrication), and a panels' department names its line
  const asLv = scope === "LV" ? lvFloorDeptOf(dept) : isLvFloorDept(dept) ? dept : "all";
  const asTr = scope === "LV" ? "all" : floorDeptOf(dept);
  if (asLv !== "all") { lvDept = asLv; scope = "LV"; }
  else if (asTr !== "all") { trDept = asTr; scope = "TR"; }
  const lvAsked = lvFloorDeptOf(lvRaw);
  if (lvAsked !== "all") {
    lvDept = lvAsked;
    // the old page's two sections: each line its own department, both on screen
    scope = trDept !== "all" ? "all" : "LV";
  }
  let centre: WorkCentre | null = null;
  const c = one(sp, "centre");
  if (c && isWorkCentre(c) && scope !== "LV" && (trDept === "all" || trDept === groupOfCentre(c))) {
    centre = c;
    trDept = groupOfCentre(c);
    if (scope === "all" && lvDept === "all") scope = "TR";
  }
  const shift = isOneOf(SHIFT_FILTERS, one(sp, "shift")) ? (one(sp, "shift") as ShiftFilter) : "both";
  const focus = isOneOf(PRODUCTION_FOCUS, one(sp, "focus")) ? (one(sp, "focus") as ProductionFocus) : null;
  const dayRaw = one(sp, "day");
  const day = dayRaw && parseISODate(dayRaw) ? toISODate(parseISODate(dayRaw)!) : null;
  return {
    fromISO: range.fromISO, toISO: range.toISO, clamped: range.clamped, isDefault: range.isDefault,
    scope, trDept: scope === "LV" ? "all" : trDept, lvDept: scope === "TR" ? "all" : lvDept, centre, shift, focus,
    focusDay: day && day >= range.fromISO && day <= range.toISO ? day : null,
  };
}

/** The lines a request reads. */
export const linesOf = (scope: ProductionScope): ProductLine[] => (scope === "all" ? [...PRODUCT_LINES] : [scope]);

/** The equal stretch just before a period — what each tile is compared with.
 *  Null when it would start before the history the floor keeps. */
export function previousPeriod(fromISO: string, toISO: string, todayISO: string): { fromISO: string; toISO: string } | null {
  const before = stretchBefore(fromISO, toISO);
  return before.fromISO < addDaysISO(todayISO, -(FLOOR_HISTORY_DAYS - 1)) ? null : before;
}

// ---------------------------------------------------------------- the facts

/** The people and hours of one shift on a unit-day. */
export interface ShiftPart {
  people: number;
  hours: number;
  overtimeH: number;
}

/** One unit on one day: a transformers' work centre, or a panels'
 *  department — what its people booked (the shift log), what its output was
 *  worth (the Daily log at the standard times), who came, the machines. */
export interface UnitDay {
  line: ProductLine;
  /** The department it counts under: an OutputGroup (TR) or an LvFloorDept (LV). */
  dept: string;
  /** The work centre (TR) or the department (LV). */
  unit: string;
  dateISO: string;
  /** Man-hours booked by those present, overtime included. */
  workedH: number;
  earnedH: number;
  /** People present. */
  people: number;
  overtimeH: number;
  /** Rows the shift log recorded, present or not, and how many were absent. */
  rows: number;
  absent: number;
  /** The shift hours of those set absent. */
  absentH: number;
  day: ShiftPart;
  night: ShiftPart;
  /** The unit's machine hours that day, and the hours they stood still, by cause. */
  machineH: number;
  downtimeH: number;
  stops: Partial<Record<DowntimeCode, number>>;
  /** Workers of the unit with no row in the shift log that day (on a day
   *  the unit recorded); null when the roster cannot say. */
  notSet: number | null;
}

/** What the Daily log recorded on a day at one stage — never added across stages. */
export interface VolumeRecord {
  line: ProductLine;
  dateISO: string;
  /** The stage as the Daily log records it: Cut / Welding / ShotBlast /
   *  Painting for a transformer, Punching / Bending / Welding / Painting for a panel. */
  stage: string;
  /** The departments whose output it is (the shot-blast crew passes every painted piece). */
  depts: readonly string[];
  component: string;
  qty: number;
  /** Whether it carries standard hours. */
  priced: boolean;
}

export interface LineFacts {
  line: ProductLine;
  days: UnitDay[];
  volume: VolumeRecord[];
  /** The first day the line's attendance was ever recorded — days before it are before tracking, not missing. */
  trackingSinceISO: string | null;
  /** The last day the line's attendance was recorded, up to the period's end. */
  lastRecordISO: string | null;
}

export const emptyShift = (): ShiftPart => ({ people: 0, hours: 0, overtimeH: 0 });

// ---------------------------------------------------------------- labels

export const unitKey = (d: { line: ProductLine; unit: string }) => `${d.line}:${d.unit}`;
export const deptKey = (d: { line: ProductLine; dept: string }) => `${d.line}:${d.dept}`;

export function unitLabel(line: ProductLine, unit: string): string {
  if (line === "TR") return isWorkCentre(unit) ? WORK_CENTRE_LABEL[unit] : unit;
  return isLvFloorDept(unit) ? LV_FLOOR_DEPT_LABEL[unit] : unit;
}

export function deptLabel(line: ProductLine, dept: string): string {
  if (line === "TR") return dept in OUTPUT_GROUP_LABEL ? OUTPUT_GROUP_LABEL[dept as OutputGroup] : dept;
  return isLvFloorDept(dept) ? LV_FLOOR_DEPT_LABEL[dept] : dept;
}

export const STAGE_UNIT: Record<ProductLine, string> = { TR: "pcs", LV: "panels" };
export const stageKey = (r: { line: ProductLine; stage: string }) => `${r.line}:${r.stage}`;
export function stageLabel(line: ProductLine, stage: string): string {
  return line === "TR" ? rosterDeptName(stage) : `${stage} (LV)`;
}

/** The Shifts screen's day, at the line's departments — the day's record a row links to. */
export const shiftsDayHref = (line: ProductLine, dateISO: string, view: "attendance" | "productivity" = "productivity") =>
  `/shifts?day=${dateISO}&sec=line:${line}&view=${view}`;
/** The Daily log of a line — its own filters pick the day. */
export const dailyLogHref = (line: ProductLine) => hrefWithLine("/handover", line);

// ---------------------------------------------------------------- filtering

/** The unit-days a request keeps. */
export function keepDay(req: Pick<ProductionRequest, "scope" | "trDept" | "lvDept" | "centre">, d: Pick<UnitDay, "line" | "dept" | "unit">): boolean {
  if (req.scope !== "all" && d.line !== req.scope) return false;
  if (d.line === "TR") {
    if (req.trDept !== "all" && d.dept !== req.trDept) return false;
    return !req.centre || d.unit === req.centre;
  }
  // a centre is the transformers'; on All each line keeps its own department
  return !req.centre && (req.lvDept === "all" || d.dept === req.lvDept);
}

/** The output records a request keeps — by department, never by centre (the
 *  Daily log does not say which centre made a piece). */
export function keepVolume(req: Pick<ProductionRequest, "scope" | "trDept" | "lvDept" | "centre">, r: Pick<VolumeRecord, "line" | "depts">): boolean {
  if (req.scope !== "all" && r.line !== req.scope) return false;
  if (r.line === "TR") return req.trDept === "all" || r.depts.includes(req.trDept);
  return !req.centre && (req.lvDept === "all" || r.depts.includes(req.lvDept));
}

// ---------------------------------------------------------------- the figures

/** A unit-day as the floor's shared figures read a centre-day, keyed by its unit. */
const toCentreDay = (d: UnitDay): CentreDay<string> => ({ dateISO: d.dateISO, centre: unitKey(d), workedH: d.workedH, people: d.people, earnedH: d.earnedH, machineH: d.machineH, downtimeH: d.downtimeH });


export interface HoursFigures {
  /** Unit-days that booked hours, and their distinct dates. */
  unitDays: number;
  days: number;
  earnedH: number;
  workedH: number;
  /** earned ÷ worked; null without worked hours. Never capped. */
  efficiency: number | null;
  /** People present summed over the unit-days that booked hours. */
  personDays: number;
  stdPerPersonDay: number | null;
  overtimeH: number;
  /** Overtime ÷ worked; null without worked hours. */
  overtimeShare: number | null;
  /** Rows recorded, absences, present ÷ recorded. */
  rows: number;
  absent: number;
  attendance: number | null;
}

/** The six tiles' figures over some unit-days. Earned hours count only where
 *  hours were booked — output on a day with no attendance is left out (and
 *  counted in the coverage bar instead). */
export function hoursFigures(days: readonly UnitDay[]): HoursFigures {
  // the floor's own roll-up (floorStat), over the unit-days as its centre-days
  const f = floorStat(days.map((d) => ({ ...toCentreDay(d), overtimeH: d.overtimeH, rows: d.rows, absent: d.absent })));
  return {
    unitDays: days.filter((d) => d.workedH > 0).length, days: f.days,
    earnedH: f.earnedH, workedH: f.workedH, efficiency: f.efficiency,
    personDays: f.personDays, stdPerPersonDay: f.stdPerPersonDay,
    overtimeH: f.overtimeH, overtimeShare: f.overtimeShare,
    rows: days.reduce((t, d) => t + d.rows, 0), absent: days.reduce((t, d) => t + d.absent, 0), attendance: f.attendance,
  };
}

export type DeltaKind = "pct" | "pts";
export interface Kpi {
  key: ProductionFocus;
  value: number | null;
  /** The same figure over the stretch before; null where there is none. */
  before: number | null;
  /** Relative change for an amount, points for a ratio; null with no valid base. */
  delta: { kind: DeltaKind; value: number } | null;
}

const FOCUS_OF: Record<ProductionFocus, { pick: (f: HoursFigures) => number | null; kind: DeltaKind }> = {
  earned: { pick: (f) => (f.unitDays > 0 ? f.earnedH : null), kind: "pct" },
  booked: { pick: (f) => (f.unitDays > 0 ? f.workedH : null), kind: "pct" },
  efficiency: { pick: (f) => f.efficiency, kind: "pts" },
  stdpd: { pick: (f) => f.stdPerPersonDay, kind: "pct" },
  attendance: { pick: (f) => f.attendance, kind: "pts" },
  overtime: { pick: (f) => f.overtimeShare, kind: "pts" },
};

/** A change against the stretch before: relative for an amount (a zero or
 *  missing base is N/A), in points for a ratio (a missing base is N/A). */
export function deltaOf(now: number | null, before: number | null, kind: DeltaKind): Kpi["delta"] {
  if (now === null || before === null) return null;
  if (kind === "pts") return { kind, value: Math.round((now - before) * 1000) / 10 };
  if (!(before > 0)) return null;
  return { kind, value: Math.round(((now - before) / before) * 1000) / 10 };
}

export function kpisOf(now: HoursFigures, before: HoursFigures | null): Kpi[] {
  return PRODUCTION_FOCUS.map((key) => {
    const { pick, kind } = FOCUS_OF[key];
    const v = pick(now);
    const b = before ? pick(before) : null;
    return { key, value: v, before: b, delta: deltaOf(v, b, kind) };
  });
}

// ---------------------------------------------------------------- coverage

export interface Coverage {
  /** Working days of the period on or after tracking began (Fridays and holidays off, never past today). */
  workingDays: number;
  /** Of those, the days some unit kept booked hours. */
  recordedDays: number;
  share: number | null;
  /** Each line's tracking start, when the period begins before it. */
  beforeTracking: { line: ProductLine; sinceISO: string | null }[];
  lastRecordISO: string | null;
  /** Share of each line's output carrying standard hours — a line's own (pieces and panels never add). */
  priced: Partial<Record<ProductLine, number | null>>;
  /** Output recorded on unit-days nobody booked hours: in the volume chart, out of the efficiency. */
  unmatched: { unitDays: number; earnedH: number; dates: string[] };
  /** The period ends today — still being logged. */
  todayOpen: boolean;
}

/** The working days of a stretch — Fridays and the factory's holidays off. */
export function workingDaysIn(fromISO: string, toISO: string, holidays: ReadonlySet<string>): string[] {
  if (toISO < fromISO) return [];
  return workingDaysFrom(fromISO, daysBetweenISO(fromISO, toISO) + 1, holidays).filter((d) => d <= toISO);
}

/** The working days from tracking's start (or the period's) to the period's end (never past
 *  today), and how many of them some unit-day booked hours on. None before tracking began. */
function recordedOf(days: readonly UnitDay[], sinceISO: string | null, o: { fromISO: string; toISO: string; todayISO: string; holidays: ReadonlySet<string> }): { working: number; recorded: number } {
  if (!sinceISO) return { working: 0, recorded: 0 };
  const working = workingDaysIn(sinceISO > o.fromISO ? sinceISO : o.fromISO, o.toISO > o.todayISO ? o.todayISO : o.toISO, o.holidays);
  const booked = new Set(days.filter((d) => d.workedH > 0).map((d) => d.dateISO));
  return { working: working.length, recorded: working.filter((d) => booked.has(d)).length };
}

/** The first day a request's lines are all tracking, or null when none ever recorded. */
function trackingFrom(lines: readonly LineFacts[]): string | null {
  const starts = lines.map((l) => l.trackingSinceISO).filter((s): s is string => !!s);
  return starts.length ? starts.sort()[0] : null;
}

export function coverageOf(
  days: readonly UnitDay[], volume: readonly VolumeRecord[], lines: readonly LineFacts[],
  o: { fromISO: string; toISO: string; todayISO: string; holidays: ReadonlySet<string> },
): Coverage {
  const { working, recorded: recordedDays } = recordedOf(days, trackingFrom(lines), o);
  const priced: Coverage["priced"] = {};
  for (const l of lines) {
    const mine = volume.filter((r) => r.line === l.line);
    const qty = mine.reduce((s, r) => s + r.qty, 0);
    priced[l.line] = qty > 0 ? mine.filter((r) => r.priced).reduce((s, r) => s + r.qty, 0) / qty : null;
  }
  const orphan = days.filter((d) => !(d.workedH > 0) && d.earnedH > 0);
  const last = lines.map((l) => l.lastRecordISO).filter((s): s is string => !!s).sort().at(-1) ?? null;
  return {
    workingDays: working,
    recordedDays,
    share: working > 0 ? recordedDays / working : null,
    beforeTracking: lines.filter((l) => !l.trackingSinceISO || l.trackingSinceISO > o.fromISO).map((l) => ({ line: l.line, sinceISO: l.trackingSinceISO })),
    lastRecordISO: last,
    priced,
    unmatched: { unitDays: orphan.length, earnedH: round1(orphan.reduce((s, d) => s + d.earnedH, 0)), dates: [...new Set(orphan.map((d) => d.dateISO))].sort() },
    todayOpen: o.toISO >= o.todayISO,
  };
}

// ---------------------------------------------------------------- day by day

export interface DailyHours {
  dateISO: string;
  earnedH: number;
  workedH: number;
  efficiency: number | null;
  /** Each department's earned hours (by deptKey) — they stack, one unit. */
  values: Record<string, number>;
}

/** Earned against booked, day by day — the unit-days that booked hours only,
 *  so each day's bar and line meet the period's efficiency — and the
 *  departments its bars stack, in the plant's order. */
export function dailyHours(days: readonly UnitDay[]): { days: DailyHours[]; groups: { key: string; label: string }[] } {
  const by = new Map<string, DailyHours>();
  const groups = new Map<string, { line: ProductLine; dept: string }>();
  for (const d of days) {
    if (!(d.workedH > 0)) continue;
    const k = deptKey(d);
    groups.set(k, { line: d.line, dept: d.dept });
    const o = by.get(d.dateISO) ?? { dateISO: d.dateISO, earnedH: 0, workedH: 0, efficiency: null, values: {} };
    o.earnedH += d.earnedH;
    o.workedH += d.workedH;
    o.values[k] = (o.values[k] ?? 0) + d.earnedH;
    by.set(d.dateISO, o);
  }
  const lines = new Set([...groups.values()].map((g) => g.line));
  const order = [...groups].sort(([, a], [, b]) => deptOrder(a) - deptOrder(b));
  return {
    days: [...by.values()].sort((a, b) => a.dateISO.localeCompare(b.dateISO)).map((o) => ({
      dateISO: o.dateISO, earnedH: round1(o.earnedH), workedH: round1(o.workedH), efficiency: o.workedH > 0 ? o.earnedH / o.workedH : null,
      values: Object.fromEntries(order.map(([k]) => [k, round1(o.values[k] ?? 0)])),
    })),
    groups: order.map(([key, g]) => ({ key, label: lines.size > 1 ? `${deptLabel(g.line, g.dept)} · ${g.line}` : deptLabel(g.line, g.dept) })),
  };
}

export interface GapRow {
  line: ProductLine;
  dept: string;
  unit: string;
  dateISO: string;
  workedH: number;
  earnedH: number;
  efficiency: number;
  /** Hours booked and not earned. */
  gapH: number;
  /** above: an efficiency unusually high — shown as it is, worth checking its records. */
  kind: "gap" | "above";
}

/** Where the effort and the output parted most: the unit-days with the most
 *  hours booked and not earned, then those unusually above the standard. */
export function performanceGaps(days: readonly UnitDay[], n = GAP_ROWS): GapRow[] {
  const rows = days.filter((d) => d.workedH > 0).map((d) => {
    const efficiency = d.earnedH / d.workedH;
    return { line: d.line, dept: d.dept, unit: d.unit, dateISO: d.dateISO, workedH: round1(d.workedH), earnedH: round1(d.earnedH), efficiency, gapH: round1(d.workedH - d.earnedH), kind: efficiency > UNUSUAL_EFFICIENCY ? "above" as const : "gap" as const };
  });
  const gaps = rows.filter((r) => r.kind === "gap" && r.gapH > 0).sort((a, b) => b.gapH - a.gapH || a.dateISO.localeCompare(b.dateISO)).slice(0, n);
  const above = rows.filter((r) => r.kind === "above").sort((a, b) => b.efficiency - a.efficiency).slice(0, Math.max(1, Math.floor(n / 2)));
  return [...gaps, ...above];
}

/** Each unit's efficiency day by day — the heatmap's rows over the dates
 *  any unit booked hours; a unit-day nobody booked is grey, never a zero. */
export function heatGrid(days: readonly UnitDay[], unpriced: ReadonlySet<string> = new Set()): { dates: string[]; rows: HeatRow<string>[]; labels: Record<string, string>; unpricedRows: string[] } {
  const cells = days.map(toCentreDay);
  const dates = recordedDates(cells);
  const labels: Record<string, string> = {};
  const order: string[] = [];
  for (const d of days) {
    const k = unitKey(d);
    if (!(k in labels)) { labels[k] = unitLabel(d.line, d.unit); order.push(k); }
  }
  const lines = new Set(days.map((d) => d.line));
  if (lines.size > 1) for (const k of order) labels[k] = `${labels[k]} · ${k.split(":")[0]}`;
  order.sort((a, b) => unitOrder(a) - unitOrder(b));
  // a unit of a department whose output is not priced reads as not priced, never 0%
  const np = new Set(days.filter((d) => unpriced.has(deptKey(d))).map(unitKey));
  const rows = efficiencyGrid(cells, order, dates).map((r) => (np.has(r.centre) ? { ...r, total: null, cells: r.cells.map((c) => ({ ...c, efficiency: null })) } : r));
  return { dates, rows, labels, unpricedRows: [...np] };
}

/** A key's place in the plant's order — the transformers' first, anything unknown last. */
const rankIn = (list: readonly string[]) => (k: string) => { const i = list.indexOf(k); return i < 0 ? list.length : i; };
const tag = (line: ProductLine, xs: readonly string[]) => xs.map((x) => `${line}:${x}`);
const unitOrder = rankIn([...tag("TR", WORK_CENTRES), ...tag("LV", LV_FLOOR_DEPTS)]);

// ---------------------------------------------------------------- output

export interface VolumeStage {
  key: string;
  line: ProductLine;
  stage: string;
  label: string;
  unit: string;
  total: number;
}

export interface VolumeView {
  stages: VolumeStage[];
  /** Each stage's days, component by component — every day with output, hours or not. */
  days: { stage: string; dateISO: string; byComponent: Record<string, number>; total: number }[];
  components: Record<string, string[]>;
}

const stageOrder = rankIn([...tag("TR", SHIFT_DEPTS), ...tag("LV", LV_STAGES)]);

/** What the Daily log recorded, stage by stage in its own unit, component by
 *  component — every day it recorded, whether or not anyone booked hours.
 *  Net of its corrections, as the department table counts: a piece recorded
 *  and taken back is not output (a cancel-and-redo on one day counts once).
 *  A day's bar nets that day's rows and never reads below nothing — a
 *  correction typed on a later day lowers the stage's total, not a bar. */
export function volumeOf(records: readonly VolumeRecord[]): VolumeView {
  const stages = new Map<string, VolumeStage>();
  const days = new Map<string, { stage: string; dateISO: string; byComponent: Record<string, number>; total: number }>();
  const comps = new Map<string, Map<string, number>>();
  for (const r of records) {
    if (!r.qty) continue;
    const key = stageKey(r);
    const s = stages.get(key) ?? { key, line: r.line, stage: r.stage, label: stageLabel(r.line, r.stage), unit: STAGE_UNIT[r.line], total: 0 };
    s.total += r.qty;
    stages.set(key, s);
    const dk = `${key}|${r.dateISO}`;
    const d = days.get(dk) ?? { stage: key, dateISO: r.dateISO, byComponent: {}, total: 0 };
    d.byComponent[r.component] = (d.byComponent[r.component] ?? 0) + r.qty;
    d.total += r.qty;
    days.set(dk, d);
    const c = comps.get(key) ?? new Map<string, number>();
    c.set(r.component, (c.get(r.component) ?? 0) + r.qty);
    comps.set(key, c);
  }
  for (const s of stages.values()) s.total = Math.max(0, s.total);
  for (const d of days.values()) {
    for (const [c, n] of Object.entries(d.byComponent)) if (n <= 0) delete d.byComponent[c];
    d.total = Object.values(d.byComponent).reduce((a, n) => a + n, 0);
  }
  return {
    stages: [...stages.values()].filter((s) => s.total > 0).sort((a, b) => stageOrder(a.key) - stageOrder(b.key)),
    days: [...days.values()].filter((d) => d.total > 0).sort((a, b) => a.dateISO.localeCompare(b.dateISO)),
    // each stage's components, the most first
    components: Object.fromEntries([...comps].map(([k, m]) => [k, [...m].sort((a, b) => b[1] - a[1]).map(([c]) => c)])),
  };
}

// ---------------------------------------------------------------- attendance

export interface AttendanceRow {
  line: ProductLine;
  dept: string;
  label: string;
  /** Recorded rows, present, absent. */
  rows: number;
  present: number;
  absent: number;
  /** Not set on the roster — null where the roster cannot say. */
  notSet: number | null;
  day: ShiftPart;
  night: ShiftPart;
  /** The shift's (or both shifts') overtime and booked hours. */
  overtimeH: number;
  workedH: number;
}

/** Who came, department by department, and on which shift. The shift filter
 *  narrows the people, the hours and the overtime; absences carry no shift
 *  (an absent row is just absent), so they stay whole. */
export function attendanceRows(days: readonly UnitDay[], shift: ShiftFilter): AttendanceRow[] {
  const by = new Map<string, AttendanceRow>();
  for (const d of days) {
    const k = deptKey(d);
    const r = by.get(k) ?? { line: d.line, dept: d.dept, label: deptLabel(d.line, d.dept), rows: 0, present: 0, absent: 0, notSet: 0 as number | null, day: emptyShift(), night: emptyShift(), overtimeH: 0, workedH: 0 };
    r.rows += d.rows;
    r.absent += d.absent;
    // a recorded day the roster cannot speak for makes the department's count unknown
    if (d.rows > 0) r.notSet = r.notSet === null || d.notSet === null ? null : r.notSet + d.notSet;
    for (const s of ["day", "night"] as const) {
      r[s].people += d[s].people;
      r[s].hours += d[s].hours;
      r[s].overtimeH += d[s].overtimeH;
    }
    by.set(k, r);
  }
  return [...by.values()]
    .map((r) => {
      const parts = shift === "both" ? [r.day, r.night] : [r[shift]];
      const present = parts.reduce((s, p) => s + p.people, 0);
      return {
        ...r,
        present,
        day: { people: r.day.people, hours: round1(r.day.hours), overtimeH: round1(r.day.overtimeH) },
        night: { people: r.night.people, hours: round1(r.night.hours), overtimeH: round1(r.night.overtimeH) },
        overtimeH: round1(parts.reduce((s, p) => s + p.overtimeH, 0)),
        workedH: round1(parts.reduce((s, p) => s + p.hours, 0)),
      };
    })
    // a department with output but no row on the shift log has no one to count
    .filter((r) => r.rows > 0)
    .sort((a, b) => deptOrder(a) - deptOrder(b));
}

const deptRank = rankIn([...tag("TR", OUTPUT_GROUPS), ...tag("LV", LV_FLOOR_DEPTS)]);
const deptOrder = (d: { line: ProductLine; dept: string }) => deptRank(deptKey(d));

// ---------------------------------------------------------------- where the hours went

export interface HoursWalk {
  now: LossWaterfall<string>;
  before: LossWaterfall<string> | null;
  change: LossChange | null;
  biggest: string | null;
}

/** What the unexplained step is called on the page — said plainly, not blamed on anyone. */
export const UNEXPLAINED_LABEL = "Unexplained: slower than standard or not logged";

function toLossDays(days: readonly UnitDay[]) {
  return days.map((d) => ({ dateISO: d.dateISO, centre: unitKey(d), workedH: d.workedH, absentH: d.absentH, overtimeH: d.overtimeH, earnedH: d.earnedH, machineH: d.machineH, stops: d.stops }));
}

/** The period's booked hours walked down to the standard hours earned —
 *  the same unit-days as the tiles, so its ends meet them. */
export function hoursWalk(days: readonly UnitDay[], before: readonly UnitDay[] | null, name: string): HoursWalk {
  const now = relabel(lossWaterfall(toLossDays(days), null));
  const prev = before ? relabel(lossWaterfall(toLossDays(before), null)) : null;
  return {
    now,
    before: prev,
    change: prev ? explainChange(prev, now, name) : null,
    biggest: biggestLoss(now, name),
  };
}

function relabel(w: LossWaterfall<string>): LossWaterfall<string> {
  return { ...w, steps: w.steps.map((s) => (s.key === "performance" && s.hours <= 0 ? { ...s, label: UNEXPLAINED_LABEL } : s.key === "stops" ? { ...s, label: "Machine stops (est.)" } : s)) };
}

// ---------------------------------------------------------------- the departments' table

export interface DeptRow {
  line: ProductLine;
  dept: string;
  label: string;
  /** Days the department booked hours, of the working days since tracking began. */
  recordedDays: number;
  workingDays: number;
  coverage: number | null;
  personDays: number;
  workedH: number;
  overtimeH: number;
  earnedH: number;
  efficiency: number | null;
  /** What the department recorded in the period, in its unit — all of it, hours or not, as the volume chart. */
  output: number;
  outputUnit: string;
  /** The department's last recorded day, for the link to its day's record. */
  lastDayISO: string | null;
  /** False where its output carries no standard hours: efficiency not priced, never 0%. */
  priced: boolean;
}

export function deptTable(
  days: readonly UnitDay[], volume: readonly VolumeRecord[], lines: readonly LineFacts[],
  o: { fromISO: string; toISO: string; todayISO: string; holidays: ReadonlySet<string> },
): DeptRow[] {
  const keys = new Map<string, { line: ProductLine; dept: string }>();
  for (const d of days) keys.set(deptKey(d), { line: d.line, dept: d.dept });
  return [...keys.values()]
    .map(({ line, dept }) => {
      const mine = days.filter((d) => d.line === line && d.dept === dept);
      const f = hoursFigures(mine);
      const { working, recorded: recordedDays } = recordedOf(mine, lines.find((l) => l.line === line)?.trackingSinceISO ?? null, o);
      const booked = mine.filter((d) => d.workedH > 0).map((d) => d.dateISO);
      const output = volume.filter((r) => r.line === line && r.depts.includes(dept)).reduce((s, r) => s + r.qty, 0);
      return {
        line, dept, label: deptLabel(line, dept),
        recordedDays, workingDays: working, coverage: working > 0 ? recordedDays / working : null,
        personDays: f.personDays, workedH: f.workedH, overtimeH: f.overtimeH, earnedH: f.earnedH, efficiency: f.efficiency,
        output, outputUnit: STAGE_UNIT[line],
        lastDayISO: booked.sort().at(-1) ?? null,
        priced: true,
      };
    })
    .filter((r) => r.workedH > 0 || r.output > 0 || days.some((d) => d.line === r.line && d.dept === r.dept && d.rows > 0))
    .sort((a, b) => deptOrder(a) - deptOrder(b));
}

// ---------------------------------------------------------------- output with no standard

/** The departments (deptKey) whose output in the period carries no standard
 *  hours at all: their earned hours are not zero but unknown, so their
 *  efficiency is shown as not priced — never as 0%. */
export function unpricedDepts(volume: readonly VolumeRecord[]): Set<string> {
  const by = new Map<string, { qty: number; priced: number }>();
  for (const r of volume) {
    for (const dept of r.depts) {
      const k = deptKey({ line: r.line, dept });
      const v = by.get(k) ?? { qty: 0, priced: 0 };
      v.qty += r.qty;
      if (r.priced) v.priced += r.qty;
      by.set(k, v);
    }
  }
  return new Set([...by].filter(([, v]) => v.qty > 0 && v.priced === 0).map(([k]) => k));
}

// ---------------------------------------------------------------- the page

export interface ProductionView {
  scopeName: string;
  /** Every unit-day's hours, attendance and overtime. */
  figures: HoursFigures;
  /** The departments whose output is priced — what the earned side (earned, efficiency, std-h a person-day) reads. */
  pricedFigures: HoursFigures;
  kpis: Kpi[];
  /** Each line's own figures on All, so a tile can say what each brought. */
  byLine: Partial<Record<ProductLine, HoursFigures>>;
  coverage: Coverage;
  daily: ReturnType<typeof dailyHours>;
  gaps: GapRow[];
  heat: ReturnType<typeof heatGrid>;
  volume: VolumeView;
  attendance: AttendanceRow[];
  /** Departments (deptKey) whose period output carries no standard hours — efficiency not priced. */
  unpriced: string[];
  hours: HoursWalk;
  table: DeptRow[];
  /** Efficiency day by day with its rolling figure over the last recorded days. */
  trend: ProductivityPoint[];
  /** The unit-days behind every figure, for a tile's or a day's rows. */
  days: UnitDay[];
}

/** The name of what a request shows — "the whole plant", "Welding (TR)". */
export function scopeName(req: Pick<ProductionRequest, "scope" | "trDept" | "lvDept" | "centre">): string {
  if (req.centre) return `${WORK_CENTRE_LABEL[req.centre]} (TR)`;
  if (req.scope === "TR") return req.trDept === "all" ? LINE_LABEL.TR : `${OUTPUT_GROUP_LABEL[req.trDept]} (TR)`;
  if (req.scope === "LV") return req.lvDept === "all" ? LINE_LABEL.LV : LV_FLOOR_DEPT_LABEL[req.lvDept];
  if (req.trDept !== "all" || req.lvDept !== "all") {
    return [req.trDept !== "all" ? `${OUTPUT_GROUP_LABEL[req.trDept]} (TR)` : null, req.lvDept !== "all" ? LV_FLOOR_DEPT_LABEL[req.lvDept] : null].filter(Boolean).join(" + ");
  }
  return "The whole plant";
}

/** Everything the page shows for a request, from the lines' facts (and the
 *  stretch before's, for the tiles' change). */
export function productionView(
  req: ProductionRequest,
  facts: readonly LineFacts[],
  before: readonly LineFacts[] | null,
  o: { todayISO: string; holidays: ReadonlySet<string> },
): ProductionView {
  const inRange = (iso: string) => iso >= req.fromISO && iso <= req.toISO;
  const days = facts.flatMap((l) => l.days).filter((d) => inRange(d.dateISO) && keepDay(req, d));
  const volume = facts.flatMap((l) => l.volume).filter((r) => inRange(r.dateISO) && keepVolume(req, r));
  const prevDays = before ? before.flatMap((l) => l.days).filter((d) => keepDay(req, d)) : null;
  // a department whose output carries no standard hours (and earned none another way — the
  // shot-blast crew earns the panels' blasting) has unknown earned hours, not zero: its hours
  // stay in the booked man-hours, out of the efficiency
  const earnedBy = new Map<string, number>();
  for (const d of days) earnedBy.set(deptKey(d), (earnedBy.get(deptKey(d)) ?? 0) + d.earnedH);
  const unpriced = new Set([...unpricedDepts(volume)].filter((k) => !((earnedBy.get(k) ?? 0) > 0)));
  const priced = (d: Pick<UnitDay, "line" | "dept">) => !unpriced.has(deptKey(d));
  const pricedDays = days.filter(priced);
  const figures = hoursFigures(days);
  const pricedFigures = hoursFigures(pricedDays);
  const prevFigures = prevDays ? hoursFigures(prevDays) : null;
  const prevPriced = prevDays ? hoursFigures(prevDays.filter(priced)) : null;
  // the earned side of the tiles from the priced departments; the hours, attendance and overtime from all
  const pricedKpis = kpisOf(pricedFigures, prevPriced);
  const kpis = kpisOf(figures, prevFigures).map((k, i) => (PRICED_FOCUS.has(k.key) ? pricedKpis[i] : k));
  const byLine: ProductionView["byLine"] = {};
  // each line that loaded — a line that failed is said in the Data popup, never shown as zero
  if (req.scope === "all") for (const l of facts.map((f) => f.line)) byLine[l] = hoursFigures(pricedDays.filter((d) => d.line === l));
  const name = scopeName(req);
  const ctx = { fromISO: req.fromISO, toISO: req.toISO, todayISO: o.todayISO, holidays: o.holidays };
  return {
    scopeName: name,
    figures,
    pricedFigures,
    kpis,
    byLine,
    coverage: coverageOf(days, volume, facts, ctx),
    daily: dailyHours(pricedDays),
    gaps: performanceGaps(pricedDays),
    // a not-priced department's days read as not priced, never 0%
    heat: heatGrid(days, unpriced),
    unpriced: [...unpriced],
    volume: volumeOf(volume),
    attendance: attendanceRows(days, req.shift),
    hours: hoursWalk(pricedDays, prevDays ? prevDays.filter(priced) : null, name),
    table: deptTable(days, volume, facts, ctx).map((r) => (unpriced.has(deptKey(r)) ? { ...r, efficiency: null, priced: false } : r)),
    trend: productivityTrend(days.map(toCentreDay), FLOOR_TREND_WINDOW),
    days,
  };
}

/** The unit-days a tile (or a day of the chart) opens: what its figure is the sum of. */
export function focusRows(view: Pick<ProductionView, "days">, focus: ProductionFocus | null, day: string | null): UnitDay[] {
  const rows = view.days.filter((d) => (day ? d.dateISO === day : true));
  const kept = focus === "attendance" ? rows.filter((d) => d.rows > 0) : rows.filter((d) => d.workedH > 0 || (day !== null && (d.earnedH > 0 || d.rows > 0)));
  return kept.sort((a, b) => a.dateISO.localeCompare(b.dateISO) || unitOrder(unitKey(a)) - unitOrder(unitKey(b)));
}

/** Which department filters a scope offers, as the select lists them. */
export function deptOptions(scope: ProductionScope): { line: ProductLine; value: string; label: string }[] {
  const tr = OUTPUT_GROUPS.map((g) => ({ line: "TR" as const, value: g, label: OUTPUT_GROUP_LABEL[g] }));
  const lv = LV_FLOOR_DEPTS.map((d) => ({ line: "LV" as const, value: d, label: LV_FLOOR_DEPT_LABEL[d] }));
  return scope === "TR" ? tr : scope === "LV" ? lv : [...tr, ...lv];
}

// ---------------------------------------------------------------- the sheets

type SheetRow = Record<string, string | number>;
const pctCell = (v: number | null) => (v === null ? "" : Math.round(v * 1000) / 10);

/** The departments' table as a sheet, its total row the tiles — what the
 *  assistant's Excel file of the dashboard holds. */
export function productionSheetRows(view: Pick<ProductionView, "table" | "figures" | "coverage" | "kpis">): SheetRow[] {
  const rows: SheetRow[] = view.table.map((r) => ({
    Line: r.line, Department: r.label, "Recorded days": r.recordedDays, "Working days": r.workingDays, "Coverage %": pctCell(r.coverage),
    "Person-days": r.personDays, "Booked h": r.workedH, "Overtime h": r.overtimeH, "Earned std-h": r.earnedH, "Efficiency %": pctCell(r.efficiency),
    Output: r.output, Unit: r.outputUnit,
  }));
  const f = view.figures;
  rows.push({
    Line: "", Department: TOTAL_LABEL, "Recorded days": view.coverage.recordedDays, "Working days": view.coverage.workingDays, "Coverage %": pctCell(view.coverage.share),
    "Person-days": f.personDays, "Booked h": f.workedH, "Overtime h": f.overtimeH, "Earned std-h": f.earnedH,
    "Efficiency %": pctCell(view.kpis.find((k) => k.key === "efficiency")?.value ?? null),
    // pieces and panels at different stages never add up
    Output: "", Unit: "",
  });
  return rows;
}

/** Every unit-day behind the figures as a sheet — the rows a tile opens. */
export function productionDayRows(view: Pick<ProductionView, "days">): SheetRow[] {
  return [...view.days]
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO) || unitOrder(unitKey(a)) - unitOrder(unitKey(b)))
    .map((d) => ({
      Day: d.dateISO, Line: d.line, Department: deptLabel(d.line, d.dept), Unit: unitLabel(d.line, d.unit),
      "Booked h": round1(d.workedH), "Earned std-h": round1(d.earnedH), "Efficiency %": d.workedH > 0 ? pctCell(d.earnedH / d.workedH) : "",
      People: d.people, "Overtime h": round1(d.overtimeH), Rows: d.rows, Absent: d.absent, "Not set": d.notSet ?? "",
      "Day shift h": round1(d.day.hours), "Night shift h": round1(d.night.hours),
      Note: d.workedH > 0 ? "" : d.earnedH > 0 ? "Output with no attendance — left out of the efficiency" : d.rows > 0 ? "Nobody present" : "",
    }));
}
