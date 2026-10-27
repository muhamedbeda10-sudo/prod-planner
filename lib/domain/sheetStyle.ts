// How an Excel file the app writes looks. Every file takes the house style —
// a coloured, frozen header with filters, columns as wide as what they hold,
// numbers with their decimals, banded rows, a bold Total row, set up to print
// one page wide — and the assistant can ask for more when the person does: a
// title, another colour, cells or rows coloured by a rule, a colour scale,
// data bars, a number format, bold or frozen columns. The rules stay live
// Excel rules (conditional formatting), so a changed figure recolours itself.
// Pure: the request read and checked against the sheet's columns; the
// writing is lib/excel/workbook.ts.

import { columnResolver, columnsOf, isTotalRow, type LayoutRow } from "./sheetLayout";

/** A colour as Excel takes it (ARGB). The colours below are the app's tokens
 *  (app/globals.css), light theme — a workbook has no dark one. */
export const argb = (hex: string) => `FF${hex.replace("#", "").toUpperCase()}`;

export const SHEET_THEMES = {
  green: { header: "#1a8150", light: "#e4f2ea", ink: "#136041" }, // --brand, --brand-light, --brand-dark
  blue: { header: "#2a78d6", light: "#e3eefb", ink: "#1d5aa6" }, // --viz-2
  purple: { header: "#4a3aa7", light: "#ebe8f7", ink: "#3a2d86" }, // --viz-4
  orange: { header: "#b4521f", light: "#fdeadf", ink: "#8a3d16" }, // --viz-3 (#eb6834) darkened for white text
  red: { header: "#9c2006", light: "#fbd9d3", ink: "#9c2006" }, // --bad-fg, --bad-bg
  gray: { header: "#4b5752", light: "#e9edeb", ink: "#2c3531" }, // a dark grey for white text; light is --surface-3
} as const;

/** A rule's colours: the cell's fill and its text — the app's ok / warn / bad badges. */
export const MARK_COLORS = {
  red: { fill: "#fbd9d3", ink: "#9c2006" }, // --bad-bg, --bad-fg
  amber: { fill: "#fff2cc", ink: "#7f6000" }, // --warn-bg, --warn-fg
  green: { fill: "#dcefe4", ink: "#136041" }, // --ok-bg, --ok-fg
  blue: { fill: "#e3eefb", ink: "#1d5aa6" },
  gray: { fill: "#e9edeb", ink: "#2c3531" }, // --surface-3
} as const;

/** The banded rows' fill and the title's muted line — --surface-2, --muted. */
export const BAND_FILL = "#f2f4f3";
export const MUTED_INK = "#5c6964";
export const WHITE = "#ffffff";
/** A colour scale's ends and middle — Excel's own red, yellow, green. */
export const SCALE = { bad: "#f8696b", mid: "#ffeb84", good: "#63be7b" } as const;

export const NUMBER_FORMATS = {
  integer: "#,##0",
  decimal1: "#,##0.0",
  decimal2: "#,##0.00",
  decimal3: "#,##0.000",
  /** A share kept as a fraction (0.85 → 85%). */
  percent: "0.0%",
  /** A figure already in per cent (85 → 85%). */
  percentNumber: '0.0"%"',
  text: "@",
} as const;

export const MARK_OPERATORS = ["gt", "gte", "lt", "lte", "eq", "ne", "between", "contains", "blank", "notBlank"] as const;
type MarkOperator = (typeof MARK_OPERATORS)[number];

/** The most title lines over a table; a blank row parts them from it. */
export const MAX_TITLE_LINES = 2;

type Highlight = {
  when: MarkOperator;
  /** A number: gt…between take one, eq/ne may. value2 is between's other end. */
  value?: number;
  value2?: number;
  /** A text: contains takes one, eq/ne may. */
  text?: string;
};

/** What the assistant asks for, by the columns' headings. */
export interface SheetStyleInput {
  title?: string;
  subtitle?: string;
  theme?: keyof typeof SHEET_THEMES;
  banded?: boolean;
  formats?: { column: string; format: keyof typeof NUMBER_FORMATS }[];
  highlight?: (Highlight & { column: string; color: keyof typeof MARK_COLORS; row?: boolean })[];
  colorScale?: { column: string; better: "higher" | "lower" }[];
  dataBars?: string[];
  bold?: string[];
  freezeColumns?: number;
}

