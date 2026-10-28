import "server-only";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { getActiveLine } from "./line";
import {
  actualPerUnit, materialPlanIndex, materialPlanMonths, traceMaterialMatch, parseNestingTracker, sheetsDifference, sheetsForJob, sheetsForProduced,
  type MaterialLineView, type MaterialPlanIndex,
} from "@/lib/domain/material";
import { lvActualRate, lvRemainingUnits, parseLvConsumption } from "@/lib/domain/lvMaterial";
import { LV_ITEM } from "@/lib/domain/lv";
import { ODOO_DONE_STATUS } from "@/lib/domain/odoo";
import type { ProductLine } from "@/lib/domain/lines";

export interface MaterialPageData {
  lines: MaterialLineView[];
  /** Each MO the ODOO log carries (upper case) → its status there, so the
   *  sheet's rows show which MOs the clerk has typed in. */
  odooByMo: Record<string, string>;
}

type Row = {
  id: number; month: string; bom: string; mo: string; units: number; partCode: string; partName: string; materialCode: string;
  material: string; thicknessMm: number;
  sheetSize: string; sheetsPerUnit: number; actualPerUnit: number | null; actualPerUnitManual: boolean;
  sheetsUsed: number | null; producedQty: number | null;
  soi: string; mtr: string; weightKg: number | null; utilization: number | null;
  note: string | null; recordedBy: string | null; updatedAt: Date;
};

/** `lv`: only the panels' tab counts units produced — a transformer line's
 *  old typed quantity is no longer shown or costed. */
function toView(r: Row, lv: boolean, plans: MaterialPlanIndex, doneByMo: ReadonlyMap<string, string>, producedAuto: number | null = null): MaterialLineView {
  const plan = materialPlanMonths(r, plans, doneByMo.get(r.mo.trim().toUpperCase()) ?? null);
  const forJob = sheetsForJob(r.sheetsPerUnit, r.units);
  // the sheet's count; else the tracker's painted count on the line's own order
  const producedUsed = lv ? (r.producedQty ?? producedAuto) : null;
  return {
    producedAuto,
    producedUsed,
    remainingUnits: r.mo ? lvRemainingUnits(r.units, producedUsed) : null,
    id: r.id, month: r.month, bom: r.bom, mo: r.mo, units: r.units,
    partCode: r.partCode, partName: r.partName, materialCode: r.materialCode, material: r.material,
    thicknessMm: r.thicknessMm, sheetSize: r.sheetSize, sheetsPerUnit: r.sheetsPerUnit,
    sheetsUsed: r.sheetsUsed, producedQty: r.producedQty, note: r.note,
    soi: r.soi, mtr: r.mtr, weightKg: r.weightKg, utilization: r.utilization,
    actualWeightKg: r.sheetsUsed !== null && r.weightKg !== null ? Math.round(r.sheetsUsed * r.weightKg * 100) / 100 : null,
    forJob,
    difference: sheetsDifference(forJob, r.sheetsUsed),
    // the sheet's own rate where there is one; the old division only where
    // the line predates the column or was typed in by hand
    actualPerUnit: actualPerUnit(r.actualPerUnit, r.sheetsUsed, r.units),
    forProduced: sheetsForProduced(r.actualPerUnit, r.sheetsUsed, r.units, producedUsed),
    updatedISO: r.updatedAt.toISOString().slice(0, 10),
    recordedBy: r.recordedBy,
    planMonths: plan.months,
    planMatch: plan.match,
  };
}

/** The tab: the living sheet (`month` "", the default), one older sheet
 *  filed under its plan month, or everything ("all"). */
export async function getMaterialData(month: string): Promise<MaterialPageData> {
  const line = await getActiveLine(); // one product line at a time
  return loadMaterial(line, month === "all" ? { line } : { month, line });
}

/** One order's (or one code's) lines of the sheet, for its trace — which
 *  lines, lib/domain/material.ts traceMaterialMatch says. */
