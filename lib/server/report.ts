import "server-only";
import { prisma } from "@/lib/db";
import { computeDailyReport, type DailyReport } from "@/lib/domain/report";
import { findPlanForDate } from "@/lib/domain/findPlan";
import { getSettings, getPlanWindows, getGlobalGrouper, getLatestPlanNo } from "./data";
import { getTracker } from "./tracker";
import type { TrackerRow } from "@/lib/domain/tracker";

export interface DailyReportResult extends DailyReport {
  target: number;
  planNo: number | null;
  tracker: TrackerRow[];
}

export async function getDailyReport(day: Date): Promise<DailyReportResult> {
  const settings = await getSettings();
  const target = settings.dailyTarget || settings.capacityPerItem || 27;
  const [orders, handover, grouper, windows] = await Promise.all([
    prisma.planOrder.findMany({ orderBy: { id: "asc" } }),
    prisma.handoverEntry.findMany(),
    getGlobalGrouper(),
    getPlanWindows(),
  ]);

  const report = computeDailyReport(
    orders.map((o) => ({
      planNo: o.planNo, bom: o.bom, mo: o.mo, description: o.description,
      item: o.item, requiredQty: o.requiredQty, targetQty: o.targetQty,
    })),
    handover.map((h) => ({ date: h.date, dept: h.dept, bom: h.bom, item: h.item, qty: h.qty, planNo: h.planNo })),
    day,
    target,
    grouper
  );

  const planNo = findPlanForDate(windows, day, settings.leadCut) ?? (await getLatestPlanNo());
  const tracker = planNo ? await getTracker(planNo) : [];

  return { ...report, target, planNo, tracker };
}
