import { ITEMS, type Item } from "@/lib/domain/constants";
import { ITEM_PRODUCT } from "@/lib/domain/odooMirror";
import { sheetKg } from "@/lib/domain/fabAnalytics";
import { actualPerUnit, sheetsForJob } from "@/lib/domain/material";
import { monthLabelSortKey, parseISODate } from "@/lib/domain/dates";
import { formatNumber } from "@/lib/domain/format";
import { addDaysISO, clampISO } from "@/lib/domain/dateSlicer";
import { pctChange, previousPeriod } from "@/lib/domain/consumablesStats";
import { moParent } from "@/lib/domain/odooMaterial";

// 📊 The MATERIAL dashboard — what the material sheet and the ODOO log say
// about steel, in sheets and tonnes, and how much of it the data covers.
//
// Two sources, two clocks, two views:
//  - NESTING (the plan and the current sheet, "Now"): per MO and part, the
//    sheets the BOM calls for, the sheets the nesting really took, one
//    sheet's weight and the nesting's average utilization. It is read whole —
//    an MO nested last month is just as nested today — and no period touches it.
//  - CONSUMPTION (a period): an MO moved to Done on Odoo books its closed
//    quantity × the sheets one unit takes, on the factory day (Cairo) it was
//    moved to Done. It is CALCULATED from the sheet's rates — not a store
//    issue that was measured, and not the sheets the lasers really cut (the
//    machines' sheets are on the Floor, the store's balance on Inventory).
//
// Nothing unknown is ever made a zero: a sheet with no weight leaves its
// kilograms unknown (counted apart), a line with no utilization leaves its
// scrap unknown, a closing with a blank MO or an MO the sheet does not carry
// books no steel and is counted as unlinked. Every total says what it covers.
//
// Everything here is pure; the caller brings the rows.

// ---------------------------------------------------------------- inputs

/** One line of the material sheet, as stored. */
export interface SheetLine {
  /** The plan month the line was filed under; "" = the living sheet. */
  month: string;
  mo: string;
  /** The key closings book against when it is not the MO itself: a line the
   *  sheet files under the TRANSFORMER's MO takes `orderPartKey` — its order
   *  and its part — so a tank's closing never books the top cover's sheets. */
  closingKey?: string;
  soi: string;
  bom: string;
  partCode: string;
  partName: string;
  material: string;
  thicknessMm: number;
  sheetSize: string;
  units: number;
  /** BOM Qty for one Unit. */
  sheetsPerUnit: number;
  /** Pieces in Actual Nesting for one Unit — null until nested. */
  actualPerUnit: number | null;
  /** Pieces in Actual Nesting for the Job — null until nested. */
  sheetsUsed: number | null;
  /** One sheet's weight as the sheet writes it; null when blank. */
  weightKg: number | null;
  /** Average Utilization as the sheet writes it: 0.86 or 86. */
  utilization: number | null;
}

/** One ODOO row moved to Done — whatever its MO says, blank included. */
export interface DoneRow {
  /** The factory's day (Cairo) it was moved to Done. */
  dateISO: string;
  mo: string;
  qty: number;
}

// ---------------------------------------------------------------- the request

export const MATERIAL_VIEWS = ["consumption", "nesting"] as const;
export type MaterialView = (typeof MATERIAL_VIEWS)[number];
export const MATERIAL_VIEW_LABEL: Record<MaterialView, string> = { consumption: "Consumption in period", nesting: "Nesting plan · Now" };
/** The same, where a phone has room for less. */
export const MATERIAL_VIEW_SHORT: Record<MaterialView, string> = { consumption: "Consumption", nesting: "Nesting · Now" };

export const MATERIAL_BREAKDOWNS = ["thickness", "material", "size"] as const;
export type MaterialBreakdownBy = (typeof MATERIAL_BREAKDOWNS)[number];
export const MATERIAL_BREAKDOWN_LABEL: Record<MaterialBreakdownBy, string> = { thickness: "Thickness", material: "Material", size: "Sheet size" };

/** The groups the page narrows to. Empty = any. */
export interface MaterialFilters {
  material: string;
  thicknessMm: number | null;
  sheetSize: string;
  /** A part code or a part name. */
  part: string;
  mo: string;
  soi: string;
}
export const EMPTY_MATERIAL_DASH_FILTERS: MaterialFilters = { material: "", thicknessMm: null, sheetSize: "", part: "", mo: "", soi: "" };

/** The URL keys of the filters — read and written through this one map. */
export const MATERIAL_FILTER_PARAM = { material: "material", thicknessMm: "thickness", sheetSize: "size", part: "part", mo: "mo", soi: "soi" } as const satisfies Record<keyof MaterialFilters, string>;

/** How far back the consumption period may reach. */
export const MATERIAL_HISTORY_DAYS = 365;
/** The period the page opens on: the last 90 days, today included. */
export const MATERIAL_DEFAULT_DAYS = 90;

export interface MaterialRequest {
  view: MaterialView;
  by: MaterialBreakdownBy;
  /** The consumption period; from null = everything on record. */
  fromISO: string | null;
  toISO: string;
  /** The period just before, the same length — null for "everything". */
  prev: { fromISO: string; toISO: string } | null;
  filters: MaterialFilters;
}

const one = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? "") : typeof v === "string" ? v : "").trim().slice(0, 120);

export function materialDefaultRange(todayISO: string): { from: string; to: string } {
  return { from: addDaysISO(todayISO, -(MATERIAL_DEFAULT_DAYS - 1)), to: todayISO };
}

/** What a request is made of, typed — the page's address and the
 *  assistant's tools both come down to this. */
export interface MaterialScope {
  view?: string;
  by?: string;
  from?: string;
  to?: string;
  /** Every closing on record. */
  all?: boolean;
  /** An older link's window in days back from today (0 = everything). */
  days?: number;
  filters?: Partial<Record<keyof MaterialFilters, string | number | null | undefined>>;
}

