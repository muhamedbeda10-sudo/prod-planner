// ODOO close-out log — pure helpers shared by the server and the form.

import { excelSerialToDate } from "./dates";

/** The product names as Odoo's FG codes call them — a dropdown, not a
 *  constraint: anything typed is kept. */
export const ODOO_PRODUCTS = ["Tank", "Top Cover", "Core Frame", "Encloser", "Cable Box", "Conservator"] as const;

/** Where a close attempt stands. The clerk enters the row as "MO to be close";
 *  the planner moves it on. Free text is still accepted, so a new state never
 *  needs a code change. */
export const ODOO_STATUSES = ["MO to be close", "Pending", "Done", "Blocked", "Cancelled"] as const;

export type OdooTone = "ok" | "warn" | "bad" | "muted";

/** How a status reads at a glance: green when done, amber while pending,
 *  red when it will not close, grey while it is still just queued. */
export function statusTone(status: string | null | undefined): OdooTone {
  const s = (status ?? "").trim().toLowerCase();
  if (s === "done" || s === "closed") return "ok";
  if (s === "pending") return "warn";
  if (s === "blocked" || s === "cancelled" || s === "canceled") return "bad";
  return "muted";
}

export function isDoneStatus(status: string | null | undefined): boolean {
  return statusTone(status) === "ok";
}

/** Odoo's error text names the item in [BRACKETS] first — pull that out so a
 *  note can show the blocked item without the whole sentence. */
export function blockedItem(text: string | null | undefined): string | null {
  const m = /^\s*\[([^\]]+)\]/.exec(text ?? "");
  return m ? m[1] : null;
}

/** One note on a row, and when. */
export interface OdooNoteView {
  id: number;
  text: string;
  atISO: string;
  by: string | null;
  blockedItem: string | null;
}

export interface OdooEntryView {
  id: number;
  dateISO: string;
  soi: string | null;
  fgCode: string;
  product: string;
  odooMo: string;
  qty: number;
  status: string;
  tone: OdooTone;
  done: boolean;
  /** When the status was moved to Done — the day the dashboard counts the close on. */
  doneAtISO: string | null;
  recordedBy: string | null;
  /** manual | import | painting | shotblast — a painting / shot-blast row was
   *  born from a closing in the ledger and starts with no MO. */
  source: string;
  /** The FG-CODE was composed (part code + BOM), not copied from an earlier
   *  row — check it before booking. */
  fgGuessed: boolean;
  /** Newest first. */
  notes: OdooNoteView[];
}

// ---- import: the office's sheet, its first seven columns ----
//
// Date | SOI# | FG-CODE | Product | MO# | QTY | Status  — the eighth column,
// Reason, is deliberately NOT read: what happened next is the planner's, kept
// as notes in the tab, so an import must never overwrite it.

export interface OdooSheetRow {
  rowNum: number;
  /** Null when the sheet's Date cell is blank — the caller decides the day. */
  date: Date | null;
  soi: string | null;
  fgCode: string;
  product: string;
  odooMo: string;
  qty: number;
  status: string;
}

export interface ParsedOdooSheet {
  rows: OdooSheetRow[];
  issues: string[];
  /** 1-based row of the header the columns were read from; 0 when none. */
  headerRow: number;
}

/** Header fragments, in the sheet's order — a header is matched by text, so
 *  a reordered or renamed sheet still imports, and a headerless one falls
 *  back to this order. */
const ODOO_HEADERS = {
  date: ["date"],
  soi: ["soi", "so#", "sales order"],
  fgCode: ["fg-code", "fg code", "fgcode", "fg"],
  product: ["product"],
  odooMo: ["mo#", "mo"],
  qty: ["qty", "quantity"],
  status: ["status"],
} as const;

type OdooCol = keyof typeof ODOO_HEADERS;
const ODOO_ORDER: OdooCol[] = ["date", "soi", "fgCode", "product", "odooMo", "qty", "status"];

const cell = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim();

function findOdooHeader(grid: unknown[][]): number {
  for (let r = 0; r < Math.min(grid.length, 20); r++) {
    const cells = (grid[r] ?? []).map((c) => cell(c).toLowerCase());
    if (cells.some((c) => c.includes("fg")) && cells.some((c) => c === "mo#" || c === "mo" || c.includes("mo#"))) return r;
  }
  return -1;
}

function mapOdooColumns(header: unknown[]): Record<OdooCol, number> {
  const cells = header.map((c) => cell(c).toLowerCase());
  const out = {} as Record<OdooCol, number>;
  for (const key of ODOO_ORDER) {
    out[key] = -1;
    for (const frag of ODOO_HEADERS[key]) {
      const i = cells.findIndex((c, idx) => c !== "" && (c === frag || c.includes(frag)) && !Object.values(out).includes(idx));
      if (i >= 0) { out[key] = i; break; }
    }
  }
  return out;
}

/** Accept an Excel serial, a JS Date, or a yyyy-mm-dd / m/d/yyyy / d-m-yyyy string. */
export function parseOdooDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return excelSerialToDate(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); // m/d/yyyy — the sheet's locale
  if (m) return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
  m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s); // d-m-yyyy
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return null;
}

