import { factoryWallClockMs, parseISODate, toISODate } from "./dates";
import { clockMinutes } from "./downtime";

const DAY = 86400000;
export interface StopPeriod {
  date: Date | string;
  hours: number;
  startTime?: string | null;
  endTime?: string | null;
  endsNextDay?: boolean;
  isOpen?: boolean;
  endDate?: Date | string | null;
}
const isoOf = (date: Date | string) => typeof date === "string" ? date.slice(0, 10) : toISODate(date);
const dayMs = (date: Date | string) => parseISODate(isoOf(date))?.getTime();

/** Factory wall-clock coordinates, the same minute arithmetic as the entered clock range. */
export function stopPeriodBounds(row: StopPeriod, openEnd = Infinity): { start: number; end: number } | null {
  const day = dayMs(row.date), startMinute = row.startTime ? clockMinutes(row.startTime) : null;
  if (day === undefined || startMinute === null) return null;
  const start = day + startMinute * 60000;
  if (row.isOpen) return { start, end: openEnd };
  const endMinute = row.endTime ? clockMinutes(row.endTime) : null;
  const endDay = row.endDate ? dayMs(row.endDate) : day + (row.endsNextDay ? DAY : 0);
  if (endMinute === null || endDay === undefined) return null;
  const end = endDay + endMinute * 60000;
  return end > start ? { start, end } : null;
}

export function elapsedStopHours(row: StopPeriod, now: Date): number {
  if (!row.isOpen) return row.hours;
  const bounds = stopPeriodBounds(row, factoryWallClockMs(now));
  return bounds ? Math.max(0, bounds.end - bounds.start) / 3600000 : 0;
}

/** New open/dated incidents count only their elapsed overlap with the requested factory days.
 * Previously recorded rows without endDate retain their original start-day booking. */
export function downtimeHoursInRange(row: StopPeriod, fromISO: string, toISO: string, now: Date): number {
  if (!row.isOpen && !row.endDate) return isoOf(row.date) >= fromISO && isoOf(row.date) <= toISO ? row.hours : 0;
  const bounds = stopPeriodBounds(row, factoryWallClockMs(now));
  const from = parseISODate(fromISO)?.getTime(), to = parseISODate(toISO)?.getTime();
  if (!bounds || from === undefined || to === undefined || to < from) return 0;
  return Math.max(0, Math.min(bounds.end, to + DAY) - Math.max(bounds.start, from)) / 3600000;
}

export function splitDowntimeDays(row: StopPeriod, fromISO: string, toISO: string, now: Date): { date: Date; hours: number }[] {
  const from = parseISODate(fromISO)?.getTime(), to = parseISODate(toISO)?.getTime();
  if (from === undefined || to === undefined || to < from) return [];
  const result: { date: Date; hours: number }[] = [];
  for (let day = from; day <= to; day += DAY) {
    const date = new Date(day), iso = toISODate(date), hours = downtimeHoursInRange(row, iso, iso, now);
    if (hours > 0) result.push({ date, hours });
  }
  return result;
}

/** Includes an older incident still open or closed inside this window. */
export function downtimeWindowWhere(fromISO: string, toISO: string) {
  return { date: { lte: parseISODate(toISO)! }, OR: [{ date: { gte: parseISODate(fromISO)! } }, { isOpen: true }, { endDate: { gte: parseISODate(fromISO)! } }] };
}

/** A recorded stop as it stands at `now`: its hours so far, and those that
 *  fall on `dayISO` — what the Shifts screen and the assistant's sheet show. */
export function liveStopHours(
  r: { dateISO?: string; storedHours?: number; hours: number; startTime?: string | null; endTime?: string | null; endsNextDay?: boolean; isOpen?: boolean; endDateISO?: string | null },
  dayISO: string,
  now: Date,
): { hours: number; dayHours: number } {
  const p: StopPeriod = { date: r.dateISO ?? dayISO, hours: r.storedHours ?? r.hours, startTime: r.startTime, endTime: r.endTime, endsNextDay: r.endsNextDay, isOpen: r.isOpen, endDate: r.endDateISO };
  return { hours: elapsedStopHours(p, now), dayHours: downtimeHoursInRange(p, dayISO, dayISO, now) };
}
