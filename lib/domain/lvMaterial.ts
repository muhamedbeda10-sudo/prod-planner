// The LV panels' material sheet — "Consumption Details". One block per
// order: product, SEC item, planned qty, MO, BOM and material on the first
// row, then one row per thickness with the sheets ONE unit needs, the sheets
// the whole order needs, and what was actually consumed so far. Blank cells
// down a block repeat the row above. Pure: the import and the tab's own
// arithmetic run on this without a database.

import { normalizeMaterialType, normalizeSheetSize, parseSheetNumber, round4 } from "./material";

export interface LvMaterialRow {
  rowNum: number; // 1-based sheet row, for the issues list
  product: string; // USS / LSS
  secItem: string;
  mo: string;
  bom: string;
  units: number; // planned qty
  material: string;
  thicknessMm: number;
  sheetSize: string;
  sheetsPerUnit: number;
  /** Units produced so far, when the consumed cell says so ("For 8 Units …") or the block is Done. */
  producedQty: number | null;
  /** Sheets consumed so far — for the produced units, or the whole job when done. */
  consumed: number | null;
  /** True when the block reads Done: the job is finished and its sheets are the job's. */
  done: boolean;
  note: string | null;
}

export interface ParsedLvMaterial {
  rows: LvMaterialRow[];
  issues: string[];
  headerRow: number;
}

const HEADERS = {
  product: ["product"],
  secItem: ["sec item", "sec"],
  units: ["planned qty", "planned", "qty of units", "units"],
  mo: ["mo"],
  bom: ["bom"],
  material: ["material"],
  thickness: ["thickness"],
  size: ["sheet size", "size"],
  perUnit: ["for one unit", "one unit", "per unit"],
  perBom: ["as per bom", "per bom"],
  consumed: ["actually consumed", "consumed", "actual"],
  note: ["remarks", "remark", "notes", "note"],
} as const;

const cellText = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

function findHeaderRow(grid: unknown[][]): number {
  for (let r = 0; r < Math.min(grid.length, 30); r++) {
    const cells = (grid[r] ?? []).map((c) => cellText(c).toLowerCase());
    if (cells.some((c) => c === "mo" || c.startsWith("mo ")) && cells.some((c) => c.includes("thickness"))) return r;
  }
  return -1;
}

function mapColumns(header: unknown[]): Record<keyof typeof HEADERS, number> {
  const cells = header.map((c) => cellText(c).toLowerCase());
  const out = {} as Record<keyof typeof HEADERS, number>;
  for (const key of Object.keys(HEADERS) as (keyof typeof HEADERS)[]) {
    out[key] = -1;
    for (const frag of HEADERS[key]) {
      const i = cells.findIndex((c, idx) => (frag === "mo" ? c === "mo" || c.startsWith("mo ") : c.includes(frag)) && !Object.values(out).includes(idx));
      if (i >= 0) { out[key] = i; break; }
    }
  }
  return out;
}

/** What the "Actually Consumed" cell says: a number is sheets consumed; the
 *  sheet also writes "For 8 Units 14.4 Sheets Consumed" for a job still
 *  running. Null when blank or unreadable. */
export function parseConsumedCell(raw: unknown): { producedQty: number | null; consumed: number | null } {
  const n = parseSheetNumber(raw);
  if (n !== null) return { producedQty: null, consumed: n };
  const text = cellText(raw).toLowerCase();
  if (!text) return { producedQty: null, consumed: null };
  const units = /for\s+([\d.]+)\s*units?/i.exec(text);
  const sheets = /([\d.]+)\s*sheets?/i.exec(text);
  return {
    producedQty: units ? Number(units[1]) : null,
    consumed: sheets ? Number(sheets[1]) : null,
  };
}

/** Units still to make on a block: planned less produced, never negative. */
export function lvRemainingUnits(units: number, produced: number | null): number {
  return Math.max(0, units - (produced ?? 0));
}

export function parseLvConsumption(grid: unknown[][]): ParsedLvMaterial {
  const headerIdx = findHeaderRow(grid);
  if (headerIdx < 0) return { rows: [], issues: ["No header row found — expected a row with 'MO' and 'Thickness'."], headerRow: 0 };
  const col = mapColumns(grid[headerIdx] ?? []);
  const issues: string[] = [];
  for (const k of ["mo", "thickness", "perUnit"] as const) {
    if (col[k] < 0) issues.push(`Column for ${k === "perUnit" ? "sheets for one unit" : k} not found in the header row.`);
  }
  if (issues.length) return { rows: [], issues, headerRow: headerIdx + 1 };

  const rows: LvMaterialRow[] = [];
  // the block's head — repeated down the thickness rows the sheet leaves blank
  let head: { product: string; secItem: string; mo: string; bom: string; units: number; material: string; note: string | null; done: boolean } | null = null;
  const at = (r: unknown[], i: number) => (i >= 0 ? r[i] : null);
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const rowNum = i + 1;
    const mo = cellText(at(r, col.mo)).toUpperCase();
    const thickness = parseSheetNumber(String(cellText(at(r, col.thickness))).replace(/mm/i, "").trim());
    if (mo) {
      const units = parseSheetNumber(at(r, col.units));
      const noteText = cellText(at(r, col.note));
      head = {
        product: cellText(at(r, col.product)).toUpperCase(),
        secItem: cellText(at(r, col.secItem)),
        mo,
        bom: cellText(at(r, col.bom)).toUpperCase(),
        units: units ?? 0,
        material: normalizeMaterialType(at(r, col.material)) || "Galvanized steel",
        note: noteText || null,
        done: /\bdone\b/i.test(noteText),
      };
      if (units === null) issues.push(`Row ${rowNum}: ${mo} has no planned qty — 0 assumed.`);
    }
    if (thickness === null || thickness <= 0) continue; // a spacer or a text row
    if (!head) { issues.push(`Row ${rowNum}: a thickness row before any order — skipped.`); continue; }
    const perUnit = parseSheetNumber(at(r, col.perUnit));
    if (perUnit === null) { issues.push(`Row ${rowNum}: ${head.mo} ${thickness} mm has no sheets-per-unit — skipped.`); continue; }
    const material = normalizeMaterialType(at(r, col.material)) || head.material;
    const sheetSize = normalizeSheetSize(at(r, col.size)) || "1220*2440";
    const forJob = round4(perUnit * head.units);
    const c = parseConsumedCell(at(r, col.consumed));
    // a finished block: the whole job's sheets, for every unit
    const done = head.done || (c.consumed !== null && c.producedQty === null && head.units > 0 && Math.abs(c.consumed - forJob) < 0.01);
    rows.push({
      rowNum, product: head.product, secItem: head.secItem, mo: head.mo, bom: head.bom, units: head.units,
      material, thicknessMm: thickness, sheetSize, sheetsPerUnit: perUnit,
      producedQty: done ? head.units : c.producedQty,
      consumed: done && c.consumed === null ? forJob : c.consumed,
      done,
      note: head.note,
    });
  }
  if (rows.length === 0) issues.push("No thickness rows found under any MO.");
  return { rows, issues, headerRow: headerIdx + 1 };
}
