import "server-only";
import { prisma } from "@/lib/db";
import { factoryDayISO, toISODate } from "@/lib/domain/dates";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { formatDate } from "@/lib/domain/format";
import { LV_ITEM } from "@/lib/domain/lv";
import { isPaintExempt, type Item } from "@/lib/domain/constants";
import { itemCentreHoursFor, tierForOrder } from "@/lib/domain/stdEngine";
import {
  DEPT_CENTRES, WORK_CENTRES, centreOf, deptCentre, isShiftCode, lineHours, machineWorkCentre, round1, type WorkCentre,
} from "@/lib/domain/shifts";
import { sectionDept, type WorkerSection } from "@/lib/domain/tanks";
import { downtimeByCause, type DowntimeCause } from "@/lib/domain/downtime";
import {
  centreStat, cockpitActions, earnedOfRecord, lateLines, loadAhead, planAdherence, stageDueISO, weldingCoverage, workingDaysFrom, zeroCentres,
  type CentreDay, type CentreHours, type CentreStat, type CockpitAction, type Coverage, type CoverageInput, type LateLine, type LoadAhead, type PlanCell, type Stage, type StageAdherence,
} from "@/lib/domain/kpis";
import { getStdData } from "./standardTimes";
import { getShiftHours } from "./data";
import { loadHolidays, loadMasterOrdersOf, loadSettingsRow } from "./loads";
import { getWeeklyPlanTracker } from "./weeklyPlanTracker";

// The planner's cockpit, read from what the floor records: the shift log's
// hours by work centre, the Daily log's output priced in standard hours, the
// machine stops, and the newest weekly plan. Every figure comes from the pure
// functions in lib/domain/kpis.ts — the page and the assistant read this one
// loader, so they never disagree.

/** Days of history the trend and the rates read. */
const HISTORY_DAYS = 21;
/** Recorded days the "lately" figures cover. */
const RECENT_DAYS = 7;
/** Working days the load ahead looks over. */
const HORIZON = 10;

export interface CentreTrendDay {
  dateISO: string;
  earnedH: number;
  workedH: number;
  efficiency: number | null;
}

export interface CentreKpi {
  centre: WorkCentre;
  /** The last recorded day. */
  last: CentreStat;
  /** The last RECENT_DAYS recorded days. */
  recent: CentreStat;
  trend: CentreTrendDay[];
}

export interface CockpitData {
  todayISO: string;
  lastDayISO: string | null;
  week: {
    planNo: number | null;
    req: number;
    covered: number;
    days: { iso: string; label: string; req: number; covered: number; isPast: boolean; isToday: boolean }[];
    adherence: StageAdherence[];
    /** The first lines behind, oldest first … */
    late: (LateLine & { soi: string | null })[];
    /** … of all of them. */
    lateCount: number;
  };
  centres: CentreKpi[];
  load: LoadAhead[];
  coverage: Coverage;
  losses: {
    causes: DowntimeCause[];
    unplannedH: number;
    plannedH: number;
    /** Absent rows ÷ recorded rows over the recent days. */
    absentRate: number | null;
    overtimeH: number;
    fromISO: string | null;
  };
  /** Share of the recent output that carries standard hours (a class and an item with hours). */
  pricedShare: number | null;
  actions: CockpitAction[];
  trend: KpiSnapshotPoint[];
}

/** What a day keeps for the trend. */
export interface KpiSnapshotData {
  late: number;
  adherence: Partial<Record<Stage, number | null>>;
  coverageDays: number | null;
  efficiency: Partial<Record<WorkCentre, number | null>>;
  unplannedH: number;
}
export interface KpiSnapshotPoint extends KpiSnapshotData {
  dateISO: string;
}

const dayStart = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Every centre's recorded days since `fromISO` — worked man-hours from the
 *  shift log, earned standard hours from the Daily log, machine hours and
 *  stops — with what the cockpit's other figures need from the same reads. */
