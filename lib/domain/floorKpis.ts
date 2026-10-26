// The floor's performance over a period the planner picks: each centre's
// efficiency day by day (the heatmap), what a person turns out, and how the
// hours were spent — attendance, overtime, the machines' availability. Pure,
// so the arithmetic is tested without a database; lib/server/kpis.ts
// (getFloorPeriod) reads the days and hands them here.
//
// Efficiency is the standard hours the output was worth ÷ the man-hours the
// shift log booked; a person-day is one person present on one recorded day.

import { WORK_CENTRES, round1, type WorkCentre } from "./shifts";
import { OUTPUT_GROUPS, groupOfCentre, type OutputGroup } from "./kpis";
import { addDaysISO, daysBetweenISO } from "./dateSlicer";

/** The department filter: every centre, or one department's. */
export type FloorDept = "all" | OutputGroup;

export function isFloorDept(x: string | null | undefined): x is FloorDept {
  return x === "all" || (OUTPUT_GROUPS as readonly string[]).includes(x ?? "");
}

/** The centres a department filter keeps, in the floor's order. */
export function centresOf(dept: FloorDept): WorkCentre[] {
  return dept === "all" ? [...WORK_CENTRES] : WORK_CENTRES.filter((c) => groupOfCentre(c) === dept);
}

/** The departments a filter keeps. */
export function groupsOf(dept: FloorDept): OutputGroup[] {
  return dept === "all" ? [...OUTPUT_GROUPS] : [dept];
}

/** One centre on one day, as the shift log, the Daily log and the stops tell it. */
export interface FloorDay {
  dateISO: string;
  centre: WorkCentre;
  /** Man-hours booked (present people's shift plus overtime). */
  workedH: number;
  /** People present. */
  people: number;
  earnedH: number;
  /** Machine hours the centre had (its machines' hours a day), on a day with booked hours. */
  machineH: number;
  downtimeH: number;
  overtimeH: number;
  /** Rows the shift log recorded (present or not), and how many were absent. */
  rows: number;
  absent: number;
}

/** Pieces the Daily log recorded for a department on a day. */
export interface FloorPieces {
  dateISO: string;
  group: OutputGroup;
  pieces: number;
}

export interface FloorStat {
  /** Recorded days: days with booked hours. */
  days: number;
  workedH: number;
  earnedH: number;
  /** earned ÷ worked; null without booked hours. */
  efficiency: number | null;
  /** People present summed over the recorded days. */
  personDays: number;
  /** Average people present on a recorded day. */
  people: number;
  /** Standard hours one person turned out on a recorded day. */
  stdPerPersonDay: number | null;
  overtimeH: number;
  /** Overtime ÷ booked hours. */
  overtimeShare: number | null;
  /** Present rows ÷ recorded rows. */
  attendance: number | null;
  downtimeH: number;
  /** 1 − stopped ÷ machine hours; null where there are no machine hours. */
  availability: number | null;
}

/** Several centre-days as one figure. Days without booked hours count no
 *  efficiency and no people, but their stops still count. */
export function floorStat(days: readonly FloorDay[]): FloorStat {
  const worked = days.filter((d) => d.workedH > 0);
  const workedH = worked.reduce((s, d) => s + d.workedH, 0);
  const earnedH = worked.reduce((s, d) => s + d.earnedH, 0);
  const machineH = worked.reduce((s, d) => s + d.machineH, 0);
  const personDays = worked.reduce((s, d) => s + d.people, 0);
  const dates = new Set(worked.map((d) => d.dateISO));
  const overtimeH = days.reduce((s, d) => s + d.overtimeH, 0);
  const rows = days.reduce((s, d) => s + d.rows, 0);
  const absent = days.reduce((s, d) => s + d.absent, 0);
  const downtimeH = days.reduce((s, d) => s + d.downtimeH, 0);
  return {
    days: dates.size,
    workedH: round1(workedH),
    earnedH: round1(earnedH),
    efficiency: workedH > 0 ? earnedH / workedH : null,
    personDays,
    people: dates.size ? round1(personDays / dates.size) : 0,
    stdPerPersonDay: personDays > 0 ? earnedH / personDays : null,
    overtimeH: round1(overtimeH),
    overtimeShare: workedH > 0 ? overtimeH / workedH : null,
    attendance: rows > 0 ? (rows - absent) / rows : null,
    downtimeH: round1(downtimeH),
    availability: machineH > 0 ? Math.max(0, 1 - downtimeH / machineH) : null,
  };
}

export interface HeatCell {
  dateISO: string;
  workedH: number;
  earnedH: number;
  /** null where the centre booked no hours that day. */
  efficiency: number | null;
}

export interface HeatRow {
  centre: WorkCentre;
  cells: HeatCell[];
  /** The whole period together. */
  total: number | null;
  days: number;
}

/** Each centre's efficiency on each recorded day — the rows of the heatmap,
 *  one cell per date of `dates`, and the period's figure at the end. A centre
 *  that booked nothing in the period is left out. */
export function efficiencyGrid(days: readonly FloorDay[], centres: readonly WorkCentre[], dates: readonly string[]): HeatRow[] {
  const at = new Map(days.map((d) => [`${d.dateISO}|${d.centre}`, d]));
  return centres
    .map((centre) => {
      const cells = dates.map((dateISO) => {
        const d = at.get(`${dateISO}|${centre}`);
        const workedH = d?.workedH ?? 0;
        const earnedH = d?.earnedH ?? 0;
        return { dateISO, workedH: round1(workedH), earnedH: round1(earnedH), efficiency: workedH > 0 ? earnedH / workedH : null };
      });
      const s = floorStat(days.filter((d) => d.centre === centre));
      return { centre, cells, total: s.efficiency, days: s.days };
    })
    .filter((r) => r.days > 0);
}

export interface GroupProductivity extends FloorStat {
  group: OutputGroup;
  pieces: number;
  /** Pieces one person turned out on a recorded day. */
  piecesPerPersonDay: number | null;
}

/** Each department over the period: its people, hours, output and what one person turned out. */
export function groupProductivity(days: readonly FloorDay[], pieces: readonly FloorPieces[], groups: readonly OutputGroup[]): GroupProductivity[] {
  return groups
    .map((group) => {
      const s = floorStat(days.filter((d) => groupOfCentre(d.centre) === group));
      // pieces count on the days the department booked hours, as its people do
      const booked = new Set(days.filter((d) => d.workedH > 0 && groupOfCentre(d.centre) === group).map((d) => d.dateISO));
      const made = pieces.filter((p) => p.group === group && booked.has(p.dateISO)).reduce((t, p) => t + Math.max(0, p.pieces), 0);
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
export function productivityTrend(days: readonly FloorDay[], window = 7): ProductivityPoint[] {
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

/** The longest period the floor's figures read at once. */
export const FLOOR_MAX_DAYS = 92;

/** The period a request asks for, held to the floor's limits: never past
 *  today, the right way round, and at most FLOOR_MAX_DAYS long (cut at its start). */
export function floorRange(fromISO: string, toISO: string, todayISO: string): { fromISO: string; toISO: string } {
  let to = toISO > todayISO ? todayISO : toISO;
  let from = fromISO;
  if (from > to) [from, to] = [to, from];
  if (daysBetweenISO(from, to) >= FLOOR_MAX_DAYS) from = addDaysISO(to, -(FLOOR_MAX_DAYS - 1));
  return { fromISO: from, toISO: to };
}
