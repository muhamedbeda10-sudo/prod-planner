// The floor's performance over a period the planner picks: each centre's
// efficiency day by day (the heatmap), what a person turns out, and how the
// hours were spent — attendance, overtime, the machines' availability. Pure,
// so the arithmetic is tested without a database; lib/server/kpis.ts
// (getFloorPeriod) reads the days and hands them here.
//
// Efficiency is the standard hours the output was worth ÷ the man-hours the
// shift log booked; a person-day is one person present on one recorded day.

import { WORK_CENTRES, round1, type ShiftDept, type WorkCentre } from "./shifts";
import { OUTPUT_GROUPS, centreCells, groupOfCentre, hoursStat, type CentreDay, type CentreStat, type OutputGroup } from "./kpis";
import { countsFor } from "./productivity";
import { addDaysISO, daysBetweenISO } from "./dateSlicer";
import { parseISODate, toISODate } from "./dates";

/** The longest period the floor's figures read at once. */
export const FLOOR_MAX_DAYS = 92;
/** How far back a period may start — the date slicer's left end too. */
export const FLOOR_HISTORY_DAYS = 180;
/** Recorded days the trend's rolling line covers. */
export const FLOOR_TREND_WINDOW = 7;
/** The section's own period when none is picked: the last 7 days, today included. */
export const FLOOR_DEFAULT_DAYS = 7;

/** The department filter: every centre, or one department's. */
export type FloorDept = "all" | OutputGroup;

export function isFloorDept(x: string | null | undefined): x is FloorDept {
  return x === "all" || (OUTPUT_GROUPS as readonly string[]).includes(x ?? "");
}

/** The roster's department each of the floor's departments is — the Shifts
 *  page and the other screens' ?dept= call Fabrication "Cut". */
export const ROSTER_OF: Record<OutputGroup, ShiftDept> = { Fabrication: "Cut", Welding: "Welding", ShotBlast: "ShotBlast", Painting: "Painting" };

/** A department filter as a link or the assistant may write it: the floor's
 *  own names, or the roster's ("Cut" for Fabrication); anything else is all. */
export function floorDeptOf(x: unknown): FloorDept {
  if (typeof x !== "string") return "all";
  if (isFloorDept(x)) return x;
  return OUTPUT_GROUPS.find((g) => ROSTER_OF[g] === x) ?? "all";
}

/** The centres a department filter keeps, in the floor's order. */
export function centresOf(dept: FloorDept): WorkCentre[] {
  return dept === "all" ? [...WORK_CENTRES] : WORK_CENTRES.filter((c) => groupOfCentre(c) === dept);
}

/** The departments a filter keeps. */
export function groupsOf(dept: FloorDept): OutputGroup[] {
  return dept === "all" ? [...OUTPUT_GROUPS] : [dept];
}

/** The departments whose output a transformer's Daily log row is — the
 *  Shifts page's own rule (OUTPUT_SOURCE): the blasters pass every painted
 *  piece, so a Painting row is shot blast's output as well as painting's. */
export function ledgerGroups(ledgerDept: string): OutputGroup[] {
  return OUTPUT_GROUPS.filter((g) => countsFor(ROSTER_OF[g], ledgerDept, false));
}

// ---------------------------------------------------------------- the period

/** The period a request asks for, held to the floor's limits: the right way
 *  round, never past today, starting at most FLOOR_HISTORY_DAYS back, and at
 *  most FLOOR_MAX_DAYS long (cut at its start). `clamped` when any of it moved. */
export function floorRange(fromISO: string, toISO: string, todayISO: string): { fromISO: string; toISO: string; clamped: boolean } {
  let [from, to] = fromISO > toISO ? [toISO, fromISO] : [fromISO, toISO];
  const earliest = addDaysISO(todayISO, -(FLOOR_HISTORY_DAYS - 1));
  if (to > todayISO) to = todayISO;
  if (from > to) from = to;
  if (from < earliest) from = earliest;
  if (to < from) to = from;
  if (daysBetweenISO(from, to) >= FLOOR_MAX_DAYS) from = addDaysISO(to, -(FLOOR_MAX_DAYS - 1));
  const asked = fromISO > toISO ? [toISO, fromISO] : [fromISO, toISO];
  return { fromISO: from, toISO: to, clamped: from !== asked[0] || to !== asked[1] };
}

/** A day as the URL or the assistant wrote it, as the factory's YYYY-MM-DD; null when it is not one. */
function dayOf(x: unknown): string | null {
  if (typeof x !== "string") return null;
  const d = parseISODate(x);
  return d ? toISODate(d) : null;
}

/** What the floor section and the assistant read for a request — the page's
 *  ?from=&to=&dept= or the tool's input — resolved one way for both: the
 *  last FLOOR_DEFAULT_DAYS days up to `to` (today when it is left out), every
 *  department, then held to the limits. `isDefault` when it is the section's own period. */
