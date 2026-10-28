import "server-only";
import { prisma } from "@/lib/db";
import { odooClosedByLedger, odooKey } from "@/lib/domain/trackerOdoo";
import { SHOTBLAST_STAGE } from "@/lib/domain/constants";
import type { ProductLine } from "@/lib/domain/lines";

// The ODOO log's closings of given orders, counted exactly: the rows born
// from their own daily-log closings (lib/domain/trackerOdoo.ts
// odooClosedByLedger). The Plan Tracker's Odoo columns — the transformers',
// the panels' and the weekly plan's — read them here, for their orders only,
// instead of the whole log.

export const ODOO_ENTRY_SELECT = { id: true, date: true, line: true, ledgerId: true, soi: true, fgCode: true, product: true, qty: true, status: true } as const;

/** The log rows born from these orders' daily-log rows, with those daily-log
 *  rows — only the closing stages', the ones a log row is ever born from
 *  (lib/domain/odooMirror.ts mirrorSource: a painting, or the core's shot blast). */
export async function odooRowsOfOrders(mos: readonly string[], line: ProductLine) {
  if (!mos.length) return { entries: [], ledgers: [] };
  const ledgers = await prisma.handoverEntry.findMany({
    where: { mo: { in: [...mos] }, dept: { in: ["Painting", SHOTBLAST_STAGE] } },
    select: { id: true, mo: true, bom: true, item: true },
  });
  const entries = ledgers.length
    ? await prisma.odooEntry.findMany({ where: { line, ledgerId: { in: ledgers.map((l) => l.id) } }, select: ODOO_ENTRY_SELECT })
    : [];
  return { entries, ledgers };
}

/** These orders' exact closings, as a lookup: an MO and item code → qty. */
export async function odooClosedOf(mos: readonly string[], line: ProductLine): Promise<(mo: string, item: string) => number> {
  const { entries, ledgers } = await odooRowsOfOrders(mos, line);
  const closed = odooClosedByLedger(entries, ledgers);
  return (mo, item) => closed.get(odooKey(mo))?.get(odooKey(item)) ?? 0;
}
