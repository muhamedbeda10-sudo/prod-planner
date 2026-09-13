import { ITEMS, type Item } from "@/lib/domain/constants";
import { ITEM_PRODUCT } from "@/lib/domain/odooMirror";

// 📊 What the fabrication floor actually did, read in SHEETS instead of pieces.
//
// The plant counts fabrication in pieces, and a piece is not a unit of work: a
// tank on one order is six times the tank on another because it is cut from
// six times the sheets. The Material tab already holds the bill of sheets per
// BOM — every part, thickness, material and sheet size — so the daily log's
// pieces can be turned into the thing a laser actually spends its day on.
//
// Everything here is pure. The caller brings the output rows and the nesting
// rows; the calendar, the database and the plant's own capacity stay out.

/** Kilograms a cubic metre of each material weighs. Anything unrecognised is
 *  taken as steel — every sheet in the plant's tracker but a handful is. */
const DENSITY: Record<string, number> = {
  "hr sheet": 7850,
  steel: 7850,
  "galvanized steel": 7850,
  "stainless steel": 8000,
  aluminium: 2700,
  copper: 8960,
};
const STEEL = 7850;

export function densityOf(material: string): number {
  return DENSITY[material.trim().toLowerCase()] ?? STEEL;
}

/** "1220*2440" → square metres. Null when the cell is not a size at all. */
export function sheetAreaM2(sheetSize: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[*x×]\s*(\d+(?:\.\d+)?)\s*$/i.exec(sheetSize);
  if (!m) return null;
  const a = Number(m[1]) / 1000;
  const b = Number(m[2]) / 1000;
  return a > 0 && b > 0 ? a * b : null;
}

/** What one sheet of this spec weighs, in kilograms. */
export function sheetKg(sheetSize: string, thicknessMm: number, material: string): number | null {
  const area = sheetAreaM2(sheetSize);
  if (area === null || !(thicknessMm > 0)) return null;
  return area * (thicknessMm / 1000) * densityOf(material);
}

// ---- inputs ----

/** One nesting line off the Material tab. */
export interface NestingRow {
  month: string;
  bom: string;
  mo: string;
  partCode: string;
  material: string;
  thicknessMm: number;
  sheetSize: string;
  /** Sheets this line puts into ONE unit of the part. */
  sheetsPerUnit: number;
}

/** One day's output off the daily log — fabrication only. */
export interface OutputRow {
  dateISO: string;
  bom: string;
  item: string;
  qty: number;
}

// ---- the bill of sheets for one part of one BOM ----

/** One thickness inside a part's bill of sheets. */
export interface SheetLine {
  thicknessMm: number;
  material: string;
  sheetSize: string;
  /** Sheets of this spec per unit of the part. */
  perUnit: number;
  /** What one of them weighs — null when the sheet size is unreadable. */
  kg: number | null;
}

export interface PartBill {
  /** Sheets of every thickness together, per unit. */
  perUnit: number;
  lines: SheetLine[];
}

const billKey = (bom: string, partCode: string) => `${bom.trim().toUpperCase()}|${partCode.trim().toUpperCase()}`;

/**
 * The current bill of sheets per BOM × part.
 *
 * A part can carry several bills — one per plan month, sometimes one per MO
 * inside a month — and they are alternatives, not additions: summing them
 * would multiply a tank's sheets by the number of times it was planned. So
 * each (month, mo) is one candidate bill, and the NEWEST month wins; several
 * MOs inside that month are averaged, since they describe the same part.
 */
export function billsOf(rows: readonly NestingRow[]): Map<string, PartBill> {
  // (bom|part) → (month|mo) → its lines
  const groups = new Map<string, Map<string, { month: string; lines: SheetLine[] }>>();
  for (const r of rows) {
    if (!r.partCode.trim() || !(r.sheetsPerUnit > 0)) continue;
    const k = billKey(r.bom, r.partCode);
    const inner = groups.get(k) ?? new Map();
    if (!groups.has(k)) groups.set(k, inner);
    const gk = `${r.month}|${r.mo}`;
    const g = inner.get(gk) ?? { month: r.month, lines: [] };
    if (!inner.has(gk)) inner.set(gk, g);
    g.lines.push({
      thicknessMm: r.thicknessMm,
      material: r.material,
      sheetSize: r.sheetSize,
      perUnit: r.sheetsPerUnit,
      kg: sheetKg(r.sheetSize, r.thicknessMm, r.material),
    });
  }

  const out = new Map<string, PartBill>();
  for (const [k, inner] of groups) {
    // the newest month's candidates; "" (entered before months existed) is oldest
    const newest = [...inner.values()].reduce((a, b) => (b.month > a.month ? b : a));
    const same = [...inner.values()].filter((g) => g.month === newest.month);
    // several MOs of the same month describe the same part — average them by
    // dividing each line's share, so the totals stay one unit's worth
    const n = same.length;
    const lines = same.flatMap((g) => g.lines).map((l) => ({ ...l, perUnit: l.perUnit / n }));
    out.set(k, { perUnit: round2(lines.reduce((s, l) => s + l.perUnit, 0)), lines });
  }
  return out;
}

// ---- the readings ----

export interface DayPoint {
  dateISO: string;
  pieces: number;
  /** Pieces whose BOM has no bill of sheets — they are in `pieces`, not in
   *  `sheets`, which is why the page reports coverage. */
  uncoveredPieces: number;
  sheets: number;
  kg: number;
}

export interface ItemFactor {
  item: Item;
  /** BOMs of this item that were produced AND have a bill. */
  boms: number;
  pieces: number;
  sheets: number;
  /** Sheets one piece takes, weighted by what was actually produced. */
  avg: number;
  min: number;
  max: number;
}

