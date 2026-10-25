import "server-only";
import { prisma } from "@/lib/db";
import { computeOtd, otdGateItems, type OtdStats } from "@/lib/domain/otd";
import { PAINT_EXEMPT, PAINTED_ITEMS, applicableItems } from "@/lib/domain/constants";
import { factoryToday } from "@/lib/domain/dates";
import { getActiveLine } from "./line";

/** On-Time Delivery stats over the whole registry. An order is "delivered"
 *  when its TANKS are painted to the order qty — the tank is the piece the
 *  order closes on, the same yardstick as the dashboard's plan completion.
 *  An order with no tank of its own (marked N/A) falls back to its other base
 *  components at their final stage: Painting, or shot blast for the core. */
export async function getOtdStats(): Promise<OtdStats> {
  const [orders, schedules, finalLogs] = await Promise.all([
    prisma.masterOrder.findMany({ where: { line: await getActiveLine() }, select: { mo: true, planQty: true, kva: true, rating: true, ospCF: true, ospTC: true, ospTN: true, ospCB: true, excludedItems: true } }),
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
      items: otdGateItems(applicableItems(o)),
    })),
    schedules,
    finalLogs,
    factoryToday()
  );
}

