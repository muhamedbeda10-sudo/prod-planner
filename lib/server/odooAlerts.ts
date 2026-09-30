import "server-only";
import { prisma } from "@/lib/db";
import { toISODate } from "@/lib/domain/dates";
import { isReadyToClose, needsMo, type ReadyRow } from "@/lib/domain/odooAlerts";

const SELECT = { id: true, line: true, date: true, soi: true, fgCode: true, product: true, odooMo: true, qty: true, status: true, source: true, checkedAt: true, checkedBy: true } as const;

type Row = { id: number; line: string; date: Date; soi: string | null; fgCode: string; product: string; odooMo: string; qty: number; status: string; source: string; checkedAt: Date | null; checkedBy: string | null };

const view = (r: Row): ReadyRow => ({
  id: r.id, line: r.line, dateISO: toISODate(r.date), soi: r.soi, fgCode: r.fgCode, product: r.product,
  odooMo: r.odooMo, qty: r.qty, status: r.status, source: r.source, checkedBy: r.checkedAt ? r.checkedBy ?? "" : null,
});

/** Every row, both lines, that has Odoo's MO and is still open — oldest first,
 *  the order they wait in. */
export async function getReadyToClose(): Promise<ReadyRow[]> {
  const rows = await prisma.odooEntry.findMany({
    where: { NOT: { odooMo: "" } },
    select: SELECT,
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });
  return rows.filter(isReadyToClose).slice(0, 200).map(view);
}

/** Every row, both lines, waiting on the clerk — born on the log and not yet
 *  ticked ✓, or typed without an MO — oldest first. */
export async function getNeedingMo(): Promise<ReadyRow[]> {
  const rows = await prisma.odooEntry.findMany({
    where: { checkedAt: null, OR: [{ odooMo: "" }, { source: { in: ["painting", "shotblast"] } }] },
    select: SELECT,
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });
  return rows.filter(needsMo).slice(0, 200).map(view);
}
