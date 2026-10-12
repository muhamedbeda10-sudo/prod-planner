import "server-only";
import type { MasterOrder } from "@prisma/client";
import { prisma } from "@/lib/db";
import { DELIVERED_STAGE, ITEMS, applicableItems } from "@/lib/domain/constants";
import { isFullyDelivered } from "@/lib/domain/groupSpread";
import { LV_ITEM } from "@/lib/domain/lv";
import type { ProductLine } from "@/lib/domain/lines";

/**
 * The OPEN orders of a line whose components have all reached the customer —
 * recomputed from the registry and the ledger, never taken from a page.
 * What "Close N delivered" closes (closeDeliveredOrders in
 * app/orders/actions.ts), and what the assistant's preview of it lists, from
 * this one function.
 */
export async function fullyDeliveredOpenOrders(line: ProductLine): Promise<MasterOrder[]> {
  const open = await prisma.masterOrder.findMany({ where: { status: "open", line } });
  if (open.length === 0) return [];

  const delivered = await prisma.handoverEntry.groupBy({
    by: ["mo", "item"],
    where: { dept: DELIVERED_STAGE, mo: { in: open.map((o) => o.mo) } },
    _sum: { qty: true },
  });
  const got = new Map(delivered.map((d) => [`${d.mo}|${d.item}`, d._sum.qty ?? 0]));

  return open.filter((o) => {
    // an LV panel is one item on the ledger; a transformer is its components
    if (o.line === "LV") return isFullyDelivered(o.planQty, [{ counts: true, delivered: got.get(`${o.mo}|${LV_ITEM}`) ?? 0 }]);
    const needed = applicableItems(o);
    return isFullyDelivered(
      o.planQty,
      ITEMS.map((it) => ({
        counts: needed.includes(it),
        delivered: got.get(`${o.mo}|${it}`) ?? 0,
      })),
    );
  });
}
