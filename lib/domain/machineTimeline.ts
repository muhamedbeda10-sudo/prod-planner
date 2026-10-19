import { round1 } from "@/lib/domain/shifts";
import type { MachineCard, MachineQueueLine } from "@/lib/domain/machineBoard";

// 📊 The timeline behind the board's Timeline view — pure.
//
// A card says what is queued on a machine and how many hours it is worth. This
// lays those hours out on the calendar: each line becomes a BLOCK that starts
// when the one before it ends and lasts as long as the machine needs for it
// (its hours over the hours that machine has in a day). The queue's order is
// the card's own — running first, then the waiting ones as ranked — so the
// picture is exactly what the floor will do, only drawn.
//
// What it is for: a planner can read a load percentage and still not know
// whether the tank due Thursday will be cut in time. Here he sees the block
// land after its date, on that machine, and can drag the work elsewhere.

export interface TimelineBlock {
  key: string;
  bom: string;
  mo: string;
  item: string;
  /** Pieces on THIS machine. */
  pieces: number;
  hours: number | null;
  running: boolean;
  /** Working days from today: when the machine starts it and finishes it. */
  startDay: number;
  endDay: number;
  /** The working day this line owes its stage, on the same axis; null = no date. */
  dueDay: number | null;
  /** It is still running after the end of that day. A day of the axis spans
   *  elapsed [d, d+1), so finishing at 1.5 on a day-1 promise is ON TIME —
   *  the piece is done during the day it was owed. */
  late: boolean;
  /** Its hours are unknown, so it takes no time on the picture. */
  unpriced: boolean;
}

export interface TimelineRow {
  machineId: number;
  code: string;
  name: string;
  center: string;
  availableH: number | null;
  blocks: TimelineBlock[];
  /** Blocks that start beyond the horizon and are not drawn. */
  beyond: number;
  /** Working days the whole queue is worth. */
  totalDays: number;
  /** Blocks that will miss their date, drawn or not. */
  lateCount: number;
}

export interface Timeline {
  rows: TimelineRow[];
  /** The working days the picture spans, as ISO dates — index = day offset. */
  days: string[];
  /** Machines with work, and how many of their blocks are late. */
  lateCount: number;
  /** The longest queue, in working days. */
  spanDays: number;
}

/** The day-offset of a date on the timeline's own axis: the index of that
 *  working day, or null when the date is unknown. A date already past sits at
 *  0 — it is due now, not "some day before the picture". A date inside the
 *  picture that is not a working day (a Friday, a holiday) is due by the last
 *  working day before it: the lead times count calendar days, so a Saturday
 *  delivery is welding-due on the Friday before. */
export function dayOffsetOf(iso: string | null | undefined, days: readonly string[]): number | null {
  if (!iso) return null;
  const i = days.indexOf(iso);
  if (i >= 0) return i;
  if (days.length === 0) return null;
  if (iso < days[0]) return 0; // overdue
  if (iso > days[days.length - 1]) return null; // beyond the horizon — nothing useful to draw
  return days.filter((d) => d < iso).length - 1;
}

/**
 * Lay every machine's queue out on the working-day axis.
 *
 * `days` is the axis itself (index 0 = today), so the calendar — Fridays, the
 * plant's days off — is decided by whoever built it, and this module only
 * counts working days.
 */
export function buildTimeline(cards: readonly MachineCard[], days: readonly string[], horizon = days.length): Timeline {
  const rows: TimelineRow[] = [];
  let spanDays = 0;
  let lateTotal = 0;

  for (const c of cards) {
    const blocks: TimelineBlock[] = [];
    let at = 0;
    let beyond = 0;
    let lateCount = 0;
    for (const q of c.queue as readonly MachineQueueLine[]) {
      const unpriced = q.hours === null;
      // a machine with no hours a day cannot place anything in time
      const length = c.availableH !== null && c.availableH > 0 && q.hours !== null ? q.hours / c.availableH : 0;
      const start = at;
      const end = at + length;
      at = end;
      const dueDay = dayOffsetOf(q.dueISO ?? q.deliveryISO, days);
      const late = dueDay !== null && end > dueDay + 1 + 1e-9;
      if (late) lateCount += 1;
      if (start >= horizon) {
        beyond += 1;
        continue;
      }
      blocks.push({
        key: `${q.key}#${q.step}#${q.sheet}`,
        bom: q.bom, mo: q.mo, item: q.item,
        pieces: q.remaining,
        hours: q.hours,
        running: q.running,
        startDay: round1(start),
        endDay: round1(end),
        dueDay,
        late,
        unpriced,
      });
    }
    spanDays = Math.max(spanDays, at);
    lateTotal += lateCount;
    rows.push({
      machineId: c.machine.id,
      code: c.machine.code,
      name: c.machine.name,
      center: c.machine.center,
      availableH: c.availableH,
      blocks,
      beyond,
      totalDays: round1(at),
      lateCount,
    });
  }

  return { rows, days: [...days], lateCount: lateTotal, spanDays: round1(spanDays) };
}
