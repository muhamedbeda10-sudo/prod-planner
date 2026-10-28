// MATERIAL — the planner's "Nesting Project Tracker" sheet, month by month.
//
// One line per month × BOM × part × material × thickness × sheet size,
// exactly the sheet's row: Quantity of Units, Part Code and Name, the
// material's code, the sheets ONE unit needs, the sheets nested for one unit
// and the sheets actually nested for the job — every figure AS THE SHEET
// WRITES IT, to its four decimals, in the sheet's own row order. The planner
// asked for the sheet back the way it is; the tab's arithmetic is confined to
// the two formula columns, which it recomputes from what it stores so they
// cannot come back as #VALUE!:
//   sheets for the job = sheets per unit × quantity of units
//   difference         = sheets for the job − sheets actually nested
//
// The panels' tab also costs the units produced so far (the sheet's count,
// else the panels painted on the tracker):
//   actual per unit      = sheets actually nested / quantity of units
//   sheets for produced  = actual per unit × units produced
// "The sheet says 50 sheets made 30 units; 5 were made — so 8.333 were used."

import { monthInputFromLabel, monthLabelSortKey } from "./dates";

/** Sheet counts are fractions of a sheet (0.429 of a sheet per unit). Excel
 *  left 0.564 × 3 as 1.6919999999999997; the nesting sheet quotes its figures
 *  to FOUR decimals (0.6216 a unit, 1.8648 for the job), so that is the
 *  precision everything here keeps — a third decimal would round the
 *  planner's own numbers away. */
export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
/** Three decimals — the Odoo material popup's coarser figures. */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export const MATERIAL_PRESETS = ["Steel", "Stainless steel", "Galvanized steel", "Aluminium", "Copper"] as const;

/** The parts the sheet nests for, by Odoo's part code — a typing aid that
 *  fills the part name; anything else typed is kept. */
export const PART_PRESETS: { code: string; name: string }[] = [
  { code: "FB-022", name: "TANK" },
  { code: "FB-024", name: "CABLE BOX" },
  { code: "FB-027", name: "ARRESTER" },
  { code: "FB-051", name: "TOP COVER" },
  { code: "FB-058", name: "CORE FRAME" },
  { code: "FB-059", name: "ENCLOSER" },
];

export function partNameFor(code: string): string {
  return PART_PRESETS.find((p) => p.code === code.trim().toUpperCase())?.name ?? "";
}
export const SHEET_SIZE_PRESETS = ["1220*2440", "1250*2500", "1500*3000", "2000*6000"] as const;

// The tracker was filled in by hand for years — "Stainless steal", "S.S", "ms"
// and "Steel " are all the same steel. Folding them here is what makes the
// per-material totals add up.
const MATERIAL_ALIASES: Record<string, string> = {
  steel: "Steel", ms: "Steel", "m.s": "Steel", "mild steel": "Steel", "carbon steel": "Steel", "black steel": "Steel",
  ss: "Stainless steel", "s.s": "Stainless steel", inox: "Stainless steel", stainless: "Stainless steel",
  "stainless steal": "Stainless steel", "stainless steel": "Stainless steel",
  gi: "Galvanized steel", galvanized: "Galvanized steel", galvanised: "Galvanized steel",
  "galvanized steel": "Galvanized steel", "galvanised steel": "Galvanized steel",
  alu: "Aluminium", aluminum: "Aluminium", aluminium: "Aluminium",
  copper: "Copper", cu: "Copper",
  // the panels' sheet writes it "GI Sheet"
  "gi sheet": "Galvanized steel", "g.i sheet": "Galvanized steel", "g.i": "Galvanized steel",
};

/** Canonical material name: known aliases fold together, anything else is
 *  kept as typed (whitespace collapsed, first letter capitalized). */
