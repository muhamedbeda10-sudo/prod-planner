import "server-only";
import { prisma } from "@/lib/db";
import { computeOtd, type OtdStats } from "@/lib/domain/otd";

/** On-Time Delivery stats over the whole registry (all plans, all paint logs). */
export async function getOtdStats(): Promise<OtdStats> {
  const [orders, schedules, paintings] = await Promise.all([
    prisma.masterOrder.findMany({ select: { mo: true, planQty: true, ospCF: true, ospTC: true, ospTN: true, ospCB: true, excludedItems: true } }),
    prisma.planSchedule.findMany({ select: { planNo: true, mo: true, ovenDate: true } }),
    prisma.handoverEntry.findMany({
      where: { dept: "Painting", mo: { not: null } },
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
    paintings,
    new Date()
  );
}
