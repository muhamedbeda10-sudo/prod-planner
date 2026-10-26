import "server-only";
import { prisma } from "@/lib/db";
import { factoryDayISO } from "@/lib/domain/dates";
import { departmentWorkers } from "@/lib/domain/consumables";
import { headcountResolver, headcountSource, HEADCOUNT_TOTAL, type HeadcountOf, type HeadcountSource } from "@/lib/domain/consumableLimits";
import { getAllWorkers } from "./workers";

// CONSUMABLES — each section's workers, month by month (ConsumableHeadcount).
// A per-worker limit is the number times the department's workers; a month
// reviewed later is held to the workers it had then. The resolver is pure
// (lib/domain/consumableLimits.ts headcountResolver); this file reads and
// writes the rows.

const thisMonth = () => factoryDayISO(new Date()).slice(0, 7);

/** Write this month's headcount as the workers list stands now — the month's
 *  rows replaced, so the last write of a month is the month as it ended.
 *  Never fails its caller: a hand-out or a change to the list is not undone
 *  because the record of the headcount could not be written. */
export async function snapshotHeadcount(): Promise<void> {
  try {
    const month = thisMonth();
    const counts = departmentWorkers(await getAllWorkers());
    const total = [...counts.values()].reduce((n, c) => n + c, 0);
    const rows = [...counts.entries()].map(([department, workers]) => ({ month, department, workers }));
    await prisma.$transaction([
      prisma.consumableHeadcount.deleteMany({ where: { month } }),
      prisma.consumableHeadcount.createMany({ data: [...rows, { month, department: HEADCOUNT_TOTAL, workers: total }] }),
    ]);
  } catch (e) {
    console.error("consumables snapshotHeadcount", e);
  }
}

/** The headcount any month is held to: this month (and later) the list as
 *  it stands; an earlier one its own record, or the latest before it, or —
 *  before anything was recorded — the list as it stands. */
export async function loadHeadcountOf(): Promise<HeadcountOf> {
  return (await loadHeadcount()).headcountOf;
}

/** The same, with where each month's headcount comes from — said on the dashboard. */
export async function loadHeadcount(): Promise<{ headcountOf: HeadcountOf; sourceOf: (month: string) => HeadcountSource }> {
  const [rows, workers] = await Promise.all([
    prisma.consumableHeadcount.findMany({ select: { month: true, department: true, workers: true } }),
    getAllWorkers(),
  ]);
  const current = thisMonth();
  const months = [...new Set(rows.map((r) => r.month))].sort();
  return { headcountOf: headcountResolver(rows, departmentWorkers(workers), current), sourceOf: (month) => headcountSource(months, month, current) };
}
