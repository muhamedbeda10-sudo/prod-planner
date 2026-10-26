import { ITEMS, type Item } from "@/lib/domain/constants";
import { ITEM_PRODUCT } from "@/lib/domain/odooMirror";
import { sheetKg, type DayPoint, type ThicknessSlice } from "@/lib/domain/fabAnalytics";

// 📊 The MATERIAL dashboard — everything the material sheet and the ODOO log
// say about steel, in sheets and kilograms.
//
// Two sources, two clocks:
//  - the material sheet (the Material tab) is the plan and the nesting: per
//    MO and part, the sheets the BOM calls for, the sheets the nesting really
//    took, one sheet's weight and the nesting's average utilization. It is
//    read whole — an MO nested last month is just as nested today;
//  - the ODOO log says WHEN the material was eaten: an MO moved to Done books
//    its closed quantity × the sheets one unit takes, on the day it closed.
//    Only closings of the sheet's own MOs count.
//
// Scrap is the part of a nested sheet the utilization says was not used:
// kilograms × (1 − utilization). Where the sheet has no utilization for a
// line, that line's scrap is unknown — never guessed — and the page says how
// much of the weight the scrap figure covers.
//
// Everything here is pure; the caller brings the rows.

/** One line of the material sheet. */
export interface SheetLine {
  mo: string;
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
  /** One sheet's weight; worked out from size × thickness × density when blank. */
  weightKg: number | null;
  /** Average Utilization as the sheet writes it: 0.86 or 86. */
  utilization: number | null;
}

/** One ODOO row moved to Done. */
export interface DoneRow {
  /** The factory's day it was moved to Done. */
  dateISO: string;
  mo: string;
  qty: number;
}

export interface Weighed {
  sheets: number;
  kg: number;
}

export interface Breakdown extends Weighed {
  key: string;
  /** Scrap kilograms, over the lines whose utilization is known. */
  scrapKg: number;
  /** Share of the kilograms (0–1). */
  share: number;
}

export interface PartRow {
  item: Item | null;
  partCode: string;
  partName: string;
  mos: number;
  unitsPlanned: number;
  unitsClosed: number;
  /** Sheets one unit takes by the BOM, and by the nesting (null until nested), averaged over the MOs. */
  bomPerUnit: number;
  actualPerUnit: number | null;
  plannedKg: number;
  nestedKg: number;
  consumedKg: number;
  scrapKg: number;
  /** Weighted by the nested kilograms; null when no line of the part has one. */
  utilization: number | null;
}

export interface MoRow {
  mo: string;
  soi: string;
  part: string;
  units: number;
  closedUnits: number;
  plannedKg: number;
  nestedKg: number | null;
  /** Nested − BOM, kilograms: positive = the nesting ate more than the BOM. */
  overKg: number | null;
  scrapKg: number | null;
  utilization: number | null;
}

export interface MaterialDashboard {
  // ---- the window: consumed when closed on Odoo ----
  consumed: Weighed & { units: number; closings: number; mos: number; scrapKg: number; netKg: number; scrapKnownShare: number };
  consumedPerDay: { sheets: number; kg: number; days: number };
  days: DayPoint[];
  thicknesses: ThicknessSlice[];

  // ---- the sheet as a whole ----
  planned: Weighed;
  nested: Weighed & { lines: number; linesTotal: number };
  /** Nested − the BOM for the nested lines only: what nesting saved (<0) or overspent (>0). */
  overBom: Weighed;
  scrap: { kg: number; share: number; knownShare: number };
  utilization: number | null;
  remaining: Weighed & { units: number };
  mos: { total: number; nested: number; closed: number; open: number };

