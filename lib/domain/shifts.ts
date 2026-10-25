import type { SheetItem } from "@/lib/domain/constants";

// The shift log's arithmetic — pure, so the day's totals can be tested
// without a database and recomputed in the browser as the supervisor types.
//
// A department's day is its workers: each present or not, on the day or
// night shift, with optional overtime on either shift, and on
// a machine where the department has machines. A worker with no record for
// a day remains unassigned until the supervisor records it. The master
// roster and the daily attendance are deliberately separate.

/** The shifts the plant runs. The CODE is what a day is recorded under and
 *  never changes; the HOURS behind it are the planner's to set (Settings), so
 *  a new roster does not rewrite history. */
export const SHIFTS = { S9: 8, S11: 8 } as const;
export type ShiftCode = keyof typeof SHIFTS;
export const SHIFT_CODES = Object.keys(SHIFTS) as ShiftCode[];
export const DEFAULT_SHIFT: ShiftCode = "S9";
/** The overtime the "+OT" button adds. */
export const DEFAULT_OVERTIME = 3;

/** What the two shifts are worth today, and the usual overtime. */
export interface ShiftHours {
  short: number;
  long: number;
  overtime: number;
  nightOvertime?: number;
}
export const DEFAULT_SHIFT_HOURS: ShiftHours = { short: SHIFTS.S9, long: SHIFTS.S11, overtime: DEFAULT_OVERTIME, nightOvertime: DEFAULT_OVERTIME };

/** Hours one shift is worth. */
export function hoursOfShift(code: ShiftCode, h: ShiftHours = DEFAULT_SHIFT_HOURS): number {
  return code === "S11" ? h.long : h.short;
}
/** How a shift reads on screen: its hours, from the settings. */
export function shiftLabel(code: ShiftCode, h: ShiftHours = DEFAULT_SHIFT_HOURS): string {
  return `${code === "S9" ? "Day" : "Night"} · ${round1(hoursOfShift(code, h))} h`;
}

export function isShiftCode(x: string): x is ShiftCode {
  return x in SHIFTS;
}

/** The transformer departments the shift log records, in shop-floor order —
 *  the ones the machines list and the calibration know. */
export const SHIFT_DEPTS = ["Cut", "Welding", "ShotBlast", "Painting"] as const;
export type ShiftDept = (typeof SHIFT_DEPTS)[number];
export function isShiftDept(x: string): x is ShiftDept {
  return (SHIFT_DEPTS as readonly string[]).includes(x);
}

/** Every department the ROSTER lists people for: the transformer four and
 *  the panels' four. A worker's day is recorded under the department his
 *  section rolls up to; the section itself is what the roster filters by. */
export const ROSTER_DEPTS = [...SHIFT_DEPTS, "Punching", "Bending", "WeldingLV", "PaintingLV"] as const;
export type RosterDept = (typeof ROSTER_DEPTS)[number];
export function isRosterDept(x: string): x is RosterDept {
  return (ROSTER_DEPTS as readonly string[]).includes(x);
}
export const ROSTER_DEPT_LINE: Record<RosterDept, "TR" | "LV"> = {
  Cut: "TR", Welding: "TR", ShotBlast: "TR", Painting: "TR",
  Punching: "LV", Bending: "LV", WeldingLV: "LV", PaintingLV: "LV",
};

/** The departments whose work runs on machines — the ones whose shift log
 *  asks which machine a worker was on and records downtime. Welding has no
 *  machines: its "machines" are PARTITIONS of the bay, each a group of
 *  welders working the same orders — they live on the same list so a
 *  partition can be loaded, staffed and drawn like a machine. The bending
 *  presses are one machine on the list too — the plant runs about ten of
 *  them and plans them as a single centre. */
export const MACHINE_DEPTS: readonly ShiftDept[] = ["Cut", "Welding", "ShotBlast", "Painting"];

/** A work centre: the machines that do the same job. A job on "Cutting" can
 *  go to any laser or punch. */