export interface ThicknessSlice {
  thicknessMm: number;
  sheets: number;
  kg: number;
  /** Share of all sheets cut in the window, 0–1. */
  share: number;
}

export interface FabAnalytics {
  days: DayPoint[];
  items: ItemFactor[];
  thicknesses: ThicknessSlice[];
  /** Totals over the whole window. */
  pieces: number;
  sheets: number;
  tons: number;
  /** Working days that recorded any output — the divisor for the per-day rates. */
  workedDays: number;
  sheetsPerDay: number;
  tonsPerDay: number;
  /** Share of produced pieces whose BOM has a bill of sheets, 0–1. It is the
   *  honesty figure: every sheet reading above is only as good as this. */
  coverage: number;
  uncoveredPieces: number;
  /** BOMs that were produced with no nesting rows at all, worst first. */
  uncoveredBoms: { bom: string; pieces: number }[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Read a window of fabrication output in sheets, tonnes and thicknesses.
 *
 * `output` is the daily log's fabrication rows and `nesting` the Material
 * tab's lines. A piece whose BOM has no bill is still counted as a piece —
 * dropping it would flatter every rate — and reported as uncovered.
 */
export function buildFabAnalytics(output: readonly OutputRow[], nesting: readonly NestingRow[]): FabAnalytics {
  const bills = billsOf(nesting);

  const byDay = new Map<string, DayPoint>();
  const byItem = new Map<Item, { pieces: number; sheets: number; boms: Set<string>; min: number; max: number }>();
  const byThickness = new Map<number, { sheets: number; kg: number }>();
  const uncovered = new Map<string, number>();
  let pieces = 0;
  let sheets = 0;
  let kg = 0;
  let uncoveredPieces = 0;

  for (const o of output) {
    // a correction is a negative row: it belongs in the totals, and it must
    // not be mistaken for a produced piece anywhere below
    if (!o.qty) continue;
    const item = ITEMS.find((i) => i === o.item);
    pieces += o.qty;

    const part = item ? ITEM_PRODUCT[item].partCode : null;
    const bill = part ? bills.get(billKey(o.bom, part)) : undefined;

    const day = byDay.get(o.dateISO) ?? { dateISO: o.dateISO, pieces: 0, uncoveredPieces: 0, sheets: 0, kg: 0 };
    if (!byDay.has(o.dateISO)) byDay.set(o.dateISO, day);
    day.pieces += o.qty;

    if (!bill) {
      uncoveredPieces += o.qty;
      day.uncoveredPieces += o.qty;
      if (o.qty > 0) uncovered.set(o.bom, (uncovered.get(o.bom) ?? 0) + o.qty);
      continue;
    }

    const s = bill.perUnit * o.qty;
    sheets += s;
    day.sheets += s;
    for (const l of bill.lines) {
      const ls = l.perUnit * o.qty;
      const lkg = l.kg === null ? 0 : l.kg * ls;
      kg += lkg;
      day.kg += lkg;
      const t = byThickness.get(l.thicknessMm) ?? { sheets: 0, kg: 0 };
      if (!byThickness.has(l.thicknessMm)) byThickness.set(l.thicknessMm, t);
      t.sheets += ls;
      t.kg += lkg;
    }

    if (item) {
      const f = byItem.get(item) ?? { pieces: 0, sheets: 0, boms: new Set<string>(), min: Infinity, max: 0 };
      if (!byItem.has(item)) byItem.set(item, f);
      f.pieces += o.qty;
      f.sheets += s;
      f.boms.add(o.bom.trim().toUpperCase());
      // the spread is over the BOMs produced, not over the pieces — one heavy
      // BOM run a hundred times must not read as a hundred heavy BOMs
      f.min = Math.min(f.min, bill.perUnit);
      f.max = Math.max(f.max, bill.perUnit);
    }
  }

  const days = [...byDay.values()]
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO))
    .map((d) => ({ ...d, pieces: round1(d.pieces), sheets: round1(d.sheets), kg: Math.round(d.kg) }));

  const items = ITEMS.map((item) => {
    const f = byItem.get(item);
    if (!f || !(f.pieces > 0)) return null;
    return {
      item,
      boms: f.boms.size,
      pieces: round1(f.pieces),
      sheets: round1(f.sheets),
      avg: round2(f.sheets / f.pieces),
      min: round2(f.min === Infinity ? 0 : f.min),
      max: round2(f.max),
    };
  }).filter((x): x is ItemFactor => x !== null);

  const thicknesses = [...byThickness.entries()]
    .map(([thicknessMm, t]) => ({
      thicknessMm,
      sheets: round1(t.sheets),
      kg: Math.round(t.kg),
      share: sheets > 0 ? t.sheets / sheets : 0,
    }))
    .filter((t) => t.sheets > 0)
    .sort((a, b) => a.thicknessMm - b.thicknessMm);

  // a day is "worked" when it recorded output at all — the rates are per day
  // the floor ran, not per day on the calendar
  const workedDays = days.filter((d) => d.pieces !== 0).length;

  return {
    days,
    items,
    thicknesses,
    pieces: round1(pieces),
    sheets: round1(sheets),
    tons: round1(kg / 1000),
    workedDays,
    sheetsPerDay: workedDays > 0 ? round1(sheets / workedDays) : 0,
    tonsPerDay: workedDays > 0 ? round2(kg / 1000 / workedDays) : 0,
    coverage: pieces > 0 ? Math.max(0, (pieces - uncoveredPieces) / pieces) : 0,
    uncoveredPieces: round1(uncoveredPieces),
    uncoveredBoms: [...uncovered.entries()]
      .map(([bom, p]) => ({ bom, pieces: round1(p) }))
      .sort((a, b) => b.pieces - a.pieces),
  };
}
