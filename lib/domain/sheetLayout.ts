// How the assistant lays a sheet's rows out in its Excel file, past the
// screen's own columns: the rows kept only where some columns are filled
// (nonBlank), one sheet per value of a column (splitBy) — a sheet per
// thickness — and a Total row closing each sheet over the columns asked for
// (totals). Pure: the rows in, the sheets out, or why not.

export type LayoutCell = string | number;
export type LayoutRow = Record<string, LayoutCell>;

export interface LayoutOptions {
  splitBy?: string;
  totals?: readonly string[];
  nonBlank?: readonly string[];
}

export interface LaidSheet {
  name: string;
  /** The sheet's rows, its Total row apart. */
  rows: readonly LayoutRow[];
  /** The row closing the sheet — when totals were asked for. */
  total?: LayoutRow;
}

export interface Layout {
  sheets: LaidSheet[];
  /** Rows left out for a blank in a nonBlank column. */
  dropped: number;
  /** Cells in a totals column that are text, not a number — left out of its sum. */
  notNumbers: number;
}

/** The most sheets one file is split into. */
export const MAX_SPLIT_SHEETS = 50;

/** The label a Total row carries, and a split sheet whose value is blank. */
export const TOTAL_LABEL = "Total";
const BLANK_SPLIT = "(blank)";

/** A Total row: its first filled cell that is not a number reads Total — the
 *  label goes in the first column not summed, any summed one before it. The
 *  screens' own closing rows read the same (the Production sheet's). */
export function isTotalRow(row: readonly unknown[] | Readonly<Record<string, unknown>> | undefined): boolean {
  if (!row) return false;
  // a row an Export button hands over may carry anything: only its texts are labels
  const label = Object.values(row).find((v) => typeof v === "string" && v.trim() !== "" && cellNumber(v) === null);
  return typeof label === "string" && label.trim() === TOTAL_LABEL;
}

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** A cell as a number to add up: a number, or text that is one ("1,234.5").
 *  A comma counts only between thousands — "3,4" is not 34. */
export function cellNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return /^-?(\d{1,3}(,\d{3})+(\.\d+)?|\d+\.?\d*|\.\d+)$/.test(t) ? Number(t.replace(/,/g, "")) : null;
}

