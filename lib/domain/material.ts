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
// The tab adds one typed number, producedQty — how many units were actually
// made so far — and derives from it the answer the planner asked for:
//   actual per unit      = sheets actually nested / quantity of units
//   sheets for produced  = actual per unit × units produced
// "The sheet says 50 sheets made 30 units; I made 5 — so I used 8.333."

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

/**
 * Is the line's rate the planner's OWN after an edit that sets it to `typed`?
 *
 * The nesting sheet does not carry a rate for every line — most of them show a
 * dash — so the tab lets him type one. What he types has to outrank the sheet:
 * a re-import must fill the blanks and leave his figures standing.
 *
 * Clearing the box hands the line back to the sheet. Typing a different figure
 * makes it his. Saving the line without touching the box leaves it as it was,
 * so re-saving an imported line does not quietly claim it.
 */
export function rateIsTyped(was: { actualPerUnit: number | null; actualPerUnitManual: boolean }, typed: number | null): boolean {
  if (typed === null) return false;
  return was.actualPerUnitManual || typed !== was.actualPerUnit;
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
  /** The rate was typed in the tab, not read off the sheet — a re-import
   *  leaves it alone. */
  actualPerUnitManual: boolean;
  soi: string | null; // the BOM's orders' SOIs, joined
  forJob: number; // sheets for the job
  difference: number | null; // forJob − sheetsUsed
  forProduced: number | null; // actualPerUnit × producedQty
  updatedISO: string;
  recordedBy: string | null;
}

/** The identity of a line — one per month × BOM × order × part × material ×
 *  thickness × size. Re-importing a month's sheet edits its lines. */
export function materialKey(l: Pick<MaterialLineInput, "month" | "bom" | "mo" | "partCode" | "material" | "thicknessMm" | "sheetSize">): string {
  return [l.month, l.bom, l.mo, l.partCode, l.material, l.thicknessMm, l.sheetSize].join("|");
}

// ---- totals per material, thickness and size ----

export interface MaterialTotal {
  material: string;
  thicknessMm: number;
  sheetSize: string;
  forJob: number; // sheets the BOMs call for
  used: number; // sheets actually nested, over the lines that were
  forProduced: number; // sheets the produced units really consumed
  /** Lines not nested yet — `used` and `forProduced` are silent about these. */
  linesNotNested: number;
}

export function summarizeMaterial(lines: MaterialLineView[]): MaterialTotal[] {
  const map = new Map<string, MaterialTotal>();
  for (const l of lines) {
    const key = `${l.material}|${l.thicknessMm}|${l.sheetSize}`;
    let t = map.get(key);
    if (!t) {
      t = { material: l.material, thicknessMm: l.thicknessMm, sheetSize: l.sheetSize, forJob: 0, used: 0, forProduced: 0, linesNotNested: 0 };
      map.set(key, t);
    }
    t.forJob = round4(t.forJob + l.forJob);
    if (l.sheetsUsed === null) t.linesNotNested += 1;
    else t.used = round4(t.used + l.sheetsUsed);
    if (l.forProduced !== null) t.forProduced = round4(t.forProduced + l.forProduced);
  }
  return [...map.values()].sort(
    (a, b) => a.material.localeCompare(b.material) || a.thicknessMm - b.thicknessMm || a.sheetSize.localeCompare(b.sheetSize)
  );
}

// ---- import: the planner's "Nesting Tracker" sheet ----

export interface NestingRow {
  rowNum: number; // 1-based sheet row, for the issues list
  bom: string;
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
}

export interface ParsedNesting {
  rows: NestingRow[];
  issues: string[];
  headerRow: number; // 1-based, for diagnostics
  /** Rows whose "for Job" column disagrees with their own per-unit rate by
   *  more than rounding — kept as written, counted so the planner can look. */
  recomputed: number;
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
} as const;

const OPTIONAL_HEADERS: ReadonlySet<string> = new Set(["note", "actual", "actualPerUnit", "partCode", "partName", "code"]);

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
    return { rows: [], issues: ["No header row found — expected a row with 'BOM Ref' and 'Thickness'."], headerRow: 0, recomputed: 0 };
  }
  const col = mapColumns(grid[headerIdx] ?? []);
  const issues: string[] = [];
  for (const [key, idx] of Object.entries(col)) {
    if (idx < 0 && !OPTIONAL_HEADERS.has(key)) issues.push(`Column "${key}" was not found in the header row.`);
  }
  if (issues.length > 0) return { rows: [], issues, headerRow: headerIdx + 1, recomputed: 0 };

  const rows: NestingRow[] = [];
  let recomputed = 0;
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

    if (!material) { issues.push(`Row ${rowNum} (${bom}): no material type — skipped.`); continue; }
    if (thickness === null || thickness <= 0) { issues.push(`Row ${rowNum} (${bom}): thickness is missing or not a number — skipped.`); continue; }
    if (!sheetSize) { issues.push(`Row ${rowNum} (${bom}): no sheet size — skipped.`); continue; }
    if (perUnit === null || perUnit < 0) { issues.push(`Row ${rowNum} (${bom}): sheets per unit is missing or not a number — skipped.`); continue; }
    if (units === null || units < 0) { issues.push(`Row ${rowNum} (${bom}): quantity of units is missing or not a number — skipped.`); continue; }

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
    const identity = `${bom}|${partCode}|${material}|${thickness}|${sheetSize}`;
    const earlier = seen.get(identity);
    if (earlier !== undefined) issues.push(`Row ${rowNum} (${bom} ${partCode} ${material} ${thickness}mm ${sheetSize}) repeats row ${earlier} — the tab keeps one line per BOM, part, material, thickness and size, so this row replaces it.`);
    seen.set(identity, rowNum);
    rows.push({
      rowNum, bom, units, material, thicknessMm: thickness, sheetSize,
      partCode, partName: partName || partNameFor(partCode),
      materialCode: col.code >= 0 ? cellText(line[col.code]).toUpperCase() : "",
      sheetsPerUnit: perUnit,
      actualPerUnit: rate,
      sheetsUsed: used,
      note: note || null,
    });
  }
  if (rows.length === 0) issues.push("No material rows found under the header.");
  return { rows, issues, headerRow: headerIdx + 1, recomputed };
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
}

export const EMPTY_MATERIAL_FILTERS: MaterialFilters = { q: "", partCode: "", material: "", thicknessMm: "", sheetSize: "", status: "all" };

export function filterMaterialLines(lines: MaterialLineView[], f: MaterialFilters): MaterialLineView[] {
  const q = f.q.trim().toLowerCase();
  return lines.filter((l) => {
    if (f.partCode && l.partCode !== f.partCode) return false;
    if (f.material && l.material !== f.material) return false;
    if (f.thicknessMm && String(l.thicknessMm) !== f.thicknessMm) return false;
    if (f.sheetSize && l.sheetSize !== f.sheetSize) return false;
    switch (f.status) {
      case "nested": if (l.sheetsUsed === null) return false; break;
      case "notNested": if (l.sheetsUsed !== null) return false; break;
      case "produced": if (l.producedQty === null) return false; break;
      case "over": if (l.difference === null || l.difference >= 0) return false; break;
      case "within": if (l.difference === null || l.difference < 0) return false; break;
    }
    if (q) {
      const hay = [l.bom, l.soi ?? "", l.partCode, l.partName, l.materialCode, l.note ?? "", l.mo].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
