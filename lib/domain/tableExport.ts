import { AI_MAX_QUESTION } from "./ai";
import { oneLine } from "./aiExplain";
import { columnKind } from "./aiTable";
import { cellNumber } from "./sheetLayout";

// "Export to Excel with AI": the mark at a table's top-right corner
// (components/TableAiExport) sends the table as the screen shows it — its
// filters and sort applied — to the assistant as a CSV attached to a new
// chat. The assistant asks which columns are wanted (all, or which), then
// makes the file with make_excel's `attached` sheet. Pure: the table's text
// in, the file and the question out; and, on the server, the file back to
// the sheet's rows.

/** The most rows a table sends — far more than any screen lists. */
export const TABLE_EXPORT_MAX_ROWS = 20_000;

/** A table as read off the screen: its column names and each row's cells, as text. */
export interface ScreenTable {
  columns: string[];
  rows: string[][];
}

const clean = (s: string) => oneLine(s, Infinity);

/** The table made fit for a sheet: every column named (an unnamed one
 *  "Column N"), no two alike ("Done", "Done (2)"), an unnamed column with
 *  nothing in any row left out (a row's ⋯ button, a colour strip), and
 *  the rows with nothing in them dropped. */
export function tidyTable(t: ScreenTable): ScreenTable {
  const width = t.rows.reduce((w, r) => Math.max(w, r.length), t.columns.length);
  const rows = t.rows.map((r) => Array.from({ length: width }, (_, c) => clean(r[c] ?? ""))).filter((r) => r.some(Boolean));
  const keep: number[] = [];
  for (let c = 0; c < width; c++) {
    if (clean(t.columns[c] ?? "") || rows.some((r) => r[c])) keep.push(c);
  }
  const taken = new Set<string>();
  const columns = keep.map((c, n) => {
    const base = clean(t.columns[c] ?? "") || `Column ${n + 1}`;
    let name = base;
    for (let times = 2; taken.has(name.toLowerCase()); times++) name = `${base} (${times})`;
    taken.add(name.toLowerCase());
    return name;
  });
  return { columns, rows: rows.map((r) => keep.map((c) => r[c])) };
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The table as a CSV file's text — UTF-8 with its byte-order mark, so
 *  Excel and the assistant's reader alike take the Arabic in it as written. */
export function tableCsv(t: ScreenTable): string {
  return `﻿${[t.columns, ...t.rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** A CSV file's text back to its rows — quoted cells, doubled quotes and
 *  line breaks inside quotes taken in; a byte-order mark ignored. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

/** The file's name: what the table is, as a short slug — "late-orders.csv",
 *  in the letters it is written in. */
export function tableFileName(title: string): string {
  const slug = title.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+/, "").slice(0, 60).replace(/-+$/, "");
  return `${slug || "table"}.csv`;
}

/** What the mark asks the assistant: the table that was sent, its columns
 *  numbered, and to ask which of them go in the file before making it. */
export function tableExportQuestion(o: { title: string; page?: string; fileId: number; fileName: string; table: ScreenTable }): string {
  const where = o.page && clean(o.page) !== clean(o.title) ? ` on the ${oneLine(o.page, 80)} screen` : "";
  const { rows, columns } = o.table;
  const head = [
    `Export this table to Excel: "${oneLine(o.title, 120) || "Table"}"${where} — ${rows.length.toLocaleString("en-US")} ${rows.length === 1 ? "row" : "rows"} × ${columns.length} ${columns.length === 1 ? "column" : "columns"}, as the screen shows it now, attached as file #${o.fileId} "${o.fileName}".`,
    "Before you make the file, ask me which columns I want: all of them, or which ones (by name or number). Then make it with make_excel's attached sheet.",
    "Its columns:",
  ].join("\n");
  const lines: string[] = [];
  let size = head.length;
  for (let i = 0; i < columns.length; i++) {
    const l = `${i + 1}. ${columns[i].slice(0, 80)}`;
    if (size + l.length + 40 > AI_MAX_QUESTION) {
      lines.push(`… and ${columns.length - i} more (in the file)`);
      break;
    }
    lines.push(l);
    size += l.length + 1;
  }
  return `${head}\n${lines.join("\n")}`;
}

/** A cell of the sent table as it goes on the sheet: a plain figure
 *  ("1,234.5", "-12") is a number Excel can add up — except in a column of
 *  names (an MO, a BOM, a code), where a leading zero is part of it
 *  ("007"), or a run of a dozen digits or more (a code, never a quantity,
 *  past what a number keeps exactly); anything else stays the text the
 *  screen showed. */
function sheetCell(v: string, idColumn: boolean): string | number {
  if (idColumn || /^-?0\d/.test(v.trim()) || /\d{12,}/.test(v)) return v;
  return cellNumber(v) ?? v;
}

/** The rows of a sent table (its header row first) as a sheet's rows. */
export function tableSheetRows(grid: readonly (readonly string[])[]): { columns: string[]; rows: Record<string, string | number>[] } | { error: string } {
  const [header, ...body] = grid;
  if (!header || header.every((h) => !h.trim())) return { error: "The file has no header row to name its columns." };
  const t = tidyTable({ columns: [...header], rows: body.map((r) => [...r]) });
  const ids = t.columns.map((c) => columnKind(c) === "id");
  return { columns: t.columns, rows: t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, sheetCell(r[i], ids[i])]))) };
}
