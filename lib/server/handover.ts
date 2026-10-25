import "server-only";
import { prisma } from "@/lib/db";
import { getActiveLine, ledgerItemWhere } from "./line";
import { getPlanWindows, getSettings } from "./data";
import { findPlanForDate } from "@/lib/domain/findPlan";

/** Distinct known BOM codes across Plan Orders (for autocomplete + classification). */
export async function getKnownBoms(): Promise<string[]> {
  const rows = await prisma.planOrder.groupBy({ by: ["bom"], orderBy: { bom: "asc" } });
  return rows.map((r) => r.bom).filter(Boolean);
}

/** The plan covering a work date (default for the handover form). */
export async function getDefaultPlanForDate(day: Date): Promise<number | null> {
  const settings = await getSettings();
  return findPlanForDate(await getPlanWindows(), day, settings.leadCut);
}

export async function getRecentHandover(limit = 60, planNo?: number) {
  // the line on screen's rows only — a panel's log and a tank's never mix
  const line = await getActiveLine();
  return prisma.handoverEntry.findMany({
    where: { ...ledgerItemWhere(line), ...(planNo ? { planNo } : {}) },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    take: limit,
  });
}