export const CENTERS: Record<ShiftDept, readonly string[]> = {
  Cut: ["Cutting", "Bending", "Fins", "Tubes", "RollBlank"],
  Welding: ["Zone"],
  ShotBlast: ["Line"],
  Painting: ["Line"],
};
export const CENTER_LABEL: Record<string, string> = {
  Cutting: "Cutting (laser / punch)",
  Bending: "Bending (presses)",
  Fins: "Fins",
  Tubes: "Laser tubes",
  RollBlank: "Laser roll blank",
  Line: "Line",
  Zone: "Partition (welding bay)",
};

/** What a department's "machines" are called on its pages. */
export function machineWord(dept: string, plural = false): string {
  if (dept === "Welding") return plural ? "partitions" : "partition";
  if (dept === "Painting" || dept === "ShotBlast") return plural ? "lines" : "line";
  return plural ? "machines" : "machine";
}

/** The work centres people are booked on: Fabrication's three — laser /
 *  punch, bending and fin folding — and one for each later stage. The hours
 *  a centre worked come from the shift log; what it earned, from the output. */
export const WORK_CENTRES = ["Cutting", "Bending", "Fins", "Welding", "ShotBlast", "Painting"] as const;
export type WorkCentre = (typeof WORK_CENTRES)[number];
export function isWorkCentre(x: string): x is WorkCentre {
  return (WORK_CENTRES as readonly string[]).includes(x);
}
export const WORK_CENTRE_LABEL: Record<WorkCentre, string> = {
  Cutting: "Laser / punch",
  Bending: "Bending",
  Fins: "Fin folding",
  Welding: "Welding",
  ShotBlast: "Shot blast",
  Painting: "Painting",
};
/** The centres of each transformer department, in shop-floor order. */
export const DEPT_CENTRES: Record<ShiftDept, readonly WorkCentre[]> = {
  Cut: ["Cutting", "Bending", "Fins"],
  Welding: ["Welding"],
  ShotBlast: ["ShotBlast"],
  Painting: ["Painting"],
};
/** The department a centre belongs to. */
export function centreDept(c: WorkCentre): ShiftDept {
  return c === "Cutting" || c === "Bending" || c === "Fins" ? "Cut" : c;
}
/** The centre a Fabrication section works at, unless the day says otherwise.
 *  Channels are formed on the presses, so they book to bending. */
export const SECTION_CENTRE: Record<string, WorkCentre> = { LaserCutTX: "Cutting", BendingTX: "Bending", Channels: "Bending", Fins: "Fins" };

/** Where each of Fabrication's machine centres books its hours and stops:
 *  the lasers on tubes and roll blanks cut like any laser. A machine centre
 *  added to CENTERS.Cut must be placed here. */
const CUT_MACHINE_CENTRE: Record<string, WorkCentre> = { Cutting: "Cutting", Tubes: "Cutting", RollBlank: "Cutting", Bending: "Bending", Fins: "Fins" };

/** The work centre a machine's hours and stops count at; outside
 *  Fabrication a line or a partition is its stage. */
export function machineWorkCentre(dept: string, center: string): WorkCentre | null {
  if (dept === "Cut") return CUT_MACHINE_CENTRE[center] ?? null;
  return isWorkCentre(dept) ? dept : null;
}

/** The centres a department books its workers to — only a department with
 *  more than one (Fabrication) asks; the others are their own centre. */
export function workerCentres(dept: string): readonly WorkCentre[] | null {
  return isShiftDept(dept) && DEPT_CENTRES[dept].length > 1 ? DEPT_CENTRES[dept] : null;
}

/** The centre a department's hours count at when it has only one. */
export function deptCentre(dept: string): WorkCentre | null {
  return isShiftDept(dept) && DEPT_CENTRES[dept].length === 1 ? DEPT_CENTRES[dept][0] : null;
}

/** The centre a Fabrication worker's day books to: the one recorded for the
 *  day when it is Fabrication's, else his section's, else the laser. Null for
 *  a department that does not book workers to centres (see workerCentres). */
export function centreOf(dept: string, sections: readonly string[], recorded?: string | null): WorkCentre | null {
  const own = workerCentres(dept);
  if (!own) return null;
  if (recorded && isWorkCentre(recorded) && own.includes(recorded)) return recorded;
  for (const sec of sections) {
    const c = SECTION_CENTRE[sec];
    if (c && own.includes(c)) return c;
  }
  return own[0];
}

