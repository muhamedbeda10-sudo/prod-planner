import type { SheetItem } from "@/lib/domain/constants";

// The shift log's arithmetic — pure, so the day's totals can be tested
// without a database and recomputed in the browser as the supervisor types.
//
// A department's day is its workers: each present or not, on the day or
// night shift, with overtime on top of the day shift only, and on
// a machine where the department has machines. A worker with no record for
// a day remains unassigned until the supervisor records it. The master
// roster and the daily attendance are deliberately separate.

/** The shifts the plant runs. The CODE is what a day is recorded under and
 *  never changes; the HOURS behind it are the planner's to set (Settings), so
 *  a new roster does not rewrite history. */
export const SHIFTS = { S9: 8, S11: 11 } as const;
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
}
export const DEFAULT_SHIFT_HOURS: ShiftHours = { short: SHIFTS.S9, long: SHIFTS.S11, overtime: DEFAULT_OVERTIME };

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
  const ot = l.shift === DEFAULT_SHIFT && Number.isFinite(l.overtimeH) && l.overtimeH > 0 ? l.overtimeH : 0;
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
    if (l.present && l.shift === DEFAULT_SHIFT && l.overtimeH > 0) overtimeH += l.overtimeH;
    if (l.present && l.machineId) byMachine[l.machineId] = round1((byMachine[l.machineId] ?? 0) + h);
  }
  return { workers: lines.length, present, hours: round1(hours), overtimeH: round1(overtimeH), byMachine };
}

export const round1 = (n: number) => Math.round(n * 10) / 10;

/** Machine hours a day really had: its hours a day less what stood still —
 *  null while the machine has no figure. */
export function machineAvailable(hoursPerDay: number | null, downtimeH: number): number | null {
  if (hoursPerDay === null) return null;
  return round1(Math.max(0, hoursPerDay - Math.max(0, downtimeH)));
}
