import { toISODate } from "@/lib/domain/dates";
import { guardLedger } from "@/lib/domain/ledgerGuard";

// The Daily log as its screen reads it — each entry with the data guard's
// warnings, and the screen's filters — shared with the assistant's sheet of
// the same log, so the two never disagree.

export interface LogRow {
  id: number;
  date: string; // ISO
  dept: string;
  bom: string;
  bomRaw: string | null;
  mo: string | null;
  item: string;
  qty: number;
  source: string;
  createdBy: string | null; // who recorded the change (worklist / tracker / manual)
  flags?: string[] | null; // data-guard warnings — the row LOOKS wrong, check it
}

/** A ledger entry as the database keeps it. */
export interface LedgerEntry {
  id: number;
  date: Date;
  dept: string;
  bom: string;
  bomRaw: string | null;
  mo: string | null;
  item: string;
  qty: number;
  source: string;
  createdBy: string | null;
  createdAt: Date;
}

/** The entries as the log lists them. The data guard runs over every entry
 *  given (not just what the filters show), so an outlier is judged against
 *  the whole history loaded. */
export function logRowsOf(entries: readonly LedgerEntry[]): LogRow[] {
  const flags = guardLedger(entries.map((r) => ({ id: r.id, dateISO: toISODate(r.date), dept: r.dept, bom: r.bom, mo: r.mo, item: r.item, qty: r.qty, createdISO: r.createdAt.toISOString() })));
  return entries.map((r) => ({
    id: r.id, date: toISODate(r.date), dept: r.dept, bom: r.bom, bomRaw: r.bomRaw, mo: r.mo, item: r.item, qty: r.qty,
    source: r.source, createdBy: r.createdBy, flags: flags.get(r.id)?.map((f) => f.detail) ?? null,
  }));
}

export interface LogFilters {
  /** Part of the BOM. */
  q?: string;
  dept?: string;
  item?: string;
  flaggedOnly?: boolean;
  /** The days, inclusive (YYYY-MM-DD). */
  from?: string;
  to?: string;
}

/** The rows the log shows under its filters. */
export function filterLogRows<T extends LogRow>(rows: readonly T[], f: LogFilters): T[] {
  const needle = (f.q ?? "").trim().toUpperCase();
  return rows.filter((r) => {
    if (f.flaggedOnly && !r.flags?.length) return false;
    if (needle && !r.bom.toUpperCase().includes(needle)) return false;
    if (f.dept && r.dept !== f.dept) return false;
    if (f.item && r.item !== f.item) return false;
    if (f.from && r.date < f.from) return false;
    return !f.to || r.date <= f.to;
  });
}