/**
 * The request a scope asks for. Anything unreadable falls back to the
 * default, never an error: the last 90 days, consumption, by thickness; a
 * period given by its end alone runs back the default length from it.
 */
export function materialRequestOf(s: MaterialScope, todayISO: string): MaterialRequest {
  const view = (MATERIAL_VIEWS as readonly string[]).includes(s.view ?? "") ? (s.view as MaterialView) : "consumption";
  const by = (MATERIAL_BREAKDOWNS as readonly string[]).includes(s.by ?? "") ? (s.by as MaterialBreakdownBy) : "thickness";
  const min = addDaysISO(todayISO, -MATERIAL_HISTORY_DAYS);
  const valid = (d: string | undefined) => (d && parseISODate(d) ? clampISO(d, min, todayISO) : null);

  let fromISO: string | null = null;
  let toISO = todayISO;
  if (!s.all && s.days !== 0) {
    toISO = valid(s.to) ?? todayISO;
    fromISO = valid(s.from) ?? addDaysISO(toISO, -((s.days && s.days > 0 ? s.days : MATERIAL_DEFAULT_DAYS) - 1));
    if (fromISO > toISO) [fromISO, toISO] = [toISO, fromISO];
  }

  const text = (v: unknown) => one(v === null || v === undefined ? "" : String(v));
  const f = s.filters ?? {};
  const thick = Number(f.thicknessMm);
  return {
    view, by, fromISO, toISO,
    prev: fromISO === null ? null : previousPeriod(fromISO, toISO),
    filters: {
      material: text(f.material),
      thicknessMm: text(f.thicknessMm) && Number.isFinite(thick) && thick > 0 ? thick : null,
      sheetSize: text(f.sheetSize),
      part: text(f.part),
      mo: text(f.mo),
      soi: text(f.soi),
    },
  };
}

/** The page's request off its address: ?view= ?by= ?from=&to= (or all=1)
 *  and the group filters under MATERIAL_FILTER_PARAM; an older link's
 *  ?days=30|60|90|0 keeps its window. */
export function materialRequest(sp: Record<string, unknown>, todayISO: string): MaterialRequest {
  const days = one(sp.days);
  return materialRequestOf({
    view: one(sp.view), by: one(sp.by), from: one(sp.from), to: one(sp.to), all: one(sp.all) === "1",
    days: /^\d{1,3}$/.test(days) ? Number(days) : undefined,
    filters: Object.fromEntries((Object.keys(MATERIAL_FILTER_PARAM) as (keyof MaterialFilters)[]).map((k) => [k, one(sp[MATERIAL_FILTER_PARAM[k]])])),
  }, todayISO);
}

/** The request's own query string (no line): what a link that keeps the
 *  page's choices carries. */
export function materialQuery(r: MaterialRequest, over: Partial<{ view: MaterialView; by: MaterialBreakdownBy; fromISO: string | null; toISO: string; filters: Partial<MaterialFilters> }>, todayISO: string): string {
  const q = new URLSearchParams();
  const view = over.view ?? r.view;
  const by = over.by ?? r.by;
  const from = over.fromISO !== undefined ? over.fromISO : r.fromISO;
  const to = over.toISO ?? r.toISO;
  const f = { ...r.filters, ...over.filters };
  if (view !== "consumption") q.set("view", view);
  if (by !== "thickness") q.set("by", by);
  if (from === null) q.set("all", "1");
  else {
    const def = materialDefaultRange(todayISO);
    if (from !== def.from || to !== def.to) { q.set("from", from); q.set("to", to); }
  }
  for (const k of Object.keys(MATERIAL_FILTER_PARAM) as (keyof MaterialFilters)[]) {
    const v = f[k];
    if (v !== null && v !== "") q.set(MATERIAL_FILTER_PARAM[k], String(v));
  }
  return q.toString();
}

export function hasMaterialFilters(f: MaterialFilters): boolean {
  return !!(f.material || f.thicknessMm !== null || f.sheetSize || f.part || f.mo || f.soi);
}

// ---------------------------------------------------------------- one line's figures

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const up = (s: string) => s.trim().toUpperCase();
/** An MO as the two sources are matched on it; "" never matches anything. */
const moKey = (mo: string) => up(mo);

/** The closing key of a part on a transformer's MO (SheetLine.closingKey,
 *  DoneRow.mo): never an Odoo MO, so no backorder rule ever touches it. */
export const orderPartKey = (orderMo: string, partCode: string) => `ORD|${up(orderMo)}|${up(partCode)}`;
const isOrderPartKey = (k: string) => k.startsWith("ORD|");

/** Utilization as a fraction, 0–1; the sheet may write 0.86 or 86. */
export function utilizationFraction(u: number | null): number | null {
  if (u === null || !Number.isFinite(u) || u <= 0) return null;
  const f = u > 1.5 ? u / 100 : u;
  return Math.min(1, Math.max(0, f));
}

export type WeightSource = "sheet" | "computed" | "unknown";
export const WEIGHT_SOURCE_LABEL: Record<WeightSource, string> = { sheet: "Weight from the sheet", computed: "Weight from size × thickness × density", unknown: "Weight unknown" };

/** One sheet's weight: the sheet's own where it gives one, else size ×
 *  thickness × the material's density; unknown (null) when neither reads. */
export function sheetWeight(l: Pick<SheetLine, "weightKg" | "sheetSize" | "thicknessMm" | "material">): { kg: number | null; source: WeightSource } {
  if (l.weightKg !== null && Number.isFinite(l.weightKg) && l.weightKg > 0) return { kg: l.weightKg, source: "sheet" };
  const kg = sheetKg(l.sheetSize, l.thicknessMm, l.material);
  return kg !== null && kg > 0 ? { kg, source: "computed" } : { kg: null, source: "unknown" };
}

export type RateSource = "actual" | "bom";
export const RATE_SOURCE_LABEL: Record<RateSource, string> = { actual: "Actual nesting rate", bom: "Estimated from BOM" };

