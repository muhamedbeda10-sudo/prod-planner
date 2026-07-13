import "server-only";
import { prisma } from "@/lib/db";
import {
  computeCutWorklist,
  computeWeldWorklist,
  type CutRow,
  type WeldRow,
} from "@/lib/domain/worklist";
import { findPlanForDate } from "@/lib/domain/findPlan";
import { getSettings, getPlanWindows, getGrouperForPlan } from "./data";

async function loadInputs(planNo: number) {
  const [schedule, orders, handover] = await Promise.all([
    prisma.planSchedule.findMany({ where: { planNo }, orderBy: { id: "asc" } }),
    prisma.planOrder.findMany({ where: { planNo }, orderBy: { id: "asc" } }),
    prisma.handoverEntry.findMany({ where: { planNo } }),
  ]);
  const grouper = await getGrouperForPlan(planNo);
  return {
    grouper,
    schedule: schedule.map((s) => ({ bom: s.bom, item: s.item, ovenDate: s.ovenDate, qty: s.qty, kva: s.description })),
    orders: orders.map((o) => ({ bom: o.bom, item: o.item, targetQty: o.targetQty, kva: o.description })),
    handover: handover.map((h) => ({ dept: h.dept, bom: h.bom, item: h.item, qty: h.qty, date: h.date })),
  };
}

export interface WorklistResult<T> {
  planNo: number | null;
  rows: T[];
  capacity: number;
  lead: number;
}

export async function getCutWorklist(day: Date): Promise<WorklistResult<CutRow>> {
  const settings = await getSettings();
  const planNo = findPlanForDate(await getPlanWindows(), day, settings.leadCut);
  if (planNo === null) return { planNo: null, rows: [], capacity: settings.capacityPerItem, lead: settings.leadCut };
  const inp = await loadInputs(planNo);
  const rows = computeCutWorklist({ ...inp, day, lead: settings.leadCut, capacity: settings.capacityPerItem });
  return { planNo, rows, capacity: settings.capacityPerItem, lead: settings.leadCut };
}

export async function getWeldWorklist(day: Date): Promise<WorklistResult<WeldRow>> {
  const settings = await getSettings();
  const planNo = findPlanForDate(await getPlanWindows(), day, settings.leadWeld);
  if (planNo === null) return { planNo: null, rows: [], capacity: settings.capacityPerItem, lead: settings.leadWeld };
  const inp = await loadInputs(planNo);
  const rows = computeWeldWorklist({ ...inp, day, lead: settings.leadWeld, capacity: settings.capacityPerItem });
  return { planNo, rows, capacity: settings.capacityPerItem, lead: settings.leadWeld };
}
