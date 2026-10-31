import "server-only";
import type { Prisma } from "@prisma/client";
import { correctionDays } from "@/lib/domain/corrections";
import { parseISODate, toISODate } from "@/lib/domain/dates";

/**
 * Write a correction of `take` pieces on one order, stage and item: one row
 * per day and plan of the work it takes back, the most recent first
 * (correctionDays) — what that work cannot cover goes on today, under
 * `fallbackPlan`. Read and written inside the caller's transaction, so the
 * output it splits over is the output it corrects. The tracker's cells and
 * group rows, transformers and panels, all write their corrections here.
 */
export async function writeCorrection(
  tx: Prisma.TransactionClient,
  a: { dept: string; bom: string; mo: string; item: string; take: number; today: Date; fallbackPlan: number; source: string; note: string; by: string | null },
): Promise<void> {
  const rows = await tx.handoverEntry.findMany({ where: { dept: a.dept, mo: a.mo, item: a.item }, select: { date: true, qty: true, planNo: true } });
  const parts = correctionDays(rows.map((r) => ({ dateISO: toISODate(r.date), qty: r.qty, planNo: r.planNo })), a.take, toISODate(a.today), a.fallbackPlan);
  for (const p of parts) {
    await tx.handoverEntry.create({
      data: {
        date: parseISODate(p.dateISO)!, dept: a.dept, bom: a.bom, mo: a.mo, item: a.item, qty: p.qty, planNo: p.planNo,
        source: a.source, note: a.note, createdBy: a.by,
      },
    });
  }
}
