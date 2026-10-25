import "server-only";
import { prisma } from "@/lib/db";
import { toISODate } from "@/lib/domain/dates";
import { FINISHED_STATUSES, isReadyToClose, needsMo, type ReadyRow } from "@/lib/domain/odooAlerts";
import { odooRowBomLabel } from "@/lib/domain/odoo";
import { resolveRowBoms } from "@/lib/server/odoo";

const SELECT = { id: true, line: true, date: true, soi: true, fgCode: true, product: true, odooMo: true, qty: true, status: true, source: true, ledgerId: true } as const;

type Row = { id: number; line: string; date: Date; soi: string | null; fgCode: string; product: string; odooMo: string; qty: number; status: string; source: string; ledgerId: number | null };

/** The rows as the popup lists them — each with its BOM, read the way the log reads it. */
async function view(rows: Row[]): Promise<ReadyRow[]> {
  const boms = await resolveRowBoms(rows);
  return rows.map((r, i) => ({
    id: r.id, line: r.line, dateISO: toISODate(r.date), soi: r.soi, bom: odooRowBomLabel(boms[i]), product: r.product,
    odooMo: r.odooMo, qty: r.qty, status: r.status, source: r.source,
  }));
}

/** Every row, both lines, that has Odoo's MO and is still open — oldest first,
 *  the order they wait in. */
export async function getReadyToClose(): Promise<ReadyRow[]> {
  // the closed rows — the bulk of the log, growing for ever — stay in the
  // database; the domain rule still has the last word on what comes back
  const rows = await prisma.odooEntry.findMany({
    where: { NOT: { odooMo: "" }, status: { notIn: [...FINISHED_STATUSES], mode: "insensitive" } },
    select: SELECT,
    orderBy: [{ date: "asc" }, { id: "asc" }],
    take: 400,
  });
  return view(rows.filter(isReadyToClose).slice(0, 200));
}


/** Every row, both lines, still waiting for Odoo's MO number — oldest first. */
export async function getNeedingMo(): Promise<ReadyRow[]> {
  const rows = await prisma.odooEntry.findMany({
    where: { odooMo: "", status: { notIn: [...FINISHED_STATUSES], mode: "insensitive" } },
    select: SELECT,
    orderBy: [{ date: "asc" }, { id: "asc" }],
    take: 400,
  });
  return view(rows.filter(needsMo).slice(0, 200));
}
