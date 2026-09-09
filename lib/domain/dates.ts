// Excel serial-date conversion + day-number helpers.
// The VBA compares dates via DOnly = Int(CDbl(date)) — i.e. the integer day.
// We mirror that with an integer "day number" (days since the Unix epoch, UTC),
// which preserves all the <=, ==, < comparisons the worklist logic relies on.

// Days between Excel's day 0 (1899-12-30, accounting for the 1900 leap-year bug)
// and the Unix epoch (1970-01-01).
const EXCEL_EPOCH_OFFSET = 25569;
const MS_PER_DAY = 86400000;

/** Excel serial number (e.g. 46211) -> JS Date at UTC midnight. */
export function excelSerialToDate(serial: number): Date {
  return new Date(Math.round((serial - EXCEL_EPOCH_OFFSET) * MS_PER_DAY));
}

/** JS Date -> Excel serial number (integer day). */
export function dateToExcelSerial(date: Date): number {
  return Math.round(date.getTime() / MS_PER_DAY) + EXCEL_EPOCH_OFFSET;
}

/** Integer day number (UTC) — the canonical unit for all worklist comparisons. */
export function dayNumber(date: Date): number {
  return Math.floor(date.getTime() / MS_PER_DAY);
}

/** Day number -> JS Date at UTC midnight. */
export function dateFromDayNumber(day: number): Date {
  return new Date(day * MS_PER_DAY);
}

/** UTC-midnight Date for a Y/M/D (month is 1-based). */
export function utcDate(year: number, month1: number, day: number): Date {
  return new Date(Date.UTC(year, month1 - 1, day));
}

/** Parse a yyyy-mm-dd string (from <input type=date>) to a UTC-midnight Date. */
export function parseISODate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return utcDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** Format a Date as yyyy-mm-dd (UTC) for date inputs. */
export function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Format a Date as dd/mm/yyyy (UTC) — matches the workbook display. */
export function toDisplayDate(date: Date): string {
  const d = String(date.getUTCDate()).padStart(2, "0");
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${d}/${m}/${date.getUTCFullYear()}`;
}

// ---- plan-month labels ("July 2026") — the monthly plan import tags orders
// with this label, and the material tab files its sheets under the same one.

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-07" (an <input type="month"> value) → "July 2026"; null if malformed. */
export function monthLabelFromInput(value: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const idx = Number(m[2]) - 1;
  if (idx < 0 || idx > 11) return null;
  return `${MONTH_NAMES[idx]} ${m[1]}`;
}

/** "July 2026" → "2026-07" for an <input type="month"> default; null if not a label. */
export function monthInputFromLabel(label: string): string | null {
  const m = /^([A-Za-z]+)\s+(\d{4})$/.exec(label.trim());
  if (!m) return null;
  const idx = MONTH_NAMES.findIndex((n) => n.toLowerCase() === m[1].toLowerCase());
  if (idx < 0) return null;
  return `${m[2]}-${String(idx + 1).padStart(2, "0")}`;
}

/** Today's month as a label, e.g. "September 2026". */
export function currentMonthLabel(now: Date = new Date()): string {
  return `${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
}

/** Sort key so "August 2026" comes after "July 2026" — labels that are not
 *  months sort last, in their own order. */
export function monthLabelSortKey(label: string): number {
  const v = monthInputFromLabel(label);
  return v ? Number(v.replace("-", "")) : -1;
}

/** The calendar day of a moment as the factory sees it (Africa/Cairo),
 *  "2026-09-07" — a close at 00:30 counts on the day it was made, not on the
 *  UTC day that was still yesterday. */
export function factoryDayISO(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
