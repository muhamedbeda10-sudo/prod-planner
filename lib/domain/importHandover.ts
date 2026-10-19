// Daily-logs Excel import — parse a sheet shaped like the log (header row 1,
// data from row 2). Columns are mapped BY HEADER NAME (case-insensitive), so
// order doesn't matter and MO is optional:
//   Date | DEPT | BOM | MO (optional) | Item | QTY | Week (= planNo)
// Legacy files without an MO column import exactly as before.
//
// Re-uploading the same file must add nothing; a grown file adds only the new
// rows. That dedup is a multiset diff done in the server layer on a stable
// signature (day|dept|bom|mo|item|qty|planNo). This module only parses + validates.

import { isItem, isDept } from "./constants";
import { calendarDate, excelSerialToDate } from "./dates";

export interface HandoverImportRow {
  rowNum: number; // 1-based sheet row
  date: Date | null;
  dept: string;
  bom: string;
  mo: string | null;
  item: string;
  qty: number;
  planNo: number | null;
}

export interface ParsedHandover {
  rows: HandoverImportRow[]; // structurally-parsed rows (may still be invalid)
  hasMoColumn: boolean;
}

const S = (v: unknown): string => (v == null ? "" : String(v).trim());

/** Accept an Excel serial (number), a JS Date, or a string date (m/d/yyyy or ISO). */
export function parseCellDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return excelSerialToDate(v);
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s); // ISO yyyy-mm-dd
  if (m) return calendarDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); // m/d/yyyy (sheet locale)
  if (m) return calendarDate(+m[3], +m[1], +m[2]);
  return null;
}

// header aliases -> canonical field
const HEADER_MAP: Record<string, keyof typeof LEGACY_COLS | "MO"> = {
  DATE: "DATE",
  DEPT: "DEPT",
  DEPARTMENT: "DEPT",
  BOM: "BOM",
  "MSN/BOM": "BOM",
  "MSN/BOM #": "BOM",
  MO: "MO",
  "MO#": "MO",
  ITEM: "ITEM",
  QTY: "QTY",
  QUANTITY: "QTY",
  WEEK: "WEEK",
  PLAN: "WEEK",
};

const LEGACY_COLS = { DATE: 0, DEPT: 1, BOM: 2, ITEM: 3, QTY: 4, WEEK: 5 } as const;

/** Map columns by the header row; fall back to the legacy fixed layout. */
function resolveColumns(header: unknown[]): { cols: Record<string, number>; hasMo: boolean } {
  const cols: Record<string, number> = {};
  for (let c = 0; c < header.length; c++) {
    const key = HEADER_MAP[S(header[c]).toUpperCase()];
    if (key && cols[key] === undefined) cols[key] = c;
  }
  const required = ["DATE", "DEPT", "BOM", "ITEM", "QTY", "WEEK"];
  const allFound = required.every((k) => cols[k] !== undefined);
  if (!allFound) return { cols: { ...LEGACY_COLS }, hasMo: false };
  return { cols, hasMo: cols.MO !== undefined };
}

export function parseHandoverGrid(grid: unknown[][]): ParsedHandover {
  const { cols, hasMo } = resolveColumns(grid[0] ?? []);
  const rows: HandoverImportRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    // data from sheet row 2
    const row = grid[r] ?? [];
    const anyVal =
      S(row[cols.DATE]) || S(row[cols.DEPT]) || S(row[cols.BOM]) || S(row[cols.ITEM]) || S(row[cols.QTY]);
    if (!anyVal) continue; // skip blank rows
    const qtyRaw = row[cols.QTY];
    const qty = typeof qtyRaw === "number" ? qtyRaw : parseFloat(S(qtyRaw));
    const weekRaw = row[cols.WEEK];
    const planNo = typeof weekRaw === "number" ? weekRaw : parseInt(S(weekRaw), 10);
    rows.push({
      rowNum: r + 1,
      date: parseCellDate(row[cols.DATE]),
      dept: S(row[cols.DEPT]),
      bom: S(row[cols.BOM]),
      mo: hasMo ? S(row[cols.MO]) || null : null,
      item: S(row[cols.ITEM]).toUpperCase(),
      qty: Number.isFinite(qty) ? qty : NaN,
      planNo: Number.isInteger(planNo) ? planNo : null,
    });
  }
  return { rows, hasMoColumn: hasMo };
}

/** Structural validation of a single parsed row (excludes BOM-known check). */
export function validateHandoverRow(row: HandoverImportRow): string | null {
  if (!row.date) return `Invalid date (row ${row.rowNum})`;
  if (!isDept(row.dept)) return `Invalid department "${row.dept}" (row ${row.rowNum})`;
  if (!row.bom) return `Empty BOM code (row ${row.rowNum})`;
  if (!isItem(row.item)) return `Invalid component "${row.item}" (row ${row.rowNum})`;
  if (!Number.isFinite(row.qty) || row.qty <= 0) return `Invalid quantity (row ${row.rowNum})`;
  if (!row.planNo) return `Invalid week/plan number (row ${row.rowNum})`;
  return null;
}
