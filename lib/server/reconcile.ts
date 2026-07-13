import "server-only";
import { prisma } from "@/lib/db";
import { computeReconciliation, type ReconRow } from "@/lib/domain/reconcile";

export interface ReconResult {
  planNo: number;
  previousPlanNo: number | null;
  rows: ReconRow[];
}

export async function getReconciliation(planNo: number): Promise<ReconResult> {
  const prevPlan = await prisma.plan.findFirst({
    where: { planNo: { lt: planNo } },
    orderBy: { planNo: "desc" },
    select: { planNo: true },
  });
  if (!prevPlan) return { planNo, previousPlanNo: null, rows: [] };

  const [curOrders, prevOrders, weldPrevRows, weldAllRows] = await Promise.all([
    prisma.planOrder.findMany({ where: { planNo } }),
    prisma.planOrder.findMany({ where: { planNo: prevPlan.planNo } }),
    prisma.handoverEntry.findMany({ where: { planNo: prevPlan.planNo, dept: "Welding" } }),
    prisma.handoverEntry.findMany({ where: { dept: "Welding" } }),
  ]);

  const weldedPrev = new Map<string, number>();
  for (const h of weldPrevRows) {
    const k = `${h.bom}|${h.item}`;
    weldedPrev.set(k, (weldedPrev.get(k) ?? 0) + h.qty);
  }
  const weldedAll = new Map<string, number>();
  for (const h of weldAllRows) {
    const k = `${h.bom}|${h.item}`;
    weldedAll.set(k, (weldedAll.get(k) ?? 0) + h.qty);
  }

  const rows = computeReconciliation(
    curOrders.map((o) => ({ bom: o.bom, mo: o.mo, item: o.item, requiredQty: o.requiredQty, targetQty: o.targetQty, plannerBalance: o.plannerBalance })),
    prevOrders.map((o) => ({ bom: o.bom, mo: o.mo, item: o.item, requiredQty: o.requiredQty, targetQty: o.targetQty })),
    weldedPrev,
    weldedAll
  );
  return { planNo, previousPlanNo: prevPlan.planNo, rows };
}