  materials: Breakdown[];
  sizes: Breakdown[];
  parts: PartRow[];
  /** The heaviest scrap and the worst overspend, ten each. */
  topScrap: MoRow[];
  topOver: MoRow[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const moKey = (mo: string) => mo.trim().toUpperCase();

/** Utilization as a fraction, 0–1; the sheet may write 0.86 or 86. */
export function utilizationFraction(u: number | null): number | null {
  if (u === null || !Number.isFinite(u) || u <= 0) return null;
  const f = u > 1.5 ? u / 100 : u;
  return Math.min(1, Math.max(0, f));
}

/** One sheet's weight: the sheet's own, else worked out. */
function eachKg(l: SheetLine): number {
  return l.weightKg ?? sheetKg(l.sheetSize, l.thicknessMm, l.material) ?? 0;
}

/** Sheets one unit really takes: the nesting's, else the BOM's. */
function ratePerUnit(l: SheetLine): number {
  if (l.actualPerUnit !== null) return l.actualPerUnit;
  if (l.sheetsUsed !== null && l.units > 0) return l.sheetsUsed / l.units;
  return l.sheetsPerUnit;
}

/** Sheets the nesting took for the job — null until nested. */
function nestedSheets(l: SheetLine): number | null {
  if (l.sheetsUsed !== null) return l.sheetsUsed;
  if (l.actualPerUnit !== null) return l.actualPerUnit * l.units;
  return null;
}

const ITEM_BY_PART = new Map(ITEMS.flatMap((i) => (ITEM_PRODUCT[i].partCode ? [[ITEM_PRODUCT[i].partCode!, i] as const] : [])));

function breakdown(map: Map<string, { sheets: number; kg: number; scrapKg: number }>, total: number): Breakdown[] {
  return [...map.entries()]
    .map(([key, v]) => ({ key, sheets: r1(v.sheets), kg: Math.round(v.kg), scrapKg: Math.round(v.scrapKg), share: total > 0 ? v.kg / total : 0 }))
    .filter((b) => b.kg > 0 || b.sheets > 0)
    .sort((a, b) => b.kg - a.kg);
}

export function buildMaterialDashboard(lines: readonly SheetLine[], done: readonly DoneRow[], windowFromISO: string | null): MaterialDashboard {
  const byMo = new Map<string, SheetLine[]>();
  for (const l of lines) {
    if (!l.mo.trim()) continue;
    const k = moKey(l.mo);
    const list = byMo.get(k) ?? [];
    if (!byMo.has(k)) byMo.set(k, list);
    list.push(l);
  }

  // every closing of the sheet's MOs — all of them for what is still open,
  // the window's for what was consumed
  const closedAll = new Map<string, number>();
  const inWindow: DoneRow[] = [];
  for (const d of done) {
    const k = moKey(d.mo);
    if (!byMo.has(k) || !(d.qty > 0)) continue;
    closedAll.set(k, (closedAll.get(k) ?? 0) + d.qty);
    if (windowFromISO === null || d.dateISO >= windowFromISO) inWindow.push(d);
  }

  // ---- consumed in the window ----
  const byDay = new Map<string, DayPoint>();
  const byThickness = new Map<number, { sheets: number; kg: number }>();
  const closedInWindow = new Map<string, number>();
  let cSheets = 0, cKg = 0, cUnits = 0, cScrap = 0, cKnownKg = 0;
  const consumedByLine = new Map<SheetLine, number>(); // kg
  for (const d of inWindow) {
    const k = moKey(d.mo);
    closedInWindow.set(k, (closedInWindow.get(k) ?? 0) + d.qty);
    cUnits += d.qty;
    const day = byDay.get(d.dateISO) ?? { dateISO: d.dateISO, pieces: 0, uncoveredPieces: 0, sheets: 0, kg: 0 };
    if (!byDay.has(d.dateISO)) byDay.set(d.dateISO, day);
    day.pieces += d.qty;
    for (const l of byMo.get(k)!) {
      const s = ratePerUnit(l) * d.qty;
      const kg = s * eachKg(l);
      cSheets += s; cKg += kg; day.sheets += s; day.kg += kg;
      consumedByLine.set(l, (consumedByLine.get(l) ?? 0) + kg);
      const u = utilizationFraction(l.utilization);
      if (u !== null) { cScrap += kg * (1 - u); cKnownKg += kg; }
      const t = byThickness.get(l.thicknessMm) ?? { sheets: 0, kg: 0 };
      if (!byThickness.has(l.thicknessMm)) byThickness.set(l.thicknessMm, t);
      t.sheets += s; t.kg += kg;
    }
  }
  const days = [...byDay.values()].sort((a, b) => a.dateISO.localeCompare(b.dateISO))
    .map((d) => ({ ...d, pieces: r1(d.pieces), sheets: r1(d.sheets), kg: Math.round(d.kg) }));
  const workedDays = days.length;
  const thicknesses: ThicknessSlice[] = [...byThickness.entries()]
    .map(([thicknessMm, t]) => ({ thicknessMm, sheets: r1(t.sheets), kg: Math.round(t.kg), share: cSheets > 0 ? t.sheets / cSheets : 0 }))
    .filter((t) => t.sheets > 0)
    .sort((a, b) => a.thicknessMm - b.thicknessMm);

  // ---- the sheet as a whole ----
  let pSheets = 0, pKg = 0, nSheets = 0, nKg = 0, nLines = 0, overS = 0, overKg = 0;
  let sScrap = 0, sKnownKg = 0, utilNum = 0, utilDen = 0, remS = 0, remKg = 0;
  const materials = new Map<string, { sheets: number; kg: number; scrapKg: number }>();
  const sizes = new Map<string, { sheets: number; kg: number; scrapKg: number }>();
  const parts = new Map<string, {
    partCode: string; partName: string; mos: Set<string>; unitsPlanned: Map<string, number>; bomRate: number; bomN: number;
    actRate: number; actN: number; plannedKg: number; nestedKg: number; consumedKg: number; scrapKg: number; uNum: number; uDen: number;
  }>();
  const moRows = new Map<string, MoRow & { knownKg: number; uNum: number }>();

  for (const l of lines) {
    const w = eachKg(l);
    const bomS = l.sheetsPerUnit * l.units;
    const nest = nestedSheets(l);
    const u = utilizationFraction(l.utilization);
    pSheets += bomS; pKg += bomS * w;
    const k = moKey(l.mo);
    let lineScrap = 0;
    if (nest !== null) {
      nLines += 1; nSheets += nest; nKg += nest * w;
      overS += nest - bomS; overKg += (nest - bomS) * w;
      if (u !== null) { lineScrap = nest * w * (1 - u); sScrap += lineScrap; sKnownKg += nest * w; utilNum += u * nest * w; utilDen += nest * w; }
    }
    // what the open part of the MO will still take
    const left = Math.max(0, l.units - (closedAll.get(k) ?? 0));
    remS += left * ratePerUnit(l); remKg += left * ratePerUnit(l) * w;

    const matKey = l.material || "—";
    const m = materials.get(matKey) ?? { sheets: 0, kg: 0, scrapKg: 0 };
    if (!materials.has(matKey)) materials.set(matKey, m);
    const z = sizes.get(l.sheetSize || "—") ?? { sheets: 0, kg: 0, scrapKg: 0 };
    if (!sizes.has(l.sheetSize || "—")) sizes.set(l.sheetSize || "—", z);
    const s = nest ?? bomS;
    m.sheets += s; m.kg += s * w; m.scrapKg += lineScrap;
    z.sheets += s; z.kg += s * w; z.scrapKg += lineScrap;

    const pk = l.partCode.trim().toUpperCase() || l.partName.trim().toUpperCase() || "—";
    const p = parts.get(pk) ?? {
      partCode: l.partCode, partName: l.partName, mos: new Set<string>(), unitsPlanned: new Map<string, number>(), bomRate: 0, bomN: 0,
      actRate: 0, actN: 0, plannedKg: 0, nestedKg: 0, consumedKg: 0, scrapKg: 0, uNum: 0, uDen: 0,
    };
    if (!parts.has(pk)) parts.set(pk, p);
    if (k) { p.mos.add(k); p.unitsPlanned.set(k, Math.max(p.unitsPlanned.get(k) ?? 0, l.units)); }
    p.plannedKg += bomS * w;
    if (nest !== null) { p.nestedKg += nest * w; }
    p.consumedKg += consumedByLine.get(l) ?? 0;
    p.scrapKg += lineScrap;
    if (u !== null && nest !== null) { p.uNum += u * nest * w; p.uDen += nest * w; }

    if (k) {
      const row = moRows.get(k) ?? {
        mo: l.mo.trim(), soi: l.soi, part: l.partName || l.partCode, units: l.units, closedUnits: closedAll.get(k) ?? 0,
        plannedKg: 0, nestedKg: null, overKg: null, scrapKg: null, utilization: null, knownKg: 0, uNum: 0,
      };
      if (!moRows.has(k)) moRows.set(k, row);
      row.plannedKg += bomS * w;
      if (nest !== null) {
        row.nestedKg = (row.nestedKg ?? 0) + nest * w;
        row.overKg = (row.overKg ?? 0) + (nest - bomS) * w;
      }
      if (u !== null && nest !== null) { row.scrapKg = (row.scrapKg ?? 0) + lineScrap; row.knownKg += nest * w; row.uNum += u * nest * w; }
    }
  }

  // per part, the per-unit rates are averaged over the part's MOs
  for (const list of byMo.values()) {
    const first = list[0];
    const pk = first.partCode.trim().toUpperCase() || first.partName.trim().toUpperCase() || "—";
    const p = parts.get(pk);
    if (!p) continue;
    p.bomRate += list.reduce((n, l) => n + l.sheetsPerUnit, 0); p.bomN += 1;
    if (list.some((l) => nestedSheets(l) !== null)) { p.actRate += list.reduce((n, l) => n + ratePerUnit(l), 0); p.actN += 1; }
  }

  // units still to close, per MO (its lines share the job's units)
  const remUnits = [...byMo.entries()].reduce((n, [k, list]) => n + Math.max(0, Math.max(...list.map((l) => l.units)) - (closedAll.get(k) ?? 0)), 0);
  const mosTotal = byMo.size;
  const mosNested = [...byMo.values()].filter((list) => list.some((l) => nestedSheets(l) !== null)).length;
  const mosClosed = [...byMo.keys()].filter((k) => closedAll.has(k)).length;
  const mosOpen = [...byMo.entries()].filter(([k, list]) => (closedAll.get(k) ?? 0) < Math.max(...list.map((l) => l.units))).length;

  const partRows: PartRow[] = [...parts.values()].map((p) => ({
    item: ITEM_BY_PART.get(p.partCode.trim().toUpperCase()) ?? null,
    partCode: p.partCode,
    partName: p.partName,
    mos: p.mos.size,
    unitsPlanned: [...p.unitsPlanned.values()].reduce((a, b) => a + b, 0),
    unitsClosed: [...p.mos].reduce((n, k) => n + (closedAll.get(k) ?? 0), 0),
    bomPerUnit: p.bomN ? r2(p.bomRate / p.bomN) : 0,
    actualPerUnit: p.actN ? r2(p.actRate / p.actN) : null,
    plannedKg: Math.round(p.plannedKg),
    nestedKg: Math.round(p.nestedKg),
    consumedKg: Math.round(p.consumedKg),
    scrapKg: Math.round(p.scrapKg),
    utilization: p.uDen > 0 ? p.uNum / p.uDen : null,
  })).sort((a, b) => b.plannedKg - a.plannedKg);

  const mos = [...moRows.values()].map(({ knownKg, uNum, ...m }) => ({
    ...m,
    plannedKg: Math.round(m.plannedKg),
    nestedKg: m.nestedKg === null ? null : Math.round(m.nestedKg),
    overKg: m.overKg === null ? null : Math.round(m.overKg),
    scrapKg: m.scrapKg === null ? null : Math.round(m.scrapKg),
    utilization: knownKg > 0 ? uNum / knownKg : null,
  }));

  return {
    consumed: {
      sheets: r1(cSheets), kg: Math.round(cKg), units: r1(cUnits), closings: inWindow.length, mos: closedInWindow.size,
      scrapKg: Math.round(cScrap), netKg: Math.round(cKg - cScrap), scrapKnownShare: cKg > 0 ? cKnownKg / cKg : 0,
    },
    consumedPerDay: { sheets: workedDays ? r1(cSheets / workedDays) : 0, kg: workedDays ? Math.round(cKg / workedDays) : 0, days: workedDays },
    days,
    thicknesses,
    planned: { sheets: r1(pSheets), kg: Math.round(pKg) },
    nested: { sheets: r1(nSheets), kg: Math.round(nKg), lines: nLines, linesTotal: lines.length },
    overBom: { sheets: r1(overS), kg: Math.round(overKg) },
    scrap: { kg: Math.round(sScrap), share: sKnownKg > 0 ? sScrap / sKnownKg : 0, knownShare: nKg > 0 ? sKnownKg / nKg : 0 },
    utilization: utilDen > 0 ? utilNum / utilDen : null,
    remaining: { sheets: r1(remS), kg: Math.round(remKg), units: remUnits },
    mos: { total: mosTotal, nested: mosNested, closed: mosClosed, open: mosOpen },
    materials: breakdown(materials, [...materials.values()].reduce((n, v) => n + v.kg, 0)),
    sizes: breakdown(sizes, [...sizes.values()].reduce((n, v) => n + v.kg, 0)),
    parts: partRows,
    topScrap: mos.filter((m) => (m.scrapKg ?? 0) > 0).sort((a, b) => (b.scrapKg ?? 0) - (a.scrapKg ?? 0)).slice(0, 10),
    topOver: mos.filter((m) => (m.overKg ?? 0) > 0).sort((a, b) => (b.overKg ?? 0) - (a.overKg ?? 0)).slice(0, 10),
  };
}
