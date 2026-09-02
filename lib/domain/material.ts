// MATERIAL — the raw material an order ACTUALLY consumed.
//
// This is a record of real consumption, not a plan: the line says "on this BOM
// I used N sheets of this material, this thickness, this size". That N is the
// one number the tab exists to capture, so it is the required field.
//
// The nesting BOM's sheets-per-unit is OPTIONAL alongside it — a reference to
// measure the real usage against. Give it and the tab derives what the BOM
// allowed for the job and how far the real usage sat from it; leave it out and
// the line still stands on its own as "used N sheets".
//
// Neither derived column is stored, so they can never go stale or come back as
// #VALUE! the way the workbook's formulas did:
//   sheets the BOM allowed = sheets per unit × quantity of units
//   difference             = sheets the BOM allowed − sheets actually used
//
// Quantity of units is not typed either: it comes from the orders registry
// (the MO's plan qty, or every order on the BOM when the line is BOM-wide).
// `unitsOverride` is the escape hatch for a BOM the registry does not know.
// The monthly plan(s) the BOM belongs to are read from the registry the same
// way, so a line never carries a month that disagrees with the order behind it.

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

/** A number as the shop floor types it ("3", "0.429"). A blank box, or
 *  anything that is not a number, comes back null — never NaN, never 0. */
export function parseSheetNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const clean = String(raw).replace(/,/g, "").trim();
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

/** Sheets the nesting BOM allowed for the whole job — null when the line was
 *  recorded without a BOM figure, which is simply "no yardstick", not zero. */
export function sheetsForJob(sheetsPerUnit: number | null, units: number): number | null {
  if (sheetsPerUnit === null) return null;
  return round3(sheetsPerUnit * units);
}

/** What the BOM allowed − what was actually used. Positive = came in under the
 *  BOM, negative = ate more than it allowed. Null without a BOM figure. */
export function sheetsDifference(allowed: number | null, used: number): number | null {
  if (allowed === null) return null;
  return round3(allowed - used);
}

// ---- a line, as the page shows it ----

export interface MaterialLineInput {
  bom: string;
  mo: string; // "" = the line covers every order on this BOM
  material: string;
  thicknessMm: number;
  sheetSize: string;
  workedISO: string; // the day this material was worked (yyyy-mm-dd)
  sheetsUsed: number; // what was ACTUALLY consumed — the point of the line
  sheetsPerUnit: number | null; // the nesting BOM's figure, when it is known
  unitsOverride: number | null;
  note: string | null;
}

export interface MaterialLineView extends MaterialLineInput {
  id: number;
  units: number; // quantity of units this line covers
  unitsFromRegistry: boolean; // false = the typed override is in effect
  soi: string | null; // sales order item — the order's, or its BOM's, joined
  planMonths: string[]; // the monthly plan(s) the BOM's orders came in on
  allowed: number | null; // sheets the BOM allowed for the job
  difference: number | null; // allowed − used
  updatedISO: string;
  recordedBy: string | null;
}

/** The monthly plans an order was imported under, as the registry stores them:
 *  a CSV of month labels, falling back to the plan that first added the MO.
 *  Same reading as the Orders registry and the Plan Tracker. */
export function parsePlanMonths(months: string | null | undefined, source?: string | null): string[] {
  const csv = String(months ?? "").trim() || String(source ?? "");
  return csv.split(",").map((m) => m.trim()).filter(Boolean);
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
  /** Sheets really consumed — always complete, every line carries one. */
  used: number;
  /** Sheets the BOM allowed, over the lines that carry a BOM figure. */
  allowed: number;
  /** Lines recorded without a BOM figure — `allowed` is silent about exactly
   *  this many lines, so the two columns are only comparable when it is 0. */
  linesWithoutBom: number;
}

export function summarizeMaterial(lines: MaterialLineView[]): MaterialTotal[] {
  const map = new Map<string, MaterialTotal>();
  for (const l of lines) {
    const key = `${l.material}|${l.thicknessMm}|${l.sheetSize}`;
    let t = map.get(key);
    if (!t) {
      t = { material: l.material, thicknessMm: l.thicknessMm, sheetSize: l.sheetSize, used: 0, allowed: 0, linesWithoutBom: 0 };
      map.set(key, t);
    }
    t.used = round3(t.used + l.sheetsUsed);
    if (l.allowed === null) t.linesWithoutBom += 1;
    else t.allowed = round3(t.allowed + l.allowed);
  }
  return [...map.values()].sort(
    (a, b) => a.material.localeCompare(b.material) || a.thicknessMm - b.thicknessMm || a.sheetSize.localeCompare(b.sheetSize)
  );
}

