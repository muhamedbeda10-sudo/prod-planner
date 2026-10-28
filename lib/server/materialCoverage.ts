import "server-only";
import { prisma } from "@/lib/db";
import { applicableItems, ospOf, type Item } from "@/lib/domain/constants";
import { ITEM_PRODUCT } from "@/lib/domain/odooMirror";
import { sheetNeeds, type NeedSummary, type PartNeed, type StockLine } from "@/lib/domain/materialCoverage";
import { getLinesMaterial, type MaterialLineRef, type OrderRef } from "./machineMaterial";
import { getTrackerSheet } from "./masterTracker";
import { ledgerItemWhere, withLine } from "./line";

// The facts the material check reads (lib/domain/materialCoverage.ts): the
// pieces Fabrication still owes per order and part, the sheets the MATERIAL
// tab nests them from, and the Physical Material table — Odoo's stock and the
// store's count per product code. Transformers only: the panels' nesting is
// filed per order and their parts are not counted piece by piece here.

const monthsOf = (csv: string | null | undefined) => (csv ?? "").split(",").map((m) => m.trim()).filter(Boolean);
const hasPart = (item: Item) => ITEM_PRODUCT[item].partCode !== null;

async function withSpecs(parts: { mo: string; bom: string; item: Item; pcsLeft: number }[], orderOf: (mo: string) => OrderRef | undefined): Promise<PartNeed[]> {
  const lines: MaterialLineRef[] = parts.map((p) => ({ key: `${p.mo}|${p.item}`, bom: p.bom, mo: p.mo, item: p.item }));
  const material = await getLinesMaterial(lines, orderOf);
  return parts.map((p) => ({ mo: p.mo, item: p.item, pcsLeft: p.pcsLeft, specs: material[`${p.mo}|${p.item}`]?.specs ?? [] }));
}

/** One order's parts still to cut, with their sheets. */
export async function getOrderPartNeeds(order: { mo: string; bom: string; soi: string | null; months: string; source: string | null; planQty: number; kva: string | null; rating: string | null; includedItems: string | null; excludedItems: string | null; ospCF: number; ospTC: number; ospTN: number; ospCB: number }): Promise<PartNeed[]> {
  return withLine("TR", async () => {
    const cut = await prisma.handoverEntry.groupBy({ by: ["item"], where: { mo: order.mo, dept: "Cut", ...ledgerItemWhere("TR") }, _sum: { qty: true } });
    const cutOf = new Map(cut.map((c) => [c.item, c._sum.qty ?? 0]));
    const parts = applicableItems(order).filter(hasPart).map((item) => ({
      mo: order.mo, bom: order.bom, item, pcsLeft: Math.max(0, order.planQty - ospOf(order, item) - (cutOf.get(item) ?? 0)),
    })).filter((p) => p.pcsLeft > 0);
    // the months as the tracker reads them (an old order's first plan when it lists none)
    return withSpecs(parts, () => ({ soi: order.soi, months: monthsOf(order.months || order.source) }));
  });
}

/** Every open, not-held transformer order's parts still to cut, with their
 *  sheets — and which orders that is (an open order may have nothing left to cut). */
export async function getOpenPartNeeds(): Promise<{ parts: PartNeed[]; openMos: Set<string> }> {
  return withLine("TR", async () => {
    // the tracker's own sheet without Odoo's closings — only cut and OSP are read
    const rows = (await getTrackerSheet()).filter((r) => r.status === "open" && !r.hold.onHold);
    const byMo = new Map(rows.map((r) => [r.mo, r]));
    const parts = rows.flatMap((r) => (Object.keys(r.items) as Item[]).flatMap((item) => {
      const c = r.items[item];
      if (!c.eligible || c.excluded || !hasPart(item)) return [];
      const pcsLeft = Math.max(0, r.required - c.osp - c.cut);
      return pcsLeft > 0 ? [{ mo: r.mo, bom: r.bom, item, pcsLeft }] : [];
    }));
    return { parts: await withSpecs(parts, (mo) => { const r = byMo.get(mo); return r ? { soi: r.soi, months: r.months } : undefined; }), openMos: new Set(rows.map((r) => r.mo)) };
  });
}

/** The Physical Material table: Odoo's stock and the store's count per code,
 *  and its newest change — when and by whom, as the screen shows it. */
export async function getStockLines(): Promise<{ lines: StockLine[]; lastChange: { atISO: string; by: string | null } | null }> {
  const rows = await prisma.physicalStock.findMany({ select: { code: true, name: true, uom: true, odoo: true, physical: true, updatedAt: true, updatedBy: true } });
  const newest = rows.reduce<(typeof rows)[number] | null>((a, r) => (!a || r.updatedAt > a.updatedAt ? r : a), null);
  return { lines: rows.map((r) => ({ code: r.code, name: r.name, uom: r.uom, odoo: r.odoo, physical: r.physical })), lastChange: newest ? { atISO: newest.updatedAt.toISOString(), by: newest.updatedBy } : null };
}

/** The sheets every open order (not on hold) still needs, per product code,
 *  with the parts that could not be priced. */
export async function getOpenSheetNeeds(): Promise<NeedSummary> {
  return sheetNeeds((await getOpenPartNeeds()).parts);
}
