import "server-only";
import { prisma } from "@/lib/db";
import { cancelsOpenRow } from "@/lib/domain/odoo";

/** Cancelling rows needs a note with the reason on them — any row of a merged
 *  line, which keeps its notes on its first row; rows cancelled already stay
 *  as they are. The tab's actions and the assistant's cards both ask here. */
export async function cancelRefused(ids: readonly number[], next: string, prevStatuses: readonly string[]): Promise<boolean> {
  if (!cancelsOpenRow(next, prevStatuses)) return false;
  return (await prisma.odooNote.count({ where: { entryId: { in: [...ids] } } })) === 0;
}
