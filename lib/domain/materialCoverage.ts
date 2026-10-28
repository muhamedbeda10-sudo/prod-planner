// Enough sheets for the work? The pieces still to cut, turned into sheets by
// the MATERIAL tab's nesting (the actual rate where a job was nested, the
// BOM's where not), added up per Odoo product code and set against the
// Physical Material table: Odoo's stock (SF01) and the store's own count.
// Pure — the release checklist and the assistant read it.

import type { LineSheetSpec } from "./machineMaterial";
import type { OdooRates } from "./odooBom";
import type { CheckStatus } from "./planningControl";
import { stockTolerance } from "./physicalStock";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A product code as both sheets write it — case aside, as the stock import keys it. */
export const normCode = (code: string) => code.trim().toUpperCase();

/** Units a sheet count can be held against: pieces, or none written. */
const countsSheets = (uom: string) => ["", "PC", "PCS", "NO", "NOS", "EA", "UNIT", "UNITS", "SHEET", "SHEETS"].includes(uom.trim().toUpperCase());

/** A part the nesting has no line for yet, priced off Odoo's BoM instead:
 *  the materials one piece takes that the stock table carries, in the unit the
 *  table counts them in (pieces with pieces, kilos with kilos — never mixed).
 *  Bolts, wood and the like are not on the table, so they stay out. */
export function specsFromOdoo(rate: OdooRates[string] | undefined, stock: readonly Pick<StockLine, "code" | "name" | "uom">[]): LineSheetSpec[] {
  if (!rate) return [];
  const byCode = new Map(stock.map((s) => [normCode(s.code), s]));
  const out: LineSheetSpec[] = [];
  for (const [code, r] of Object.entries(rate)) {
    const s = byCode.get(normCode(code));
    if (!s || !(r.qty > 0)) continue;
    const a = s.uom.trim().toUpperCase(), b = r.uom.trim().toUpperCase();
    if (!(a === b || (countsSheets(a) && countsSheets(b)))) continue;
    out.push({ material: s.name || r.name || "", materialCode: s.code, thicknessMm: 0, sheetSize: "", perUnit: r.qty, actual: false, odoo: true });
  }
  return out.sort((x, y) => x.materialCode.localeCompare(y.materialCode));
}

/** One job's part still to cut, with the sheets it is cut from. */
export interface PartNeed {
  mo: string;
  item: string;
  /** Pieces Fabrication still owes. */
  pcsLeft: number;
  /** The sheets behind the part; none when the nesting has no line for it. */
  specs: readonly LineSheetSpec[];
}

export interface SheetNeed {
  code: string;
  material: string;
  thicknessMm: number;
  sheetSize: string;
  sheets: number;
  /** Some of it priced at the BOM's rate — the job is not nested yet. */
  estimated: boolean;
  /** Some of it read off Odoo's BoM — a part with no nesting line yet. */
  byOdoo: boolean;
  /** The jobs behind it, most sheets first. */
  jobs: { mo: string; item: string; sheets: number }[];
}

export interface NeedSummary {
  byCode: SheetNeed[];
  /** Parts with pieces left but no nesting line — their sheets are unknown. */
  noNesting: { mo: string; item: string; pcsLeft: number }[];
  /** Parts with no nesting line priced off Odoo's BoM instead. */
  byOdoo: { mo: string; item: string; pcsLeft: number }[];
  /** Nesting lines with no product code — not matchable to the stock. */
  uncoded: { mo: string; item: string; sheet: string; sheets: number }[];
}

/** The sheets the parts still need, per product code. */
export function sheetNeeds(parts: readonly PartNeed[]): NeedSummary {
  const by = new Map<string, SheetNeed>();
  const noNesting: NeedSummary["noNesting"] = [];
  const byOdoo: NeedSummary["byOdoo"] = [];
  const uncoded: NeedSummary["uncoded"] = [];
  for (const p of parts) {
    if (!(p.pcsLeft > 0)) continue;
    if (p.specs.length === 0) { noNesting.push({ mo: p.mo, item: p.item, pcsLeft: p.pcsLeft }); continue; }
    if (p.specs.every((s) => s.odoo)) byOdoo.push({ mo: p.mo, item: p.item, pcsLeft: p.pcsLeft });
    for (const s of p.specs) {
      const sheets = s.perUnit * p.pcsLeft;
      if (!(sheets > 0)) continue;
      const code = normCode(s.materialCode);
      if (!code) { uncoded.push({ mo: p.mo, item: p.item, sheet: `${s.thicknessMm} mm ${s.material} ${s.sheetSize}`.trim(), sheets: r2(sheets) }); continue; }
      const n = by.get(code) ?? { code, material: s.material, thicknessMm: s.thicknessMm, sheetSize: s.sheetSize, sheets: 0, estimated: false, byOdoo: false, jobs: [] };
      n.sheets += sheets;
      n.estimated ||= !s.actual;
      n.byOdoo ||= !!s.odoo;
      n.jobs.push({ mo: p.mo, item: p.item, sheets: r2(sheets) });
      by.set(code, n);
    }
  }
  const byCode = [...by.values()].map((n) => ({ ...n, sheets: r2(n.sheets), jobs: n.jobs.sort((a, b) => b.sheets - a.sheets) })).sort((a, b) => b.sheets - a.sheets || a.code.localeCompare(b.code));
  return { byCode, noNesting, byOdoo, uncoded };
}