/** Every column of the rows, in the order they first come. */
export function columnsOf(rows: readonly LayoutRow[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
}

/** A sum without the float's tail (0.1 + 0.2 reads 0.3). */
const tidy = (n: number) => Math.round(n * 1e6) / 1e6;

/** The units a column's heading may end in, as the sheets write them. */
const UNITS = new Set(["mm", "cm", "m", "kg", "t", "kva", "kw", "mm2", "mm²", "h", "%"]);

/** The unit a heading ends in — "Thickness mm", "Thickness (mm)", "weight_kg" — or null. */
function unitOf(column: string): string | null {
  const m = /(?:\(([^()]+)\)|[\s_]([^\s_()]+))\s*$/.exec(column);
  const unit = (m?.[1] ?? m?.[2])?.trim();
  return unit && UNITS.has(unit.toLowerCase()) ? unit : null;
}

/** A split sheet's name: the value, with the column's unit when it has one ("2 mm"). */
function splitName(column: string, value: LayoutCell | undefined): string {
  if (isBlank(value)) return BLANK_SPLIT;
  const text = String(value).trim();
  const unit = cellNumber(value) === null ? null : unitOf(column);
  return unit ? `${text} ${unit}` : text;
}

/** The split values in order: numbers from the smallest, then text, the blank last. */
function compareSplit(a: LayoutCell | undefined, b: LayoutCell | undefined): number {
  if (isBlank(a) !== isBlank(b)) return isBlank(a) ? 1 : -1;
  const na = cellNumber(a);
  const nb = cellNumber(b);
  if (na !== null && nb !== null) return na - nb;
  if (na !== null || nb !== null) return na !== null ? -1 : 1;
  return String(a ?? "").localeCompare(String(b ?? ""), "en", { numeric: true, sensitivity: "base" });
}

/** The columns of a sheet as the assistant names them — case and spaces
 *  aside — and the refusal of a name the sheet does not have, naming the
 *  ones it has. layoutSheets and the styling (sheetStyle.ts) alike. */
export function columnResolver(columns: readonly string[]): { resolve: (name: string) => string | undefined; unknown: (names: readonly string[]) => string | null } {
  const byKey = new Map(columns.map((c) => [c.trim().toLowerCase(), c]));
  const resolve = (name: string) => byKey.get(name.trim().toLowerCase());
  return {
    resolve,
    unknown: (names) => {
      const missing = [...new Set(names.filter((n) => !resolve(n)))];
      return missing.length > 0 ? `The sheet has no column ${missing.map((n) => `"${n}"`).join(", ")} — its columns are: ${columns.join(", ")}.` : null;
    },
  };
}

/** The rows laid out as asked — on one sheet named `sheet` unless split.
 *  Columns are named as the sheet heads them, case and spaces aside; a name
 *  it does not have is refused with the ones it has. */
export function layoutSheets(rows: readonly LayoutRow[], sheet: string, o: LayoutOptions): Layout | { error: string } {
  const columns = columnsOf(rows);
  const { resolve, unknown } = columnResolver(columns);
  const problem = unknown([o.splitBy ?? [], o.totals ?? [], o.nonBlank ?? []].flat());
  if (problem) return { error: problem };

  const totals = [...new Set((o.totals ?? []).map((n) => resolve(n)!))];
  // the Total row's label goes in the first column that is not summed
  const labelColumn = columns.find((c) => !totals.includes(c));
  if (totals.length > 0 && labelColumn === undefined) return { error: "Leave at least one column out of totals — the Total row's label goes in it." };

  const nonBlank = (o.nonBlank ?? []).map((n) => resolve(n)!);
  const kept = nonBlank.length === 0 ? rows : rows.filter((r) => nonBlank.every((c) => !isBlank(r[c])));
  const split = o.splitBy === undefined ? null : resolve(o.splitBy)!;

  const groups: { name: string; rows: readonly LayoutRow[] }[] = [];
  if (split === null) groups.push({ name: sheet, rows: kept });
  else {
    const byValue = new Map<string, { value: LayoutCell | undefined; rows: LayoutRow[] }>();
    for (const r of kept) {
      const v = r[split];
      const key = isBlank(v) ? "" : String(cellNumber(v) ?? String(v).trim().toLowerCase());
      const g = byValue.get(key) ?? { value: v, rows: [] };
      g.rows.push(r);
      byValue.set(key, g);
    }
    if (byValue.size > MAX_SPLIT_SHEETS) return { error: `Split by "${split}" that is ${byValue.size} sheets — at most ${MAX_SPLIT_SHEETS} in one file. Narrow it (a filter) or split by another column.` };
    for (const g of [...byValue.values()].sort((a, b) => compareSplit(a.value, b.value))) groups.push({ name: splitName(split, g.value), rows: g.rows });
  }

  let notNumbers = 0;
  const sheets = groups.map((g): LaidSheet => {
    if (totals.length === 0) return { name: g.name, rows: g.rows };
    const sums: Record<string, number> = {};
    for (const c of totals) {
      let sum = 0;
      for (const r of g.rows) {
        const v = r[c];
        const n = cellNumber(v);
        if (n !== null) sum += n;
        else if (!isBlank(v)) notNumbers++;
      }
      sums[c] = tidy(sum);
    }
    const total: LayoutRow = Object.fromEntries(columns.map((c) => [c, c === labelColumn ? TOTAL_LABEL : c in sums ? sums[c] : ""]));
    return { name: g.name, rows: g.rows, total };
  });

  return { sheets, dropped: rows.length - kept.length, notNumbers };
}
