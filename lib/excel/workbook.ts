import ExcelJS from "exceljs";
import { BAND_FILL, MAX_TITLE_LINES, MUTED_INK, SCALE, WHITE, argb, columnLetter, markFormula, stylePlan, type SheetStyleInput, type StylePlan } from "@/lib/domain/sheetStyle";
import { isTotalRow, type LayoutRow } from "@/lib/domain/sheetLayout";
import { sheetNamesOf } from "@/lib/domain/aiFiles";

// Every Excel file the app writes, in the house style (lib/domain/sheetStyle.ts)
// — the assistant's files on the server (streamed, lib/server/excel.ts), the
// Floor's and the chat's Export buttons in the browser (loaded on the first
// press). The values are written as they are: a text is a text (never a
// formula), a number a number; only how they look changes.

export interface WorkbookSheet {
  name: string;
  rows: readonly Record<string, unknown>[];
}

export type WorkbookResult = { ok: true; data: Uint8Array<ArrayBuffer>; names: string[] } | { ok: false; error: string };

/** The widest a column grows, in characters, and how many rows are measured for it. */
const MAX_WIDTH = 60;
const MEASURED_ROWS = 2000;
/** A text column's cells, a little off the figures to their left (an indent counts only with its side set). */
const TEXT_ALIGN: Partial<ExcelJS.Alignment> = { horizontal: "left", indent: 1 };
const BOLD: Partial<ExcelJS.Font> = { bold: true };

const solid = (hex: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb: argb(hex) } });
const thin = (hex: string): Partial<ExcelJS.Border> => ({ style: "thin", color: { argb: argb(hex) } });

/** A cell's value as Excel takes it: numbers and texts as they are, a yes/no as text, nothing as an empty cell. */
function cellValue(v: unknown): ExcelJS.CellValue {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (v instanceof Date) return v;
  return JSON.stringify(v);
}

/** How wide a column is drawn: its heading or its longest value, within reason. */
function widthOf(header: string, rows: readonly Record<string, unknown>[], formatted: boolean): number {
  let widest = Math.min(header.length, 24); // a long heading wraps
  for (let i = 0; i < rows.length && i < MEASURED_ROWS; i++) {
    const v = rows[i][header];
    if (v === null || v === undefined || v === "") continue;
    // a formatted number gains its separators and decimals
    widest = Math.max(widest, String(v).length + (formatted && typeof v === "number" ? 3 : 0));
  }
  return Math.min(MAX_WIDTH, Math.max(6, widest + 3));
}

/** Each sheet's plan, or why the style does not fit one — nothing is written then. */
export function plansOf(sheets: readonly WorkbookSheet[], style: SheetStyleInput | undefined): StylePlan[] | { error: string } {
  const plans: StylePlan[] = [];
  for (const s of sheets) {
    const plan = stylePlan(s.rows as LayoutRow[], style);
    if ("error" in plan) return plan;
    plans.push(plan);
  }
  return plans;
}

/** The row a sheet's table heads: under its title lines and a blank row. */
const headerRowOf = (plan: StylePlan) => {
  const lines = (plan.title ? 1 : 0) + (plan.subtitle ? 1 : 0);
  return lines > 0 ? Math.min(lines, MAX_TITLE_LINES) + 2 : 1;
};

/** What a sheet is made with — its view and print set-up, which a streamed
 *  sheet takes only when it is added. */
export function sheetOptions(plan: StylePlan): Partial<ExcelJS.AddWorksheetOptions> {
  const headerRow = headerRowOf(plan);
  return {
    views: [{ state: "frozen", xSplit: plan.freezeColumns, ySplit: headerRow }],
    pageSetup: {
      orientation: plan.columns.length > 6 ? "landscape" : "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${headerRow}:${headerRow}`,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
    },
    headerFooter: { oddFooter: "&L&8&F — &A&R&8Page &P of &N" },
  };
}

/** One sheet, added with sheetOptions, in the order a streamed sheet takes
 *  it: its columns, filter and rules first, then its rows top to bottom, each
 *  committed once styled — an in-memory sheet commits nothing. */