export function floorRequest(q: { from?: unknown; to?: unknown; dept?: unknown }, todayISO: string): { fromISO: string; toISO: string; dept: FloorDept; clamped: boolean; isDefault: boolean } {
  const to = dayOf(q.to) ?? todayISO;
  const from = dayOf(q.from) ?? addDaysISO(to, -(FLOOR_DEFAULT_DAYS - 1));
  const r = floorRange(from, to, todayISO);
  const def = floorDefault(todayISO);
  return { ...r, dept: floorDeptOf(q.dept), isDefault: r.fromISO === def.from && r.toISO === def.to };
}

/** The section's own period, as the date slicer's first quick filter. */
export function floorDefault(todayISO: string): { label: string; from: string; to: string } {
  return { label: `Last ${FLOOR_DEFAULT_DAYS} days`, from: addDaysISO(todayISO, -(FLOOR_DEFAULT_DAYS - 1)), to: todayISO };
}

// ---------------------------------------------------------------- the days

/** One centre on one day, as the shift log, the Daily log and the stops tell
 *  it — the cockpit's centre-day with who came and the overtime. */
export interface FloorDay<C extends string = WorkCentre> extends CentreDay<C> {
  overtimeH: number;
  /** Rows the shift log recorded (present or not), and how many were absent. */
  rows: number;
  absent: number;
}

/** The shift log's rows on one centre-day. */
export interface FloorAttendance<C extends string = WorkCentre> {
  dateISO: string;
  centre: C;
  rows: number;
  absent: number;
  overtimeH: number;
}

/** The period's centre-days of the centres kept: each recorded centre-day
 *  with its attendance, and a day the whole crew was away (rows, no hours). */
export function floorDays<C extends string = WorkCentre>(days: readonly CentreDay<C>[], attendance: readonly FloorAttendance<C>[], centres: readonly C[], fromISO: string, toISO: string): FloorDay<C>[] {
  const keep = new Set<C>(centres);
  const inRange = (iso: string) => iso >= fromISO && iso <= toISO;
  const att = new Map(attendance.map((a) => [`${a.dateISO}|${a.centre}`, a]));
  const out: FloorDay<C>[] = [];
  const seen = new Set<string>();
  for (const d of days) {
    if (!keep.has(d.centre) || !inRange(d.dateISO)) continue;
    const key = `${d.dateISO}|${d.centre}`;
    const a = att.get(key);
    seen.add(key);
    out.push({ ...d, overtimeH: a?.overtimeH ?? 0, rows: a?.rows ?? 0, absent: a?.absent ?? 0 });
  }
  for (const a of attendance) {
    const key = `${a.dateISO}|${a.centre}`;
    if (seen.has(key) || !keep.has(a.centre) || !inRange(a.dateISO)) continue;
    seen.add(key);
    out.push({ dateISO: a.dateISO, centre: a.centre, workedH: 0, people: 0, earnedH: 0, machineH: 0, downtimeH: 0, overtimeH: a.overtimeH, rows: a.rows, absent: a.absent });
  }
  return out;
}

/** Pieces the Daily log recorded on a day: the departments whose output they
 *  are, and whether they carry standard hours. */
export interface LedgerPieces {
  dateISO: string;
  groups: readonly OutputGroup[];
  pieces: number;
  priced: boolean;
}

/** Pieces the Daily log recorded for a department on a day. */
export interface FloorPieces {
  dateISO: string;
  group: OutputGroup;
  pieces: number;
}

/** The period's pieces by department, and the share of the period's records
 *  that carry standard hours — each record once, however many departments it counts for. */
export function floorPieces(rows: readonly LedgerPieces[], groups: readonly OutputGroup[], fromISO: string, toISO: string): { pieces: FloorPieces[]; pricedShare: number | null } {
  const pieces: FloorPieces[] = [];
  let qty = 0, priced = 0;
  for (const r of rows) {
    if (r.dateISO < fromISO || r.dateISO > toISO) continue;
    const mine = r.groups.filter((g) => groups.includes(g));
    if (mine.length === 0) continue;
    for (const g of mine) pieces.push({ dateISO: r.dateISO, group: g, pieces: r.pieces });
    qty += r.pieces;
    if (r.priced) priced += r.pieces;
  }
  return { pieces, pricedShare: qty > 0 ? Math.max(0, Math.min(1, priced / qty)) : null };
}

// ---------------------------------------------------------------- the figures

export interface FloorStat extends Omit<CentreStat, "centre"> {
  /** People present summed over the recorded days. */
  personDays: number;
  /** Standard hours one person turned out on a recorded day. */
  stdPerPersonDay: number | null;
  overtimeH: number;
  /** Overtime ÷ booked hours. */
  overtimeShare: number | null;
  /** Present rows ÷ recorded rows. */
  attendance: number | null;
}

