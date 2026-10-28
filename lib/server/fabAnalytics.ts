import "server-only";
import { prisma } from "@/lib/db";
import { buildMaterialDashboard, orderPartKey, type DoneRow, type MaterialDashboard, type MaterialRequest, type SheetLine } from "@/lib/domain/materialDashboard";
import { ITEM_PRODUCT } from "@/lib/domain/odooMirror";
import { isItem } from "@/lib/domain/constants";
import { factoryDayISO, factoryDayStart } from "@/lib/domain/dates";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import type { ProductLine } from "@/lib/domain/lines";
import { isDoneStatus } from "@/lib/domain/odoo";

// The material dashboard's one query pair, for the line on screen: every line
// of its material sheet (every month — the domain reads one copy of each MO)
// and its ODOO rows moved to Done from the period before's first day to the
// period's last, blank MOs included so the page can say what did not link.
// The sheet is NOT windowed — an MO closed today was nested whenever it was
// nested. Nothing here writes; the page and the assistant read the same.

export interface MaterialDashboardData extends MaterialDashboard {
  /** When the sheet and the ODOO log of the line last changed — null when empty. */
  sheetUpdatedISO: string | null;
  odooUpdatedISO: string | null;
}

/** `maxRows`: how many detail rows to carry — the page's few hundred by
 *  default, the assistant's Excel sheet all of them. */
export async function getMaterialDashboard(req: MaterialRequest, line: ProductLine, opts: { maxRows?: number } = {}): Promise<MaterialDashboardData> {
  const firstDay = req.prev?.fromISO ?? req.fromISO;
  const gte = firstDay ? factoryDayStart(firstDay) : null;
  const lt = factoryDayStart(addDaysISO(req.toISO, 1));

  const [material, done, sheetLatest, odooLatest, orders] = await Promise.all([
    prisma.materialUsage.findMany({
      where: { line },
      select: {
        month: true, mo: true, soi: true, bom: true, partCode: true, partName: true, material: true, thicknessMm: true, sheetSize: true, units: true,
        sheetsPerUnit: true, actualPerUnit: true, sheetsUsed: true, weightKg: true, utilization: true,
      },
    }),
    prisma.odooEntry.findMany({
      where: { line, doneAt: { not: null, ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) } },
      select: { odooMo: true, qty: true, status: true, doneAt: true, ledgerId: true },
    }),
    prisma.materialUsage.aggregate({ where: { line }, _max: { updatedAt: true } }),
    prisma.odooEntry.aggregate({ where: { line }, _max: { updatedAt: true } }),
    // which MOs on the sheet are the transformers' own, not a part's
    prisma.masterOrder.findMany({ where: { line }, select: { mo: true } }),
  ]);
  const registry = new Set(orders.map((o) => o.mo.trim().toUpperCase()));
  // a line filed under its transformer's MO books the closings of ITS part
  // of that order: the order × part key (orderPartKey)
  const lines: SheetLine[] = material.map((l) => (registry.has(l.mo.trim().toUpperCase()) && l.partCode.trim()
    ? { ...l, closingKey: orderPartKey(l.mo, l.partCode) }
    : l));
  const keys = new Set(lines.flatMap((l) => (l.closingKey ? [l.closingKey] : [])));
  // the order and component each closing came from — the key it books against
  // when the sheet files that order's MO
  const ledgerIds = keys.size > 0 ? done.flatMap((r) => (r.ledgerId === null ? [] : [r.ledgerId])) : [];
  const ledger = ledgerIds.length > 0
    ? new Map((await prisma.handoverEntry.findMany({ where: { id: { in: ledgerIds }, mo: { not: null } }, select: { id: true, mo: true, item: true } }))
      .map((h) => [h.id, { mo: h.mo!, item: h.item }]))
    : new Map<number, { mo: string; item: string }>();
  const bookedKey = (r: (typeof done)[number]) => {
    const c = r.ledgerId === null ? undefined : ledger.get(r.ledgerId);
    const part = c && isItem(c.item) ? ITEM_PRODUCT[c.item].partCode : null;
    const k = c && part ? orderPartKey(c.mo, part) : null;
    return k && keys.has(k) ? k : r.odooMo ?? "";
  };

  // Done on Odoo, on the factory's day it was moved there
  const rows: DoneRow[] = done
    .filter((r) => r.doneAt && isDoneStatus(r.status))
    .map((r) => ({ dateISO: factoryDayISO(r.doneAt!), mo: bookedKey(r), qty: r.qty }));

  return {
    ...buildMaterialDashboard(lines, rows, req, opts),
    sheetUpdatedISO: sheetLatest._max.updatedAt ? sheetLatest._max.updatedAt.toISOString() : null,
    odooUpdatedISO: odooLatest._max.updatedAt ? odooLatest._max.updatedAt.toISOString() : null,
  };
}