/** Sheets one unit takes: the nesting's (the material tab's own rule), else
 *  the BOM's — said so, as an estimate. */
export function unitRate(l: Pick<SheetLine, "actualPerUnit" | "sheetsUsed" | "units" | "sheetsPerUnit">): { perUnit: number; source: RateSource } {
  const a = actualPerUnit(l.actualPerUnit, l.sheetsUsed, l.units);
  return a !== null ? { perUnit: a, source: "actual" } : { perUnit: l.sheetsPerUnit, source: "bom" };
}

/** Sheets the nesting took for the job — the sheet's job figure, else its
 *  per-unit figure × the units; null until nested. */
function nestedSheets(l: Pick<SheetLine, "sheetsUsed" | "actualPerUnit" | "units">): number | null {
  if (l.sheetsUsed !== null) return l.sheetsUsed;
  if (l.actualPerUnit !== null) return l.actualPerUnit * l.units;
  return null;
}

// ---------------------------------------------------------------- versions

export interface VersionInfo {
  /** Lines read from the living sheet ("" month). */
  livingLines: number;
  /** Lines read from an older month's sheet — MOs the living sheet does not carry. */
  archivedLines: number;
  /** The older months those lines come from, newest first. */
  archivedMonths: string[];
  /** Lines left out because a newer copy of the same MO (or BOM × part) was read. */
  skippedLines: number;
}

// a part filed under its transformer's MO is a job of its own: the order × part
const versionKey = (l: SheetLine) => l.closingKey ?? (l.mo.trim() ? `MO|${moKey(l.mo)}` : `BOM|${up(l.bom)}|${up(l.partCode) || up(l.partName)}`);
const monthRank = (m: string) => (m === "" ? Number.MAX_SAFE_INTEGER : monthLabelSortKey(m));

/**
 * One copy of each MO. The import writes the living sheet (month ""); older
 * sheets were filed under a plan month and may carry the same MO again — the
 * same job, not more steel. So each MO (a blank-MO line: its BOM × part) is
 * read from ONE sheet: the living one when it has it, else the newest month
 * that does. MOs only an older month carries stay in — their months are not
 * dropped — and nothing is counted twice.
 */
export function pickSheetVersions(lines: readonly SheetLine[]): { lines: SheetLine[]; versions: VersionInfo } {
  const best = new Map<string, string>();
  for (const l of lines) {
    const k = versionKey(l);
    const cur = best.get(k);
    if (cur === undefined || monthRank(l.month) > monthRank(cur) || (monthRank(l.month) === monthRank(cur) && l.month > cur)) best.set(k, l.month);
  }
  const kept: SheetLine[] = [];
  const months = new Set<string>();
  let skipped = 0;
  for (const l of lines) {
    if (best.get(versionKey(l)) !== l.month) { skipped += 1; continue; }
    kept.push(l);
    if (l.month) months.add(l.month);
  }
  return {
    lines: kept,
    versions: {
      livingLines: kept.filter((l) => l.month === "").length,
      archivedLines: kept.filter((l) => l.month !== "").length,
      archivedMonths: [...months].sort((a, b) => monthRank(b) - monthRank(a) || b.localeCompare(a)),
      skippedLines: skipped,
    },
  };
}

// ---------------------------------------------------------------- filters

const sameText = (a: string, b: string) => up(a) === up(b);

function lineMatches(l: SheetLine, f: MaterialFilters): boolean {
  if (f.material && !sameText(l.material, f.material)) return false;
  if (f.thicknessMm !== null && Math.abs(l.thicknessMm - f.thicknessMm) > 1e-6) return false;
  if (f.sheetSize && !sameText(l.sheetSize, f.sheetSize)) return false;
  if (f.part && !sameText(l.partCode, f.part) && !sameText(l.partName, f.part)) return false;
  if (f.mo && (!l.mo.trim() || moKey(l.mo) !== moKey(f.mo))) return false;
  if (f.soi && !sameText(l.soi, f.soi)) return false;
  return true;
}

export interface FilterOptions {
  materials: string[];
  thicknesses: number[];
  sizes: string[];
  parts: { value: string; label: string }[];
  sois: string[];
}

function filterOptions(lines: readonly SheetLine[]): FilterOptions {
  const uniq = (xs: string[]) => [...new Map(xs.filter(Boolean).map((x) => [up(x), x.trim()])).values()].sort((a, b) => a.localeCompare(b));
  const parts = new Map<string, { value: string; label: string }>();
  for (const l of lines) {
    const value = l.partCode.trim() || l.partName.trim();
    if (!value || parts.has(up(value))) continue;
    parts.set(up(value), { value, label: l.partCode.trim() && l.partName.trim() ? `${l.partName.trim()} · ${l.partCode.trim()}` : value });
  }
  return {
    materials: uniq(lines.map((l) => l.material)),
    thicknesses: [...new Set(lines.map((l) => l.thicknessMm).filter((t) => t > 0))].sort((a, b) => a - b),
    sizes: uniq(lines.map((l) => l.sheetSize)),
    parts: [...parts.values()].sort((a, b) => a.label.localeCompare(b.label)),
    sois: uniq(lines.map((l) => l.soi)),
  };
}

// ---------------------------------------------------------------- outputs

/** Weight with what it covers: kilograms over the sheets whose weight is
 *  known, and the sheets whose weight is not. */
export interface Weighed {
  sheets: number;
  kg: number;
  /** Sheets in `sheets` whose weight is unknown — not in `kg`. */
  unknownWeightSheets: number;
}

export interface NestingFigures {
  planned: Weighed & { lines: number; mos: number };
  nested: Weighed & { lines: number; mos: number };
  /** Nested − BOM on the SAME lines (those nested): >0 the nesting took more. */
  variance: { sheets: number; kg: number; bomSheets: number; bomKg: number; lines: number };
  /** Weighted by the nested kilograms of the lines whose utilization is known. */
  utilization: number | null;
  /** Nested kg with a known utilization / nested kg with a known weight. */
  utilizationKg: number;
  /** Scrap and net product, on the nested kg whose utilization is known only. */
  scrapKg: number;
  netKg: number;
  /** Nested kg whose utilization is unknown — its scrap is unknown, not zero. */
  unknownUtilKg: number;
}