async function readCentreDays(fromISO: string) {
  const from = dayStart(fromISO);
  const [std, hrs, orders, shiftRows, ledger, stops, machines] = await Promise.all([
    getStdData(),
    getShiftHours(),
    loadMasterOrdersOf("TR"),
    prisma.shiftEntry.findMany({ where: { date: { gte: from } }, select: { date: true, dept: true, present: true, shift: true, overtimeH: true, center: true, worker: { select: { depts: true } } } }),
    prisma.handoverEntry.findMany({ where: { date: { gte: from }, item: { not: LV_ITEM } }, select: { date: true, dept: true, mo: true, bom: true, item: true, qty: true } }),
    prisma.machineDowntime.findMany({ where: { date: { gte: from } }, select: { date: true, hours: true, reasonCode: true, reason: true, machine: { select: { dept: true, center: true } } } }),
    prisma.machine.findMany({ where: { active: true }, select: { dept: true, center: true, hoursPerDay: true } }),
  ]);

  // ---- an order's KVA class, and the hours a piece per centre for it ----
  const tierByMo = new Map(orders.map((o) => [o.mo, tierForOrder(std, o)]));
  const tierByBom = new Map<string, number | null>();
  for (const o of orders) {
    const t = tierByMo.get(o.mo) ?? null;
    if (!tierByBom.has(o.bom)) tierByBom.set(o.bom, t);
    else if (tierByBom.get(o.bom) !== t) tierByBom.set(o.bom, null);
  }
  const perTier = new Map<number, Record<string, CentreHours>>();
  const perPiece = (tier: number | null, item: string): CentreHours | undefined => {
    if (tier === null) return undefined;
    if (!perTier.has(tier)) perTier.set(tier, itemCentreHoursFor(std, tier));
    return perTier.get(tier)![item];
  };
  const tierOf = (mo: string | null | undefined, bom: string) => ((mo ? tierByMo.get(mo) : undefined) ?? tierByBom.get(bom) ?? null);

  // ---- each recorded day, centre by centre ----
  const days = new Map<string, Map<WorkCentre, CentreDay>>();
  const cell = (iso: string, c: WorkCentre): CentreDay => {
    if (!days.has(iso)) days.set(iso, new Map());
    const m = days.get(iso)!;
    if (!m.has(c)) m.set(c, { dateISO: iso, centre: c, workedH: 0, people: 0, earnedH: 0, machineH: 0, downtimeH: 0 });
    return m.get(c)!;
  };
  let absent = 0, rowsRecent = 0, overtimeH = 0;
  const recordedDates = [...new Set(shiftRows.map((r) => toISODate(r.date)))].sort();
  const recentDates = new Set(recordedDates.slice(-RECENT_DAYS));
  for (const r of shiftRows) {
    const iso = toISODate(r.date);
    if (recentDates.has(iso)) {
      rowsRecent += 1;
      if (!r.present) absent += 1;
      else overtimeH += r.overtimeH;
    }
    if (!r.present) continue;
    const sections = (r.worker.depts ?? "").split(",").map((s) => s.trim()).filter((s) => s && (sectionDept(s as WorkerSection) as string) === r.dept);
    const c = centreOf(r.dept, sections, r.center) ?? deptCentre(r.dept);
    if (!c) continue; // the LV panels
    const d = cell(iso, c);
    d.workedH += lineHours({ present: true, shift: isShiftCode(r.shift) ? r.shift : "S9", overtimeH: r.overtimeH }, hrs);
    d.people += 1;
  }
  let pricedQty = 0, recentQty = 0;
  for (const e of ledger) {
    const iso = toISODate(e.date);
    const per = perPiece(tierOf(e.mo, e.bom), e.item);
    const got = earnedOfRecord(e.dept, e.qty, per);
    const counts = e.dept === "Cut" || e.dept === "Welding" || e.dept === "ShotBlast" || e.dept === "Painting";
    if (counts && recentDates.has(iso)) {
      recentQty += e.qty;
      if (per) pricedQty += e.qty;
    }
    for (const c of WORK_CENTRES) if (got[c] > 0) cell(iso, c).earnedH += got[c];
  }
  const machineH = zeroCentres();
  for (const m of machines) {
    const c = machineWorkCentre(m.dept, m.center);
    if (c) machineH[c] += m.hoursPerDay ?? 0;
  }
  for (const s of stops) {
    const c = machineWorkCentre(s.machine.dept, s.machine.center);
    if (c) cell(toISODate(s.date), c).downtimeH += s.hours;
  }
  const all: CentreDay[] = [];
  for (const [, m] of days) for (const [, d] of m) {
    if (d.workedH > 0) d.machineH = machineH[d.centre];
    all.push(d);
  }
  return { std, orders, stops, days, all, recordedDates, tierByMo, tierOf, perPiece, absent, rowsRecent, overtimeH, pricedQty, recentQty };
}

export interface CentrePace {
  centre: WorkCentre;
  days: number;
  workedH: number;
  earnedH: number;
  /** earned ÷ worked over the window — the floor's pace against the hours a piece now in force. */
  efficiency: number | null;
}

/** How each centre has worked against its hours a piece over the last
 *  `windowDays` days — what the standard-times screen shows beside the typed
 *  figures: a piece takes about (hours a piece ÷ efficiency) on the floor. */
