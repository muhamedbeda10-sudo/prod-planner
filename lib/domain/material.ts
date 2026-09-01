// MATERIAL / nesting — what raw material an order actually eats.
//
// Port of the planner's "Nesting Tracker" sheet: one line per
// BOM (× order) × material × thickness × sheet size, carrying the nesting
// BOM's sheets-per-unit and what the nester ACTUALLY laid out for the job.
//
// The sheet's two computed columns are NOT stored — they are derived here, so
// they can never go stale or come back as #VALUE! the way the workbook's did:
//   sheets for the job = sheets per unit × quantity of units
//   difference         = sheets for the job − sheets actually nested
//
// Quantity of units is NOT typed either: it comes from the orders registry
// (the MO's plan qty, or every order on the BOM when the line is BOM-wide).
// `unitsOverride` is the escape hatch for a BOM the registry does not know.

/** Sheet counts are fractions of a sheet (0.429 of a sheet per unit). Excel
 *  left 0.564 × 3 as 1.6919999999999997; three decimals is finer than any
 *  nesting is ever quoted and keeps the arithmetic readable. */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Material types the plant actually buys — the dropdown, not a constraint:
 *  anything typed is kept (normalized) so a new alloy needs no code change. */
export const MATERIAL_PRESETS = [
  "Steel",
  "Stainless steel",
  "Galvanized steel",
  "Aluminium",
  "Copper",
] as const;

/** Sheet sizes on the floor. Same rule: presets, not a whitelist. */
export const SHEET_SIZE_PRESETS = ["1220*2440", "1250*2500", "1500*3000", "2000*6000"] as const;

// The tracker was filled in by hand for years — "Stainless steal", "S.S", "ms"
// and "Steel " are all the same steel. Folding them here is what makes the
// per-material purchasing totals add up.
const MATERIAL_ALIASES: Record<string, string> = {
  steel: "Steel",
  ms: "Steel",
  "m.s": "Steel",
  "mild steel": "Steel",
  "carbon steel": "Steel",
  "black steel": "Steel",
  ss: "Stainless steel",
  "s.s": "Stainless steel",
  inox: "Stainless steel",
  "stainless": "Stainless steel",
  "stainless steal": "Stainless steel",
  "stainless steel": "Stainless steel",
  gi: "Galvanized steel",
  galvanized: "Galvanized steel",
  galvanised: "Galvanized steel",
  "galvanized steel": "Galvanized steel",
  "galvanised steel": "Galvanized steel",
  alu: "Aluminium",
  aluminum: "Aluminium",
  aluminium: "Aluminium",
  copper: "Copper",
  cu: "Copper",
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
 *  "1220*2440 mm" — the four spellings the sheet already contains. */
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

/** A number as the shop floor types it ("3", "0.429", "١٢" is not expected).
 *  Blanks, text and Excel's #VALUE! come back null, never NaN or 0. */
export function parseSheetNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const clean = String(raw).replace(/,/g, "").trim();
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

/** Sheets the nesting BOM says the whole job needs. */
export function sheetsForJob(sheetsPerUnit: number, units: number): number {
  return round3(sheetsPerUnit * units);
}

/** Required − actually nested. Null while nothing has been nested yet: a blank
 *  actual is "not laid out", which is not the same as "used zero sheets". */
export function sheetsDifference(required: number, used: number | null): number | null {
  if (used === null) return null;
  return round3(required - used);
}

// ---- a line, as the page shows it ----

export interface MaterialLineInput {
  bom: string;
  mo: string; // "" = the line covers every order on this BOM
  material: string;
  thicknessMm: number;
  sheetSize: string;
  sheetsPerUnit: number;
  sheetsUsed: number | null;
  unitsOverride: number | null;
  note: string | null;
}

export interface MaterialLineView extends MaterialLineInput {
  id: number;
  units: number; // quantity of units this line covers
  unitsFromRegistry: boolean; // false = the typed override is in effect
  required: number; // sheets for the job
  difference: number | null; // required − used
  updatedISO: string;
  recordedBy: string | null;
}

/** Quantity of units behind a line: the override wins, otherwise the registry
 *  (the MO's own qty, or every order on the BOM for a BOM-wide line). */
export function resolveUnits(
  override: number | null,
  registryQty: number
): { units: number; fromRegistry: boolean } {
  if (override !== null && override > 0) return { units: override, fromRegistry: false };
  return { units: registryQty, fromRegistry: true };
}

/** The identity of a material line — one per BOM × order × material ×
 *  thickness × size. The workbook allowed the same line twice with different
 *  numbers; here the second entry edits the first. */
export function materialKey(l: Pick<MaterialLineInput, "bom" | "mo" | "material" | "thicknessMm" | "sheetSize">): string {
  return [l.bom, l.mo, l.material, l.thicknessMm, l.sheetSize].join("|");
}

// ---- purchasing view: what the plant needs, per material and thickness ----

export interface MaterialTotal {
  material: string;
  thicknessMm: number;
  sheetSize: string;
  required: number;
  used: number;
  /** Lines still waiting for their actual nesting — the totals below are
   *  incomplete by exactly this many lines. */
  pendingLines: number;
}

export function summarizeMaterial(lines: MaterialLineView[]): MaterialTotal[] {
  const map = new Map<string, MaterialTotal>();
  for (const l of lines) {
    const key = `${l.material}|${l.thicknessMm}|${l.sheetSize}`;
    let t = map.get(key);
    if (!t) {
      t = { material: l.material, thicknessMm: l.thicknessMm, sheetSize: l.sheetSize, required: 0, used: 0, pendingLines: 0 };
      map.set(key, t);
    }
    t.required = round3(t.required + l.required);
    if (l.sheetsUsed === null) t.pendingLines += 1;
    else t.used = round3(t.used + l.sheetsUsed);
  }
  return [...map.values()].sort(
    (a, b) => a.material.localeCompare(b.material) || a.thicknessMm - b.thicknessMm || a.sheetSize.localeCompare(b.sheetSize)
  );
}

// ---- import: the planner's existing "Nesting Tracker" sheet ----

export interface NestingRow {
  rowNum: number; // 1-based sheet row, for the issues list
  bom: string;
  material: string;
  thicknessMm: number;
  sheetSize: string;
  sheetsPerUnit: number;
  sheetsUsed: number | null;
  units: number | null; // the sheet's own "Quantity of Units" — the fallback
  note: string | null;
}

export interface ParsedNesting {
  rows: NestingRow[];
  issues: string[];
  headerRow: number; // 1-based, for diagnostics
}

// Columns are found BY HEADER TEXT, so the planner may reorder or add columns
// without breaking the import. Each entry is the distinguishing fragment.
const HEADERS = {
  bom: ["bom ref", "bom"],
  units: ["quantity of units", "qty of units", "units"],
  material: ["material type", "material"],
  thickness: ["thickness"],
  size: ["sheet size", "size"],
  perUnit: ["one unit", "per unit"],
  actual: ["actual nesting", "actual"],
  note: ["notes", "note", "remark"],
} as const;

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
      if (i >= 0) {
        out[key] = i;
        break;
      }
    }
  }
  return out;
}