export interface ConsumptionFigures extends Weighed {
  /** Closings (ODOO rows moved to Done in the period) that booked steel, and their units — each once. */
  closings: number;
  units: number;
  mos: number;
  /** Sheets (and their kg) at the BOM's rate, where the nesting gave none. */
  bomRateSheets: number;
  bomRateKg: number;
  /** Scrap estimated on the consumed kg whose utilization is known. */
  scrapKg: number;
  netKg: number;
  /** Consumed kg with a known utilization — what `scrapKg` covers. */
  utilizationKg: number;
  /** Days with a booked closing. */
  days: number;
}

export interface LinkCoverage {
  /** Every closing of the line in the period, and its quantity. */
  rows: number;
  qty: number;
  /** Closings whose MO is blank — never matched to anything. */
  blankRows: number;
  blankQty: number;
  /** Closings whose MO the sheet does not carry. */
  offSheetRows: number;
  offSheetQty: number;
  /** Closings matched to the sheet by their MO. */
  linkedRows: number;
  linkedQty: number;
  /** MOs closed in the period whose closed quantity passes the sheet's units. */
  overClosedMos: number;
  /** The off-sheet MOs, the largest quantity first (ten). */
  offSheetMos: { mo: string; qty: number }[];
}

export interface DataCoverage {
  lines: number;
  weight: Record<WeightSource, number>;
  /** Lines nested, and of them with a utilization. */
  nestedLines: number;
  utilizationLines: number;
  /** Lines whose rate is the nesting's, the rest the BOM's. */
  actualRateLines: number;
}

export interface DayPoint {
  dateISO: string;
  closings: number;
  units: number;
  sheets: number;
  kg: number;
  /** The part of `kg` booked at the BOM's rate (an estimate). */
  bomRateKg: number;
  unknownWeightSheets: number;
}

export interface Breakdown {
  key: string;
  /** The thickness, for sorting; null for the other dimensions. */
  thicknessMm: number | null;
  /** What a click on the group narrows the page to; null for a blank group. */
  filter: Partial<MaterialFilters> | null;
  bom: Weighed;
  nested: Weighed;
  consumed: Weighed;
  /** Consumed scrap, on known utilization. */
  scrapKg: number;
}

export interface PartCompare {
  part: string;
  partCode: string;
  item: Item | null;
  /** The lines compared — nested lines only, so both sides cover the same rows. */
  lines: number;
  bomSheets: number;
  actualSheets: number;
  bomKg: number;
  actualKg: number;
}

export interface Overrun {
  mo: string;
  soi: string;
  part: string;
  units: number;
  bomSheets: number;
  actualSheets: number;
  deltaSheets: number;
  /** Null where a line of the MO has no known weight. */
  deltaKg: number | null;
}

/** One line of the detail table: one MO × part × sheet spec. */
export interface DetailRow {
  key: string;
  mo: string;
  soi: string;
  bom: string;
  partCode: string;
  partName: string;
  material: string;
  thicknessMm: number;
  sheetSize: string;
  /** The sheet the line was read from: "" the living one, else its month. */
  month: string;
  units: number;
  bomSheets: number;
  actualSheets: number | null;
  deltaSheets: number | null;
  sheetKg: number | null;
  weightSource: WeightSource;
  utilization: number | null;
  rateSource: RateSource;
  ratePerUnit: number;
  /** The MO's closed quantity in the period — the MO's, shown on each of its lines. */
  closedQty: number;
  consumedSheets: number;
  consumedKg: number | null;
  scrapKg: number | null;
}

export interface DetailTotals {
  lines: number;
  mos: number;
  /** Units of the MOs (each MO once — its lines share them). */
  units: number;
  bomSheets: number;
  actualSheets: number;
  /** Nested − BOM on the nested lines only. */
  deltaSheets: number;
  /** Closed units in the period, each MO once. */
  closedQty: number;
  consumedSheets: number;
  consumedKg: number;
  /** Over the lines whose utilization is known; null when none is — unknown, not zero. */
  scrapKg: number | null;
}

export interface MaterialAction {
  tone: "bad" | "warn" | "info";
  text: string;
  /** Where to fix or see it: "odoo" the period's ODOO log, "material" the
   *  sheet, or a filter on this page. */
  target: { kind: "odoo" } | { kind: "material" } | { kind: "filter"; key: keyof MaterialFilters; value: string };
}

/** The coverage shares and the period changes — read once here, by the page and the assistant alike. */
export interface CoverageSummary {
  /** Closings linked to the sheet, by rows and by units. */
  linkRows: number | null;
  linkQty: number | null;
  /** Consumed sheets at an actual nesting rate. */
  actualRate: number | null;
  /** Lines with a known sheet weight. */
  weightKnown: number | null;
  /** Nested tonnes with a known utilization. */
  utilKnown: number | null;
  /** Consumed tonnes with a known utilization — what the scrap estimate covers. */
  scrapKnown: number | null;
  /** Any share short of whole: the figures are partial. */
  partial: boolean;
  consumptionChangePct: number | null;
  scrapChangePct: number | null;
}

export interface MaterialDashboard {
  nesting: NestingFigures;
  consumption: ConsumptionFigures;
  /** The period before, for the period cards' change — null for "everything". */
  prevConsumption: ConsumptionFigures | null;
  link: LinkCoverage;
  coverage: DataCoverage;
  versions: VersionInfo;
  days: DayPoint[];
  breakdown: Breakdown[];
  parts: PartCompare[];
  overruns: Overrun[];
  rows: DetailRow[];
  /** How many rows the view has — `rows` carries the first MAX_DETAIL_ROWS (or the caller's maxRows). */
  rowsTotal: number;
  totals: DetailTotals;
  options: FilterOptions;
  actions: MaterialAction[];
  summary: CoverageSummary;
  /** Lines on the sheet (after picking one copy per MO) before the filters. */
  sheetLines: number;
}

