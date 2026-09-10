import { round1 } from "@/lib/domain/shifts";
import { dayOffsetOf } from "@/lib/domain/machineTimeline";

// 📈 The department's load over the days ahead — pure.
//
// Every open line owes a stage a number of standard hours by a certain day.
// This adds those hours up per day and sets them against the hours the
// department HAS that day (its machines' hours, less today's downtime), then
// carries both forward: work can be done early, so what decides whether a
// week is deliverable is not any single day but whether the running total of
// what is owed ever passes the running total of what can be worked.
//
// The answer it exists to give: "you go short on Tuesday, by 90 hours" — or
// "the week clears with 200 hours to spare".

export interface LoadInput {
  /** Standard hours the line still owes this stage; null = no figure. */
  hours: number | null;
  /** The day this stage owes it. Null = no date, so it is not on the curve. */
  dueISO: string | null;
}

export interface LoadDay {
  dateISO: string;
  /** Standard hours owed BY the end of that day. */
  owedH: number;
  /** Hours the department has that day. */
  capacityH: number;
  /** Both, added up from today to that day. */
  cumOwedH: number;
  cumCapH: number;
  /** How far the running total of work is past the running total of hours —
   *  0 while the department is still ahead. */
  shortH: number;
  /** More is owed on this day than the department can work in it. */
  over: boolean;
}

export interface DeptLoad {
  days: LoadDay[];
  /** The first day the running totals cross — null when the week clears. */
  shortFromISO: string | null;
  /** Hours to spare over the whole picture; negative = short by that much. */
  spareH: number;
  /** The tallest day, for the scale. */
  peakH: number;
  totalOwedH: number;
  totalCapH: number;
  /** Open work with no date at all — real, but nothing says when. */
  undatedH: number;
  /** Work owed past the end of the picture. */
  beyondH: number;
  /** Lines with no standard time — their hours are missing from all of this. */
  unpricedLines: number;
}

/**
 * Add the open work up against the hours available, day by day.
 *
 * `days` is the working-day axis (index 0 = today) and `capacityH` the hours
 * the department has on each of those days — the caller decides both, so the
 * calendar and the plant's own capacity stay out of this module.
 */
export function buildDeptLoad(lines: readonly LoadInput[], days: readonly string[], capacityH: readonly number[]): DeptLoad {
  const owed = new Array(days.length).fill(0) as number[];
  let undatedH = 0;
  let beyondH = 0;
  let unpricedLines = 0;

  for (const l of lines) {
    if (l.hours === null) {
      unpricedLines += 1;
      continue;
    }
    if (!(l.hours > 0)) continue;
    if (!l.dueISO) {
      undatedH += l.hours;
      continue;
    }
    const at = dayOffsetOf(l.dueISO, days);
    // a date past the picture is real work, just not this week's problem
    if (at === null) {
      beyondH += l.hours;
      continue;
    }
    owed[at] += l.hours;
  }

  let cumOwed = 0;
  let cumCap = 0;
  let shortFromISO: string | null = null;
  let peak = 0;
  const out: LoadDay[] = days.map((dateISO, i) => {
    const capacity = Math.max(0, capacityH[i] ?? 0);
    cumOwed += owed[i];
    cumCap += capacity;
    const shortH = Math.max(0, cumOwed - cumCap);
    if (shortH > 0 && shortFromISO === null) shortFromISO = dateISO;
    peak = Math.max(peak, owed[i], capacity);
    return {
      dateISO,
      owedH: round1(owed[i]),
      capacityH: round1(capacity),
      cumOwedH: round1(cumOwed),
      cumCapH: round1(cumCap),
      shortH: round1(shortH),
      over: owed[i] > capacity + 1e-9,
    };
  });

  return {
    days: out,
    shortFromISO,
    spareH: round1(cumCap - cumOwed),
    peakH: round1(peak),
    totalOwedH: round1(cumOwed),
    totalCapH: round1(cumCap),
    undatedH: round1(undatedH),
    beyondH: round1(beyondH),
    unpricedLines,
  };
}