/** The route each component takes through fabrication, in order: cut on a
 *  laser or punch, then bent, and the tank's fins folded — the planner's
 *  routing sheet. A piece owes work at EVERY centre on its route, so the load
 *  board queues it on one machine per centre and the planner sequences each. */
export const ROUTING: Record<SheetItem, readonly ("Cutting" | "Bending" | "Fins")[]> = {
  CF: ["Cutting", "Bending"],
  TC: ["Cutting"],
  TN: ["Cutting", "Bending", "Fins"],
  CB: ["Cutting", "Bending"],
};

/** The crew each fabrication work centre carries, from the capacity sheet
 *  ("available manpower: laser 15 + bending 8 + fin folding 10 people").
 *  Two jobs: it seeds a machine's hours a day, and it SPLITS an item's cut
 *  hours over the centres its route visits — the timings sheet prices the
 *  whole stage ("Cut = laser + bending + fin folding"), never each centre. */
export const CENTER_CREW: Record<string, number> = { Cutting: 15, Bending: 8, Fins: 10 };

/** The centres a line must pass in this department, in order. Outside
 *  fabrication a department is one centre, so the route is that one step. */
export function routeFor(dept: string, item: string): readonly string[] {
  if (dept !== "Cut") return dept === "Welding" ? ["Zone"] : ["Line"];
  return ROUTING[item as SheetItem] ?? ["Cutting"]; // AR / MB — cut only
}

/** How ONE piece's stage hours divide over the centres of its route, in
 *  proportion to the crew that does the work, normalised over that item's own
 *  route: a top cover never sees bending, so its whole cut is cutting; a tank
 *  splits over all three. INFERRED — the sheet gives the stage total and the
 *  centre crews, not the hours per centre — so the split is a plan estimate,
 *  and a machine's hours a day (Tools → Machines) is what tunes it. */
export function centerShares(dept: string, item: string): Record<string, number> {
  const route = routeFor(dept, item);
  const weights = route.map((c) => CENTER_CREW[c] ?? 1);
  const total = weights.reduce((s, w) => s + w, 0) || 1;
  const out: Record<string, number> = {};
  route.forEach((c, i) => { out[c] = weights[i] / total; });
  return out;
}

export interface ShiftLine {
  present: boolean;
  shift: ShiftCode;
  overtimeH: number;
  machineId?: number | null;
}

/** The hours one worker's day is worth: nothing when absent, else the shift
 *  plus overtime. */
export function lineHours(l: ShiftLine, h: ShiftHours = DEFAULT_SHIFT_HOURS): number {
  if (!l.present) return 0;
  const ot = Number.isFinite(l.overtimeH) && l.overtimeH > 0 ? l.overtimeH : 0;
  return hoursOfShift(l.shift, h) + ot;
}

export interface DayTotals {
  workers: number;
  present: number;
  hours: number;
  overtimeH: number;
  /** Man-hours on each machine, by id — the load a machine really had. */
  byMachine: Record<number, number>;
}

export function dayTotals(lines: readonly ShiftLine[], hrs: ShiftHours = DEFAULT_SHIFT_HOURS): DayTotals {
  const byMachine: Record<number, number> = {};
  let present = 0, hours = 0, overtimeH = 0;
  for (const l of lines) {
    const h = lineHours(l, hrs);
    if (l.present) present += 1;
    hours += h;
    if (l.present && Number.isFinite(l.overtimeH) && l.overtimeH > 0) overtimeH += l.overtimeH;
    if (l.present && l.machineId) byMachine[l.machineId] = round1((byMachine[l.machineId] ?? 0) + h);
  }
  return { workers: lines.length, present, hours: round1(hours), overtimeH: round1(overtimeH), byMachine };
}

export const round1 = (n: number) => Math.round(n * 10) / 10;

/** Where a worker was on a day, as the supervisor picks it: one choice that
 *  says both whether he came and which shift — the day shift (S9) or the
 *  night shift (S11). "unset" is a worker the day has no record for yet. */
export type Attendance = "day" | "night" | "absent";
export const ATTENDANCE_SHIFT: Record<Exclude<Attendance, "absent">, ShiftCode> = { day: "S9", night: "S11" };
export const ATTENDANCES = ["day", "night", "absent"] as const satisfies readonly Attendance[];
export function isAttendance(x: string): x is Attendance {
  return (ATTENDANCES as readonly string[]).includes(x);
}

