import "server-only";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/db";
import { getActiveLine } from "./line";
import { getSoiLookup } from "@/lib/server/soi";
import { monthLabelSortKey } from "@/lib/domain/dates";
import {
  actualPerUnit, parseNestingTracker, sheetsDifference, sheetsForJob, sheetsForProduced, summarizeMaterial,
  type MaterialLineView, type MaterialTotal,
} from "@/lib/domain/material";
import { lvRemainingUnits, parseLvConsumption } from "@/lib/domain/lvMaterial";
import { LV_ITEM } from "@/lib/domain/lv";

/** One panel order as the LV tab offers it: what to add material for, and
 *  how many panels the tracker says were painted — the produced count. */
export interface LvOrderRef {
  mo: string;
  bom: string;
  product: string | null;
  secItem: string | null;
  planQty: number;
  painted: number;
  status: string;
}

export interface MaterialPageData {
  lines: MaterialLineView[];
  totals: MaterialTotal[];
  /** The older sheets filed under a plan month, newest first — the tab's
   *  archive. The living sheet ("") is not among them. */
  months: string[];
  /** BOMs for the add form's typing aid: those with lines, plus the registry's. */
  knownBoms: string[];
  /** The panels' orders (LV only): the add-order picker and the produced counts. */
  lvOrders: LvOrderRef[];
  /** LV only: the thickness rows already recorded under each BOM, on any
   *  order — the template a new order of that BOM starts from. */
  lvTemplates: Record<string, { material: string; thicknessMm: number; sheetSize: string; sheetsPerUnit: number }[]>;
  /** Each MO the ODOO tab carries (upper case) → its status there, so the
   *  sheet's rows show which MOs the clerk has typed in. */
  odooByMo: Record<string, string>;
}

type Row = {
  id: number; month: string; bom: string; mo: string; units: number; partCode: string; partName: string; materialCode: string;
  material: string; thicknessMm: number;
  sheetSize: string; sheetsPerUnit: number; actualPerUnit: number | null; actualPerUnitManual: boolean;
  sheetsUsed: number | null; producedQty: number | null;
  note: string | null; recordedBy: string | null; updatedAt: Date;
};

function toView(r: Row, soiByBom: Record<string, string>, producedAuto: number | null = null): MaterialLineView {
  const forJob = sheetsForJob(r.sheetsPerUnit, r.units);
  // typed wins; else the tracker's painted count on the line's own order
  const producedUsed = r.producedQty ?? producedAuto;
  return {
    producedAuto,
    producedUsed,
    remainingUnits: r.mo ? lvRemainingUnits(r.units, producedUsed) : null,
    id: r.id, month: r.month, bom: r.bom, mo: r.mo, units: r.units,
    partCode: r.partCode, partName: r.partName, materialCode: r.materialCode, material: r.material,
    thicknessMm: r.thicknessMm, sheetSize: r.sheetSize, sheetsPerUnit: r.sheetsPerUnit,
    sheetsUsed: r.sheetsUsed, producedQty: r.producedQty, note: r.note,
    soi: soiByBom[r.bom] ?? null,
    forJob,
    difference: sheetsDifference(forJob, r.sheetsUsed),
    // the sheet's own rate where there is one; the old division only where
    // the line predates the column or was typed in by hand
    actualPerUnit: actualPerUnit(r.actualPerUnit, r.sheetsUsed, r.units),
    actualPerUnitManual: r.actualPerUnitManual,
    forProduced: sheetsForProduced(r.actualPerUnit, r.sheetsUsed, r.units, producedUsed),
    updatedISO: r.updatedAt.toISOString().slice(0, 10),
    recordedBy: r.recordedBy,
  };
}

/** The tab: the living sheet (`month` "", the default), one older sheet
 *  filed under its plan month, or everything ("all"). */
