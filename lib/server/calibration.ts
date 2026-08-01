import "server-only";
import { prisma } from "@/lib/db";
import { toISODate } from "@/lib/domain/dates";
import { tierForOrder, itemHoursFor } from "@/lib/domain/stdEngine";
import { calibrate, type CalibrationSummary } from "@/lib/domain/calibration";
import { getStdData } from "./standardTimes";

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
    prisma.masterOrder.findMany({ select: { mo: true, bom: true, fgCode: true, kva: true } }),
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
  // (a Painting entry banks its shot-blast share to the ShotBlast stage)
  const dates = [...byDate.keys()];
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

  const earned = new Map<string, Record<CalStage, number>>(); // dateISO → per stage
  for (const e of entries) {
    const iso = toISODate(e.date);
    const tier = (e.mo ? moTier.get(e.mo) : bomTier.get(e.bom)) ?? null;
    if (tier === null) continue;
    const per = itemHoursFor(std, tier)[e.item];
    if (!per) continue; // AR / MB
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