function parseQty(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the Odoo close-out sheet (sheet_to_json with header:1). Columns are
 * found by header text; a sheet with no header row is read positionally in
 * the sheet's order. Only the first seven columns are taken — see above.
 */
export function parseOdooSheet(grid: unknown[][]): ParsedOdooSheet {
  const headerIdx = findOdooHeader(grid);
  let col: Record<OdooCol, number>;
  if (headerIdx >= 0) {
    col = mapOdooColumns(grid[headerIdx] ?? []);
  } else {
    col = {} as Record<OdooCol, number>;
    ODOO_ORDER.forEach((k, i) => { col[k] = i; });
  }
  const issues: string[] = [];
  for (const key of ODOO_ORDER) {
    if (col[key] < 0 && key !== "soi" && key !== "status" && key !== "date") issues.push(`Column "${key}" was not found in the header row.`);
  }
  if (issues.length > 0) return { rows: [], issues, headerRow: headerIdx + 1 };

  const rows: OdooSheetRow[] = [];
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const line = grid[r] ?? [];
    const rowNum = r + 1;
    const fgCode = cell(line[col.fgCode]).toUpperCase();
    const odooMo = cell(line[col.odooMo]).toUpperCase();
    if (!fgCode && !odooMo && parseQty(line[col.qty]) === null) continue; // blank line
    const product = cell(line[col.product]);
    const qty = parseQty(line[col.qty]);
    const dateRaw = col.date >= 0 ? line[col.date] : null;
    const date = parseOdooDate(dateRaw);

    if (!fgCode) { issues.push(`Row ${rowNum}: no FG-CODE — skipped.`); continue; }
    if (!odooMo) { issues.push(`Row ${rowNum} (${fgCode}): no MO# — skipped.`); continue; }
    if (!product) { issues.push(`Row ${rowNum} (${odooMo}): no product — skipped.`); continue; }
    if (qty === null || qty < 0) { issues.push(`Row ${rowNum} (${odooMo}): QTY is missing or not a number — skipped.`); continue; }
    if (dateRaw != null && dateRaw !== "" && !date) { issues.push(`Row ${rowNum} (${odooMo}): the date "${cell(dateRaw)}" could not be read — skipped.`); continue; }

    rows.push({
      rowNum, date,
      soi: col.soi >= 0 ? cell(line[col.soi]).toUpperCase() || null : null,
      fgCode, product, odooMo, qty,
      status: (col.status >= 0 ? cell(line[col.status]) : "") || "MO to be close",
    });
  }
  if (rows.length === 0) issues.push("No rows found under the header.");
  return { rows, issues, headerRow: headerIdx + 1 };
}

// ---- filters: narrowing the day's rows on the page ----

export const ODOO_NOTE_FILTERS = { all: "Notes: any", with: "With notes", without: "No notes" } as const;
export type OdooNoteFilter = keyof typeof ODOO_NOTE_FILTERS;

export const ODOO_MO_FILTERS = { all: "MO: any", missing: "Needs MO", guessed: "Check FG-CODE" } as const;
export type OdooMoFilter = keyof typeof ODOO_MO_FILTERS;

/** Whether a row has been closed in Odoo yet. The status select matches ONE
 *  status exactly; this is the reading the planner actually works from —
 *  "what is still open" is every status that is not a closing, whichever of
 *  them it happens to be. */
export const ODOO_CLOSED_FILTERS = { all: "Closing: any", open: "Not closed", done: "Done" } as const;
export type OdooClosedFilter = keyof typeof ODOO_CLOSED_FILTERS;

export interface OdooFilters {
  /** Matches SOI, FG-CODE, MO#, product and every note — case-insensitive, any part. */
  q: string;
  product: string; // "" = any
  status: string; // "" = any
  notes: OdooNoteFilter;
  /** Rows born from a closing that still wait for Odoo's MO, or whose FG-CODE was guessed. */
  mo: OdooMoFilter;
  /** Closed in Odoo, still open, or both. */
  closed: OdooClosedFilter;
}

export const EMPTY_ODOO_FILTERS: OdooFilters = { q: "", product: "", status: "", notes: "all", mo: "all", closed: "all" };

export function filterOdooEntries(entries: OdooEntryView[], f: OdooFilters): OdooEntryView[] {
  const q = f.q.trim().toLowerCase();
  return entries.filter((e) => {
    if (f.product && e.product !== f.product) return false;
    if (f.status && e.status !== f.status) return false;
    if (f.notes === "with" && e.notes.length === 0) return false;
    if (f.notes === "without" && e.notes.length > 0) return false;
    if (f.mo === "missing" && e.odooMo.trim() !== "") return false;
    if (f.mo === "guessed" && !e.fgGuessed) return false;
    if (f.closed === "open" && e.done) return false;
    if (f.closed === "done" && !e.done) return false;
    if (q) {
      const hay = [e.soi ?? "", e.fgCode, e.odooMo, e.product, e.status, ...e.notes.map((n) => n.text)].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