/** The most detail rows the browser gets; the totals cover them all. */
export const MAX_DETAIL_ROWS = 400;

// ---------------------------------------------------------------- the build

type Acc = { sheets: number; kg: number; unk: number };
const acc = (): Acc => ({ sheets: 0, kg: 0, unk: 0 });
function addTo(a: Acc, sheets: number, each: number | null) {
  a.sheets += sheets;
  if (each === null) a.unk += sheets; else a.kg += sheets * each;
}
const weighed = (a: Acc): Weighed => ({ sheets: r1(a.sheets), kg: Math.round(a.kg), unknownWeightSheets: r1(a.unk) });

const ITEM_BY_PART = new Map(ITEMS.flatMap((i) => (ITEM_PRODUCT[i].partCode ? [[ITEM_PRODUCT[i].partCode!.toUpperCase(), i] as const] : [])));

interface LineCalc {
  l: SheetLine;
  key: string;
  mo: string;
  w: { kg: number | null; source: WeightSource };
  rate: { perUnit: number; source: RateSource };
  bomS: number;
  nest: number | null;
  u: number | null;
}

function calcLine(l: SheetLine, i: number): LineCalc {
  return {
    l,
    key: `${i}`,
    mo: l.closingKey ?? (l.mo.trim() ? moKey(l.mo) : ""),
    w: sheetWeight(l),
    rate: unitRate(l),
    bomS: sheetsForJob(l.sheetsPerUnit, l.units),
    nest: nestedSheets(l),
    u: utilizationFraction(l.utilization),
  };
}

type PerLine = { sheets: number; kg: number | null; scrap: number | null };

/** The value under `k`, made and stored by `init` the first time. */
function getOr<K, V>(m: Map<K, V>, k: K, init: () => V): V {
  let v = m.get(k);
  if (v === undefined) { v = init(); m.set(k, v); }
  return v;
}

/**
 * How a closing's MO finds the sheet — the ODOO tab's own rule (linesOfMo in
 * lib/domain/odooMaterial.ts): the MO itself, else the MO it is a backorder
 * of ("SF01/MO/15337-002" → "SF01/MO/15337"), else a sibling backorder of the
 * same job. A blank MO finds nothing.
 */
function moResolver(sheetMos: Iterable<string>): (mo: string) => string | null {
  const keys = new Set(sheetMos);
  const children = new Map<string, string[]>();
  for (const k of keys) {
    if (isOrderPartKey(k)) continue; // an order × part is itself or nothing
    const parent = moParent(k);
    if (parent !== k) getOr(children, parent, () => []).push(k);
  }
  for (const list of children.values()) list.sort();
  return (mo) => {
    const k = moKey(mo);
    if (!k) return null;
    if (keys.has(k)) return k;
    if (isOrderPartKey(k)) return null;
    const parent = moParent(k);
    if (keys.has(parent)) return parent;
    return children.get(parent)?.[0] ?? null;
  };
}

/** A closing with the sheet MO it books against — "" for a blank MO, null for one the sheet does not carry. */
type Linked = DoneRow & { key: string | null };

/** The closings of a period booked against the (filtered) lines of their MOs. */
function consume(closings: readonly Linked[], byMo: Map<string, LineCalc[]>) {
  const a = acc(), bomRate = acc();
  let closingsN = 0, units = 0, scrap = 0, utilKg = 0;
  const perLine = new Map<LineCalc, PerLine>();
  const perDay = new Map<string, DayPoint>();
  const closedQty = new Map<string, number>();
  for (const d of closings) {
    const list = d.key ? byMo.get(d.key) : undefined;
    if (!list || !(d.qty > 0)) continue;
    // the closing's units once, whatever the number of its MO's lines
    closingsN += 1; units += d.qty;
    closedQty.set(d.key!, (closedQty.get(d.key!) ?? 0) + d.qty);
    const day = getOr(perDay, d.dateISO, () => ({ dateISO: d.dateISO, closings: 0, units: 0, sheets: 0, kg: 0, bomRateKg: 0, unknownWeightSheets: 0 }));
    day.closings += 1; day.units += d.qty;
    for (const c of list) {
      const s = c.rate.perUnit * d.qty;
      addTo(a, s, c.w.kg);
      if (c.rate.source === "bom") addTo(bomRate, s, c.w.kg);
      const kg = c.w.kg === null ? null : s * c.w.kg;
      const p = getOr(perLine, c, () => ({ sheets: 0, kg: c.w.kg === null ? null : 0, scrap: null }));
      p.sheets += s;
      day.sheets += s;
      if (kg === null) { day.unknownWeightSheets += s; continue; }
      p.kg! += kg;
      day.kg += kg;
      if (c.rate.source === "bom") day.bomRateKg += kg;
      if (c.u !== null) { const sc = kg * (1 - c.u); scrap += sc; utilKg += kg; p.scrap = (p.scrap ?? 0) + sc; }
    }
  }
  const figures: ConsumptionFigures = {
    ...weighed(a),
    closings: closingsN, units: r1(units), mos: closedQty.size,
    bomRateSheets: r1(bomRate.sheets), bomRateKg: Math.round(bomRate.kg),
    scrapKg: Math.round(scrap), netKg: Math.round(utilKg - scrap), utilizationKg: Math.round(utilKg),
    days: perDay.size,
  };
  return { figures, perLine, perDay, closedQty };
}

const inRange = (iso: string, from: string | null, to: string) => (from === null || iso >= from) && iso <= to;

/** A share's reading: complete (≥95 %), partial (≥60 %), poor, or nothing to cover. */
export type CoverageTone = "ok" | "warn" | "bad" | "muted";
export const coverageTone = (f: number | null): CoverageTone => (f === null ? "muted" : f >= 0.95 ? "ok" : f >= 0.6 ? "warn" : "bad");