export async function getMaterialData(month: string): Promise<MaterialPageData> {
  const line = await getActiveLine(); // one product line at a time
  const [rows, monthRows, orders, soi, odoo] = await Promise.all([
    prisma.materialUsage.findMany({
      where: month === "all" ? { line } : { month, line },
      // the sheet's own order — its rows come back the way they were laid out;
      // lines typed in the tab (sortOrder 0, or the manual marker) sort by age
      orderBy: [{ month: "desc" }, { sortOrder: "asc" }, { id: "asc" }],
    }),
    prisma.materialUsage.findMany({ where: { line }, select: { month: true, bom: true }, distinct: ["month", "bom"] }),
    prisma.masterOrder.findMany({ where: { line }, select: { bom: true } }),
    getSoiLookup(),
    prisma.odooEntry.findMany({ where: { line, odooMo: { not: "" } }, select: { odooMo: true, status: true }, orderBy: { date: "asc" } }),
  ]);

  const lvOrders = line === "LV" ? await lvOrderRefs() : [];
  const paintedByMo = new Map(lvOrders.map((o) => [o.mo, o.painted]));
  const lines = rows.map((r) => toView(r, soi.byBom, line === "LV" && r.mo ? (paintedByMo.get(r.mo) ?? 0) : null));
  const months = [...new Set(monthRows.map((m) => m.month))]
    .filter(Boolean)
    .sort((a, b) => monthLabelSortKey(b) - monthLabelSortKey(a) || b.localeCompare(a));
  const knownBoms = [...new Set([...monthRows.map((m) => m.bom), ...orders.map((o) => o.bom)])].sort();

  // the rows a BOM was recorded with, on any order, newest month first — the
  // template a new order of the same BOM starts from
  const lvTemplates: MaterialPageData["lvTemplates"] = {};
  if (line === "LV") {
    const all = month === "all" ? rows : await prisma.materialUsage.findMany({ where: { line }, orderBy: [{ month: "desc" }, { sortOrder: "asc" }, { id: "asc" }] });
    for (const r of all) {
      const list = (lvTemplates[r.bom] ??= []);
      if (!list.some((t) => t.material === r.material && t.thicknessMm === r.thicknessMm && t.sheetSize === r.sheetSize)) {
        list.push({ material: r.material, thicknessMm: r.thicknessMm, sheetSize: r.sheetSize, sheetsPerUnit: r.sheetsPerUnit });
      }
    }
    for (const list of Object.values(lvTemplates)) list.sort((a, b) => a.thicknessMm - b.thicknessMm);
  }

  // the latest row of an MO speaks for it
  const odooByMo: Record<string, string> = {};
  for (const o of odoo) odooByMo[o.odooMo.trim().toUpperCase()] = o.status;

  return { lines, totals: summarizeMaterial(lines), months, knownBoms, lvOrders, lvTemplates, odooByMo };
}

/** The panels' orders with what the tracker says was painted on each — the
 *  produced count the LV tab costs its lines by. */
async function lvOrderRefs(): Promise<LvOrderRef[]> {
  const [orders, painted] = await Promise.all([
    prisma.masterOrder.findMany({ where: { line: "LV" }, select: { mo: true, bom: true, product: true, secItem: true, planQty: true, status: true }, orderBy: { mo: "asc" } }),
    prisma.handoverEntry.groupBy({ by: ["mo"], where: { dept: "Painting", item: LV_ITEM, mo: { not: null } }, _sum: { qty: true } }),
  ]);
  const by = new Map(painted.map((p) => [p.mo!, Math.max(0, p._sum.qty ?? 0)]));
  return orders.map((o) => ({ mo: o.mo, bom: o.bom, product: o.product, secItem: o.secItem, planQty: o.planQty, painted: Math.min(o.planQty, by.get(o.mo) ?? 0), status: o.status }));
}

// ---- import: the planner's material sheet — one living table, row by MO ----

export interface MaterialImportResult {
  ok: boolean;
  error?: string;
  added?: number;
  updated?: number;
  unchanged?: number;
  issues?: string[];
  preview?: boolean;
  sheet?: string;
  /** Rows whose "for Job" column disagrees with their own per-unit rate —
   *  kept as written, counted so the planner can look. */
  recomputed?: number;
  /** Rows of the tab's table the file no longer carries (lines typed in the
   *  tab aside) — removed when the import was asked to, else kept. */
  missing?: number;
  removed?: number;
}

/** The sheet's rows on the tab that the file no longer carries: the ids to
 *  drop when the import mirrors the file. Lines typed in the tab stay. */
