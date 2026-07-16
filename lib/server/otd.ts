import "server-only";
import { prisma } from "@/lib/db";
import { computeOtd, type OtdStats } from "@/lib/domain/otd";
import { PAINT_EXEMPT, PAINTED_ITEMS } from "@/lib/domain/constants";

/** On-Time Delivery stats over the whole registry. A component is "delivered"
 *  when its FINAL stage reaches the order qty: Painting for TC/TN/CB, Welding
 *  for the paint-exempt core (CF). We feed the final-stage log of each item. */
export async function getOtdStats(): Promise<OtdStats> {
  const [orders, schedules, finalLogs] = await Promise.all([
    prisma.masterOrder.findMany({ select: { mo: true, planQty: true, ospCF: true, ospTC: true, ospTN: true, ospCB: true, excludedItems: true } }),
    prisma.planSchedule.findMany({ select: { planNo: true, mo: true, ovenDate: true } }),
    prisma.handoverEntry.findMany({
      where: {
        mo: { not: null },
        OR: [
          { dept: "Painting", item: { in: PAINTED_ITEMS as unknown as string[] } },
          { dept: "Welding", item: { in: PAINT_EXEMPT as unknown as string[] } },
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
      excluded: (o.excludedItems ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    })),
    schedules,
    finalLogs,
    new Date()
  );
}