function summarize(link: LinkCoverage, cov: DataCoverage, n: NestingFigures, c: ConsumptionFigures, p: ConsumptionFigures | null): CoverageSummary {
  const linkRows = share(link.linkedRows, link.rows);
  const actualRate = c.sheets > 0 ? 1 - c.bomRateSheets / c.sheets : null;
  const weightKnown = share(cov.weight.sheet + cov.weight.computed, cov.lines);
  const utilKnown = share(n.utilizationKg, n.nested.kg);
  return {
    linkRows, linkQty: share(link.linkedQty, link.qty), actualRate, weightKnown, utilKnown,
    scrapKnown: share(c.utilizationKg, c.kg),
    partial: [linkRows, actualRate, weightKnown, utilKnown].some((f) => f !== null && f < 0.999) || (n.nested.lines > 0 && utilKnown === null),
    consumptionChangePct: changePct(c.kg, p?.kg),
    // a scrap figure needs a known utilization on both sides to be compared
    scrapChangePct: c.utilizationKg > 0 && p && p.utilizationKg > 0 ? changePct(c.scrapKg, p.scrapKg) : null,
  };
}

/**
 * Build the dashboard from the line's material sheet (every month — one copy
 * of each MO is picked here) and its ODOO closings (any MO, blank included,
 * from the previous period's start to the period's end).
 */
