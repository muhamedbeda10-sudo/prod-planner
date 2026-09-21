// The shift week — the summary strip over the rosters.
//
// What the rates and the calibration need from a day is ONE number per
// department: the man-hours it worked. The per-worker roster is where it is
// recorded; this module only shapes the week the summary shows, so the
// grid can be tested without a database.

import { SHIFT_DEPTS, type ShiftDept } from "./shifts";

export const round1 = (n: number) => Math.round(n * 10) / 10;

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

/** One department's day as the roster summed it: heads present and man-hours. */
export interface WeekDayCell {
  people: number | null;
  hours: number;
  /** False until the department's roster was saved for the day. */
  recorded: boolean;
}

export type ShiftWeek = Record<string, Record<ShiftDept, WeekDayCell>>;

/** Week total per department, and the days that carry a figure. */
export function weekTotals(week: ShiftWeek): Record<ShiftDept, { hours: number; days: number }> {
  const out = Object.fromEntries(SHIFT_DEPTS.map((d) => [d, { hours: 0, days: 0 }])) as Record<ShiftDept, { hours: number; days: number }>;
  for (const cells of Object.values(week)) {
    for (const d of SHIFT_DEPTS) {
      const c = cells[d];
      if (c && c.recorded) { out[d].hours = round1(out[d].hours + c.hours); out[d].days += 1; }
    }
  }
  return out;
}