async function rowsGone(line: string, month: string, seen: Set<number>, prune: boolean, preview: boolean) {
  const gone = (await prisma.materialUsage.findMany({ where: { line, month, sortOrder: { gt: 0, lt: MANUAL_SORT } }, select: { id: true } }))
    .map((r) => r.id).filter((id) => !seen.has(id));
  let removed = 0;
  if (prune && !preview && gone.length > 0) removed = (await prisma.materialUsage.deleteMany({ where: { id: { in: gone } } })).count;
  return { missing: gone.length, removed };
}

/** Lines typed in the tab sort after any sheet's rows (a sheet has fewer rows than this). */
export const MANUAL_SORT = 1_000_000;

/**
 * Import the material sheet into the tab's one table — no month: each row is
 * known by its MO (Odoo's, per part), BOM, part, material, thickness and
 * size, so uploading the sheet again adds the rows that are new and updates
 * the ones whose values changed — never doubles them. The tab's own column,
 * units produced, is not in the sheet and is left exactly as it was. With
 * `prune`, rows the file no longer carries leave the table.
 */
export async function importNestingTracker(
  buffer: ArrayBuffer, recordedBy: string | null, preview = false, prune = false
): Promise<MaterialImportResult> {
  const month = ""; // the living table
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(new Uint8Array(buffer), { cellDates: false });
  } catch {
    return { ok: false, error: "Could not read the file — make sure it is a valid Excel file." };
  }
  // the workbook carries pivots and lookup tabs beside the tracker — take the
  // tab NAMED for it, else the first one
  const sheetName = wb.SheetNames.find((n) => /nesting/i.test(n)) ?? wb.SheetNames[0];
  const ws = sheetName ? wb.Sheets[sheetName] : undefined;
  if (!ws) return { ok: false, error: "The file has no sheets." };

  const opts: XLSX.Sheet2JSONOpts = { header: 1, raw: true, defval: null, blankrows: true };
  if (ws["!ref"]) {
    const range = XLSX.utils.decode_range(ws["!ref"]);
    range.s.r = 0; range.s.c = 0;
    opts.range = XLSX.utils.encode_range(range);
  }
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, opts);
  const line = await getActiveLine(); // the sheet is the line on screen's
  if (line === "LV") return importLvConsumption(grid, month, recordedBy, preview, sheetName, prune);
  const { rows, issues, recomputed } = parseNestingTracker(grid);
  if (rows.length === 0) return { ok: false, error: issues[0] ?? "No material rows found.", issues, sheet: sheetName };

  // a line is its MO's when the sheet names one (the newer sheet: Odoo's MO
  // per part), else the BOM's (mo "")
  const existing = await prisma.materialUsage.findMany({ where: { month, line } });
  const keyOf = (e: { bom: string; mo: string; partCode: string; material: string; thicknessMm: number; sheetSize: string }) =>
    `${e.bom}|${e.mo}|${e.partCode}|${e.material}|${e.thicknessMm}|${e.sheetSize}`;
  const byKey = new Map(existing.map((e) => [keyOf(e), e]));

  let added = 0, updated = 0, unchanged = 0;
  const seen = new Set<number>();
  for (const r of rows) {
    const cur = byKey.get(keyOf(r));
    if (cur) seen.add(cur.id);
    // A rate typed in the tab is the planner's own statement about a line the
    // sheet leaves blank. The import fills the blanks; it never overwrites his.
    const keepsRate = cur?.actualPerUnitManual === true;
    const same = cur && cur.units === r.units && cur.sheetsPerUnit === r.sheetsPerUnit
      && (keepsRate || cur.actualPerUnit === r.actualPerUnit) && cur.sheetsUsed === r.sheetsUsed && cur.partName === r.partName && cur.materialCode === r.materialCode
      && cur.sortOrder === r.rowNum
      && (cur.note ?? null) === (r.note ?? cur.note ?? null);
    if (!cur) added += 1; else if (same) unchanged += 1; else updated += 1;
    if (preview || same) continue;

    const data = {
      units: r.units, partName: r.partName, materialCode: r.materialCode,
      sheetsPerUnit: r.sheetsPerUnit, sheetsUsed: r.sheetsUsed,
      sortOrder: r.rowNum, // the sheet's row — the tab reads in this order
      ...(keepsRate ? {} : { actualPerUnit: r.actualPerUnit }),
      // a blank note in the sheet must not erase one typed in the tab
      ...(r.note !== null ? { note: r.note } : {}),
      recordedBy,
    };
    const key = { month, bom: r.bom, mo: r.mo, partCode: r.partCode, material: r.material, thicknessMm: r.thicknessMm, sheetSize: r.sheetSize };
    await prisma.materialUsage.upsert({
      where: { month_bom_mo_partCode_material_thicknessMm_sheetSize: key },
      create: { ...key, ...data, note: r.note, line },
      update: data,
    });
  }
  const { missing, removed } = await rowsGone(line, month, seen, prune, preview);
  return { ok: true, added, updated, unchanged, issues, preview, sheet: sheetName, recomputed, missing, removed };
}