export function buildMaterialDashboard(sheet: readonly SheetLine[], done: readonly DoneRow[], req: MaterialRequest, { maxRows = MAX_DETAIL_ROWS }: { maxRows?: number } = {}): MaterialDashboard {
  const { lines: picked, versions } = pickSheetVersions(sheet);
  const options = filterOptions(picked);
  const calcs = picked.map(calcLine);
  const fc = calcs.filter((c) => lineMatches(c.l, req.filters));
  const resolve = moResolver(calcs.filter((c) => c.mo).map((c) => c.mo));

  const byMo = new Map<string, LineCalc[]>();
  for (const c of fc) if (c.mo) getOr(byMo, c.mo, () => []).push(c); // a blank MO on the sheet matches no closing
  const unitsOfMo = new Map<string, number>();
  for (const c of calcs) if (c.mo) unitsOfMo.set(c.mo, Math.max(unitsOfMo.get(c.mo) ?? 0, c.l.units));

  // ---- the period's closings: how they link to the sheet (the line's, before filters) ----
  const linked = (rows: readonly DoneRow[]): Linked[] => rows.map((d) => ({ ...d, key: d.mo.trim() ? resolve(d.mo) : "" }));
  const period = linked(done.filter((d) => inRange(d.dateISO, req.fromISO, req.toISO)));
  const link: LinkCoverage = { rows: 0, qty: 0, blankRows: 0, blankQty: 0, offSheetRows: 0, offSheetQty: 0, linkedRows: 0, linkedQty: 0, overClosedMos: 0, offSheetMos: [] };
  const offSheet = new Map<string, { mo: string; qty: number }>();
  const closedAll = new Map<string, number>();
  for (const d of period) {
    link.rows += 1; link.qty += d.qty;
    if (d.key === "") { link.blankRows += 1; link.blankQty += d.qty; continue; }
    if (d.key === null) {
      link.offSheetRows += 1; link.offSheetQty += d.qty;
      getOr(offSheet, moKey(d.mo), () => ({ mo: d.mo.trim(), qty: 0 })).qty += d.qty;
      continue;
    }
    link.linkedRows += 1; link.linkedQty += d.qty;
    closedAll.set(d.key, (closedAll.get(d.key) ?? 0) + d.qty);
  }
  link.qty = r1(link.qty); link.blankQty = r1(link.blankQty); link.offSheetQty = r1(link.offSheetQty); link.linkedQty = r1(link.linkedQty);
  link.overClosedMos = [...closedAll.entries()].filter(([k, q]) => q > (unitsOfMo.get(k) ?? 0) + 1e-9).length;
  link.offSheetMos = [...offSheet.values()].sort((a, b) => b.qty - a.qty).slice(0, 10).map((o) => ({ mo: o.mo, qty: r1(o.qty) }));

  // ---- consumption in the period, and the period before ----
  const { figures: consumption, perLine, perDay, closedQty } = consume(period, byMo);
  const prevConsumption = req.prev ? consume(linked(done.filter((d) => inRange(d.dateISO, req.prev!.fromISO, req.prev!.toISO))), byMo).figures : null;
  const days = [...perDay.values()].sort((a, b) => a.dateISO.localeCompare(b.dateISO))
    .map((d) => ({ ...d, units: r1(d.units), sheets: r1(d.sheets), kg: Math.round(d.kg), bomRateKg: Math.round(d.bomRateKg), unknownWeightSheets: r1(d.unknownWeightSheets) }));

  // ---- the nesting, Now ----
  const planned = acc(), nested = acc(), vBom = acc();
  let nestedLines = 0, uNum = 0, uDen = 0, nestedKnownKg = 0;
  const plannedMos = new Set<string>(), nestedMos = new Set<string>();
  for (const c of fc) {
    addTo(planned, c.bomS, c.w.kg);
    if (c.mo) plannedMos.add(c.mo);
    if (c.nest === null) continue;
    nestedLines += 1;
    if (c.mo) nestedMos.add(c.mo);
    addTo(nested, c.nest, c.w.kg);
    addTo(vBom, c.bomS, c.w.kg); // the same lines' BOM — the variance compares like with like
    if (c.w.kg !== null) {
      const kg = c.nest * c.w.kg;
      nestedKnownKg += kg;
      if (c.u !== null) { uNum += c.u * kg; uDen += kg; }
    }
  }
  const nScrap = uDen - uNum; // Σ kg × (1 − u)
  const nesting: NestingFigures = {
    planned: { ...weighed(planned), lines: fc.length, mos: plannedMos.size },
    nested: { ...weighed(nested), lines: nestedLines, mos: nestedMos.size },
    variance: { sheets: r1(nested.sheets - vBom.sheets), kg: Math.round(nested.kg - vBom.kg), bomSheets: r1(vBom.sheets), bomKg: Math.round(vBom.kg), lines: nestedLines },
    utilization: uDen > 0 ? uNum / uDen : null,
    utilizationKg: Math.round(uDen),
    scrapKg: Math.round(nScrap),
    netKg: Math.round(uDen - nScrap),
    unknownUtilKg: Math.round(nestedKnownKg - uDen),
  };

  const weight: Record<WeightSource, number> = { sheet: 0, computed: 0, unknown: 0 };
  for (const c of fc) weight[c.w.source] += 1;
  const coverage: DataCoverage = {
    lines: fc.length,
    weight,
    nestedLines,
    utilizationLines: fc.filter((c) => c.nest !== null && c.u !== null).length,
    actualRateLines: fc.filter((c) => c.rate.source === "actual").length,
  };

  // ---- the breakdown by thickness, material or sheet size ----
  const bk = new Map<string, { thicknessMm: number | null; filter: Partial<MaterialFilters> | null; bom: Acc; nested: Acc; consumed: Acc; scrap: number }>();
  for (const c of fc) {
    const t = c.l.thicknessMm, m = c.l.material.trim(), z = c.l.sheetSize.trim();
    const key = req.by === "thickness" ? `${t} mm` : (req.by === "material" ? m : z) || "—";
    const b = getOr(bk, key, () => ({
      thicknessMm: req.by === "thickness" ? t : null,
      // what a click on the group filters to — a blank group is no filter
      filter: req.by === "thickness" ? (t > 0 ? { thicknessMm: t } : null) : req.by === "material" ? (m ? { material: m } : null) : z ? { sheetSize: z } : null,
      bom: acc(), nested: acc(), consumed: acc(), scrap: 0,
    }));
    addTo(b.bom, c.bomS, c.w.kg);
    if (c.nest !== null) addTo(b.nested, c.nest, c.w.kg);
    const p = perLine.get(c);
    if (p) { addTo(b.consumed, p.sheets, c.w.kg); b.scrap += p.scrap ?? 0; }
  }
  const breakdown: Breakdown[] = [...bk.entries()]
    .map(([key, b]) => ({ key, thicknessMm: b.thicknessMm, filter: b.filter, bom: weighed(b.bom), nested: weighed(b.nested), consumed: weighed(b.consumed), scrapKg: Math.round(b.scrap) }))
    .sort((a, b) => (a.thicknessMm !== null && b.thicknessMm !== null ? a.thicknessMm - b.thicknessMm : (req.view === "consumption" ? b.consumed.kg - a.consumed.kg : b.bom.kg - a.bom.kg) || a.key.localeCompare(b.key)));

  // ---- actual vs BOM per part, on the nested lines ----
  const pc = new Map<string, Omit<PartCompare, "bomSheets" | "actualSheets" | "bomKg" | "actualKg"> & { bomAcc: Acc; actAcc: Acc }>();
  for (const c of fc) {
    if (c.nest === null) continue;
    const code = c.l.partCode.trim();
    const p = getOr(pc, up(code) || up(c.l.partName) || "—", () => ({ part: c.l.partName.trim() || code || "—", partCode: code, item: ITEM_BY_PART.get(up(code)) ?? null, lines: 0, bomAcc: acc(), actAcc: acc() }));
    p.lines += 1;
    addTo(p.bomAcc, c.bomS, c.w.kg);
    addTo(p.actAcc, c.nest, c.w.kg);
  }
  const parts: PartCompare[] = [...pc.values()].map(({ bomAcc, actAcc, ...p }) => ({
    ...p, bomSheets: r1(bomAcc.sheets), actualSheets: r1(actAcc.sheets), bomKg: Math.round(bomAcc.kg), actualKg: Math.round(actAcc.kg),
  })).sort((a, b) => b.bomSheets - a.bomSheets);

  // ---- the MOs whose nesting took most over the BOM ----
  const ov = new Map<string, Overrun & { kgKnown: boolean }>();
  for (const c of fc) {
    if (c.nest === null || !c.mo) continue;
    const o = getOr(ov, c.mo, () => ({ mo: c.l.mo.trim(), soi: c.l.soi, part: c.l.partName || c.l.partCode, units: c.l.units, bomSheets: 0, actualSheets: 0, deltaSheets: 0, deltaKg: 0, kgKnown: true }));
    o.bomSheets += c.bomS; o.actualSheets += c.nest;
    if (c.w.kg === null) o.kgKnown = false; else o.deltaKg = (o.deltaKg ?? 0) + (c.nest - c.bomS) * c.w.kg;
  }
  const overruns: Overrun[] = [...ov.values()]
    .map(({ kgKnown, ...o }) => ({ ...o, bomSheets: r1(o.bomSheets), actualSheets: r1(o.actualSheets), deltaSheets: r1(o.actualSheets - o.bomSheets), deltaKg: kgKnown ? Math.round(o.deltaKg ?? 0) : null }))
    .filter((o) => o.deltaSheets > 0)
    .sort((a, b) => (b.deltaKg ?? -1) - (a.deltaKg ?? -1) || b.deltaSheets - a.deltaSheets)
    .slice(0, 10);

  // ---- the detail table: the view's lines ----
  const viewCalcs = req.view === "consumption" ? fc.filter((c) => perLine.has(c)) : fc;
  const allRows: DetailRow[] = viewCalcs.map((c) => {
    const p = perLine.get(c);
    return {
      key: c.key,
      mo: c.l.mo.trim(), soi: c.l.soi, bom: c.l.bom, partCode: c.l.partCode, partName: c.l.partName,
      material: c.l.material, thicknessMm: c.l.thicknessMm, sheetSize: c.l.sheetSize, month: c.l.month,
      units: c.l.units,
      bomSheets: r2(c.bomS),
      actualSheets: c.nest === null ? null : r2(c.nest),
      deltaSheets: c.nest === null ? null : r2(c.nest - c.bomS),
      sheetKg: c.w.kg === null ? null : r2(c.w.kg),
      weightSource: c.w.source,
      utilization: c.u,
      rateSource: c.rate.source,
      ratePerUnit: r2(c.rate.perUnit),
      closedQty: c.mo ? r1(closedQty.get(c.mo) ?? 0) : 0,
      consumedSheets: r2(p?.sheets ?? 0),
      consumedKg: p ? (p.kg === null ? null : Math.round(p.kg)) : (c.w.kg === null ? null : 0),
      scrapKg: p?.scrap == null ? null : Math.round(p.scrap),
    };
  });
  allRows.sort(req.view === "consumption"
    ? (a, b) => (b.consumedKg ?? -1) - (a.consumedKg ?? -1) || b.consumedSheets - a.consumedSheets
    : (a, b) => b.bomSheets * (b.sheetKg ?? 0) - a.bomSheets * (a.sheetKg ?? 0) || b.bomSheets - a.bomSheets);

  const rowMos = new Set(viewCalcs.filter((c) => c.mo).map((c) => c.mo));
  const sum = (f: (c: LineCalc) => number) => viewCalcs.reduce((n, c) => n + f(c), 0);
  const totals: DetailTotals = {
    lines: viewCalcs.length,
    mos: rowMos.size,
    units: r1([...rowMos].reduce((n, k) => n + Math.max(...(byMo.get(k) ?? []).map((c) => c.l.units), 0), 0) + sum((c) => (c.mo ? 0 : c.l.units))),
    bomSheets: r1(sum((c) => c.bomS)),
    actualSheets: r1(sum((c) => c.nest ?? 0)),
    deltaSheets: r1(sum((c) => (c.nest === null ? 0 : c.nest - c.bomS))),
    closedQty: r1([...rowMos].reduce((n, k) => n + (closedQty.get(k) ?? 0), 0)),
    consumedSheets: r1(sum((c) => perLine.get(c)?.sheets ?? 0)),
    consumedKg: Math.round(sum((c) => perLine.get(c)?.kg ?? 0)),
    scrapKg: viewCalcs.some((c) => perLine.get(c)?.scrap != null) ? Math.round(sum((c) => perLine.get(c)?.scrap ?? 0)) : null,
  };

  return {
    nesting, consumption, prevConsumption, link, coverage, versions, days, breakdown, parts, overruns,
    rows: allRows.slice(0, maxRows), rowsTotal: allRows.length, totals, options,
    actions: materialActions(link, coverage, consumption, overruns),
    summary: summarize(link, coverage, nesting, consumption, prevConsumption),
    sheetLines: picked.length,
  };
}

