import { round1 } from "@/lib/domain/shifts";

// What an item REALLY takes on a machine, measured — pure.
//
// Two things the app already records make it possible: the pieces a machine
// finished (a ✓ on its card carries the machine) and the man-hours the shift
// log put on that machine that day. One machine usually runs several items in
// a day, so a day's hours are split between them in proportion to the standard
// hours their output earned — the same way the department-level calibration
// splits a day. When nothing on the machine that day carries a standard time
// (AR, MB, or a class nobody has priced), the split falls back to pieces, so
// those items still end up with a measured figure — often the only one there
// will ever be. A day that mixes priced and unpriced items is left out: it
// cannot be split without loading one kind with the other's hours.
//
// The answer is deliberately plain: pieces, hours, and hours a piece. The
// planner compares it with what he typed and decides.

/** One day's output of one item on one machine. */
export interface RateOutput {
  dateISO: string;
  machineId: number;
  item: string;
  qty: number;
  /** Standard hours those pieces earn at this stage; 0 when nothing is priced. */
  stdHours: number;
}

/** Man-hours the shift log put on one machine on one day. */
export interface RateHours {
  dateISO: string;
  machineId: number;
  hours: number;
}

export interface MeasuredRate {
  machineId: number;
  item: string;
  pieces: number;
  /** Man-hours attributed to this item on this machine. */
  hours: number;
  /** What one piece really took: hours / pieces. */
  hoursPerPc: number;
  /** Days that carried both output and hours — how much this figure rests on. */
  days: number;
}

export function measureRates(output: readonly RateOutput[], hours: readonly RateHours[]): MeasuredRate[] {
  const hoursOn = new Map<string, number>();
  for (const h of hours) {
    if (!(h.hours > 0)) continue;
    const k = `${h.dateISO}#${h.machineId}`;
    hoursOn.set(k, (hoursOn.get(k) ?? 0) + h.hours);
  }

  // a machine's day, gathered so its hours can be split between what it ran —
  // one line per item, however many log rows recorded it, so a day counts once
  const byDay = new Map<string, Map<string, RateOutput>>();
  for (const o of output) {
    if (!(o.qty > 0)) continue;
    const k = `${o.dateISO}#${o.machineId}`;
    const items = byDay.get(k) ?? byDay.set(k, new Map()).get(k)!;
    const at = items.get(o.item);
    if (at) items.set(o.item, { ...at, qty: at.qty + o.qty, stdHours: at.stdHours + Math.max(0, o.stdHours) });
    else items.set(o.item, { ...o, stdHours: Math.max(0, o.stdHours) });
  }

  const acc = new Map<string, MeasuredRate>();
  for (const [k, items] of byDay) {
    const dayHours = hoursOn.get(k);
    if (!dayHours || !(dayHours > 0)) continue; // no crew recorded — nothing to measure with
    const rows = [...items.values()];
    // a day mixing priced and unpriced items has no fair way to split: by
    // standard hours the unpriced ones would get nothing and the priced ones
    // would carry their hours, by pieces a tank would weigh what a bolt does —
    // so it measures nothing rather than something wrong
    if (rows.some((r) => r.stdHours > 0) && rows.some((r) => !(r.stdHours > 0))) continue;
    const std = rows.reduce((s, r) => s + Math.max(0, r.stdHours), 0);
    const pcs = rows.reduce((s, r) => s + r.qty, 0);
    for (const r of rows) {
      // its share of the day: by standard hours where there are any, by pieces
      // otherwise — an unpriced item still gets what its pieces are worth
      const share = std > 0 ? Math.max(0, r.stdHours) / std : pcs > 0 ? r.qty / pcs : 0;
      if (share <= 0) continue;
      const key = `${r.machineId}#${r.item}`;
      const at = acc.get(key) ?? { machineId: r.machineId, item: r.item, pieces: 0, hours: 0, hoursPerPc: 0, days: 0 };
      at.pieces += r.qty;
      at.hours += dayHours * share;
      at.days += 1;
      acc.set(key, at);
    }
  }

  const out: MeasuredRate[] = [];
  for (const r of acc.values()) {
    if (!(r.pieces > 0) || !(r.hours > 0)) continue;
    out.push({
      machineId: r.machineId,
      item: r.item,
      pieces: Math.round(r.pieces * 100) / 100,
      hours: round1(r.hours),
      hoursPerPc: Math.round((r.hours / r.pieces) * 1000) / 1000,
      days: r.days,
    });
  }
  return out.sort((a, b) => a.machineId - b.machineId || a.item.localeCompare(b.item));
}

/** The measured figures as the pages want them: machine id → item → rate. */
export function ratesByMachine(rates: readonly MeasuredRate[]): Record<number, Record<string, MeasuredRate>> {
  const out: Record<number, Record<string, MeasuredRate>> = {};
  for (const r of rates) (out[r.machineId] ??= {})[r.item] = r;
  return out;
}