/** The request read against a sheet: columns by their 1-based place. */
export interface StylePlan {
  /** The sheet's columns, as its rows carry them (columnsOf). */
  columns: string[];
  title: string | null;
  subtitle: string | null;
  theme: (typeof SHEET_THEMES)[keyof typeof SHEET_THEMES];
  banded: boolean;
  /** The columns of numbers alone — headed and aligned on the right. */
  numeric: Set<number>;
  /** Each column's number format, by place — the asked-for one, else what its values call for. */
  formats: Map<number, string>;
  highlight: (Highlight & { column: number; color: (typeof MARK_COLORS)[keyof typeof MARK_COLORS]; row: boolean })[];
  colorScale: { column: number; better: "higher" | "lower" }[];
  dataBars: number[];
  bold: number[];
  freezeColumns: number;
}

const NUMERIC_OPERATORS: readonly MarkOperator[] = ["gt", "gte", "lt", "lte", "between"];

/** Headings that name things, not amounts — never given thousands separators
 *  (an MO, a badge, a code) — unless they also name a quantity ("Plan qty",
 *  "Number of sheets"). */
const NAME_LIKE = /(^|[^a-z])(id|no|nr|number|code|mo|bom|soi|plan|serial|badge|emp|ref|#)([^a-z]|$)/i;
const QUANTITY = /(qty|quantity|count|total|sheets|pieces|pcs|units|kg|weight|hours|amount)/i;

/** A column's figures — the most decimals any carries (up to 3) and the
 *  largest — or null when a filled cell is not a number (or none is filled). */
function figuresOf(values: Iterable<unknown>): { decimals: number; largest: number } | null {
  let numbers = 0;
  let decimals = 0;
  let largest = 0;
  for (const v of values) {
    if (v === "" || v === null || v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    numbers++;
    largest = Math.max(largest, Math.abs(v));
    if (decimals < 3 && !Number.isInteger(v)) {
      // 1e-7 has no "." to count after: a tiny figure takes all three
      const text = String(v);
      const dot = text.indexOf(".");
      decimals = Math.max(decimals, text.includes("e") ? 3 : Math.min(3, text.length - dot - 1));
    }
  }
  return numbers === 0 ? null : { decimals, largest };
}

/** The format figures call for: their decimals, thousands separated from
 *  10,000 on unless the heading names things. Null for whole numbers that
 *  read as they are. */
function formatOf(column: string, f: { decimals: number; largest: number }): string | null {
  const grouped = f.largest >= 10_000 && (!NAME_LIKE.test(column) || QUANTITY.test(column));
  if (f.decimals === 0) return grouped ? NUMBER_FORMATS.integer : null;
  return `${grouped ? "#,##0" : "0"}.${"0".repeat(f.decimals)}`;
}

/** What a column's values call for (formatOf), or null — for a column not all numbers too. */
export function numberFormatOf(column: string, values: readonly unknown[]): string | null {
  const f = figuresOf(values);
  return f && formatOf(column, f);
}

/** Why a style does not fit a sheet of these columns, or null — a column it
 *  does not have (columnResolver), a rule without what it compares with. */
function styleProblem(columns: readonly string[], o: SheetStyleInput): string | null {
  const unknown = columnResolver(columns).unknown([
    ...(o.formats ?? []).map((f) => f.column), ...(o.highlight ?? []).map((h) => h.column),
    ...(o.colorScale ?? []).map((c) => c.column), ...(o.dataBars ?? []), ...(o.bold ?? []),
  ]);
  if (unknown) return unknown;
  for (const h of o.highlight ?? []) {
    const value = h.value !== undefined && Number.isFinite(h.value);
    const text = h.text !== undefined && h.text.trim() !== "";
    if (NUMERIC_OPERATORS.includes(h.when) && !value) return `highlight "${h.column}" ${h.when} needs a number (value).`;
    if (h.when === "between" && (h.value2 === undefined || !Number.isFinite(h.value2))) return `highlight "${h.column}" between needs value and value2.`;
    if (h.when === "contains" && !text) return `highlight "${h.column}" contains needs a text (text).`;
    if ((h.when === "eq" || h.when === "ne") && !value && !text) return `highlight "${h.column}" ${h.when} needs a number (value) or a text (text).`;
  }
  return null;
}

/** The request read against the sheet's rows, or why not. */
export function stylePlan(rows: readonly LayoutRow[], o: SheetStyleInput = {}): StylePlan | { error: string } {
  const columns = columnsOf(rows);
  const problem = styleProblem(columns, o);
  if (problem) return { error: problem };
  const { resolve } = columnResolver(columns);
  const place = (name: string) => columns.indexOf(resolve(name)!) + 1;

  // one pass a column: whether it is numbers, and the format they call for —
  // a Total row's label, in a column of numbers, does not make it text
  const body = isTotalRow(rows[rows.length - 1]) ? rows.slice(0, -1) : rows;
  const numeric = new Set<number>();
  const formats = new Map<number, string>();
  columns.forEach((c, i) => {
    const f = figuresOf(body.map((r) => r[c]));
    if (!f) return;
    numeric.add(i + 1);
    const format = formatOf(c, f);
    if (format) formats.set(i + 1, format);
  });
  for (const f of o.formats ?? []) formats.set(place(f.column), NUMBER_FORMATS[f.format]);

  const title = o.title?.trim() || null;
  return {
    columns,
    title,
    subtitle: title && (o.subtitle?.trim() || null),
    theme: SHEET_THEMES[o.theme ?? "green"],
    banded: o.banded ?? true,
    numeric,
    formats,
    highlight: (o.highlight ?? []).map((h) => ({
      column: place(h.column), when: h.when, color: MARK_COLORS[h.color], row: h.row ?? false,
      // a text is what eq/ne/contains read first; the numbers what the rest do
      ...(h.text?.trim() && !NUMERIC_OPERATORS.includes(h.when) ? { text: h.text.trim() } : {}),
      ...(h.value === undefined ? {} : { value: h.value }),
      ...(h.value2 === undefined ? {} : { value2: h.value2 }),
    })),
    colorScale: (o.colorScale ?? []).map((c) => ({ column: place(c.column), better: c.better })),
    dataBars: [...new Set((o.dataBars ?? []).map(place))],
    bold: [...new Set((o.bold ?? []).map(place))],
    freezeColumns: Math.max(0, Math.min(3, o.freezeColumns ?? 0)),
  };
}

/** A column's letters (1 → A, 28 → AB). */
export function columnLetter(n: number): string {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** A text as an Excel formula's string. */
const quoted = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;
/** A text SEARCH looks for as it is: its wildcards (* ?) and their escape (~) escaped. */
const literal = (v: string) => v.replace(/[~*?]/g, (c) => `~${c}`);

/** A rule as the Excel formula it is tested by, for the cell `ref` (its
 *  column fixed, its row relative — so a rule on the whole row reads the
 *  one column). A number is compared as a number and as the text of one, so
 *  a column that keeps its figures as text matches too. */
export function markFormula(h: Pick<StylePlan["highlight"][number], "when" | "value" | "value2" | "text">, ref: string): string {
  const num = (op: string) => `AND(ISNUMBER(${ref}),${ref}${op}${h.value})`;
  switch (h.when) {
    case "gt": return num(">");
    case "gte": return num(">=");
    case "lt": return num("<");
    case "lte": return num("<=");
    case "between": return `AND(ISNUMBER(${ref}),${ref}>=${Math.min(Number(h.value), Number(h.value2))},${ref}<=${Math.max(Number(h.value), Number(h.value2))})`;
    case "eq": return h.text !== undefined ? `TRIM(${ref})=${quoted(h.text)}` : `OR(${ref}=${h.value},TRIM(${ref})=${quoted(String(h.value))})`;
    // an empty cell is not "not equal" — it is not filled in yet
    case "ne": return h.text !== undefined ? `AND(LEN(TRIM(${ref}))>0,TRIM(${ref})<>${quoted(h.text)})` : `AND(LEN(TRIM(${ref}))>0,${ref}<>${h.value},TRIM(${ref})<>${quoted(String(h.value))})`;
    case "contains": return `ISNUMBER(SEARCH(${quoted(literal(h.text ?? String(h.value ?? "")))},${ref}))`;
    case "blank": return `LEN(TRIM(${ref}))=0`;
    case "notBlank": return `LEN(TRIM(${ref}))>0`;
  }
}
