import "server-only";
import { prisma } from "@/lib/db";
import { computeTracker, type TrackerRow } from "@/lib/domain/tracker";
import { getEffectiveLogs } from "./data";

export async function getTracker(planNo: number): Promise<TrackerRow[]> {
  const [orders, logs] = await Promise.all([
    prisma.planOrder.findMany({ where: { planNo }, orderBy: { id: "asc" } }),
    getEffectiveLogs(planNo),
  ]);
  const rows = computeTracker(
    orders.map((o) => ({
      bom: o.bom,
      mo: o.mo,
      description: o.description,
      item: o.item,
      requiredQty: o.requiredQty,
      targetQty: o.targetQty,
    })),
    logs.map((l) => ({ dept: l.dept, bom: l.bom, item: l.item, qty: l.qty }))
  );
  // stable sort by BOM for display
  return rows.sort((a, b) => (a.bom < b.bom ? -1 : a.bom > b.bom ? 1 : 0));
}