export async function getTraceMaterial(line: ProductLine, target: { scope: "mo" | "bom"; mos: readonly string[]; bom: string; sois: readonly string[] }): Promise<MaterialPageData> {
  const up = (v: string) => v.trim().toUpperCase();
  const mos = [...new Set(target.mos.map(up).filter(Boolean))];
  const sois = [...new Set(target.sois.map(up).filter(Boolean))];
  const bom = up(target.bom);
  const any = (field: "mo" | "soi" | "bom", values: readonly string[]) => values.map((v) => ({ [field]: { equals: v, mode: "insensitive" as const } }));
  const or: Prisma.MaterialUsageWhereInput[] = [...any("mo", mos), ...any("soi", sois), ...(bom ? any("bom", [bom]) : [])];
  if (or.length === 0) return { lines: [], odooByMo: {} };
  const [data, soiOrders] = await Promise.all([
    // the living table, as the tab shows it
    loadMaterial(line, { line, month: "", OR: or }),
    sois.length > 0
      ? prisma.masterOrder.findMany({ where: { line, OR: any("soi", sois) as Prisma.MasterOrderWhereInput[] }, select: { mo: true, soi: true, bom: true } })
      : Promise.resolve([]),
  ]);
  const lines = data.lines.filter(traceMaterialMatch({ scope: target.scope, mos, sois, bom, soiOrders: soiOrders.map((o) => ({ mo: o.mo, soi: o.soi ?? "", bom: o.bom })) }));
  return { lines, odooByMo: data.odooByMo };
}

async function loadMaterial(line: ProductLine, where: Prisma.MaterialUsageWhereInput): Promise<MaterialPageData> {
  const lv = line === "LV";
  const [rows, odoo, orders, painted] = await Promise.all([
    prisma.materialUsage.findMany({
      where,
      // the sheet's own order — its rows come back the way they were laid out;
      // lines typed in the tab (sortOrder 0, or the manual marker) sort by age
      orderBy: [{ month: "desc" }, { sortOrder: "asc" }, { id: "asc" }],
    }),
    prisma.odooEntry.findMany({ where: { line, odooMo: { not: "" } }, select: { odooMo: true, status: true, date: true }, orderBy: [{ date: "asc" }, { id: "asc" }] }),
    // every order of the line, closed ones too: a month's sheet stays that month's
    prisma.masterOrder.findMany({ where: { line }, select: { mo: true, soi: true, bom: true, months: true, source: true, planQty: true } }),
    lv ? prisma.handoverEntry.groupBy({ by: ["mo"], where: { dept: "Painting", item: LV_ITEM, mo: { not: null } }, _sum: { qty: true } }) : null,
  ]);
  const paintedByMo = painted ? lvPaintedByMo(orders, painted) : new Map<string, number>();
  // the latest row of an MO speaks for it: its status, and — Done — the day
  // of that closing (the row's own day, not when it was ticked)
  const odooByMo: Record<string, string> = {};
  const doneByMo = new Map<string, string>();
  for (const o of odoo) {
    const mo = o.odooMo.trim().toUpperCase();
    odooByMo[mo] = o.status;
    if (o.status === ODOO_DONE_STATUS) doneByMo.set(mo, o.date.toISOString().slice(0, 10));
    else doneByMo.delete(mo);
  }

  const plans = materialPlanIndex(orders.map((o) => ({ ...o, months: (o.months || o.source || "").split(",") })));
  const lines = rows.map((r) => toView(r, lv, plans, doneByMo, lv && r.mo ? (paintedByMo.get(r.mo) ?? 0) : null));

  return { lines, odooByMo };
}

/** Each panel order's MO → the panels the tracker says were painted on it
 *  (never more than the order) — the produced count the LV tab costs its
 *  lines by where the sheet gives none. */
function lvPaintedByMo(orders: readonly { mo: string; planQty: number }[], painted: readonly { mo: string | null; _sum: { qty: number | null } }[]): Map<string, number> {
  const by = new Map(painted.map((p) => [p.mo!, Math.max(0, p._sum.qty ?? 0)]));
  return new Map(orders.map((o) => [o.mo, Math.min(o.planQty, by.get(o.mo) ?? 0)]));
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
  /** Lines of the tab's table the file no longer carries — removed when the
   *  import was asked to, else kept. */
  missing?: number;
  removed?: number;
}

