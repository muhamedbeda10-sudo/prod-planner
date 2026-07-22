import "server-only";
import { prisma } from "@/lib/db";
import { computeOtd, type OtdStats } from "@/lib/domain/otd";
import { PAINT_EXEMPT, PAINTED_ITEMS, applicableItems } from "@/lib/domain/constants";

/** On-Time Delivery stats over the whole registry. A component is "delivered"
 *  when its FINAL stage reaches the order qty: Painting for TC/TN/CB, SHOT
 *  BLAST for the paint-exempt core (CF). We feed the final-stage log of each item. */
export async function getOtdStats(): Promise<OtdStats> {
  const [orders, schedules, finalLogs] = await Promise.all([
    prisma.masterOrder.findMany({ select: { mo: true, planQty: true, kva: true, rating: true, ospCF: true, ospTC: true, ospTN: true, ospCB: true, excludedItems: true } }),
    prisma.planSchedule.findMany({ select: { planNo: true, mo: true, ovenDate: true } }),
    prisma.handoverEntry.findMany({
      where: {
        mo: { not: null },
        OR: [
          { dept: "Painting", item: { in: PAINTED_ITEMS as unknown as string[] } },
          { dept: "ShotBlast", item: { in: PAINT_EXEMPT as unknown as string[] } },
        ],
      },
      select: { mo: true, item: true, qty: true, date: true },
    }),
  ]);
  return computeOtd(
    orders.map((o) => ({
      mo: o.mo,
      planQty: o.planQty,
      osp: { CF: o.ospCF, TC: o.ospTC, TN: o.ospTN, CB: o.ospCB },
      // the order's real components: base four + AR/MB when its KVA/rating rule
      // matches, minus any marked N/A — only these gate on-time delivery
      items: applicableItems(o),
    })),
    schedules,
    finalLogs,
    new Date()
  );
}