export const ATTENDANCE_LABEL: Record<Attendance, string> = { day: "Day", night: "Night", absent: "Absent" };
/** The clock times each shift stands for, as the floor names them. */
export const ATTENDANCE_TIME: Record<Exclude<Attendance, "absent">, string> = { day: "07:00–16:00", night: "19:00–04:00" };
export const OVERTIME_TIME = "16:00–19:00";
export const NIGHT_OVERTIME_TIME = "04:00–07:00";
export const overtimeTime = (shift: ShiftCode) => shift === "S11" ? NIGHT_OVERTIME_TIME : OVERTIME_TIME;
export const overtimeHoursFor = (shift: ShiftCode, hours: ShiftHours = DEFAULT_SHIFT_HOURS) => shift === "S11" ? hours.nightOvertime ?? DEFAULT_OVERTIME : hours.overtime;
/** A worker the day has no record for yet: not set, worth nothing. */
export const UNSET_LINE = { present: false, shift: DEFAULT_SHIFT, overtimeH: 0 } as const;

export function attendanceOf(l: { recorded?: boolean; present: boolean; shift: ShiftCode }): Attendance | "unset" {
  if (l.recorded === false) return "unset";
  if (!l.present) return "absent";
  return l.shift === "S11" ? "night" : "day";
}

/** A worker's line for an attendance choice. Overtime is kept on the same
 *  shift and cleared when changing shifts. A worker away on
 *  vacation is absent whatever the choice for "the rest" was. */
export function attendanceLine(a: Attendance, current: { overtimeH: number; shift?: ShiftCode } = { overtimeH: 0 }, onVacation = false): { present: boolean; shift: ShiftCode; overtimeH: number } {
  if (a === "absent" || onVacation) return { present: false, shift: DEFAULT_SHIFT, overtimeH: 0 };
  const shift = ATTENDANCE_SHIFT[a];
  return { present: true, shift, overtimeH: current.shift && current.shift !== shift ? 0 : current.overtimeH };
}

export interface ShiftSplit {
  /** Everyone counted. */
  workers: number;
  day: { people: number; hours: number; overtimePeople: number; overtimeH: number };
  night: { people: number; hours: number; overtimePeople: number; overtimeH: number };
  absent: number;
  unset: number;
  /** Man-hours of the day, both shifts and the overtime. */
  hours: number;
}

/** Who came on which shift: the day's figures split by the day and the
 *  night shift, with the absences and the workers not set yet. */
export function shiftSplit(lines: readonly { recorded?: boolean; present: boolean; shift: ShiftCode; overtimeH: number }[], h: ShiftHours = DEFAULT_SHIFT_HOURS): ShiftSplit {
  const s: ShiftSplit = { workers: lines.length, day: { people: 0, hours: 0, overtimePeople: 0, overtimeH: 0 }, night: { people: 0, hours: 0, overtimePeople: 0, overtimeH: 0 }, absent: 0, unset: 0, hours: 0 };
  for (const l of lines) {
    const a = attendanceOf(l);
    if (a === "unset") s.unset += 1;
    else if (a === "absent") s.absent += 1;
    else {
      const hours = lineHours(l, h);
      const part = s[a];
      part.people += 1;
      part.hours += hours;
      if (Number.isFinite(l.overtimeH) && l.overtimeH > 0) { part.overtimePeople += 1; part.overtimeH += l.overtimeH; }
    }
  }
  s.day.hours = round1(s.day.hours);
  s.day.overtimeH = round1(s.day.overtimeH);
  s.night.hours = round1(s.night.hours);
  s.night.overtimeH = round1(s.night.overtimeH);
  s.hours = round1(s.day.hours + s.night.hours);
  return s;
}

/** Machine hours a day really had: its hours a day less what stood still —
 *  null while the machine has no figure. */
export function machineAvailable(hoursPerDay: number | null, downtimeH: number): number | null {
  if (hoursPerDay === null) return null;
  return round1(Math.max(0, hoursPerDay - Math.max(0, downtimeH)));
}