/** The tab's lines that the file no longer carries: the ids to drop when the
 *  import mirrors the file. The sheet is the tab's only source, so a line
 *  typed in by hand before typing was closed goes like any other. */
async function rowsGone(line: string, month: string, seen: Set<number>, prune: boolean, preview: boolean) {
  const gone = (await prisma.materialUsage.findMany({ where: { line, month }, select: { id: true } }))
    .map((r) => r.id).filter((id) => !seen.has(id));
  let removed = 0;
  if (prune && !preview && gone.length > 0) removed = (await prisma.materialUsage.deleteMany({ where: { id: { in: gone } } })).count;
  return { missing: gone.length, removed };
}

/** Mirroring the file removes the rows it no longer carries — but a row the
 *  parser had to skip (a #VALUE! thickness, a blank size) IS in the file: its
 *  line stays, and the person is told why nothing was removed. `skipped` is
 *  the parser's own count of those rows, never read back from message text. */
function pruneSafely(prune: boolean, skipped: number, issues: string[]): boolean {
  if (!prune) return false;
  if (skipped === 0) return true;
  issues.push(`${skipped} row(s) could not be read, so nothing was removed — fix them and upload again to mirror the file.`);
  return false;
}

/**
 * Import the material sheet into the tab's one table — no month: each row is
 * known by its MO (Odoo's, per part), BOM, part, material, thickness and
 * size, so uploading the sheet again adds the rows that are new and updates
 * the ones whose values changed — never doubles them. The sheet is the
 * tab's only source: what it says replaces what the line held (a blank note
 * aside). With `prune`, every line the file no longer carries leaves the
 * table.
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
  const { rows, issues, recomputed, skipped } = parseNestingTracker(grid);
  if (rows.length === 0) return { ok: false, error: issues[0] ?? "No material rows found.", issues, sheet: sheetName };

  // a line is its MO's when the sheet names one (the newer sheet: Odoo's MO
  // per part), else the BOM's (mo "")
  const existing = await prisma.materialUsage.findMany({ where: { month, line } });
  const keyOf = (e: { bom: string; mo: string; partCode: string; material: string; thicknessMm: number; sheetSize: string }) =>
    `${e.bom}|${e.mo}|${e.partCode}|${e.material}|${e.thicknessMm}|${e.sheetSize}`;
  const byKey = new Map(existing.map((e) => [keyOf(e), e]));

  let added = 0, updated = 0, unchanged = 0;
  const seen = new Set<number>();
  const creates: Prisma.MaterialUsageCreateManyInput[] = [];
  const updates: { id: number; data: Prisma.MaterialUsageUpdateInput }[] = [];
  // a sheet may list the same line twice — the later row wins, as it would
  // have row by row
  const last = new Map<string, (typeof rows)[number]>();
  for (const r of rows) last.set(keyOf(r), r);
  for (const r of last.values()) {
    const cur = byKey.get(keyOf(r));
    if (cur) seen.add(cur.id);
    // the sheet is the only source: its rate replaces one typed in the tab
    // before typing was closed
    const same = cur && cur.units === r.units && cur.sheetsPerUnit === r.sheetsPerUnit
      && !cur.actualPerUnitManual && cur.actualPerUnit === r.actualPerUnit && cur.sheetsUsed === r.sheetsUsed && cur.partName === r.partName && cur.materialCode === r.materialCode
      && cur.sortOrder === r.rowNum && cur.soi === r.soi && cur.mtr === r.mtr && cur.weightKg === r.weightKg && cur.utilization === r.utilization
      && (cur.note ?? null) === (r.note ?? cur.note ?? null);
    if (!cur) added += 1; else if (same) unchanged += 1; else updated += 1;
    if (preview || same) continue;

    const data = {
      units: r.units, partName: r.partName, materialCode: r.materialCode,
      sheetsPerUnit: r.sheetsPerUnit, sheetsUsed: r.sheetsUsed,
      soi: r.soi, mtr: r.mtr, weightKg: r.weightKg, utilization: r.utilization,
      sortOrder: r.rowNum, // the sheet's row — the tab reads in this order
      actualPerUnit: r.actualPerUnit, actualPerUnitManual: false,
      // a sheet without the optional Notes column must not erase the notes
      ...(r.note !== null ? { note: r.note } : {}),
      recordedBy,
    };
    if (cur) updates.push({ id: cur.id, data });
    else creates.push({ month, bom: r.bom, mo: r.mo, partCode: r.partCode, material: r.material, thicknessMm: r.thicknessMm, sheetSize: r.sheetSize, ...data, note: r.note, line });
  }
  // in bulk — a sheet of hundreds of rows written one by one outlasted the
  // request and stopped part-way
  if (creates.length) await prisma.materialUsage.createMany({ data: creates, skipDuplicates: true });
  for (let i = 0; i < updates.length; i += 100) {
    await prisma.$transaction(updates.slice(i, i + 100).map((u) => prisma.materialUsage.update({ where: { id: u.id }, data: u.data })));
  }
  const { missing, removed } = await rowsGone(line, month, seen, pruneSafely(prune, skipped, issues), preview);
  return { ok: true, added, updated, unchanged, issues, preview, sheet: sheetName, recomputed, missing, removed };
}

/**
 * The panels' "Consumption Details" sheet: one line per order × thickness,
 * keyed on month × BOM × MO × material × thickness × size. The planned qty,
 * the sheets per unit and what was consumed so far come off the sheet; a
 * running block's "For 8 Units 14.4 Sheets Consumed" lands as produced 8
 * with the rate 14.4 ÷ 8, a Done block as the whole job nested. A bare
 * number with neither says nothing a line can hold — the job is not nested
 * yet and no unit count came with it — so the import says so for that row.
 */
