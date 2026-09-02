import "server-only";
import { prisma } from "@/lib/db";
import { toISODate } from "@/lib/domain/dates";
import {
  parsePlanMonths,
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
  soi: string | null; // sales order item, as the registry carries it
  planMonths: string[]; // the monthly plan(s) this order was imported under
}

/** Every order the registry knows, as the material page's BOM/MO pickers. */
export async function getMaterialOrders(): Promise<MaterialOrderRef[]> {
  const orders = await prisma.masterOrder.findMany({
    select: { mo: true, bom: true, planQty: true, customer: true, status: true, soi: true, months: true, source: true },
    orderBy: [{ bom: "asc" }, { mo: "asc" }],
  });
  return orders.map(({ months, source, ...o }) => ({ ...o, planMonths: parsePlanMonths(months, source) }));
}

/** The orders a line speaks for: the one it names, or all of its BOM's. */
function ordersFor(orders: MaterialOrderRef[], bom: string, mo: string): MaterialOrderRef[] {
  return mo ? orders.filter((o) => o.mo === mo) : orders.filter((o) => o.bom === bom);
}

/** The monthly plan(s) behind a line: the named MO's own, or every month the
 *  BOM's orders came in on when the line covers the whole BOM. */
function planMonthsFor(orders: MaterialOrderRef[], bom: string, mo: string): string[] {
  return [...new Set(ordersFor(orders, bom, mo).flatMap((o) => o.planMonths))].sort();
}

/** The SOI(s) behind a line — joined for a BOM-level line, which can cover
 *  several orders and must not pretend to be only one of them. */
function soiFor(orders: MaterialOrderRef[], bom: string, mo: string): string | null {
  const sois = [...new Set(ordersFor(orders, bom, mo).map((o) => (o.soi ?? "").trim()).filter(Boolean))].sort();
  return sois.length > 0 ? sois.join(" · ") : null;
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
    workedAt: Date; sheetsUsed: number; sheetsPerUnit: number | null; unitsOverride: number | null;
    note: string | null; recordedBy: string | null; updatedAt: Date;
  },
  orders: MaterialOrderRef[]
): MaterialLineView {
  const { units, fromRegistry } = resolveUnits(row.unitsOverride, registryQty(orders, row.bom, row.mo));
  const allowed = sheetsForJob(row.sheetsPerUnit, units);
  return {
    id: row.id,
    bom: row.bom,
    mo: row.mo,
    material: row.material,
    thicknessMm: row.thicknessMm,
    sheetSize: row.sheetSize,
    workedISO: toISODate(row.workedAt),
    sheetsUsed: row.sheetsUsed,
    sheetsPerUnit: row.sheetsPerUnit,
    unitsOverride: row.unitsOverride,
    note: row.note,
    units,
    unitsFromRegistry: fromRegistry,
    soi: soiFor(orders, row.bom, row.mo),
    planMonths: planMonthsFor(orders, row.bom, row.mo),
    allowed,
    difference: sheetsDifference(allowed, row.sheetsUsed),
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

/** The whole tab: the material lines actually consumed (optionally one BOM's),
 *  the totals over exactly those lines, and the pickers' data. */
export async function getMaterialData(bom?: string): Promise<MaterialPageData> {
  const [rows, orders] = await Promise.all([
    prisma.materialUsage.findMany({
      where: bom ? { bom } : undefined,
      orderBy: [{ workedAt: "desc" }, { bom: "asc" }, { mo: "asc" }, { material: "asc" }, { thicknessMm: "asc" }],
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

