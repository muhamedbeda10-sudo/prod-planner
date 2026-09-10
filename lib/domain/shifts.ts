import type { SheetItem } from "@/lib/domain/constants";

// The shift log's arithmetic — pure, so the day's totals can be tested
// without a database and recomputed in the browser as the supervisor types.
//
// A department's day is its workers: each present or not, on the 9-hour or
// the 11-hour shift, with overtime on top (three hours is the usual), and on
// a machine where the department has machines. A worker with no record for
// a day counts as present on the default shift with no overtime — the
// supervisor records the exceptions, not the rule.

/** The shifts the plant runs and their hours. */
export const SHIFTS = { S9: 9, S11: 11 } as const;
export type ShiftCode = keyof typeof SHIFTS;
export const SHIFT_CODES = Object.keys(SHIFTS) as ShiftCode[];
export const DEFAULT_SHIFT: ShiftCode = "S9";
export const SHIFT_LABEL: Record<ShiftCode, string> = { S9: "9 h", S11: "11 h" };
/** The overtime the "+OT" button adds. */
export const DEFAULT_OVERTIME = 3;

export function isShiftCode(x: string): x is ShiftCode {
  return x in SHIFTS;
}

/** The departments the shift log records, in shop-floor order. */
export const SHIFT_DEPTS = ["Cut", "Welding", "ShotBlast", "Painting"] as const;
export type ShiftDept = (typeof SHIFT_DEPTS)[number];
export function isShiftDept(x: string): x is ShiftDept {
  return (SHIFT_DEPTS as readonly string[]).includes(x);
}

/** The departments whose work runs on machines — the ones whose shift log
 *  asks which machine a worker was on and records downtime. Welding is
 *  worked by people at benches; bending, for now, the same. */
export const MACHINE_DEPTS: readonly ShiftDept[] = ["Cut", "ShotBlast", "Painting"];

/** A work centre: the machines that do the same job. A job on "Cutting" can
 *  go to any laser or punch. */
export const CENTERS: Record<ShiftDept, readonly string[]> = {
  Cut: ["Cutting", "Fins", "Tubes", "RollBlank"],
  Welding: [],
  ShotBlast: ["Line"],
  Painting: ["Line"],
};
export const CENTER_LABEL: Record<string, string> = {
  Cutting: "Cutting (laser / punch)",
  Fins: "Fins",
  Tubes: "Laser tubes",
  RollBlank: "Laser roll blank",
  Line: "Line",
};

/** The route each component takes through fabrication, in order: cut on a
 *  laser or punch, then bent, and the tank's fins folded. Recorded from the
 *  planner's routing sheet for the machine load board; nothing consumes it
 *  yet. */
export const ROUTING: Record<SheetItem, readonly ("Cutting" | "Bending" | "Fins")[]> = {
  CF: ["Cutting", "Bending"],
  TC: ["Cutting"],
  TN: ["Cutting", "Bending", "Fins"],
  CB: ["Cutting", "Bending"],
};

export interface ShiftLine {
  present: boolean;
  shift: ShiftCode;
  overtimeH: number;
  machineId?: number | null;
}

/** The hours one worker's day is worth: nothing when absent, else the shift
 *  plus overtime. */
export function lineHours(l: ShiftLine): number {
  if (!l.present) return 0;
  const ot = Number.isFinite(l.overtimeH) && l.overtimeH > 0 ? l.overtimeH : 0;
  return SHIFTS[l.shift] + ot;
}

export interface DayTotals {
  workers: number;
  present: number;
  hours: number;
  overtimeH: number;
  /** Man-hours on each machine, by id — the load a machine really had. */
  byMachine: Record<number, number>;
}

export function dayTotals(lines: readonly ShiftLine[]): DayTotals {
  const byMachine: Record<number, number> = {};
  let present = 0, hours = 0, overtimeH = 0;
  for (const l of lines) {
    const h = lineHours(l);
    if (l.present) present += 1;
    hours += h;
    if (l.present && l.overtimeH > 0) overtimeH += l.overtimeH;
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
