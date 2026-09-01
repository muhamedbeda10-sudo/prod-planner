import "server-only";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/db";
import {
  parseNestingTracker,
  resolveUnits,
  round3,
  sheetsDifference,
  sheetsForJob,
  summarizeMaterial,
  type MaterialLineView,
  type MaterialTotal,
} from "@/lib/domain/material";

export interface MaterialOrderRef {
  mo: string;
  bom: string;
  planQty: number;
  customer: string | null;
  status: string;
}

/** Every order the registry knows, as the material page's BOM/MO pickers. */
export async function getMaterialOrders(): Promise<MaterialOrderRef[]> {
  const orders = await prisma.masterOrder.findMany({
    select: { mo: true, bom: true, planQty: true, customer: true, status: true },
    orderBy: [{ bom: "asc" }, { mo: "asc" }],
  });
  return orders;
}

/** planQty behind a line: the named MO's own quantity, or every order on the
 *  BOM added up when the line is BOM-wide. */
function registryQty(orders: MaterialOrderRef[], bom: string, mo: string): number {
  if (mo) return orders.find((o) => o.mo === mo)?.planQty ?? 0;
  return round3(orders.filter((o) => o.bom === bom).reduce((s, o) => s + o.planQty, 0));
}

function toView(
  row: {
    id: number; bom: string; mo: string; material: string; thicknessMm: number; sheetSize: string;
    sheetsPerUnit: number; sheetsUsed: number | null; unitsOverride: number | null; note: string | null;
    recordedBy: string | null; updatedAt: Date;
  },
  orders: MaterialOrderRef[]
): MaterialLineView {
  const { units, fromRegistry } = resolveUnits(row.unitsOverride, registryQty(orders, row.bom, row.mo));
  const required = sheetsForJob(row.sheetsPerUnit, units);
  return {
    id: row.id,
    bom: row.bom,
    mo: row.mo,
    material: row.material,
    thicknessMm: row.thicknessMm,
    sheetSize: row.sheetSize,
    sheetsPerUnit: row.sheetsPerUnit,
    sheetsUsed: row.sheetsUsed,
    unitsOverride: row.unitsOverride,
    note: row.note,
    units,
    unitsFromRegistry: fromRegistry,
    required,
    difference: sheetsDifference(required, row.sheetsUsed),
    updatedISO: row.updatedAt.toISOString().slice(0, 10),
    recordedBy: row.recordedBy,
  };
}

export interface MaterialPageData {
  lines: MaterialLineView[];
  totals: MaterialTotal[];
  orders: MaterialOrderRef[];
  boms: string[]; // every BOM with a material line or an order, for the picker
}

/** The whole tab: material lines (optionally one BOM's), the purchasing
 *  totals over exactly those lines, and the pickers' data. */
export async function getMaterialData(bom?: string): Promise<MaterialPageData> {
  const [rows, orders] = await Promise.all([
    prisma.materialUsage.findMany({
      where: bom ? { bom } : undefined,
      orderBy: [{ bom: "asc" }, { mo: "asc" }, { material: "asc" }, { thicknessMm: "asc" }],
    }),
    getMaterialOrders(),
  ]);
  const lines = rows.map((r) => toView(r, orders));

  // the picker lists every BOM that HAS material recorded plus every BOM with
  // an order — a BOM whose lines were all deleted must stay reachable
  const allBoms = await prisma.materialUsage.findMany({ select: { bom: true }, distinct: ["bom"] });
  const boms = [...new Set([...allBoms.map((b) => b.bom), ...orders.map((o) => o.bom)])].sort();

  return { lines, totals: summarizeMaterial(lines), orders, boms };
}

// ---- import: the planner's existing Nesting Tracker workbook ----

export interface MaterialImportResult {
  ok: boolean;
  error?: string;
  added?: number;
  updated?: number;
  issues?: string[];
  preview?: boolean;
}

/**
 * Import the Nesting Tracker sheet. Lines are upserted on their identity
 * (BOM × material × thickness × size, BOM-wide), so re-importing a corrected
 * sheet updates the same rows instead of doubling them.
 *
 * The sheet's "Quantity of Units" is only kept as an OVERRIDE for a BOM the
 * orders registry does not carry — a known BOM takes its quantity live from
 * the registry, which is what stops the two drifting apart.
 */
export async function importNestingTracker(
  buffer: ArrayBuffer,
  recordedBy: string | null,
  preview = false
): Promise<MaterialImportResult> {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(new Uint8Array(buffer), { cellDates: false });
  } catch {
    return { ok: false, error: "Could not read the file — make sure it is a valid Excel file." };
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { ok: false, error: "The file has no sheets." };

  const opts: XLSX.Sheet2JSONOpts = { header: 1, raw: true, defval: null, blankrows: true };
  if (ws["!ref"]) {
    const range = XLSX.utils.decode_range(ws["!ref"]);
    range.s.r = 0;
    range.s.c = 0;
    opts.range = XLSX.utils.encode_range(range);
  }
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, opts);

  const { rows, issues } = parseNestingTracker(grid);
  if (rows.length === 0) return { ok: false, error: issues[0] ?? "No material rows found.", issues };

  const knownBoms = new Set((await prisma.masterOrder.findMany({ select: { bom: true }, distinct: ["bom"] })).map((b) => b.bom));
  const existing = await prisma.materialUsage.findMany({ where: { mo: "" } });
  const seen = new Map(existing.map((e) => [`${e.bom}|${e.material}|${e.thicknessMm}|${e.sheetSize}`, e.id]));

  let added = 0;
  let updated = 0;
  for (const r of rows) {
    const key = `${r.bom}|${r.material}|${r.thicknessMm}|${r.sheetSize}`;
    if (seen.has(key)) updated += 1;
    else added += 1;
    if (preview) continue;

    const data = {
      sheetsPerUnit: r.sheetsPerUnit,
      sheetsUsed: r.sheetsUsed,
      unitsOverride: knownBoms.has(r.bom) ? null : r.units,
      note: r.note,
      recordedBy,
    };
    await prisma.materialUsage.upsert({
      where: {
        bom_mo_material_thicknessMm_sheetSize: {
          bom: r.bom, mo: "", material: r.material, thicknessMm: r.thicknessMm, sheetSize: r.sheetSize,
        },
      },
      create: { bom: r.bom, mo: "", material: r.material, thicknessMm: r.thicknessMm, sheetSize: r.sheetSize, ...data },
      update: data,
    });
  }

  return { ok: true, added, updated, issues, preview };
}