async function importLvConsumption(grid: unknown[][], month: string, recordedBy: string | null, preview: boolean, sheetName: string, prune: boolean): Promise<MaterialImportResult> {
  const { rows, issues, skipped } = parseLvConsumption(grid);
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
    // a bare number in the consumed cell on a block that is neither Done nor
    // "For N units": not the job's nesting (it is still running) and no rate
    // (no unit count) — said out loud rather than dropped in silence
    if (r.consumed !== null && !r.done && r.producedQty === null) {
      issues.push(`Row ${r.rowNum}: ${r.mo} shows ${r.consumed} sheets consumed but neither "Done" nor "For N units" — not counted yet; write "For N units" on the sheet, or "Done" once the job is nested.`);
    }
    // the job's nesting is what a DONE block consumed; a running one is not it
    const used = r.done ? r.consumed : null;
    // a running block: the rate is what was consumed over what was produced.
    // The sheet is the only source — its rate and produced count replace any
    // typed in the tab before typing was closed; a produced count the sheet
    // leaves out falls back to the panels painted on the tracker
    const rate = lvActualRate(r);
    const data = {
      units: r.units, partName: r.product, materialCode: r.secItem,
      sheetsPerUnit: r.sheetsPerUnit,
      sheetsUsed: used,
      actualPerUnit: rate, actualPerUnitManual: false,
      producedQty: r.producedQty,
      sortOrder: r.rowNum,
      // a blank remark must not erase the notes
      ...(r.note !== null ? { note: r.note } : {}),
      recordedBy,
    };
    const same = cur && cur.units === data.units && cur.sheetsPerUnit === data.sheetsPerUnit && cur.sheetsUsed === used
      && !cur.actualPerUnitManual && cur.actualPerUnit === rate && cur.producedQty === r.producedQty && cur.partName === data.partName && cur.materialCode === data.materialCode
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
  const { missing, removed } = await rowsGone("LV", month, seen, pruneSafely(prune, skipped, issues), preview);
  return { ok: true, added, updated, unchanged, issues, preview, sheet: sheetName, recomputed: 0, missing, removed };
}
