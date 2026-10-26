import "server-only";
import { prisma } from "@/lib/db";
import { factoryDayISO, toISODate } from "@/lib/domain/dates";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { cycleDays, firstPassRate, returnsByWeek, returnsSummary, type CycleStat, type FirstPass, type ReturnsSummary } from "@/lib/domain/quality";
import type { TankStatus } from "@/lib/domain/tanks";
import { getSettings } from "./data";
import { loadMasterOrdersOf } from "./loads";

// Quality and rework on the transformers for the Production dashboard: the
// tanks' leak test and waits (while tanks are tracked piece by piece), and
// the pieces sent back upstream. The arithmetic is lib/domain/quality.ts.

export interface QualityPeriod {
  fromISO: string;
  toISO: string;
  /** Tanks tracked piece by piece (Settings) — without it the tank figures are not kept. */
  tankTracking: boolean;
  tanks: {
    /** Where the open tanks stand now. */
    waitingTest: number;
    inRepair: number;
    readyToPaint: number;
    /** Tanks welded and painted in the period. */
    weldedInPeriod: number;
    paintedInPeriod: number;
    firstPass: FirstPass;
    weldToTest: CycleStat;
    testToPaint: CycleStat;
  } | null;
  returns: ReturnsSummary;
  /** Returns filed per week of the period (the Saturday the week starts), newest last. */
  returnsByWeek: { weekISO: string; qty: number; count: number }[];
}

const dayStart = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

export async function getQualityPeriod(fromISO: string, toISO: string): Promise<QualityPeriod> {
  const until = { gte: dayStart(fromISO), lt: dayStart(addDaysISO(toISO, 1)) };
  const [settings, returns, orders] = await Promise.all([
    getSettings(),
    prisma.returnEntry.findMany({ where: { OR: [{ status: "open" }, { date: until }] }, select: { date: true, qty: true, reason: true, status: true, mo: true } }),
    loadMasterOrdersOf("TR"),
  ]);
  const urgent = new Set(orders.filter((o) => o.urgent && o.status === "open").map((o) => o.mo));
  const rows = returns.map((r) => ({ dateISO: toISODate(r.date), qty: r.qty, reason: r.reason, status: r.status, urgent: !!r.mo && urgent.has(r.mo) }));
  const base = {
    fromISO, toISO, tankTracking: settings.tankTracking,
    returns: returnsSummary(rows, fromISO, toISO),
    returnsByWeek: returnsByWeek(rows, fromISO, toISO),
  };
  if (!settings.tankTracking) return { ...base, tanks: null };

  const leak = { in: ["leak-pass", "leak-repair"] };
  const [counts, tanks, inPeriodAttempts] = await Promise.all([
    prisma.tankUnit.groupBy({ by: ["status"], where: { status: { in: ["welded", "repair", "tested"] } }, _count: { _all: true } }),
    // the tanks that reached a step in the period, however long ago they were welded
    prisma.tankUnit.findMany({ where: { OR: [{ weldedAt: until }, { testedAt: until }, { paintedAt: until }] }, select: { weldedAt: true, testedAt: true, paintedAt: true } }),
    prisma.tankEvent.findMany({ where: { kind: leak, at: until }, select: { tankId: true } }),
  ]);
  // every attempt of the tanks tested in the period, so a re-test of an old failure is never read as a first test
  const tankIds = [...new Set(inPeriodAttempts.map((a) => a.tankId))];
  const attempts = tankIds.length ? await prisma.tankEvent.findMany({ where: { kind: leak, tankId: { in: tankIds } }, select: { tankId: true, kind: true, at: true } }) : [];
  const count = (s: TankStatus) => counts.find((c) => c.status === s)?._count._all ?? 0;
  // the factory's day of a moment — the day the records are judged on
  const day = (d: Date) => factoryDayISO(d);
  const inPeriod = (d: Date | null) => !!d && day(d) >= fromISO && day(d) <= toISO;
  const times = tanks.map((t) => ({ weldedISO: day(t.weldedAt), testedISO: t.testedAt ? day(t.testedAt) : null, paintedISO: t.paintedAt ? day(t.paintedAt) : null }));
  const cycle = cycleDays(times, fromISO, toISO);
  return {
    ...base,
    tanks: {
      waitingTest: count("welded"),
      inRepair: count("repair"),
      readyToPaint: count("tested"),
      weldedInPeriod: tanks.filter((t) => inPeriod(t.weldedAt)).length,
      paintedInPeriod: tanks.filter((t) => inPeriod(t.paintedAt)).length,
      firstPass: firstPassRate(attempts.map((a) => ({ tankId: a.tankId, kind: a.kind as "leak-pass" | "leak-repair", atISO: `${day(a.at)}T${a.at.toISOString().slice(11)}` })), fromISO, toISO),
      weldToTest: cycle.weldToTest,
      testToPaint: cycle.testToPaint,
    },
  };
}