export function writeSheet(ws: ExcelJS.Worksheet, rows: readonly Record<string, unknown>[], plan: StylePlan): void {
  const { columns } = plan;
  const n = Math.max(1, columns.length);
  const lines: [string, Partial<ExcelJS.Font>][] = [];
  if (plan.title) lines.push([plan.title, { bold: true, size: 14, color: { argb: argb(plan.theme.ink) } }]);
  if (plan.subtitle) lines.push([plan.subtitle, { italic: true, size: 10, color: { argb: argb(MUTED_INK) } }]);
  const headerRow = headerRowOf(plan);
  const total = rows.length > 0 && isTotalRow(rows[rows.length - 1] as LayoutRow);
  const firstBody = headerRow + 1;
  const lastBody = headerRow + rows.length - (total ? 1 : 0);
  const bold = new Set(plan.bold);

  ws.columns = columns.map((c, i) => {
    const numFmt = plan.formats.get(i + 1);
    return {
      key: c,
      width: widthOf(c, rows, numFmt !== undefined),
      // a text column stands a little off the figures to its left
      style: { ...(numFmt && { numFmt }), ...(!plan.numeric.has(i + 1) && { alignment: TEXT_ALIGN }), ...(bold.has(i + 1) && { font: BOLD }) },
    };
  });
  if (lastBody >= firstBody) addRules(ws, plan, headerRow, firstBody, lastBody, n);

  lines.forEach(([text, font], i) => {
    const row = ws.getRow(i + 1);
    row.getCell(1).value = text;
    row.getCell(1).font = font;
    if (n > 1) ws.mergeCells(i + 1, 1, i + 1, n);
    row.commit();
  });
  if (lines.length > 0) ws.getRow(lines.length + 1).commit();

  // every column's cell, empty ones too — eachCell stops at the last filled one
  const across = (row: ExcelJS.Row, style: (cell: ExcelJS.Cell, column: number) => void) => { for (let c = 1; c <= n; c++) style(row.getCell(c), c); };
  const head = ws.getRow(headerRow);
  head.values = columns;
  head.height = 30;
  across(head, (cell, c) => {
    cell.font = { bold: true, color: { argb: argb(WHITE) } };
    cell.fill = solid(plan.theme.header);
    // a column of numbers is headed on the right, over its figures
    cell.alignment = { vertical: "middle", wrapText: true, ...(plan.numeric.has(c) ? { horizontal: "right" } : TEXT_ALIGN) };
    cell.border = { bottom: thin(plan.theme.ink) };
  });
  head.commit();

  rows.forEach((r, i) => {
    const row = ws.addRow(columns.map((c) => cellValue(r[c])));
    if (total && i === rows.length - 1) {
      across(row, (cell) => {
        cell.font = { bold: true, color: { argb: argb(plan.theme.ink) } };
        cell.fill = solid(plan.theme.light);
        cell.border = { top: { style: "medium", color: { argb: argb(plan.theme.header) } } };
      });
    }
    row.commit();
  });
}

/** The filter and the live rules, over the rows alone — the Total row stays put when sorted, and uncoloured. */
function addRules(ws: ExcelJS.Worksheet, plan: StylePlan, headerRow: number, firstBody: number, lastBody: number, n: number): void {
  ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: lastBody, column: n } };
  const body = (col: number | null) => (col === null ? `A${firstBody}:${columnLetter(n)}${lastBody}` : `${columnLetter(col)}${firstBody}:${columnLetter(col)}${lastBody}`);
  // the first rule that matches colours the cell, the bands under them all
  let priority = 1;
  for (const h of plan.highlight) {
    ws.addConditionalFormatting({
      ref: body(h.row ? null : h.column),
      rules: [{ type: "expression", priority: priority++, formulae: [markFormula(h, `$${columnLetter(h.column)}${firstBody}`)], style: { fill: solid(h.color.fill), font: { color: { argb: argb(h.color.ink) } } } }],
    });
  }
  for (const c of plan.colorScale) {
    const [low, high] = c.better === "higher" ? [SCALE.bad, SCALE.good] : [SCALE.good, SCALE.bad];
    ws.addConditionalFormatting({
      ref: body(c.column),
      rules: [{ type: "colorScale", priority: priority++, cfvo: [{ type: "min" }, { type: "percentile", value: 50 }, { type: "max" }], color: [{ argb: argb(low) }, { argb: argb(SCALE.mid) }, { argb: argb(high) }] }],
    });
  }
  for (const c of plan.dataBars) {
    ws.addConditionalFormatting({
      ref: body(c),
      // a gradient fades to white, so the figure on it stays readable
      rules: [{ type: "dataBar", priority: priority++, gradient: true, cfvo: [{ type: "min" }, { type: "max" }], color: { argb: argb(plan.theme.header) } } as ExcelJS.ConditionalFormattingRule],
    });
  }
  if (plan.banded) {
    ws.addConditionalFormatting({ ref: body(null), rules: [{ type: "expression", priority: priority++, formulae: [`MOD(ROW(),2)=${firstBody % 2 === 0 ? 1 : 0}`], style: { fill: solid(BAND_FILL) } }] });
  }
}

// the browser takes the media type along with the writer, loaded on the first press
export { XLSX_TYPE } from "@/lib/domain/aiFiles";

/** Each sheet in the house style and the style asked for, into a workbook in
 *  memory or streamed — or why the style does not fit (nothing is written
 *  then). Sheet names are made Excel's own (sheetNamesOf), returned as written. */
export function fillWorkbook(wb: ExcelJS.Workbook | ExcelJS.stream.xlsx.WorkbookWriter, sheets: readonly WorkbookSheet[], style?: SheetStyleInput): { names: string[] } | { error: string } {
  const plans = plansOf(sheets, style);
  if ("error" in plans) return plans;
  wb.creator = "ATC Production Planner";
  wb.created = new Date();
  const names = sheetNamesOf(sheets.map((s) => s.name));
  sheets.forEach((s, i) => {
    const ws = wb.addWorksheet(names[i], sheetOptions(plans[i]));
    writeSheet(ws, s.rows, plans[i]);
    ws.commit?.();
  });
  if (sheets.length === 0) wb.addWorksheet("Sheet1").commit?.();
  return { names };
}

/** The workbook's bytes, built in memory — the browser's Export buttons. */
export async function workbookBytes(sheets: readonly WorkbookSheet[], style?: SheetStyleInput): Promise<WorkbookResult> {
  const wb = new ExcelJS.Workbook();
  const filled = fillWorkbook(wb, sheets, style);
  if ("error" in filled) return { ok: false, error: filled.error };
  const buffer = await wb.xlsx.writeBuffer();
  return { ok: true, data: new Uint8Array(buffer as ArrayBuffer), names: filled.names };
}
