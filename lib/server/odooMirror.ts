import "server-only";
import type { Prisma } from "@prisma/client";
import { isItem } from "@/lib/domain/constants";
import { ITEM_PRODUCT, MIRROR_STATUS, isUntouched, mirrorFgCode, mirrorSource, sameProduct } from "@/lib/domain/odooMirror";

// The ledger → ODOO tab bridge. Every place that writes a Painting or
// ShotBlast row to the ledger calls `mirrorLedgerToOdoo` inside the same
// transaction, so a closing and its Odoo row are one write. The two edit
// paths of the Daily Logs call `syncMirroredOdoo`, which only moves a row
// nobody has touched yet — once the clerk has typed Odoo's MO, moved the
// status or noted something, the row is the office's and stays put.

interface LedgerRow {
  id: number;
  date: Date;
  dept: string;
  bom: string;
  mo: string | null;
  item: string;
  qty: number;
}

/** Write the Odoo row a ledger closing calls for; nothing for a row that is
 *  not a closing (another stage, a correction, a paint-exempt part). */
export async function mirrorLedgerToOdoo(tx: Prisma.TransactionClient, ledger: LedgerRow, by: string | null): Promise<void> {
  const source = mirrorSource(ledger.dept, ledger.item);
  if (!source || !(ledger.qty > 0) || !isItem(ledger.item)) return;
  const { product } = ITEM_PRODUCT[ledger.item];

  const order = ledger.mo ? await tx.masterOrder.findUnique({ where: { mo: ledger.mo }, select: { soi: true, bom: true } }) : null;
  const soi = (order?.soi ?? "").trim().toUpperCase() || null;
  const bom = (order?.bom ?? ledger.bom).trim().toUpperCase();

  // the last row of the same SOI and product knows the part's real FG-CODE
  let prior: string | null = null;
  if (soi) {
    const rows = await tx.odooEntry.findMany({
      where: { soi, fgCode: { not: "" } },
      orderBy: [{ date: "desc" }, { id: "desc" }],
      select: { fgCode: true, product: true, fgGuessed: true },
      take: 50,
    });
    prior = rows.find((r) => !r.fgGuessed && sameProduct(r.product, product))?.fgCode
      ?? rows.find((r) => sameProduct(r.product, product))?.fgCode
      ?? null;
  }
  const fg = mirrorFgCode(prior, ledger.item, bom);

  await tx.odooEntry.create({
    data: {
      date: ledger.date, soi, fgCode: fg.fgCode, product, odooMo: "", qty: ledger.qty,
      status: MIRROR_STATUS, doneAt: null, recordedBy: by,
      source, ledgerId: ledger.id, fgGuessed: fg.guessed,
    },
  });
}

/** The ledger row changed: carry its new qty / date onto its Odoo row, or
 *  delete the Odoo row with it — only while that row is still untouched. A
 *  row the office has worked keeps its numbers and, on delete, loses only
 *  the link. */
export async function syncMirroredOdoo(
  tx: Prisma.TransactionClient,
  ledgerId: number,
  change: { qty: number; date?: Date } | "delete"
): Promise<void> {
  const row = await tx.odooEntry.findUnique({
    where: { ledgerId },
    select: { id: true, odooMo: true, status: true, _count: { select: { notes: true } } },
  });
  if (!row) return;
  const untouched = isUntouched({ odooMo: row.odooMo, status: row.status, notes: row._count.notes });
  if (change === "delete") {
    if (untouched) await cancelMirror(tx, row.id, "The daily-log record this row was born from was deleted.");
    else await tx.odooEntry.update({ where: { id: row.id }, data: { ledgerId: null } });
    return;
  }
  if (!untouched) return;
  if (!(change.qty > 0)) {
    await cancelMirror(tx, row.id, "The daily-log record this row was born from was corrected to nothing.");
    return;
  }
  await tx.odooEntry.update({ where: { id: row.id }, data: { qty: change.qty, ...(change.date ? { date: change.date } : {}) } });
}

/**
 * A born row whose ledger record is gone is CANCELLED, never deleted.
 *
 * Deleting it was tidier and was wrong: the row would disappear from the tab
 * with nothing to say where it went, and the planner would be left hunting a
 * close-out he remembers writing. Cancelled, it stays on its day, reads red,
 * carries the reason, and he removes it himself if he wants it gone. It also
 * stops following the ledger — there is no ledger left to follow.
 */
async function cancelMirror(tx: Prisma.TransactionClient, id: number, why: string): Promise<void> {
  await tx.odooEntry.update({
    where: { id },
    data: {
      status: "Cancelled",
      doneAt: null,
      ledgerId: null,
      notes: { create: { text: why, recordedBy: null } },
    },
  });
}
