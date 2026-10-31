import "server-only";
import type { Prisma } from "@prisma/client";
import { correctionDays } from "@/lib/domain/corrections";
import { findPlanForDate } from "@/lib/domain/findPlan";
import { parseISODate, toISODate } from "@/lib/domain/dates";
import { getPlanWindows, getSettings } from "./data";

/**
 * The rows a correction of `take` pieces is written as: dated on the days of
 * the work it takes back, the most recent first (correctionDays), each filed
 * under the weekly plan that covers its day — else `fallbackPlan`, the plan
 * the correction itself would have been filed under. Read inside the write's
 * transaction, so the output it splits over is the output it corrects.
 */
export async function correctionRows(
  tx: Prisma.TransactionClient,
  where: Prisma.HandoverEntryWhereInput,
  take: number,
  today: Date,
  fallbackPlan: number,
): Promise<{ date: Date; qty: number; planNo: number }[]> {
  const [rows, windows, settings] = await Promise.all([
    tx.handoverEntry.findMany({ where, select: { date: true, qty: true } }),
    getPlanWindows(),
    getSettings(),
  ]);
  const parts = correctionDays(rows.map((r) => ({ dateISO: toISODate(r.date), qty: r.qty })), take, toISODate(today));
  return parts.map((p) => {
    const date = parseISODate(p.dateISO)!;
    return { date, qty: p.qty, planNo: findPlanForDate(windows, date, settings.leadCut) ?? fallbackPlan };
  });
}
