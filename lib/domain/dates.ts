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
