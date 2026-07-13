import "server-only";
import { prisma } from "@/lib/db";
import { getPlanWindows, getSettings } from "./data";
import { findPlanForDate } from "@/lib/domain/findPlan";

/** Distinct known BOM codes across Plan Orders (for autocomplete + classification). */
export async function getKnownBoms(): Promise<string[]> {
  const rows = await prisma.planOrder.findMany({ select: { bom: true }, distinct: ["bom"], orderBy: { bom: "asc" } });
  return rows.map((r) => r.bom).filter(Boolean);
}

/** The plan covering a work date (default for the handover form). */
export async function getDefaultPlanForDate(day: Date): Promise<number | null> {
  const settings = await getSettings();
  return findPlanForDate(await getPlanWindows(), day, settings.leadCut);
}

export async function getRecentHandover(limit = 60, planNo?: number) {
  return prisma.handoverEntry.findMany({
    where: planNo ? { planNo } : undefined,
    orderBy: [{ date: "desc" }, { id: "desc" }],
    take: limit,
  });
}
