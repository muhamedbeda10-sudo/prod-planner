import "server-only";
import { prisma } from "@/lib/db";
import { toISODate } from "@/lib/domain/dates";
import { isReadyToClose, type ReadyRow } from "@/lib/domain/odooAlerts";

/** Every row, both lines, that has Odoo's MO and is still open — oldest first,
 *  the order they wait in. */
export async function getReadyToClose(): Promise<ReadyRow[]> {
  const rows = await prisma.odooEntry.findMany({
    where: { NOT: { odooMo: "" } },
    select: { id: true, line: true, date: true, soi: true, fgCode: true, product: true, odooMo: true, qty: true, status: true },
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });
  return rows
    .filter(isReadyToClose)
    .slice(0, 200)
    .map((r) => ({ id: r.id, line: r.line, dateISO: toISODate(r.date), soi: r.soi, fgCode: r.fgCode, product: r.product, odooMo: r.odooMo, qty: r.qty, status: r.status }));
}
