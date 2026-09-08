// MATERIAL — the planner's "Nesting Project Tracker" sheet, month by month.
//
// One line per month × BOM × part × material × thickness × sheet size,
// exactly the sheet's row: Quantity of Units, Part Code and Name, the
// material's code, the sheets ONE unit needs, and the sheets actually nested
// for the job. The sheet's two formula columns are derived
// here, never stored, so they cannot go stale or come back as #VALUE!:
//   sheets for the job = sheets per unit × quantity of units
//   difference         = sheets for the job − sheets actually nested
//
// The tab adds one typed number, producedQty — how many units were actually
// made so far — and derives from it the answer the planner asked for:
//   actual per unit      = sheets actually nested / quantity of units
//   sheets for produced  = actual per unit × units produced
// "The sheet says 50 sheets made 30 units; I made 5 — so I used 8.333."

/** Sheet counts are fractions of a sheet (0.429 of a sheet per unit). Excel
 *  left 0.564 × 3 as 1.6919999999999997; three decimals is finer than any
 *  nesting is ever quoted and keeps the arithmetic readable. */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export const MATERIAL_PRESETS = ["Steel", "Stainless steel", "Galvanized steel", "Aluminium", "Copper"] as const;

/** The parts the sheet nests for, by Odoo's part code — a typing aid that
 *  fills the part name; anything else typed is kept. */
export const PART_PRESETS: { code: string; name: string }[] = [
  { code: "FB-022", name: "TANK" },
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
  return round3(sheetsPerUnit * units);
}

/** Sheets for the job − actually nested. Null while nothing has been nested:
 *  a blank actual is "not laid out", which is not "used zero sheets". */
export function sheetsDifference(forJob: number, used: number | null): number | null {
  if (used === null) return null;
  return round3(forJob - used);
}

// ---- the tab's addition: what the produced units really consumed ----

/** The sheet's real rate: sheets actually nested per unit of the job. Null
 *  until the job is nested, or when the sheet names no units. */
export function actualPerUnit(used: number | null, units: number): number | null {
  if (used === null || !(units > 0)) return null;
  return used / units;
}

/** Sheets the produced units really consumed, at the job's actual rate.
 *  50 sheets nested for 30 units, 5 produced → 8.333. */
export function sheetsForProduced(used: number | null, units: number, produced: number | null): number | null {
  const rate = actualPerUnit(used, units);
  if (rate === null || produced === null) return null;
  return round3(rate * produced);
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
  sheetsUsed: number | null; // No. of Sheets in Actual Nesting for Job
  producedQty: number | null; // units produced so far
  note: string | null;
}

export interface MaterialLineView extends MaterialLineInput {
  id: number;
  soi: string | null; // the BOM's orders' SOIs, joined
  forJob: number; // sheets for the job
  difference: number | null; // forJob − sheetsUsed
  actualPerUnit: number | null; // sheetsUsed / units
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
    t.forJob = round3(t.forJob + l.forJob);
    if (l.sheetsUsed === null) t.linesNotNested += 1;
    else t.used = round3(t.used + l.sheetsUsed);
    if (l.forProduced !== null) t.forProduced = round3(t.forProduced + l.forProduced);
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
  sheetsUsed: number | null;
  note: string | null;
}

export interface ParsedNesting {
  rows: NestingRow[];
  issues: string[];
  headerRow: number; // 1-based, for diagnostics
}

// Columns are found BY HEADER TEXT, so the planner may reorder or add columns
// without breaking the import. Each entry lists the distinguishing fragments.
// "…in BOM for one Unit" and "…in Actual Nesting for one Unit" both say "one
// unit": the BOM's is claimed first (its fragment is more specific), and the
// actual rate is never read — the tab derives it from the actual for the job.
const HEADERS = {
  bom: ["bom ref", "bom"],
  units: ["quantity of units", "qty of units", "units"],
  partCode: ["part code"],
  partName: ["part name"],
  code: ["codes", "code"],
  material: ["material type", "material"],
  thickness: ["thickness"],
  size: ["sheet size", "size"],
  perUnit: ["bom for one unit", "one unit", "per unit"],
  actual: ["actual nesting for job", "actual for job", "actual nesting", "actual"],
  note: ["notes", "note", "remark"],
} as const;

const OPTIONAL_HEADERS: ReadonlySet<string> = new Set(["note", "actual", "partCode", "partName", "code"]);

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

/**
 * Parse the Nesting Tracker grid (sheet_to_json with header:1).
 * "Sheets for job" and "Difference" are ignored on purpose — they are the
 * sheet's formulas, and this tab recomputes them.
 */
export function parseNestingTracker(grid: unknown[][]): ParsedNesting {
  const headerIdx = findHeaderRow(grid);
  if (headerIdx < 0) {
    return { rows: [], issues: ["No header row found — expected a row with 'BOM Ref' and 'Thickness'."], headerRow: 0 };
  }
  const col = mapColumns(grid[headerIdx] ?? []);
  const issues: string[] = [];
  for (const [key, idx] of Object.entries(col)) {
    if (idx < 0 && !OPTIONAL_HEADERS.has(key)) issues.push(`Column "${key}" was not found in the header row.`);
  }
  if (issues.length > 0) return { rows: [], issues, headerRow: headerIdx + 1 };

  const rows: NestingRow[] = [];
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

    const used = col.actual >= 0 ? parseSheetNumber(line[col.actual]) : null;
    const note = col.note >= 0 ? cellText(line[col.note]) : "";
    const partCode = col.partCode >= 0 ? cellText(line[col.partCode]).toUpperCase() : "";
    const partName = col.partName >= 0 ? cellText(line[col.partName]).toUpperCase() : "";
    rows.push({
      rowNum, bom, units, material, thicknessMm: thickness, sheetSize,
      partCode, partName: partName || partNameFor(partCode),
      materialCode: col.code >= 0 ? cellText(line[col.code]).toUpperCase() : "",
      sheetsPerUnit: perUnit, sheetsUsed: used !== null && used >= 0 ? used : null, note: note || null,
    });
  }
  if (rows.length === 0) issues.push("No material rows found under the header.");
  return { rows, issues, headerRow: headerIdx + 1 };
}
