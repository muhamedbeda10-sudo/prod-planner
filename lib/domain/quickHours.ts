// The quick hours entry — the planner's shortcut past the per-worker roster.
//
// What the rates and the calibration need from a day is ONE number per
// department: the man-hours it worked. The roster derives it from every
// worker's line; the quick entry takes it as heads present × hours each,
// typed into a week grid. Pure, so the grid can total as the planner types.

import { SHIFT_DEPTS, type ShiftDept } from "./shifts";

export const round1 = (n: number) => Math.round(n * 10) / 10;

/** Man-hours a department worked: heads × hours each; nothing when either is blank. */
export function quickHours(people: number | null | undefined, hoursEach: number | null | undefined): number {
  if (!people || !hoursEach || people <= 0 || hoursEach <= 0) return 0;
  return round1(people * hoursEach);
}

export interface QuickCellInput {
  dateISO: string;
  dept: ShiftDept;
  people: number | null;
  hoursEach: number | null;
}

/** What one typed cell means: `null` clears the day; else a checked figure.
 *  A head-count with no hours takes the default shift; hours with no heads
 *  are an error — the planner has to say how many came in. */
export function parseQuickCell(raw: { people?: unknown; hoursEach?: unknown }, defaultHours: number): { people: number; hoursEach: number } | null | { error: string } {
  const p = raw.people === "" || raw.people === null || raw.people === undefined ? null : Number(raw.people);
  const h = raw.hoursEach === "" || raw.hoursEach === null || raw.hoursEach === undefined ? null : Number(raw.hoursEach);
  if (p === null && h === null) return null;
  if (p === null || !Number.isInteger(p) || p < 0 || p > 500) return { error: "How many came in? A whole number, 0–500." };
  if (p === 0) return null;
  const hoursEach = h === null ? defaultHours : h;
  if (!Number.isFinite(hoursEach) || hoursEach <= 0 || hoursEach > 24) return { error: "Hours each must be between 0.5 and 24." };
  return { people: p, hoursEach: Math.round(hoursEach * 2) / 2 };
}

const addDaysISO = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dowOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 Sun … 6 Sat

/** The Saturday that starts the work week holding this day. */
export function weekStartISO(iso: string): string {
  return addDaysISO(iso, -((dowOf(iso) + 1) % 7));
}

/** The seven days of the work week from that Saturday, Friday last. */
export function weekDaysISO(startISO: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysISO(startISO, i));
}

export const isFridayISO = (iso: string) => dowOf(iso) === 5;

export interface QuickDayCell {
  people: number | null;
  hoursEach: number | null;
  hours: number;
  /** "roster" days were summed from the per-worker log and are read there. */
  source: "roster" | "quick" | null;
}

export type QuickWeek = Record<string, Record<ShiftDept, QuickDayCell>>;

/** Week total per department, and the days that carry a figure. */
export function weekTotals(week: QuickWeek): Record<ShiftDept, { hours: number; days: number }> {
  const out = Object.fromEntries(SHIFT_DEPTS.map((d) => [d, { hours: 0, days: 0 }])) as Record<ShiftDept, { hours: number; days: number }>;
  for (const cells of Object.values(week)) {
    for (const d of SHIFT_DEPTS) {
      const c = cells[d];
      if (c && c.hours > 0) { out[d].hours = round1(out[d].hours + c.hours); out[d].days += 1; }
    }
  }
  return out;
}