export function normalizeMaterialType(raw: unknown): string {
  const clean = String(raw ?? "").replace(/[\r\n]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const alias = MATERIAL_ALIASES[clean.toLowerCase().replace(/\.$/, "")];
  if (alias) return alias;
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** Canonical sheet size "1220*2440". Accepts 1220x2440, 1220 × 2440,
 *  "1220*2440 mm" — the spellings the sheet already contains. */
export function normalizeSheetSize(raw: unknown): string {
  const clean = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const nums = clean.match(/\d+(?:\.\d+)?/g);
  if (nums && nums.length >= 2) {
    const [a, b] = nums.map((n) => String(Number(n)));
    return `${a}*${b}`;
  }
  return clean;
}

/** A number as the sheet or the shop floor writes it. Blanks, text and
 *  Excel's #VALUE! come back null — never NaN, never 0. */
export function parseSheetNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const clean = String(raw).replace(/,/g, "").trim();
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

/** parseSheetNumber, but a figure with a note beside it ("60 (urgent)") still
 *  reads as the number it starts with (comma-stripped parseFloat); anything
 *  else — blank, text, #VALUE! — is `fallback`. */
export function sheetNumberOr(v: unknown, fallback = 0): number {
  const n = parseSheetNumber(v);
  if (n !== null) return n;
  const lead = parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(lead) ? lead : fallback;
}

// ---- the sheet's formula columns ----

/** Sheets the nesting BOM says the whole job needs. */
export function sheetsForJob(sheetsPerUnit: number, units: number): number {
  return round4(sheetsPerUnit * units);
}

/** Sheets for the job − actually nested. Null while nothing has been nested:
 *  a blank actual is "not laid out", which is not "used zero sheets". */
export function sheetsDifference(forJob: number, used: number | null): number | null {
  if (used === null) return null;
  return round4(forJob - used);
}

// ---- the tab's addition: what the produced units really consumed ----

/**
 * Sheets actually nested for ONE unit.
 *
 * The sheet states this outright, and where it did the stored figure IS the
 * sheet's — it is passed straight back. Dividing the job's sheets by the units
 * to recover it was a round trip through a rounded product: what the tab
 * showed was never quite what the sheet said, and a line with no units lost
 * the rate entirely.
 *
 * The division survives only as the fallback for a line that has no rate of
 * its own — one typed by hand, or imported before the column was kept.
 */
export function actualPerUnit(stored: number | null, used: number | null, units: number): number | null {
  if (stored !== null && stored >= 0) return stored;
  if (used === null || !(units > 0)) return null;
  return used / units;
}

/** Sheets the produced units really consumed, at that rate. 1.667 a unit with
 *  5 produced → 8.333. */
export function sheetsForProduced(stored: number | null, used: number | null, units: number, produced: number | null): number | null {
  const rate = actualPerUnit(stored, used, units);
  if (rate === null || produced === null) return null;
  return round4(rate * produced);
}

// ---- a line, as the page shows it ----

export interface MaterialLineInput {
  month: string; // plan month label ("July 2026"); "" = untagged
  bom: string;
  mo: string; // "" = the line covers every order on this BOM
  units: number; // Quantity of Units
  partCode: string; // FB-022 — "" when the line predates the column
  partName: string; // TANK
  materialCode: string; // the sheet's "Codes": T-SSS-5MM
  material: string;
  thicknessMm: number;
  sheetSize: string;
  sheetsPerUnit: number; // No. of Sheets in BOM for one Unit
  /** "Actual Nesting for one Unit", exactly as the sheet writes it. */
  actualPerUnit: number | null;
  sheetsUsed: number | null; // No. of Sheets in Actual Nesting for Job
  producedQty: number | null; // units produced so far
  note: string | null;
  /** The newer sheet's SOI column — "" on a line without one. */
  soi: string;
  /** The newest sheet's "MTR Request #" — the material request the sheets
   *  were drawn on; "" on a line without one. */
  mtr: string;
  weightKg: number | null; // Weight(Kg) — one sheet's
  utilization: number | null; // Average Utilization, as the sheet writes it
}

export interface MaterialLineView extends MaterialLineInput {
  id: number;
  /** Units the tracker says were produced on this line's order (the panels'
   *  painted count) — what the tab costs when nothing was typed. Null on a
   *  line with no order of its own. */
  producedAuto: number | null;
  /** The quantity the costing uses: typed if typed, else the tracker's. */
  producedUsed: number | null;
  /** Units still to make: the job less what was produced. */
  remainingUnits: number | null;
  forJob: number; // sheets for the job
  /** Actual Weight (Kg): the pieces nested for the job × one sheet's weight. */
  actualWeightKg: number | null;
  difference: number | null; // forJob − sheetsUsed
  forProduced: number | null; // actualPerUnit × producedQty
  updatedISO: string;
  recordedBy: string | null;
  /** The monthly plans the line's order was in, newest first (materialPlanMonths). */
  planMonths: string[];
  /** What tied the line to its plan: its own MO, its SOI, or its BOM; null when nothing did. */
  planMatch: MaterialPlanMatch | null;
  /** The orders (their MOs) this line's part MO was closed against on the
   *  ODOO log — the closing row born of an order's daily-log closing carries
   *  the part's own MO the clerk typed. Empty while the part is not closed
   *  there, or on a row typed without a closing behind it. */
  orderMos: string[];
}

/** The identity of a line — one per month × BOM × order × part × material ×
 *  thickness × size. Re-importing a month's sheet edits its lines. */
export function materialKey(l: Pick<MaterialLineInput, "month" | "bom" | "mo" | "partCode" | "material" | "thicknessMm" | "sheetSize">): string {
  return [l.month, l.bom, l.mo, l.partCode, l.material, l.thicknessMm, l.sheetSize].join("|");
}

// ---- import: the planner's "Nesting Tracker" sheet ----

export interface NestingRow {
  rowNum: number; // 1-based sheet row, for the issues list
  bom: string;
  /** Odoo's MO for this part (SF01/MO/20941) when the sheet has an MO column;
   *  "" when the line covers the BOM, as the older sheet wrote it. */
  mo: string;
  units: number;
  partCode: string;
  partName: string;
  materialCode: string;
  material: string;
  thicknessMm: number;
  sheetSize: string;
  sheetsPerUnit: number;
  /** Sheets actually nested for ONE unit — the sheet's own measured rate. */
  actualPerUnit: number | null;
  /** Sheets actually nested for the JOB, as the sheet's own column writes it;
   *  the rate above × the units only where that column is blank. */
  sheetsUsed: number | null;
  note: string | null;
  soi: string;
  mtr: string;
  weightKg: number | null;
  utilization: number | null;
}

export interface ParsedNesting {
  rows: NestingRow[];
  issues: string[];
  headerRow: number; // 1-based, for diagnostics
  /** Rows whose "for Job" column disagrees with their own per-unit rate by
   *  more than rounding — kept as written, counted so the planner can look. */
  recomputed: number;
  /** Data rows the parser could not read and left out (each also named in
   *  `issues`) — they ARE in the file, so the import must not prune. */
  skipped: number;
}

// Columns are found BY HEADER TEXT, so the planner may reorder or add columns
// without breaking the import. Each entry lists the distinguishing fragments,
// and a column is claimed once — so the ACTUAL rate ("…in Actual Nesting for
// one Unit") is matched BEFORE the BOM's "…for one Unit", and neither can
// steal the other's column whatever else the header says.
const HEADERS = {
  bom: ["bom ref", "bom"],
  units: ["quantity of units", "qty of units", "units"],
  partCode: ["part code"],
  partName: ["part name"],
  code: ["codes", "code"],
  material: ["material type", "material"],
  thickness: ["thickness"],
  size: ["sheet size", "size"],
  actualPerUnit: ["actual nesting for one unit", "actual for one unit", "actual nesting for unit", "actual per unit"],
  perUnit: ["bom for one unit", "one unit", "per unit"],
  actual: ["actual nesting for job", "actual for job", "actual nesting", "actual"],
  note: ["notes", "note", "remark"],
  // the newer sheet's — matched last, so none of them steals a column above
  // ("Weight(Kg)" is one sheet's; "Actual Weight (Kg)" is worked out)
  weight: ["weight"],
  utilization: ["utilization", "utilisation"],
} as const;

const OPTIONAL_HEADERS: ReadonlySet<string> = new Set(["note", "actual", "actualPerUnit", "partCode", "partName", "code", "weight", "utilization"]);

function cellText(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function findHeaderRow(grid: unknown[][]): number {
  for (let r = 0; r < Math.min(grid.length, 30); r++) {
    const cells = (grid[r] ?? []).map((c) => cellText(c).toLowerCase());
    if (cells.some((c) => c.includes("bom")) && cells.some((c) => c.includes("thickness"))) return r;
  }
  return -1;
}

function mapColumns(header: unknown[]): Record<keyof typeof HEADERS, number> {
  const cells = header.map((c) => cellText(c).toLowerCase());
  const out = {} as Record<keyof typeof HEADERS, number>;
  for (const key of Object.keys(HEADERS) as (keyof typeof HEADERS)[]) {
    out[key] = -1;
    for (const frag of HEADERS[key]) {
      const i = cells.findIndex((c, idx) => c.includes(frag) && !Object.values(out).includes(idx));
      if (i >= 0) { out[key] = i; break; }
    }
  }
  return out;
}

/** The job column and the rate × units only count as disagreeing when the
 *  gap is bigger than the rounding the sheet itself carries (the rate is
 *  quoted to four decimals, so a long job drifts a little by arithmetic). */
const STALE_ABS = 0.05;
const STALE_FRAC = 0.02;

/**
 * Parse the Nesting Tracker grid (sheet_to_json with header:1).
 *
 * Every figure is taken as the sheet writes it. The sheets actually nested
 * FOR THE JOB are the sheet's own column; the rate × units stands in only
 * where that column is blank. A row whose column disagrees with its own rate
 * by more than rounding is counted (`recomputed`) so the planner can look,
 * never overwritten — the sheet is his, and he asked for it back as it is.
 * The BOM's "for Job" and "Difference" columns are recomputed from what is
 * stored (per unit × units, and the difference), which on a fresh sheet is
 * the same figure without the #VALUE! risk. A row that repeats another's
 * identity (BOM, part, material, thickness, size) is reported: the tab keeps
 * one line per identity, so the later row replaces the earlier.
 */
export function parseNestingTracker(grid: unknown[][]): ParsedNesting {
  const headerIdx = findHeaderRow(grid);
  if (headerIdx < 0) {
    return { rows: [], issues: ["No header row found — expected a row with 'BOM Ref' and 'Thickness'."], headerRow: 0, recomputed: 0, skipped: 0 };
  }
  const col = mapColumns(grid[headerIdx] ?? []);
  // the newer sheet carries Odoo's MO per part: a column headed exactly "MO"
  // (a fragment match would catch other headers), found apart from the rest
  const moCol = (grid[headerIdx] ?? []).findIndex((c) => /^mo\s*(#|no\.?)?$/i.test(cellText(c)));
  const soiCol = (grid[headerIdx] ?? []).findIndex((c) => /^soi\s*#?$/i.test(cellText(c)));
  // "MTR Request #" — the newest sheet's first column; none of the fragments
  // above can claim it
  const mtrCol = (grid[headerIdx] ?? []).findIndex((c) => /^mtr\b/i.test(cellText(c)));
  const issues: string[] = [];
  for (const [key, idx] of Object.entries(col)) {
    if (idx < 0 && !OPTIONAL_HEADERS.has(key)) issues.push(`Column "${key}" was not found in the header row.`);
  }
  if (issues.length > 0) return { rows: [], issues, headerRow: headerIdx + 1, recomputed: 0, skipped: 0 };

  const rows: NestingRow[] = [];
  let recomputed = 0;
  let skipped = 0;
  const seen = new Map<string, number>(); // identity → sheet row
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const line = grid[r] ?? [];
    const rowNum = r + 1;
    const bom = cellText(line[col.bom]).toUpperCase();
    if (!bom) continue; // the tracker's blank template rows carry formulas only
    const material = normalizeMaterialType(line[col.material]);
    const thickness = parseSheetNumber(line[col.thickness]);
    const sheetSize = normalizeSheetSize(line[col.size]);
    const perUnit = parseSheetNumber(line[col.perUnit]);
    const units = parseSheetNumber(line[col.units]);

    if (!material) { issues.push(`Row ${rowNum} (${bom}): no material type — skipped.`); skipped++; continue; }
    if (thickness === null || thickness <= 0) { issues.push(`Row ${rowNum} (${bom}): thickness is missing or not a number — skipped.`); skipped++; continue; }
    if (!sheetSize) { issues.push(`Row ${rowNum} (${bom}): no sheet size — skipped.`); skipped++; continue; }
    if (perUnit === null || perUnit < 0) { issues.push(`Row ${rowNum} (${bom}): sheets per unit is missing or not a number — skipped.`); skipped++; continue; }
    if (units === null || units < 0) { issues.push(`Row ${rowNum} (${bom}): quantity of units is missing or not a number — skipped.`); skipped++; continue; }

    // what the sheet says the job used, and what it measured for ONE unit —
    // both as written; the product stands in only for a blank job column
    const onSheet = col.actual >= 0 ? parseSheetNumber(line[col.actual]) : null;
    const rateRaw = col.actualPerUnit >= 0 ? parseSheetNumber(line[col.actualPerUnit]) : null;
    const rate = rateRaw !== null && rateRaw >= 0 ? round4(rateRaw) : null;
    const fromSheet = onSheet !== null && onSheet >= 0 ? round4(onSheet) : null;
    const used = fromSheet ?? (rate !== null ? round4(rate * units) : null);
    if (fromSheet !== null && rate !== null) {
      const product = rate * units;
      const gap = Math.abs(product - fromSheet);
      if (gap > STALE_ABS && gap > STALE_FRAC * Math.max(product, fromSheet)) recomputed += 1;
    }

    const note = col.note >= 0 ? cellText(line[col.note]) : "";
    const partCode = col.partCode >= 0 ? cellText(line[col.partCode]).toUpperCase() : "";
    const partName = col.partName >= 0 ? cellText(line[col.partName]).toUpperCase() : "";
    const mo = moCol >= 0 ? cellText(line[moCol]).toUpperCase() : "";
    const identity = `${bom}|${mo}|${partCode}|${material}|${thickness}|${sheetSize}`;
    const earlier = seen.get(identity);
    if (earlier !== undefined) issues.push(`Row ${rowNum} (${mo ? `${mo} ` : ""}${bom} ${partCode} ${material} ${thickness}mm ${sheetSize}) repeats row ${earlier} — the tab keeps one line per ${mo ? "MO, " : ""}BOM, part, material, thickness and size, so this row replaces it.`);
    seen.set(identity, rowNum);
    rows.push({
      rowNum, bom, mo, units, material, thicknessMm: thickness, sheetSize,
      partCode, partName: partName || partNameFor(partCode),
      materialCode: col.code >= 0 ? cellText(line[col.code]).toUpperCase() : "",
      sheetsPerUnit: perUnit,
      actualPerUnit: rate,
      sheetsUsed: used,
      note: note || null,
      soi: soiCol >= 0 ? cellText(line[soiCol]).toUpperCase() : "",
      mtr: mtrCol >= 0 ? cellText(line[mtrCol]).toUpperCase() : "",
      weightKg: col.weight >= 0 ? parseSheetNumber(line[col.weight]) : null,
      utilization: col.utilization >= 0 ? parseSheetNumber(line[col.utilization]) : null,
    });
  }
  if (rows.length === 0) issues.push("No material rows found under the header.");
  return { rows, issues, headerRow: headerIdx + 1, recomputed, skipped };
}

// ---- filters: narrowing the month's lines on the page ----

export const MATERIAL_STATUS_FILTERS = {
  all: "All lines",
  nested: "Nested",
  notNested: "Not nested yet",
  produced: "With produced",
  over: "Over BOM",
  within: "Within BOM",
} as const;
export type MaterialStatusFilter = keyof typeof MATERIAL_STATUS_FILTERS;

export interface MaterialFilters {
  /** Matches BOM, SOI, part code, part name, material code or note — case-insensitive, any part. */
  q: string;
  partCode: string; // "" = any
  material: string; // "" = any
  thicknessMm: string; // "" = any; the number as text, as the select carries it
  sheetSize: string; // "" = any
  status: MaterialStatusFilter;
  /** A monthly plan's label ("October 2026"); NO_PLAN_MONTH for the lines no plan carries; "" = any. */
  planMonth: string;
}

export const EMPTY_MATERIAL_FILTERS: MaterialFilters = { q: "", partCode: "", material: "", thicknessMm: "", sheetSize: "", status: "all", planMonth: "" };

export function filterMaterialLines(lines: MaterialLineView[], f: MaterialFilters): MaterialLineView[] {
  const q = f.q.trim().toLowerCase();
  return lines.filter((l) => {
    if (f.partCode && l.partCode !== f.partCode) return false;
    if (f.material && l.material !== f.material) return false;
    if (f.thicknessMm && String(l.thicknessMm) !== f.thicknessMm) return false;
    if (f.sheetSize && l.sheetSize !== f.sheetSize) return false;
    if (f.planMonth && !(f.planMonth === NO_PLAN_MONTH ? l.planMonths.length === 0 : l.planMonths.includes(f.planMonth))) return false;
    switch (f.status) {
      case "nested": if (l.sheetsUsed === null) return false; break;
      case "notNested": if (l.sheetsUsed !== null) return false; break;
      case "produced": if (l.producedUsed === null) return false; break;
      case "over": if (l.difference === null || l.difference >= 0) return false; break;
      case "within": if (l.difference === null || l.difference < 0) return false; break;
    }
    if (q) {
      const hay = [l.bom, l.soi ?? "", l.mtr ?? "", l.partCode, l.partName, l.materialCode, l.note ?? "", l.mo, ...l.orderMos].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ---- the monthly plan a line belongs to ----

/** The filter value for the lines no monthly plan carries — the tracker's own "No month" mark. */
export const NO_PLAN_MONTH = "—";

export type MaterialPlanMatch = "mo" | "odoo" | "soiBom" | "soi" | "bom";

/** An order of the registry as the plan filter reads it: its keys and the monthly plans it was in. */
export interface MaterialPlanOrder {
  mo: string;
  soi: string | null;
  bom: string;
  /** Every monthly plan the order appeared in (MasterOrder.months, else its source). */
  months: string[];
}

export interface MaterialPlanIndex {
  byMo: Map<string, string[]>;
  /** By SOI and BOM together ("SOI|BOM") — the order of one sales item on one code. */
  bySoiBom: Map<string, string[]>;
  bySoi: Map<string, string[]>;
  byBom: Map<string, string[]>;
}

const planKey = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();

/** The registry's orders by MO, by SOI and by BOM — each key with the union
 *  of its orders' months. */
export function materialPlanIndex(orders: readonly MaterialPlanOrder[]): MaterialPlanIndex {
  const idx: MaterialPlanIndex = { byMo: new Map(), bySoiBom: new Map(), bySoi: new Map(), byBom: new Map() };
  const add = (m: Map<string, string[]>, k: string, months: string[]) => {
    if (!k || months.length === 0) return;
    const cur = m.get(k);
    if (!cur) { m.set(k, [...months]); return; }
    for (const x of months) if (!cur.includes(x)) cur.push(x);
  };
  for (const o of orders) {
    const months = o.months.map((x) => x.trim()).filter(Boolean);
    add(idx.byMo, planKey(o.mo), months);
    if (planKey(o.soi) && planKey(o.bom)) add(idx.bySoiBom, `${planKey(o.soi)}|${planKey(o.bom)}`, months);
    add(idx.bySoi, planKey(o.soi), months);
    add(idx.byBom, planKey(o.bom), months);
  }
  // each key's months sorted once, newest first — every line of it reads the same array
  for (const m of [idx.byMo, idx.bySoiBom, idx.bySoi, idx.byBom]) for (const [k, v] of m) m.set(k, sortPlanMonths(v));
  return idx;
}

/** Newest month first; labels that are not months last, in their own order. */
export function sortPlanMonths(months: Iterable<string>): string[] {
  return [...months].sort((a, b) => monthLabelSortKey(b) - monthLabelSortKey(a) || a.localeCompare(b));
}

/**
 * The monthly plans a line of the sheet belongs to, by the surest key it
 * shares with the registry: its own MO (the panels' sheet files each order's
 * MO; a transformer line carries its PART's MO from Odoo, which no plan
 * lists), else the orders that part MO was closed against on the ODOO log
 * (`orderMos` — exact), else its SOI and BOM together — one sales item is planned month
 * after month, each month on its own code — else its SOI alone (a part filed
 * under a sub-assembly or an older revision of the code). Only a line with
 * neither MO nor SOI — one that covers its BOM as a whole — goes by its BOM.
 * A line whose MO or SOI finds no order is in no plan: a mistyped key is
 * shown, never guessed at through its BOM.
 *
 * `doneISO`, the day the line's MO was closed Done on the ODOO log, takes the
 * line out of every plan month that began after it: a sales item carried into
 * a new month brings its balance there, not the nesting it already finished.
 * A line closed before all of its months keeps the earliest — its nesting
 * predates the plans on record.
 */
export function materialPlanMonths(
  l: Pick<MaterialLineInput, "mo" | "soi" | "bom">, idx: MaterialPlanIndex, doneISO: string | null = null, orderMos: readonly string[] = [],
): { months: string[]; match: MaterialPlanMatch | null } {
  const found = planMonthsByKey(l, idx, orderMos);
  if (!doneISO || found.months.length === 0) return found;
  const doneMonth = doneISO.slice(0, 7);
  const dated = found.months.filter((m) => monthInputFromLabel(m) !== null);
  // a month that began after the close loses the line; a label that is no month stays
  const kept = dated.filter((m) => monthInputFromLabel(m)! <= doneMonth);
  const months = kept.length > 0 ? kept : dated.slice(-1); // newest first: the last is the earliest
  return { ...found, months: [...months, ...found.months.filter((m) => !dated.includes(m))] };
}

function planMonthsByKey(l: Pick<MaterialLineInput, "mo" | "soi" | "bom">, idx: MaterialPlanIndex, orderMos: readonly string[]): { months: string[]; match: MaterialPlanMatch | null } {
  const byMo = idx.byMo.get(planKey(l.mo));
  if (byMo) return { months: byMo, match: "mo" };
  // the part's MO closed against an order on the ODOO log: that order's months, exactly
  const byOdoo = orderMos.flatMap((m) => idx.byMo.get(planKey(m)) ?? []);
  if (byOdoo.length > 0) return { months: sortPlanMonths(new Set(byOdoo)), match: "odoo" };
  const soi = planKey(l.soi);
  const bySoiBom = soi && planKey(l.bom) ? idx.bySoiBom.get(`${soi}|${planKey(l.bom)}`) : undefined;
  if (bySoiBom) return { months: bySoiBom, match: "soiBom" };
  const bySoi = idx.bySoi.get(soi);
  if (bySoi) return { months: bySoi, match: "soi" };
  const own = !!planKey(l.mo) || !!soi;
  const byBom = own ? undefined : idx.byBom.get(planKey(l.bom));
  return byBom ? { months: byBom, match: "bom" } : { months: [], match: null };
}

/**
 * Whether a line of the sheet belongs to an order's (or a code's) trace.
 * A line whose part MO was closed against an order on the ODOO log belongs
 * to that order, exactly, and to no other. Otherwise —
 * a code's: every line on the code, whatever its order. An order's: the
 * lines on its MO (the panels file each order's MO), on its code under its
 * SOI, or on its code with neither MO nor SOI (a line covering the code as a
 * whole). Either way, under one of its SOIs, a line on a code no order of
 * that SOI carries (a sub-assembly, an older revision of the code) — the
 * keys materialPlanMonths ties a line to its plan by. A line of the same SOI
 * on ANOTHER order's code — or on another order's MO — is that order's, not
 * this one's.
 */
export function traceMaterialMatch(t: {
  scope: "mo" | "bom";
  mos: readonly string[]; sois: readonly string[]; bom: string;
  /** Every order of the SOIs in scope: its MO, SOI and code. */
  soiOrders: readonly { mo: string; soi: string; bom: string }[];
}): (l: Pick<MaterialLineView, "mo" | "soi" | "bom" | "orderMos">) => boolean {
  const mos = new Set(t.mos.map(planKey));
  const sois = new Set(t.sois.map(planKey));
  const bom = planKey(t.bom);
  const carried = new Set(t.soiOrders.map((o) => `${planKey(o.soi)}|${planKey(o.bom)}`));
  // the SOIs' other orders: a line filed on one of their MOs is theirs
  const others = new Set(t.soiOrders.map((o) => planKey(o.mo)).filter((m) => m && !mos.has(m)));
  return (l) => {
    const mo = planKey(l.mo), soi = planKey(l.soi), lb = planKey(l.bom);
    if (mo && mos.has(mo)) return true;
    const onCode = !!bom && lb === bom;
    // closed on the ODOO log against an order: exactly that order's — on a
    // code's trace, also a line on the code closed against an order the
    // registry does not list as one of the SOIs' others
    if (l.orderMos.length > 0) {
      return l.orderMos.some((m) => mos.has(planKey(m)))
        || (t.scope === "bom" && onCode && !l.orderMos.some((m) => others.has(planKey(m))));
    }
    if (t.scope === "mo" && others.has(mo)) return false;
    if (soi && sois.has(soi) && (onCode || !carried.has(`${soi}|${lb}`))) return true;
    return onCode && (t.scope === "bom" || (!soi && !mo));
  };
}

/** A plan month as asked (the assistant, a typed value): the lines' own
 *  label whatever its case, NO_PLAN_MONTH for "none" (or the mark itself), ""
 *  for nothing asked — and null for a month no line carries. */
export function resolvePlanMonth(asked: string, options: readonly string[]): string | null {
  const a = asked.trim();
  if (!a) return "";
  if (a.toLowerCase() === "none" || a === NO_PLAN_MONTH) return NO_PLAN_MONTH;
  return options.find((m) => m.toLowerCase() === a.toLowerCase()) ?? null;
}

/** The plan months the lines carry, newest first — the filter's options. */
export function materialPlanMonthOptions(lines: readonly Pick<MaterialLineView, "planMonths">[]): string[] {
  return sortPlanMonths(new Set(lines.flatMap((l) => l.planMonths)));
}

// ---- what the lines shown add up to: the strip above the table ----

export interface MaterialSummary {
  lines: number;
  /** Distinct orders: by SOI where the line has one (as the SOI groups write it), else its MO, else its BOM. */
  orders: number;
  forJob: number;
  /** Sums over the lines that carry the figure; null when none does. */
  sheetsUsed: number | null;
  actualWeightKg: number | null;
  difference: number | null;
  /** Lines that ate more than their BOM allows (difference below zero). */
  overLines: number;
  /** The panels' figures: units planned, sheets the produced units consumed, units still to make. */
  units: number;
  forProduced: number | null;
  remainingUnits: number | null;
}

/** The sheets a panel line's produced units consumed, as its Consumed column
 *  shows it: the line's own costing, else the BOM's rate × units produced;
 *  null while nothing is produced. */
export function sheetsConsumed(l: Pick<MaterialLineView, "forProduced" | "producedUsed" | "sheetsPerUnit">): number | null {
  if (l.forProduced !== null) return l.forProduced;
  return l.producedUsed === null ? null : round4(l.sheetsPerUnit * l.producedUsed);
}

export function materialSummary(lines: readonly MaterialLineView[]): MaterialSummary {
  const orders = new Set(lines.map((l) => l.soi.trim() || l.mo.trim() || l.bom.trim()).filter(Boolean));
  return {
    lines: lines.length,
    orders: orders.size,
    forJob: round4(lines.reduce((a, l) => a + l.forJob, 0)),
    sheetsUsed: sumOf(lines.map((l) => l.sheetsUsed)),
    actualWeightKg: sumOf(lines.map((l) => l.actualWeightKg)),
    difference: sumOf(lines.map((l) => l.difference)),
    overLines: lines.filter((l) => l.difference !== null && l.difference < 0).length,
    units: round4(lines.reduce((a, l) => a + l.units, 0)),
    forProduced: sumOf(lines.map(sheetsConsumed)),
    remainingUnits: sumOf(lines.map((l) => l.remainingUnits)),
  };
}

// ---- the table grouped by SOI, the MOs under it ----

export interface MaterialSoiGroup {
  /** The SOI as the lines write it; "" for lines without one. */
  soi: string;
  lines: MaterialLineView[];
  /** The MOs under the SOI, in the order they first appear. */
  mos: string[];
  forJob: number;
  /** Sums over the lines that carry the figure; null when none does. */
  sheetsUsed: number | null;
  actualWeightKg: number | null;
  difference: number | null;
}

const sumOf = (xs: (number | null)[]): number | null => {
  const ns = xs.filter((x): x is number => x !== null);
  return ns.length ? Number(ns.reduce((a, b) => a + b, 0).toFixed(4)) : null;
};

/** Lines by SOI — groups in the order their first line appears, and inside a
 *  group the lines of one MO together, MOs in the order they first appear.
 *  Nothing is added or dropped: every line lands in exactly one group. */
export function groupMaterialBySoi(lines: MaterialLineView[]): MaterialSoiGroup[] {
  const bySoi = new Map<string, MaterialLineView[]>();
  for (const l of lines) {
    const k = l.soi.trim();
    const g = bySoi.get(k);
    if (g) g.push(l); else bySoi.set(k, [l]);
  }
  return [...bySoi.entries()].map(([soi, ls]) => {
    const mos = [...new Set(ls.map((l) => l.mo.trim()))];
    const ordered = mos.flatMap((mo) => ls.filter((l) => l.mo.trim() === mo));
    return {
      soi,
      lines: ordered,
      mos: mos.filter(Boolean),
      forJob: Number(ordered.reduce((a, l) => a + l.forJob, 0).toFixed(4)),
      sheetsUsed: sumOf(ordered.map((l) => l.sheetsUsed)),
      actualWeightKg: sumOf(ordered.map((l) => l.actualWeightKg)),
      difference: sumOf(ordered.map((l) => l.difference)),
    };
  });
}