export interface StockLine {
  code: string;
  name: string;
  uom: string;
  odoo: number;
  physical: number;
}

export type CoverStatus = "covered" | "short" | "store_short" | "not_listed" | "not_comparable";

export interface CoverageRow {
  code: string;
  name: string | null;
  material: string;
  thicknessMm: number;
  sheetSize: string;
  need: number;
  estimated: boolean;
  byOdoo: boolean;
  /** Odoo's stock (SF01) and the store's count; null when the code is not on the table. */
  odoo: number | null;
  physical: number | null;
  uom: string | null;
  /** What all the open work needs of the code, when it was read with it. */
  openDemand: number | null;
  /** The other open orders that need the code, most sheets first. */
  competing: { mo: string; item: string; sheets: number }[];
  /** The store has a count for the code (0 on the table reads as not counted). */
  storeCounted: boolean | null;
  /** Odoo's stock less the need (negative = short). */
  balance: number | null;
  status: CoverStatus;
  /** The open work wants more of it than Odoo holds — this need competes with others. */
  contended: boolean;
  jobs: SheetNeed["jobs"];
}

export const COVER_TEXT: Record<CoverStatus, string> = {
  covered: "Odoo holds enough",
  short: "Odoo holds less than needed",
  store_short: "Odoo holds enough, but the store's count is less",
  not_listed: "Not on the Physical Material table",
  not_comparable: "Held in another unit (e.g. KG) — cannot be set against sheets",
};

/** Each code's need against the stock table (and, given, all the open work's
 *  need of it, with the orders behind it). Short first, then by sheets. A store
 *  count of 0 is read as not counted — a table imported with Odoo's figures only. */
export function coverage(needs: readonly SheetNeed[], stock: readonly StockLine[], openDemand?: ReadonlyMap<string, SheetNeed>): CoverageRow[] {
  const byCode = new Map(stock.map((s) => [normCode(s.code), s]));
  const rank: Record<CoverStatus, number> = { short: 0, store_short: 1, not_listed: 2, not_comparable: 3, covered: 4 };
  return needs.map((n) => {
    const s = byCode.get(n.code);
    const open = openDemand?.get(n.code);
    const mine = new Set(n.jobs.map((j) => j.mo));
    const base = {
      code: n.code, material: n.material, thicknessMm: n.thicknessMm, sheetSize: n.sheetSize, need: n.sheets, estimated: n.estimated, byOdoo: n.byOdoo,
      openDemand: open ? open.sheets : null, competing: (open?.jobs ?? []).filter((j) => !mine.has(j.mo)).slice(0, 6), jobs: n.jobs.slice(0, 8),
    };
    if (!s) return { ...base, name: null, odoo: null, physical: null, uom: null, balance: null, status: "not_listed" as const, contended: false, storeCounted: null };
    const tol = stockTolerance(s.uom);
    const comparable = countsSheets(s.uom);
    const counted = Math.abs(s.physical) >= tol;
    const status: CoverStatus = !comparable ? "not_comparable" : s.odoo + tol <= n.sheets ? "short" : counted && s.physical + tol <= n.sheets ? "store_short" : "covered";
    return {
      ...base, name: s.name, odoo: s.odoo, physical: s.physical, uom: s.uom || "PC", storeCounted: counted,
      balance: comparable ? r2(s.odoo - n.sheets) : null, status,
      contended: comparable && open !== undefined && open.sheets >= s.odoo + tol,
    };
  }).sort((a, b) => rank[a.status] - rank[b.status] || b.need - a.need || a.code.localeCompare(b.code));
}

