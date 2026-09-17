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

export interface MaterialPageData {
  lines: MaterialLineView[];
  totals: MaterialTotal[];
  /** Every month the tab can filter by: months with material lines, plus the
   *  monthly plans the registry knows, newest first. */
  months: string[];
  /** BOMs for the add form's typing aid: those with lines, plus the registry's. */
  knownBoms: string[];
}

type Row = {
  id: number; month: string; bom: string; mo: string; units: number; partCode: string; partName: string; materialCode: string;
  material: string; thicknessMm: number;
  sheetSize: string; sheetsPerUnit: number; actualPerUnit: number | null; actualPerUnitManual: boolean;
  sheetsUsed: number | null; producedQty: number | null;
  note: string | null; recordedBy: string | null; updatedAt: Date;
};

function toView(r: Row, soiByBom: Record<string, string>): MaterialLineView {
  const forJob = sheetsForJob(r.sheetsPerUnit, r.units);
  return {
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
    forProduced: sheetsForProduced(r.actualPerUnit, r.sheetsUsed, r.units, r.producedQty),
    updatedISO: r.updatedAt.toISOString().slice(0, 10),
    recordedBy: r.recordedBy,
  };
}

const monthsOf = (csv: string | null | undefined, source?: string | null) =>
  (String(csv ?? "").trim() || String(source ?? "")).split(",").map((m) => m.trim()).filter(Boolean);

/** The tab for one month (label), or every month when `month` is "all". */
export async function getMaterialData(month: string): Promise<MaterialPageData> {
  const line = await getActiveLine(); // one product line at a time
  const [rows, monthRows, orders, soi] = await Promise.all([
    prisma.materialUsage.findMany({
      where: month === "all" ? { line } : { month, line },
      // the sheet's own order — its rows come back the way they were laid out;
      // lines typed in the tab (sortOrder 0, or the manual marker) sort by age
      orderBy: [{ month: "desc" }, { sortOrder: "asc" }, { id: "asc" }],
    }),
    prisma.materialUsage.findMany({ where: { line }, select: { month: true, bom: true }, distinct: ["month", "bom"] }),
    prisma.masterOrder.findMany({ where: { line }, select: { bom: true, months: true, source: true } }),
    getSoiLookup(),
  ]);

  const lines = rows.map((r) => toView(r, soi.byBom));
  const months = [...new Set([...monthRows.map((m) => m.month), ...orders.flatMap((o) => monthsOf(o.months, o.source))])]
    .filter(Boolean)
    .sort((a, b) => monthLabelSortKey(b) - monthLabelSortKey(a) || b.localeCompare(a));
  const knownBoms = [...new Set([...monthRows.map((m) => m.bom), ...orders.map((o) => o.bom)])].sort();

  return { lines, totals: summarizeMaterial(lines), months, knownBoms };
}

// ---- import: the planner's Nesting Tracker workbook, filed under a month ----

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
}

/**
 * Import the Nesting Tracker sheet for one month. Lines are upserted on their
 * identity (month × BOM × part × material × thickness × size), so importing the same
 * month's sheet again adds the rows that are new and updates the ones whose
 * values changed — never doubles them. The tab's own column, units produced,
 * is not in the sheet and is left exactly as it was.
 */
export async function importNestingTracker(
  buffer: ArrayBuffer, month: string, recordedBy: string | null, preview = false
): Promise<MaterialImportResult> {
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
  const { rows, issues, recomputed } = parseNestingTracker(grid);
  if (rows.length === 0) return { ok: false, error: issues[0] ?? "No material rows found.", issues, sheet: sheetName };

  const line = await getActiveLine(); // the sheet is the line on screen's
  const existing = await prisma.materialUsage.findMany({ where: { month, mo: "", line } });
  const byKey = new Map(existing.map((e) => [`${e.bom}|${e.partCode}|${e.material}|${e.thicknessMm}|${e.sheetSize}`, e]));

  let added = 0, updated = 0, unchanged = 0;
  for (const r of rows) {
    const cur = byKey.get(`${r.bom}|${r.partCode}|${r.material}|${r.thicknessMm}|${r.sheetSize}`);
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
    const key = { month, bom: r.bom, mo: "", partCode: r.partCode, material: r.material, thicknessMm: r.thicknessMm, sheetSize: r.sheetSize };
    await prisma.materialUsage.upsert({
      where: { month_bom_mo_partCode_material_thicknessMm_sheetSize: key },
      create: { ...key, ...data, note: r.note, line },
      update: data,
    });
  }
  return { ok: true, added, updated, unchanged, issues, preview, sheet: sheetName, recomputed };
}
