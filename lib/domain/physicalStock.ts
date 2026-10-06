// PHYSICAL MATERIAL — the store's count of its sheets, coils and sections
// held against what Odoo says SF01 has. One living table, one row per Odoo
// product code: the store's physical count, Odoo's stock, the gap between
// them. Display and import only — nothing here moves stock in Odoo.

export interface StockRow {
  code: string;
  name: string;
  uom: string;
  /** What the store counted on its shelves. */
  physical: number;
  /** SF01's stock in Odoo for the same code. */
  odoo: number;
}

/** The families the store keeps, read off the product's own name. */
export const STOCK_GROUPS = ["HR Sheet", "Cold Rolled Coil", "Galvanized Sheet", "Galvanized Coil", "Aluminium", "Angle Bar", "Channel", "Other"] as const;
export type StockGroup = (typeof STOCK_GROUPS)[number];

export function stockGroupOf(name: string): StockGroup {
  const n = name.toLowerCase();
  if (/alumin/.test(n)) return "Aluminium";
  if (/mother coil|\bcoil\b/.test(n) && /galvani|g90|gi\b/.test(n)) return "Galvanized Coil";
  if (/cold rolled|\bcrc\b/.test(n)) return "Cold Rolled Coil";
  if (/galvani|\bgi\b|g90/.test(n)) return "Galvanized Sheet";
  if (/hr sheet|hot rolled/.test(n)) return "HR Sheet";
  if (/angle/.test(n)) return "Angle Bar";
  if (/channel|\bupn\b/.test(n)) return "Channel";
  return "Other";
}

export type StockStatus = "match" | "short" | "over" | "empty";

/** A gap smaller than this is counting noise, not a difference: a hundredth
 *  of a piece, or a kilo on a coil. */
export function stockTolerance(uom: string): number {
  return uom.trim().toUpperCase() === "KG" ? 1 : 0.01;
}

export interface StockView extends StockRow {
  group: StockGroup;
  /** Physical − Odoo: below zero the store holds less than Odoo says. */
  diff: number;
  /** The gap as a share of Odoo's figure, signed; null when Odoo shows none. */
  diffPct: number | null;
  status: StockStatus;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function stockView(r: StockRow): StockView {
  const diff = r2(r.physical - r.odoo);
  const tol = stockTolerance(r.uom);
  const status: StockStatus =
    Math.abs(r.physical) < tol && Math.abs(r.odoo) < tol ? "empty" : Math.abs(diff) < tol ? "match" : diff < 0 ? "short" : "over";
  return { ...r, group: stockGroupOf(r.name), diff: Math.abs(diff) < tol ? 0 : diff, diffPct: r.odoo > 0 ? Math.round((diff / r.odoo) * 100) : null, status };
}

export const STATUS_LABEL: Record<StockStatus, string> = {
  match: "Matches Odoo",
  short: "Store short",
  over: "Store over",
  empty: "None held",
};

export interface StockSummary {
  items: number;
  match: number;
  short: number;
  over: number;
  empty: number;
  /** Per unit of measure: the two totals and the net gap. */
  byUom: { uom: string; physical: number; odoo: number; diff: number }[];
}

export function summarizeStock(rows: readonly StockView[]): StockSummary {
  const byUom = new Map<string, { uom: string; physical: number; odoo: number; diff: number }>();
  for (const r of rows) {
    const k = r.uom.trim().toUpperCase() || "—";
    const u = byUom.get(k) ?? { uom: k, physical: 0, odoo: 0, diff: 0 };
    u.physical = r2(u.physical + r.physical);
    u.odoo = r2(u.odoo + r.odoo);
    u.diff = r2(u.physical - u.odoo);
    byUom.set(k, u);
  }
  const count = (s: StockStatus) => rows.filter((r) => r.status === s).length;
  return { items: rows.length, match: count("match"), short: count("short"), over: count("over"), empty: count("empty"), byUom: [...byUom.values()] };
}

// ---- the sheet: Product Code · Product Name · Physically Stock Internal Store · UOM · SF01 Stock In Odoo ----

type Col = "code" | "name" | "physical" | "uom" | "odoo";

/** Header text → the column it is, forgiving spelling ("Phsically"), case and spacing. */
export function stockColumnOf(header: string): Col | null {
  const h = header.toLowerCase().replace(/\s+/g, " ").trim();
  if (!h) return null;
  if (/odoo|sf01/.test(h)) return "odoo";
  if (/ph[iy]?s[iy]?c?a?l+y?|internal store|counted|physical/.test(h)) return "physical";
  if (/^uom$|unit of measure|^unit$/.test(h)) return "uom";
  if (/code/.test(h)) return "code";
  if (/name|description/.test(h)) return "name";
  return null;
}

/** A sheet number: 1,234.50 / "1234" / blank → number or null. */
export function stockNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

export interface StockParse {
  rows: StockRow[];
  issues: string[];
  headerRow: number;
}

/** The sheet as a grid of cells → its stock rows. The header row is the
 *  first one that names a code column and either stock column; a row with
 *  no code is skipped, a code seen twice keeps its last row (and says so). */
export function parseStockGrid(grid: unknown[][]): StockParse {
  const issues: string[] = [];
  let headerRow = -1;
  let col: Partial<Record<Col, number>> = {};
  for (let i = 0; i < Math.min(grid.length, 15); i++) {
    const found: Partial<Record<Col, number>> = {};
    (grid[i] ?? []).forEach((c, j) => {
      const k = stockColumnOf(String(c ?? ""));
      if (k && found[k] === undefined) found[k] = j;
    });
    if (found.code !== undefined && (found.physical !== undefined || found.odoo !== undefined)) { headerRow = i; col = found; break; }
  }
  if (headerRow < 0) return { rows: [], issues: ["No header row with a Product Code and a stock column was found."], headerRow: 0 };
  const byCode = new Map<string, StockRow>();
  for (let i = headerRow + 1; i < grid.length; i++) {
    const line = grid[i] ?? [];
    const cell = (k: Col) => (col[k] === undefined ? "" : line[col[k]!]);
    const code = String(cell("code") ?? "").trim();
    if (!code) continue;
    const physical = stockNumber(cell("physical"));
    const odoo = stockNumber(cell("odoo"));
    if (physical === null && odoo === null) { issues.push(`Row ${i + 1} (${code}): no stock figures — skipped.`); continue; }
    const key = code.toUpperCase();
    if (byCode.has(key)) issues.push(`Row ${i + 1}: ${code} appears again — the later row is kept.`);
    byCode.set(key, {
      code,
      name: String(cell("name") ?? "").replace(/\s+/g, " ").trim(),
      uom: String(cell("uom") ?? "").trim().toUpperCase(),
      physical: physical ?? 0,
      odoo: odoo ?? 0,
    });
  }
  return { rows: [...byCode.values()], issues, headerRow: headerRow + 1 };
}
