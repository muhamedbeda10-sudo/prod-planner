import "server-only";
import { prisma } from "@/lib/db";
import { toISODate } from "@/lib/domain/dates";
import { deptLabel } from "@/lib/domain/constants";
import { guardLedger } from "@/lib/domain/ledgerGuard";
import { getEarnedHours } from "./report";
import { getRecentHandover } from "./handover";
import { getOrderEtas } from "./eta";
import { getPlanCapacity } from "./planCapacity";
import { getStageCapacity } from "./standardTimes";

/* The morning brief: what the factory manager needs to know at 7am, computed
 * from the ledger — yesterday's output priced in std-hours, where the week is
 * heading, which orders are forecast late, and what the data guard wants a
 * human to look at. Rendered by the Morning Brief page (/report/morning). */

export interface MorningDigest {
  dayISO: string; // the working day being reported (last one before today)
  output: { dept: string; pcs: number }[];
  earned: { stage: string; hours: number; capacity: number | null }[]; // capacity = mh available that day
  earnedTotal: number;
  uncoveredPcs: number;
  totalPcs: number;
  pace: { planNo: number; elapsedWd: number; workingDays: number; coverage: number; worst: string | null } | null;
  lateOrders: { mo: string; dueISO: string; etaISO: string }[];
  flagged: { dateISO: string; dept: string; bom: string; qty: number; detail: string }[];
}

const DAY = 86400000;

/** The last WORKING day strictly before today (skips Fridays and holidays). */
export async function lastWorkingDay(): Promise<Date> {
  const off = new Set((await prisma.holiday.findMany()).map((h) => toISODate(h.date)));
  let d = new Date(Math.floor(Date.now() / DAY) * DAY - DAY);
  while (d.getUTCDay() === 5 || off.has(toISODate(d))) d = new Date(d.getTime() - DAY);
  return d;
}

export async function buildMorningDigest(): Promise<MorningDigest> {
  const day = await lastWorkingDay();
  const dayISO = toISODate(day);
  const next = new Date(day.getTime() + DAY);

  const [entries, earned, capacity, recent, latest] = await Promise.all([
    prisma.handoverEntry.groupBy({
      by: ["dept"],
      where: { date: { gte: day, lt: next } },
      _sum: { qty: true },
    }),
    getEarnedHours(day),
    getStageCapacity(),
    getRecentHandover(2000),
    prisma.planSchedule.aggregate({ _max: { planNo: true } }),
  ]);

  const output = entries
    .map((e) => ({ dept: deptLabel(e.dept), pcs: e._sum.qty ?? 0 }))
    .filter((e) => e.pcs > 0)
    .sort((a, b) => b.pcs - a.pcs);

  // earned per report stage vs that DAY's capacity (finishing = shb + paint)
  const capFor = (stage: string): number | null => {
    if (stage === "Cut") return capacity.Cut ?? null;
    if (stage === "Welding") return capacity.Welding ?? null;
    const shb = capacity.ShotBlast;
    const paint = capacity.Painting;
    return shb === undefined && paint === undefined ? null : (shb ?? 0) + (paint ?? 0);
  };
  const earnedRows = (["Cut", "Welding", "Finishing"] as const).map((stage) => ({
    stage: stage === "Finishing" ? "Painting & Shot Blast" : deptLabel(stage),
    hours: earned.byStage[stage] ?? 0,
    capacity: capFor(stage),
  }));

  // the weekly plan's pace line, if the window is live
  const cap = await getPlanCapacity(latest._max.planNo ?? null);
  const pace =
    cap?.pace != null
      ? {
          planNo: cap.planNo,
          elapsedWd: cap.pace.elapsedWd,
          workingDays: cap.workingDays,
          coverage: cap.pace.projectedCoverage,
          worst:
            cap.pace.worstStage && cap.pace.worstStage.coverage < 1
              ? `${deptLabel(cap.pace.worstStage.dept)} ${Math.round(cap.pace.worstStage.coverage * 100)}%`
              : null,
        }
      : null;

  // orders forecast to land after their delivery date, soonest due first
  const { byMo } = await getOrderEtas();
  const lateOrders = [...byMo.entries()]
    .filter(([, e]) => e.late && e.etaISO && e.dueISO)
    .map(([mo, e]) => ({ mo, dueISO: e.dueISO!, etaISO: e.etaISO! }))
    .sort((a, b) => (a.dueISO < b.dueISO ? -1 : 1))
    .slice(0, 8);

  // what the data guard wants checked — the reported day first, then the rest
  const flags = guardLedger(
    recent.map((r) => ({
      id: r.id,
      dateISO: toISODate(r.date),
      dept: r.dept,
      bom: r.bom,
      mo: r.mo,
      item: r.item,
      qty: r.qty,
      createdISO: r.createdAt.toISOString(),
    }))
  );
  const flagged = recent
    .filter((r) => flags.has(r.id))
    .map((r) => ({
      dateISO: toISODate(r.date),
      dept: deptLabel(r.dept),
      bom: r.bom,
      qty: r.qty,
      detail: flags.get(r.id)!.map((f) => f.detail).join(" · "),
    }))
    .sort((a, b) => (a.dateISO === dayISO ? -1 : 0) - (b.dateISO === dayISO ? -1 : 0))
    .slice(0, 8);

  return {
    dayISO,
    output,
    earned: earnedRows,
    earnedTotal: earned.total,
    uncoveredPcs: earned.totalPcs - earned.coveredPcs,
    totalPcs: earned.totalPcs,
    pace,
    lateOrders,
    flagged,
  };
}
