import "server-only";
import { prisma } from "@/lib/db";
import { toISODate } from "@/lib/domain/dates";
import { tierForOrder, itemHoursFor } from "@/lib/domain/stdEngine";
import { calibrate, type CalibrationSummary } from "@/lib/domain/calibration";
import { getStdData } from "./standardTimes";
import { loadMasterOrdersOf } from "./loads";
import type { StdData } from "@/lib/domain/stdEngine";

// recorded days older than this stop counting — the crew, the standards, or
// both have moved on, and a stale sample would fight every new recording
export const CALIBRATION_WINDOW_DAYS = 56;

export const CAL_STAGES = ["Cut", "Welding", "ShotBlast", "Painting"] as const;
export type CalStage = (typeof CAL_STAGES)[number];

export interface DayHoursRow {
  dateISO: string;
  hours: Partial<Record<CalStage, number>>;
}

export interface StageCalibration extends CalibrationSummary {
  dept: CalStage;
}

/** The admin's recorded work-hours (newest first) and, per stage, the
 *  actual-vs-earned comparison over the calibration window. */
export async function getCalibration(): Promise<{ rows: DayHoursRow[]; stages: StageCalibration[] }> {
  const since = new Date(Math.floor(Date.now() / 86400000 - CALIBRATION_WINDOW_DAYS) * 86400000);
  const [recorded, std, orders] = await Promise.all([
    prisma.deptDayHours.findMany({ where: { date: { gte: since } }, orderBy: { date: "desc" } }),
    getStdData(),
    // the standard times are the transformers' — their orders, whichever line is on screen
    loadMasterOrdersOf("TR"),
  ]);
  if (recorded.length === 0) return { rows: [], stages: CAL_STAGES.map((dept) => ({ dept, ...calibrate([]) })) };

  // group the recordings by day for the UI table
  const byDate = new Map<string, Partial<Record<CalStage, number>>>();
  for (const r of recorded) {
    const iso = toISODate(r.date);
    if (!byDate.has(iso)) byDate.set(iso, {});
    byDate.get(iso)![r.dept as CalStage] = r.hours;
  }

  // what the ledger EARNED on exactly those days, priced like everywhere else
  const dates = [...byDate.keys()];
  const earned = await earnedOnDays(dates, std, orders);

  const stages = CAL_STAGES.map((dept) => {
    const days = dates
      .filter((iso) => byDate.get(iso)![dept] !== undefined)
      .map((iso) => ({ actual: byDate.get(iso)![dept]!, earned: earned.get(iso)?.[dept] ?? 0 }));
    return { dept, ...calibrate(days) };
  });

  const rows = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([dateISO, hours]) => ({ dateISO, hours }));
  return { rows, stages };
}

type OrderTierFields = Parameters<typeof tierForOrder>[1] & { mo: string; bom: string };

/** The std-hours the daily log's output EARNED on each of these days, per
 *  calibration stage — a Painting entry banks its shot-blast share to the
 *  ShotBlast stage, as every piece is blasted before paint. AR / MB and the
 *  panels carry no standard times and earn nothing. */
export async function earnedOnDays(dates: readonly string[], std: StdData, orders: readonly OrderTierFields[]): Promise<Map<string, Record<CalStage, number>>> {
  const earned = new Map<string, Record<CalStage, number>>();
  if (dates.length === 0) return earned;
  const dayStart = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const entries = await prisma.handoverEntry.findMany({
    where: { OR: dates.map((iso) => ({ date: { gte: dayStart(iso), lt: new Date(dayStart(iso).getTime() + 86400000) } })) },
    select: { mo: true, bom: true, dept: true, item: true, qty: true, date: true },
  });

  const moTier = new Map(orders.map((o) => [o.mo, tierForOrder(std, o)]));
  const bomTier = new Map<string, number | null>();
  for (const o of orders) {
    const t = moTier.get(o.mo) ?? null;
    if (!bomTier.has(o.bom)) bomTier.set(o.bom, t);
    else if (bomTier.get(o.bom) !== t) bomTier.set(o.bom, null);
  }

  for (const e of entries) {
    const iso = toISODate(e.date);
    const tier = (e.mo ? moTier.get(e.mo) : bomTier.get(e.bom)) ?? null;
    if (tier === null) continue;
    const per = itemHoursFor(std, tier)[e.item];
    if (!per) continue; // AR / MB, panels
    if (!earned.has(iso)) earned.set(iso, { Cut: 0, Welding: 0, ShotBlast: 0, Painting: 0 });
    const day = earned.get(iso)!;
    if (e.dept === "Cut") day.Cut += per.cut * e.qty;
    else if (e.dept === "Welding") day.Welding += per.weld * e.qty;
    else if (e.dept === "ShotBlast") day.ShotBlast += per.shb * e.qty;
    else if (e.dept === "Painting") {
      day.ShotBlast += per.shb * e.qty;
      day.Painting += per.paint * e.qty;
    }
  }
  return earned;
}