/**
 * The panels' "Consumption Details" sheet: one line per order × thickness,
 * keyed on month × BOM × MO × material × thickness × size. The planned qty,
 * the sheets per unit and what was consumed so far come off the sheet; a
 * running block's "For 8 Units 14.4 Sheets Consumed" lands as produced 8
 * with the rate 14.4 ÷ 8, a Done block as the whole job nested.
 */
async function importLvConsumption(grid: unknown[][], month: string, recordedBy: string | null, preview: boolean, sheetName: string, prune: boolean): Promise<MaterialImportResult> {
  const { rows, issues } = parseLvConsumption(grid);
  if (rows.length === 0) return { ok: false, error: issues[0] ?? "No material rows found.", issues, sheet: sheetName };
  const existing = await prisma.materialUsage.findMany({ where: { month, line: "LV" } });
  const keyOf = (r: { bom: string; mo: string; material: string; thicknessMm: number; sheetSize: string }) => `${r.bom}|${r.mo}|${r.material}|${r.thicknessMm}|${r.sheetSize}`;
  const byKey = new Map(existing.map((e) => [keyOf(e), e]));
  const known = new Set((await prisma.masterOrder.findMany({ where: { line: "LV" }, select: { mo: true } })).map((o) => o.mo));

  let added = 0, updated = 0, unchanged = 0;
  const seen = new Set<number>();
  for (const r of rows) {
    if (!known.has(r.mo)) issues.push(`Row ${r.rowNum}: ${r.mo} is not in the LV orders registry — the line is kept, but the tracker cannot count its panels.`);
    const cur = byKey.get(keyOf(r));
    if (cur) seen.add(cur.id);
    // a running block: the rate is what was consumed over what was produced
    const rate = r.done ? null : r.producedQty && r.consumed !== null && r.producedQty > 0 ? Math.round((r.consumed / r.producedQty) * 10000) / 10000 : null;
    const data = {
      units: r.units, partName: r.product, materialCode: r.secItem,
      sheetsPerUnit: r.sheetsPerUnit,
      sheetsUsed: r.done ? r.consumed : null,
      actualPerUnit: rate,
      producedQty: r.producedQty,
      sortOrder: r.rowNum,
      ...(r.note !== null ? { note: r.note } : {}),
      recordedBy,
    };
    const same = cur && cur.units === data.units && cur.sheetsPerUnit === data.sheetsPerUnit && cur.sheetsUsed === data.sheetsUsed
      && cur.actualPerUnit === data.actualPerUnit && cur.producedQty === data.producedQty && cur.partName === data.partName && cur.materialCode === data.materialCode
      && cur.sortOrder === data.sortOrder && (cur.note ?? null) === (r.note ?? cur.note ?? null);
    if (!cur) added += 1; else if (same) unchanged += 1; else updated += 1;
    if (preview || same) continue;
    const key = { month, bom: r.bom, mo: r.mo, partCode: "", material: r.material, thicknessMm: r.thicknessMm, sheetSize: r.sheetSize };
    await prisma.materialUsage.upsert({
      where: { month_bom_mo_partCode_material_thicknessMm_sheetSize: key },
      create: { ...key, ...data, note: r.note, line: "LV" },
      update: data,
    });
  }
  const { missing, removed } = await rowsGone("LV", month, seen, prune, preview);
  return { ok: true, added, updated, unchanged, issues, preview, sheet: sheetName, recomputed: 0, missing, removed };
}