/**
 * Parse the Nesting Tracker grid (sheet_to_json with header:1).
 * "Sheets for job" and "Difference" are ignored on purpose — they are the
 * sheet's formulas, and this app recomputes them.
 */
export function parseNestingTracker(grid: unknown[][]): ParsedNesting {
  const headerIdx = findHeaderRow(grid);
  if (headerIdx < 0) {
    return { rows: [], issues: ["No header row found — expected a row with 'BOM Ref' and 'Thickness'."], headerRow: 0 };
  }
  const col = mapColumns(grid[headerIdx] ?? []);
  const issues: string[] = [];
  for (const [key, idx] of Object.entries(col)) {
    if (idx < 0 && key !== "note" && key !== "units" && key !== "actual") {
      issues.push(`Column "${key}" was not found in the header row.`);
    }
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

    if (!material) { issues.push(`Row ${rowNum} (${bom}): no material type — skipped.`); continue; }
    if (thickness === null || thickness <= 0) { issues.push(`Row ${rowNum} (${bom}): thickness is missing or not a number — skipped.`); continue; }
    if (!sheetSize) { issues.push(`Row ${rowNum} (${bom}): no sheet size — skipped.`); continue; }
    if (perUnit === null || perUnit < 0) { issues.push(`Row ${rowNum} (${bom}): sheets per unit is missing or not a number — skipped.`); continue; }

    const units = col.units >= 0 ? parseSheetNumber(line[col.units]) : null;
    const used = col.actual >= 0 ? parseSheetNumber(line[col.actual]) : null;
    const note = col.note >= 0 ? cellText(line[col.note]) : "";

    rows.push({
      rowNum,
      bom,
      material,
      thicknessMm: thickness,
      sheetSize,
      sheetsPerUnit: perUnit,
      sheetsUsed: used !== null && used >= 0 ? used : null,
      units: units !== null && units > 0 ? units : null,
      note: note || null,
    });
  }

  if (rows.length === 0) issues.push("No material rows found under the header.");
  return { rows, issues, headerRow: headerIdx + 1 };
}