export async function getCentrePace(windowDays = 60, now = new Date()): Promise<{ fromISO: string; centres: CentrePace[] }> {
  const fromISO = addDaysISO(factoryDayISO(now), -windowDays);
  const { all } = await readCentreDays(fromISO);
  return {
    fromISO,
    centres: WORK_CENTRES.map((c) => {
      const s = centreStat(c, all);
      return { centre: c, days: s.days, workedH: s.workedH, earnedH: s.earnedH, efficiency: s.efficiency };
    }),
  };
}

export async function getCockpit(now = new Date()): Promise<CockpitData> {
  const todayISO = factoryDayISO(now);
  const fromISO = addDaysISO(todayISO, -HISTORY_DAYS);
  const [read, settings, holidays, plan] = await Promise.all([readCentreDays(fromISO), loadSettingsRow(), loadHolidays(), getWeeklyPlanTracker()]);
  const { orders, stops, days, all, recordedDates, tierByMo, tierOf, perPiece, absent, rowsRecent, overtimeH, pricedQty, recentQty } = read;

  const workedDates = [...new Set(all.filter((d) => d.workedH > 0).map((d) => d.dateISO))].sort();
  const lastDayISO = workedDates.at(-1) ?? null;
  const recentWorked = new Set(workedDates.slice(-RECENT_DAYS));
  const centres: CentreKpi[] = WORK_CENTRES.map((c) => ({
    centre: c,
    last: centreStat(c, all.filter((d) => d.dateISO === lastDayISO)),
    recent: centreStat(c, all.filter((d) => recentWorked.has(d.dateISO))),
    trend: workedDates.map((iso) => {
      const d = days.get(iso)?.get(c);
      const workedH = d?.workedH ?? 0;
      const earnedH = d?.earnedH ?? 0;
      return { dateISO: iso, workedH: round1(workedH), earnedH: round1(earnedH), efficiency: workedH > 0 ? earnedH / workedH : null };
    }),
  }));

  // ---- the weekly plan ----
  const leads = { cut: settings?.leadCut ?? 4, weld: settings?.leadWeld ?? 1 };
  const cells: (PlanCell & { tier: number | null; soi: string | null })[] = [];
  for (const d of plan.days) {
    for (const row of d.rows) {
      for (const [item, c] of Object.entries(row.items)) {
        if (!c) continue;
        const owed = Math.max(0, c.req - c.na - c.over);
        if (owed <= 0) continue;
        cells.push({
          dayISO: d.iso, bom: row.bom, item, owed, soi: row.soi,
          // pieces made outside need no cutting here
          done: { cut: Math.min(owed, c.cut + c.osp), weld: c.weld, finish: c.finish },
          tier: tierOf(c.mos[0], row.bom),
        });
      }
    }
  }
  const adherence = planAdherence(cells, todayISO, leads);
  const late = lateLines(cells, todayISO, leads).map((l) => ({ ...l, soi: cells.find((c) => c.dayISO === l.dayISO && c.bom === l.bom && c.item === l.item)?.soi ?? null }));

  // ---- the load ahead, centre by centre ----
  const holidaySet = new Set(holidays.map((h) => toISODate(h.date)));
  const horizon = workingDaysFrom(todayISO, HORIZON, holidaySet);
  const dueByCentre = new Map<WorkCentre, { dayISO: string; dueH: number }[]>();
  const owe = (c: WorkCentre, dayISO: string, h: number) => {
    if (!(h > 0)) return;
    if (!dueByCentre.has(c)) dueByCentre.set(c, []);
    dueByCentre.get(c)!.push({ dayISO, dueH: h });
  };
  for (const c of cells) {
    const per = perPiece(c.tier, c.item);
    if (!per) continue;
    const left = (s: Stage) => Math.max(0, c.owed - c.done[s]);
    for (const centre of DEPT_CENTRES.Cut) owe(centre, stageDueISO(c.dayISO, "cut", leads), left("cut") * per[centre]);
    owe("Welding", stageDueISO(c.dayISO, "weld", leads), left("weld") * per.Welding);
    owe("ShotBlast", c.dayISO, left("finish") * per.ShotBlast);
    if (!isPaintExempt(c.item as Item)) owe("Painting", c.dayISO, left("finish") * per.Painting);
  }
  const load = WORK_CENTRES.map((c) => {
    const k = centres.find((x) => x.centre === c)!;
    // what the centre usually has, at the pace it has measured (the standard when unmeasured)
    const perDay = k.recent.days > 0 ? k.recent.workedH / k.recent.days : 0;
    const pace = k.recent.efficiency === null ? 1 : Math.min(1.5, Math.max(0.3, k.recent.efficiency));
    return loadAhead(c, horizon, dueByCentre.get(c) ?? [], perDay * pace);
  }).filter((l) => l.days.some((d) => d.dueH > 0) || l.loadRate !== null);

  // ---- welding coverage: cut and waiting, against the welders' pace ----
  const openMos = orders.filter((o) => o.status === "open").map((o) => o.mo);
  const sums = openMos.length
    ? await prisma.handoverEntry.groupBy({ by: ["mo", "item", "dept"], where: { mo: { in: openMos }, dept: { in: ["Cut", "Welding"] } }, _sum: { qty: true } })
    : [];
  const byMoItem = new Map<string, { cut: number; weld: number }>();
  for (const s of sums) {
    const k = `${s.mo}|${s.item}`;
    const v = byMoItem.get(k) ?? { cut: 0, weld: 0 };
    if (s.dept === "Cut") v.cut += s._sum.qty ?? 0;
    else v.weld += s._sum.qty ?? 0;
    byMoItem.set(k, v);
  }
  const wip = new Map<string, CoverageInput>();
  for (const [k, v] of byMoItem) {
    const pcs = Math.max(0, v.cut - v.weld);
    if (!(pcs > 0)) continue;
    const [mo, item] = k.split("|");
    const per = perPiece(tierByMo.get(mo) ?? null, item);
    const w = wip.get(item) ?? { item, pcs: 0, weldH: 0 };
    w.pcs += pcs;
    w.weldH += pcs * (per?.Welding ?? 0);
    wip.set(item, w);
  }
  const weldRecent = centres.find((c) => c.centre === "Welding")!.trend.filter((t) => recentWorked.has(t.dateISO)).map((t) => t.earnedH);
  const coverage = weldingCoverage([...wip.values()], weldRecent);

  // ---- what was lost lately ----
  // the stops since the first of the recent recorded days (the last week when nothing is recorded)
  const lossFrom = workedDates.at(-RECENT_DAYS) ?? addDaysISO(todayISO, -7);
  const loss = downtimeByCause(stops.filter((s) => toISODate(s.date) >= lossFrom));
  const losses = {
    ...loss,
    absentRate: rowsRecent > 0 ? absent / rowsRecent : null,
    overtimeH: round1(overtimeH),
    fromISO: lossFrom,
  };

  const recentStats = centres.map((c) => c.recent);
  const topLoss = loss.causes.find((c) => !c.planned) ?? null;
  const actions = cockpitActions({
    late, lateCount: late.length, coverage, load, centres: recentStats,
    topLoss: topLoss ? { label: topLoss.label, hours: topLoss.hours } : null,
    todayRecorded: recordedDates.includes(todayISO),
    ddmm: (iso) => formatDate(iso),
  });

  // ---- keep today's figures for the trend ----
  const snap: KpiSnapshotData = {
    late: late.length,
    adherence: Object.fromEntries(adherence.map((a) => [a.stage, a.rate])),
    coverageDays: coverage.days,
    efficiency: Object.fromEntries(recentStats.map((s) => [s.centre, s.efficiency])),
    unplannedH: loss.unplannedH,
  };
  const trend = await keepSnapshot(todayISO, snap);

  return {
    todayISO,
    lastDayISO,
    week: {
      planNo: plan.planNo,
      req: plan.req,
      covered: plan.covered,
      days: plan.days.map((d) => ({ iso: d.iso, label: d.label, req: d.req, covered: d.covered, isPast: d.isPast, isToday: d.isToday })),
      adherence,
      late: late.slice(0, 20),
      lateCount: late.length,
    },
    centres,
    load,
    coverage,
    losses,
    pricedShare: recentQty > 0 ? pricedQty / recentQty : null,
    actions,
    trend,
  };
}

/** Write today's figures (rewritten while the day lasts) and read the last
 *  fortnight back. A failure to write never stops the cockpit. */
async function keepSnapshot(todayISO: string, data: KpiSnapshotData): Promise<KpiSnapshotPoint[]> {
  const date = dayStart(todayISO);
  try {
    await prisma.kpiSnapshot.upsert({ where: { date }, create: { date, data: data as object }, update: { data: data as object } });
  } catch {
    // the trend just misses today
  }
  const rows = await prisma.kpiSnapshot.findMany({ where: { date: { gte: dayStart(addDaysISO(todayISO, -28)) } }, orderBy: { date: "asc" } });
  return rows.map((r) => ({ dateISO: toISODate(r.date), ...(r.data as unknown as KpiSnapshotData) }));
}
