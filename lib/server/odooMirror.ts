import "server-only";
import type { Prisma } from "@prisma/client";
import { isItem } from "@/lib/domain/constants";
import { LV_ITEM } from "@/lib/domain/lv";
import { ITEM_PRODUCT, MIRROR_STATUS, isUntouched, mirrorFgCode, mirrorSource, sameProduct } from "@/lib/domain/odooMirror";
import { pickChildMo } from "@/lib/domain/childMos";

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
  if (!source || !(ledger.qty > 0)) return;
  const order = ledger.mo ? await tx.masterOrder.findUnique({ where: { mo: ledger.mo }, select: { soi: true, bom: true, line: true, product: true, fgCode: true } }) : null;
  const soi = (order?.soi ?? "").trim().toUpperCase() || null;
  const bom = (order?.bom ?? ledger.bom).trim().toUpperCase();

  // An LV panel's painting is its closing too. Its plan carries Odoo's own
  // finished-good code and the panel type, so nothing is guessed: the row is
  // born filed under the panels, with the code the sheet gave it.
  if (ledger.item === LV_ITEM) {
    if (!order || order.line !== "LV") return;
    await tx.odooEntry.create({
      data: {
        line: "LV", date: ledger.date, soi, fgCode: (order.fgCode ?? "").trim().toUpperCase(), product: order.product ?? "LV Panel",
        odooMo: "", qty: ledger.qty, status: MIRROR_STATUS, doneAt: null, recordedBy: by,
        source, ledgerId: ledger.id, fgGuessed: !order.fgCode,
      },
    });
    return;
  }
  if (!isItem(ledger.item)) return;
  const { product } = ITEM_PRODUCT[ledger.item];

  // the last row of the same SOI and product knows the part's real FG-CODE
  let prior: string | null = null;
  if (soi) {
    const rows = await tx.odooEntry.findMany({
      where: { soi, fgCode: { not: "" }, line: order?.line ?? "TR" },
      orderBy: [{ date: "desc" }, { id: "desc" }],
      select: { fgCode: true, product: true, fgGuessed: true },
      take: 50,
    });
    prior = rows.find((r) => !r.fgGuessed && sameProduct(r.product, product))?.fgCode
      ?? rows.find((r) => sameProduct(r.product, product))?.fgCode
      ?? null;
  }
  const fg = mirrorFgCode(prior, ledger.item, bom);
  // the plan's child MO for this component, when the plan sheet gave one —
  // the row then lands ready to close, nobody has to type Odoo's number
  const childMo = ledger.mo ? await childMoFor(tx, ledger.mo, ledger.item, ledger.qty) : null;

  await tx.odooEntry.create({
    data: {
      line: order?.line ?? "TR",
      date: ledger.date, soi, fgCode: fg.fgCode, product, odooMo: childMo ?? "", autoMo: childMo !== null, qty: ledger.qty,
      status: MIRROR_STATUS, doneAt: null, recordedBy: by,
      source, ledgerId: ledger.id, fgGuessed: fg.guessed,
    },
  });
}

/** The child MO a closing of `qty` of this plan MO's component takes: an
 *  open one with room left after what the ODOO tab already booked on it. */
export async function childMoFor(tx: Prisma.TransactionClient, planMo: string, item: string, qty: number): Promise<string | null> {
  const children = await tx.childMo.findMany({
    where: { planMo: planMo.trim().toUpperCase(), item },
    orderBy: { id: "asc" },
    select: { childMo: true, qty: true, state: true },
  });
  if (children.length === 0) return null;
  const sums = await tx.odooEntry.groupBy({
    by: ["odooMo"],
    where: { odooMo: { in: children.map((c) => c.childMo) }, status: { not: "Cancelled" } },
    _sum: { qty: true },
  });
  return pickChildMo(children, new Map(sums.map((s) => [s.odooMo, s._sum.qty ?? 0])), qty);
}

/**
 * Rows born before the plan's child MOs were loaded, still waiting for an
 * MO and untouched: fill them from the child MOs now. Nothing already typed,
 * moved or noted is changed.
 */
export async function fillBornRowsFromChildMos(tx: Prisma.TransactionClient): Promise<number> {
  const waiting = await tx.odooEntry.findMany({
    where: { odooMo: "", status: MIRROR_STATUS, source: { in: ["painting", "shotblast"] }, ledgerId: { not: null }, notes: { none: {} } },
    orderBy: [{ date: "asc" }, { id: "asc" }],
    select: { id: true, qty: true, ledgerId: true },
  });
  if (waiting.length === 0) return 0;
  const ledgers = await tx.handoverEntry.findMany({ where: { id: { in: waiting.map((w) => w.ledgerId!) } }, select: { id: true, mo: true, item: true } });
  const byId = new Map(ledgers.map((l) => [l.id, l]));
  let filled = 0;
  for (const w of waiting) {
    const l = byId.get(w.ledgerId!);
    if (!l?.mo || !isItem(l.item)) continue;
    const mo = await childMoFor(tx, l.mo, l.item, w.qty);
    if (!mo) continue;
    await tx.odooEntry.update({ where: { id: w.id }, data: { odooMo: mo, autoMo: true } });
    filled += 1;
  }
  return filled;
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
    select: { id: true, odooMo: true, autoMo: true, checkedAt: true, status: true, _count: { select: { notes: true } } },
  });
  if (!row) return;
  const untouched = isUntouched({ odooMo: row.odooMo, autoMo: row.autoMo, checkedAt: row.checkedAt, status: row.status, notes: row._count.notes });
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