/** The release checklist's material line, from an order's coverage. */
export function stockCheck(rows: readonly CoverageRow[], gaps: Pick<NeedSummary, "noNesting" | "uncoded"> & Partial<Pick<NeedSummary, "byOdoo">>): { status: CheckStatus; detail: string } {
  const list = (rs: readonly CoverageRow[]) => rs.map((r) => `${r.code} (needs ${r.need}${r.odoo === null ? "" : `, Odoo ${r.odoo}`})`).join(", ");
  const short = rows.filter((r) => r.status === "short");
  if (short.length) return { status: "blocked", detail: `Odoo holds less than this order needs: ${list(short)}.` };
  const notes: string[] = [];
  const store = rows.filter((r) => r.status === "store_short");
  if (store.length) notes.push(`the store's count is less than the need for ${store.map((r) => `${r.code} (needs ${r.need}, store ${r.physical}, Odoo ${r.odoo})`).join(", ")}`);
  const contended = rows.filter((r) => r.contended);
  if (contended.length) notes.push(`all the open work wants more than Odoo holds of ${contended.map((r) => `${r.code} (${r.openDemand} needed, Odoo ${r.odoo}${r.competing.length ? `; also wanted by ${r.competing.map((c) => c.mo).join(", ")}` : ""})`).join(", ")} — this order competes for it`);
  const unknown = rows.filter((r) => r.status === "not_listed" || r.status === "not_comparable");
  if (unknown.length) notes.push(`${unknown.map((r) => r.code).join(", ")} cannot be checked (${[...new Set(unknown.map((r) => COVER_TEXT[r.status]))].join("; ").toLowerCase()})`);
  if (gaps.noNesting.length) notes.push(`no nesting for ${gaps.noNesting.map((g) => g.item).join(", ")}, so its sheets are unknown`);
  if (gaps.byOdoo?.length) notes.push(`no nesting for ${gaps.byOdoo.map((g) => g.item).join(", ")} yet, so its sheets are Odoo's BoM figures`);
  if (gaps.uncoded.length) notes.push(`${gaps.uncoded.length} nesting line(s) carry no product code`);
  if (rows.length === 0 && !gaps.noNesting.length && !gaps.uncoded.length) return { status: "ok", detail: "Nothing is left to cut — no sheets needed." };
  if (notes.length) {
    const blind = store.length === 0 && contended.length === 0;
    return { status: blind && rows.every((r) => r.status !== "covered") ? "unknown" : "warn", detail: `${rows.filter((r) => r.status === "covered").length} of ${rows.length} sheet codes are covered by Odoo's stock; ${notes.join("; ")}.` };
  }
  return { status: "ok", detail: `Odoo holds enough of all ${rows.length} sheet code(s) this order still needs (${rows.map((r) => `${r.code}: ${r.need} of ${r.odoo}`).join(", ")}).` };
}

/** What the open work needs of one stock line — the Physical Material screen's columns. */
export interface StockNeed {
  need: number;
  /** Odoo's stock after the need (negative = short); null when it cannot be set against sheets. */
  after: number | null;
  status: CoverStatus;
  estimated: boolean;
  /** Some of it read off Odoo's BoM (a part with no nesting line yet). */
  byOdoo: boolean;
  /** How many orders and jobs need the code, and the biggest of them. */
  orders: number;
  jobCount: number;
  jobs: SheetNeed["jobs"];
}

/** The open work's need beside each stock line, keyed by its code as the
 *  stock import keys it; the codes the work needs that the table lacks; and
 *  how many parts it could not price (no nesting, no code) — so a need shown
 *  is never read as all of it when it is not. */
export function needByStock(summary: NeedSummary, stock: readonly StockLine[]): {
  byCode: Record<string, StockNeed>;
  missing: Pick<SheetNeed, "code" | "material" | "thicknessMm" | "sheetSize" | "sheets">[];
  unpriced: { noNesting: number; uncoded: number };
  /** Parts with no nesting line that Odoo's BoM priced instead. */
  byOdoo: number;
} {
  const needs = summary.byCode;
  const full = new Map(needs.map((n) => [n.code, n]));
  const byCode: Record<string, StockNeed> = {};
  const missing: ReturnType<typeof needByStock>["missing"] = [];
  for (const r of coverage(needs, stock)) {
    const n = full.get(r.code)!;
    if (r.status === "not_listed") { missing.push({ code: n.code, material: n.material, thicknessMm: n.thicknessMm, sheetSize: n.sheetSize, sheets: n.sheets }); continue; }
    byCode[r.code] = { need: r.need, after: r.balance, status: r.status, estimated: r.estimated, byOdoo: r.byOdoo, orders: new Set(n.jobs.map((j) => j.mo)).size, jobCount: n.jobs.length, jobs: n.jobs.slice(0, 8) };
  }
  return { byCode, missing, unpriced: { noNesting: summary.noNesting.length, uncoded: summary.uncoded.length }, byOdoo: summary.byOdoo.length };
}