/** Several centre-days as one figure — the cockpit's roll-up (hoursStat),
 *  with what a person turned out, the overtime and the attendance. */
export function floorStat(days: readonly FloorDay<string>[]): FloorStat {
  const s = hoursStat(days);
  const overtimeH = days.reduce((t, d) => t + d.overtimeH, 0);
  const rows = days.reduce((t, d) => t + d.rows, 0);
  const absent = days.reduce((t, d) => t + d.absent, 0);
  const booked = days.reduce((t, d) => t + (d.workedH > 0 ? d.workedH : 0), 0);
  return {
    ...s,
    stdPerPersonDay: s.personDays > 0 ? s.earnedH / s.personDays : null,
    overtimeH: round1(overtimeH),
    overtimeShare: booked > 0 ? overtimeH / booked : null,
    attendance: rows > 0 ? (rows - absent) / rows : null,
  };
}

/** The dates of the period that hold booked hours, oldest first. */
export function recordedDates(days: readonly CentreDay<string>[]): string[] {
  return [...new Set(days.filter((d) => d.workedH > 0).map((d) => d.dateISO))].sort();
}

export interface HeatCell {
  dateISO: string;
  workedH: number;
  earnedH: number;
  /** null where the centre booked no hours that day. */
  efficiency: number | null;
}

export interface HeatRow<C extends string = WorkCentre> {
  centre: C;
  cells: HeatCell[];
  /** The whole period together. */
  total: number | null;
  days: number;
}

/** Each centre's efficiency on each recorded day — the rows of the heatmap,
 *  one cell per date of `dates`, and the period's figure at the end. A centre
 *  that booked nothing in the period is left out. */
export function efficiencyGrid<C extends string = WorkCentre>(days: readonly CentreDay<C>[], centres: readonly C[], dates: readonly string[]): HeatRow<C>[] {
  return centres
    .map((centre) => {
      const s = hoursStat(days.filter((d) => d.centre === centre));
      return { centre, cells: centreCells(days, centre, dates), total: s.efficiency, days: s.days };
    })
    .filter((r) => r.days > 0);
}

export interface GroupProductivity extends FloorStat {
  group: OutputGroup;
  pieces: number;
  /** Pieces one person turned out on a recorded day. */
  piecesPerPersonDay: number | null;
}

/** Each department over the period: its people, hours, output and what one
 *  person turned out. A department with only stops keeps its row. */
export function groupProductivity(days: readonly FloorDay[], pieces: readonly FloorPieces[], groups: readonly OutputGroup[]): GroupProductivity[] {
  return groups
    .map((group) => {
      const mine = days.filter((d) => groupOfCentre(d.centre) === group);
      const s = floorStat(mine);
      // pieces count on the days the department booked hours, as its people do
      const booked = new Set(recordedDates(mine));
      const made = Math.max(0, pieces.filter((p) => p.group === group && booked.has(p.dateISO)).reduce((t, p) => t + p.pieces, 0));
      return { ...s, group, pieces: made, piecesPerPersonDay: s.personDays > 0 ? made / s.personDays : null };
    })
    .filter((g) => g.days > 0 || g.downtimeH > 0);
}

export interface ProductivityPoint {
  dateISO: string;
  workedH: number;
  earnedH: number;
  /** The day's efficiency. */
  efficiency: number | null;
  /** The last `window` recorded days up to this one together — the line to read, a day being noisy. */
  rolling: number | null;
  /** Standard hours one person turned out that day. */
  stdPerPersonDay: number | null;
}

/** The floor's efficiency day by day, with its rolling figure over `window` recorded days. */
export function productivityTrend(days: readonly CentreDay<string>[], window = FLOOR_TREND_WINDOW): ProductivityPoint[] {
  const byDay = new Map<string, { workedH: number; earnedH: number; people: number }>();
  for (const d of days) {
    if (!(d.workedH > 0)) continue;
    const v = byDay.get(d.dateISO) ?? { workedH: 0, earnedH: 0, people: 0 };
    v.workedH += d.workedH;
    v.earnedH += d.earnedH;
    v.people += d.people;
    byDay.set(d.dateISO, v);
  }
  const sorted = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  return sorted.map(([dateISO, v], i) => {
    const span = sorted.slice(Math.max(0, i - window + 1), i + 1);
    const w = span.reduce((s, [, x]) => s + x.workedH, 0);
    const e = span.reduce((s, [, x]) => s + x.earnedH, 0);
    return {
      dateISO,
      workedH: round1(v.workedH),
      earnedH: round1(v.earnedH),
      efficiency: v.workedH > 0 ? v.earnedH / v.workedH : null,
      rolling: w > 0 ? e / w : null,
      stdPerPersonDay: v.people > 0 ? v.earnedH / v.people : null,
    };
  });
}