/** What the data asks someone to do, worst first. */
function materialActions(link: LinkCoverage, cov: DataCoverage, c: ConsumptionFigures, overruns: readonly Overrun[]): MaterialAction[] {
  const out: MaterialAction[] = [];
  const n = (v: number) => formatNumber(v, Number.isInteger(v) ? 0 : 1);
  if (link.blankRows > 0) out.push({ tone: "bad", text: `${n(link.blankRows)} closing(s) in the period have no MO (${n(link.blankQty)} units) — type the MO on the ODOO log so their steel can be booked.`, target: { kind: "odoo" } });
  if (link.offSheetRows > 0) out.push({ tone: "warn", text: `${n(link.offSheetRows)} closing(s) name an MO the material sheet does not carry (${n(link.offSheetQty)} units${link.offSheetMos[0] ? `, e.g. ${link.offSheetMos[0].mo}` : ""}) — add its nesting to the sheet.`, target: { kind: "material" } });
  if (cov.weight.unknown > 0) out.push({ tone: "warn", text: `${n(cov.weight.unknown)} sheet line(s) have no weight and no readable size — their tonnes are unknown.`, target: { kind: "material" } });
  if (c.sheets > 0 && c.bomRateSheets > 0) out.push({ tone: "info", text: `${Math.round((c.bomRateSheets / c.sheets) * 100)}% of the consumed sheets are estimated from the BOM — those lines have no actual nesting rate yet.`, target: { kind: "material" } });
  if (cov.nestedLines > cov.utilizationLines) out.push({ tone: "info", text: `${n(cov.nestedLines - cov.utilizationLines)} nested line(s) have no utilization — their scrap is unknown, not zero.`, target: { kind: "material" } });
  if (link.overClosedMos > 0) out.push({ tone: "warn", text: `${n(link.overClosedMos)} MO(s) closed more units in the period than the sheet plans — check the closings or the sheet's units.`, target: { kind: "odoo" } });
  const top = overruns[0];
  if (top) out.push({ tone: "warn", text: `${top.mo} nested ${n(top.deltaSheets)} sheet(s) over its BOM${top.deltaKg !== null ? ` (${signedTonnes(top.deltaKg)} t)` : ""}.`, target: { kind: "filter", key: "mo", value: top.mo } });
  return out;
}

/** The change of a figure against the period before, in whole percent, as
 *  the other dashboards count it — null (N/A) where there is no period
 *  before or it was zero: no base, no change. */
export function changePct(now: number, before: number | null | undefined): number | null {
  return before === null || before === undefined ? null : pctChange(now, before);
}

/** Kilograms as tonnes to two decimals — the one rounding the page, its
 *  tables and the assistant all show. */
export const kgToT = (kg: number) => Math.round(kg / 10) / 100;
/** "12.34" — kilograms written as tonnes. */
export const tonnes = (kg: number) => formatNumber(kgToT(kg), 2);
/** "+0.42" / "-0.18" — a difference in tonnes with its sign. */
export const signedTonnes = (kg: number) => `${kg > 0 ? "+" : ""}${tonnes(kg)}`;

/** A share 0–1, or null where the whole is zero (nothing to cover). */
export const share = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);
