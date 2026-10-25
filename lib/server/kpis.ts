import "server-only";
import { prisma } from "@/lib/db";
import { factoryDayISO, monthLabelFromInput, toISODate } from "@/lib/domain/dates";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { formatDate } from "@/lib/domain/format";
import { LV_ITEM } from "@/lib/domain/lv";
import { applicableItems, isPaintExempt, ospOf, type Item } from "@/lib/domain/constants";
import { workingDaysInclusive } from "@/lib/domain/insights";
import { itemCentreHoursFor, tierForOrder } from "@/lib/domain/stdEngine";
import {
  DEFAULT_SHIFT, DEPT_CENTRES, WORK_CENTRES, centreOf, deptCentre, isShiftCode, isWorkCentre, lineHours, machineWorkCentre, round1, type WorkCentre,
} from "@/lib/domain/shifts";
import { sectionDept } from "@/lib/domain/tanks";
import { parseWorkerSections } from "@/lib/domain/workers";
import { downtimeByCause, type DowntimeCause } from "@/lib/domain/downtime";
import { downtimeHoursInRange, downtimeWindowWhere, splitDowntimeDays } from "@/lib/domain/downtimePeriods";
import { FACTOR_MAX, FACTOR_MIN, MIN_CALIBRATION_DAYS } from "@/lib/domain/calibration";
import {
  centreStat, cockpitActions, combinedStat, earnedOfRecord, inMonthPlan, isFloorAction, lateLines, loadAhead, manpowerPlan, parseKpiSnapshot, planAdherence, stageDueISO, weldingCoverage, workingDaysFrom, zeroCentres,
  type CentreDay, type CentreHours, type CentreStat, type CockpitAction, type Coverage, type CoverageInput, type KpiSnapshotData, type KpiSnapshotPoint,
  type LateLine, type LoadAhead, type ManpowerRow, type PlanCell, type Stage, type StageAdherence,
} from "@/lib/domain/kpis";
import { getStdData } from "./standardTimes";
import { getSettings, getShiftHours } from "./data";
import { loadHolidays, loadMasterOrdersOf } from "./loads";
import { getWeeklyPlanTracker } from "./weeklyPlanTracker";
import { CALIBRATION_WINDOW_DAYS } from "./calibration";
import { earnedLvOnDays } from "./lvStd";
import { withLine } from "./line";

// The planner's cockpit, read from what the floor records: the shift log's
// hours by work centre, the Daily log's output priced in standard hours, the
// machine stops, and the newest weekly plan. Every figure comes from the pure
// functions in lib/domain/kpis.ts — the page and the assistant read this one
// loader, so they never disagree. It only reads: today's point of the trend
// is written apart (recordKpiSnapshot).

/** Days of history the trend and the rates read. */
const HISTORY_DAYS = 21;
/** Recorded days the "lately" figures cover — the Shifts page's productivity window. */
const RECENT_DAYS = 7;
/** Days of the stored trend shown. */
const TREND_DAYS = 28;
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
  /** Laser / punch, bending and fin folding together, over the recent days. */
  fabrication: { workedH: number; earnedH: number; efficiency: number | null };
  load: LoadAhead[];
  coverage: Coverage;
  /** The month's plan in people: what it needs at each centre against who comes. */
  manpower: {
    monthLabel: string;
    /** Working days in the month, and those left from today. */
    monthWd: number;
    leftWd: number;
    /** Net hours one person works a day — the day shift less its break (Settings). */
    hoursPerPersonDay: number;
    /** Transformers the month's plan asks for. */
    pieces: number;
    rows: ManpowerRow[];
  };
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
  /** Today's figures as the trend keeps them. */
  snapshot: KpiSnapshotData;
  /** The stored days, today's as it reads now. */
  trend: KpiSnapshotPoint[];
}

const dayStart = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Every centre's recorded days since `fromISO` — worked man-hours from the
 *  shift log, earned standard hours from the Daily log, machine hours and
 *  stops — with what the cockpit's other figures need from the same reads. */
async function readCentreDays(fromISO: string) {
  const from = dayStart(fromISO);
  const stopNow = new Date(), stopToday = factoryDayISO(stopNow);
  const [std, hrs, orders, shiftRows, ledger, stops, machines, lvShotBlast] = await Promise.all([
    getStdData(),
    getShiftHours(),
    loadMasterOrdersOf("TR"),
    prisma.shiftEntry.findMany({ where: { date: { gte: from } }, select: { date: true, dept: true, present: true, shift: true, overtimeH: true, center: true, worker: { select: { depts: true } } } }),
    prisma.handoverEntry.findMany({ where: { date: { gte: from }, item: { not: LV_ITEM } }, select: { date: true, dept: true, mo: true, bom: true, item: true, qty: true } }),
    prisma.machineDowntime.findMany({ where: downtimeWindowWhere(fromISO, stopToday), select: { date: true, hours: true, startTime: true, endTime: true, endsNextDay: true, isOpen: true, endDate: true, reasonCode: true, reason: true, customDept: true, customCentre: true, machine: { select: { dept: true, center: true } } } }),
    prisma.machine.findMany({ where: { active: true }, select: { dept: true, center: true, hoursPerDay: true } }),
    // the one shot-blast crew blasts the LV panels as well — its booked hours
    // cover both, so the panels' shot-blast hours count on its side (as the calibration does)
    lvShotBlastSince(fromISO),
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
  // an order's class by its number, else by its project's — a plan line or a
  // record whose order is not on the master list yet is still priced
  const tierOf = (mo: string | null | undefined, bom: string) => (mo ? tierByMo.get(mo) : undefined) ?? tierByBom.get(bom) ?? null;

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
    // the worker's sections in this row's department (legacy codes translated, unknown ones dropped)
    const sections = parseWorkerSections(r.worker.depts).filter((s) => sectionDept(s) === r.dept);
    const c = centreOf(r.dept, sections, r.center) ?? deptCentre(r.dept);
    if (!c) continue; // the LV panels — not the transformers' figures
    const shift = isShiftCode(r.shift) ? r.shift : DEFAULT_SHIFT;
    if (recentDates.has(iso)) {
      rowsRecent += 1;
      if (!r.present) absent += 1;
      // Both day and night overtime contribute to resource effort.
      else if (r.overtimeH > 0) overtimeH += r.overtimeH;
    }
    if (!r.present) continue;
    const d = cell(iso, c);
    d.workedH += lineHours({ present: true, shift, overtimeH: r.overtimeH }, hrs);
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
    for (const c of WORK_CENTRES) if (got[c] !== 0) cell(iso, c).earnedH += got[c];
  }
  for (const [iso, h] of lvShotBlast) cell(iso, "ShotBlast").earnedH += h;
  const machineH = zeroCentres();
  for (const m of machines) {
    const c = machineWorkCentre(m.dept, m.center);
    if (c) machineH[c] += m.hoursPerDay ?? 0;
  }
  for (const s of stops) {
    const c = s.machine ? machineWorkCentre(s.machine.dept, s.machine.center) : s.customCentre && isWorkCentre(s.customCentre) ? s.customCentre : null;
    if (c) for (const day of splitDowntimeDays(s, fromISO, stopToday, stopNow)) cell(toISODate(day.date), c).downtimeH += day.hours;
  }
  const all: CentreDay[] = [];
  for (const [, m] of days) for (const [, d] of m) {
    if (d.workedH > 0) d.machineH = machineH[d.centre];
    all.push(d);
  }
  return { std, orders, stops, days, all, recordedDates, tierByBom, tierOf, perPiece, absent, rowsRecent, overtimeH, pricedQty, recentQty, lvShotBlast };
}

/** The LV panels' shot-blast std-hours by day since `fromISO`. */
async function lvShotBlastSince(fromISO: string): Promise<Map<string, number>> {
  const rows = await prisma.handoverEntry.findMany({ where: { date: { gte: dayStart(fromISO) }, item: LV_ITEM }, select: { date: true }, distinct: ["date"] });
  const earned = await earnedLvOnDays([...new Set(rows.map((r) => toISODate(r.date)))]);
  const out = new Map<string, number>();
  for (const [iso, lv] of earned) if (lv.ShotBlast) out.set(iso, lv.ShotBlast);
  return out;
}

/** The pace a centre's measured efficiency may stand for — the calibration's own sanity limits. */
const clampPace = (e: number) => Math.min(1 / FACTOR_MIN, Math.max(1 / FACTOR_MAX, e));

export interface CentrePace {
  centre: WorkCentre;
  days: number;
  workedH: number;
  earnedH: number;
  /** earned ÷ worked over the window — the floor's pace against the hours a
   *  piece now in force; null until the centre has the calibration's minimum
   *  of recorded days. Held to the calibration's limits. */
  efficiency: number | null;
}

/** How each centre has worked against its hours a piece over the
 *  calibration's window — what the standard-times screen shows beside the
 *  typed figures: a piece takes about (hours a piece ÷ efficiency) on the floor. */
export async function getCentrePace(now = new Date()): Promise<{ fromISO: string; centres: CentrePace[] }> {
  const fromISO = addDaysISO(factoryDayISO(now), -CALIBRATION_WINDOW_DAYS);
  const { all } = await readCentreDays(fromISO);
  return {
    fromISO,
    centres: WORK_CENTRES.map((c) => {
      const s = centreStat(c, all);
      const efficiency = s.days >= MIN_CALIBRATION_DAYS && s.efficiency !== null && s.efficiency > 0 ? clampPace(s.efficiency) : null;
      return { centre: c, days: s.days, workedH: s.workedH, earnedH: s.earnedH, efficiency };
    }),
  };
}

export async function getCockpit(now = new Date()): Promise<CockpitData> {
  const todayISO = factoryDayISO(now);
  const fromISO = addDaysISO(todayISO, -HISTORY_DAYS);
  const [read, settings, holidays, plan] = await Promise.all([
    readCentreDays(fromISO), getSettings(), loadHolidays(),
    // the transformers' plan, whichever line the toggle is on
    withLine("TR", () => getWeeklyPlanTracker()),
  ]);
  const { orders, stops, days, all, recordedDates, tierByBom, tierOf, perPiece, absent, rowsRecent, overtimeH, pricedQty, recentQty, lvShotBlast } = read;

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
  const leads = { cut: settings.leadCut, weld: settings.leadWeld };
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
    // what the centre usually has, at the pace it has measured (the standard
    // while nothing it made is priced); no booked hours, no capacity to judge by
    if (!(k.recent.workedH > 0)) return loadAhead(c, horizon, dueByCentre.get(c) ?? [], null);
    const pace = k.recent.efficiency !== null && k.recent.efficiency > 0 ? clampPace(k.recent.efficiency) : 1;
    // the shot-blast crew's day goes partly to the LV panels — what is left is the transformers'
    // (over the days the crew itself booked — the days its pace is measured on)
    const lvPerDay = c === "ShotBlast"
      ? [...recentWorked].filter((iso) => (days.get(iso)?.get("ShotBlast")?.workedH ?? 0) > 0).reduce((s, iso) => s + (lvShotBlast.get(iso) ?? 0), 0) / k.recent.days
      : 0;
    return loadAhead(c, horizon, dueByCentre.get(c) ?? [], Math.max(0, (k.recent.workedH / k.recent.days) * pace - lvPerDay));
  }).filter((l) => l.days.some((d) => d.dueH > 0) || l.loadRate !== null);

  // ---- welding coverage: cut and waiting, against the welders' pace ----
  // netted project by project, over all its records: the Daily log's form
  // records no order number, so cut on the form and welded against an order
  // (or the other way round) still meet
  const openBoms = [...new Set(orders.filter((o) => o.status === "open").map((o) => o.bom))];
  const sums = openBoms.length
    ? await prisma.handoverEntry.groupBy({
      by: ["bom", "item", "dept"],
      where: { dept: { in: ["Cut", "Welding"] }, item: { not: LV_ITEM }, bom: { in: openBoms } },
      _sum: { qty: true },
    })
    : [];
  const byBomItem = new Map<string, { bom: string; item: string; cut: number; weld: number }>();
  for (const s of sums) {
    const k = `${s.bom}|${s.item}`;
    const v = byBomItem.get(k) ?? { bom: s.bom, item: s.item, cut: 0, weld: 0 };
    if (s.dept === "Cut") v.cut += s._sum.qty ?? 0;
    else v.weld += s._sum.qty ?? 0;
    byBomItem.set(k, v);
  }
  const wip = new Map<string, CoverageInput>();
  for (const v of byBomItem.values()) {
    const pcs = Math.max(0, v.cut - v.weld);
    if (!(pcs > 0)) continue;
    const per = perPiece(tierByBom.get(v.bom) ?? null, v.item);
    const w = wip.get(v.item) ?? { item: v.item, pcs: 0, weldH: 0 };
    w.pcs += pcs;
    w.weldH += pcs * (per?.Welding ?? 0);
    wip.set(v.item, w);
  }
  const weldRecent = centres.find((c) => c.centre === "Welding")!.trend.filter((t) => recentWorked.has(t.dateISO)).map((t) => t.earnedH);
  const coverage = weldingCoverage([...wip.values()], weldRecent);

  // ---- what was lost lately ----
  // the stops since the first of the recent recorded days (the last week when nothing is recorded)
  const lossFrom = workedDates.at(-Math.min(RECENT_DAYS, workedDates.length)) ?? addDaysISO(todayISO, -7);
  const loss = downtimeByCause(stops.map((s) => ({ ...s, hours: downtimeHoursInRange(s, lossFrom, todayISO, new Date()) })));
  const losses = {
    ...loss,
    absentRate: rowsRecent > 0 ? absent / rowsRecent : null,
    overtimeH: round1(overtimeH),
    fromISO: lossFrom,
  };

  const recentStats = centres.map((c) => c.recent);

  // ---- the month's plan in people ----
  // the orders of this month's plan: each one's components × its pieces, the
  // outsourced ones left out, priced at the order's class; what the ledger
  // earned on them since the month began is done
  const monthStartISO = `${todayISO.slice(0, 7)}-01`;
  const [y, m] = todayISO.split("-").map(Number);
  const monthEndISO = toISODate(new Date(Date.UTC(y, m, 0)));
  const monthLabel = monthLabelFromInput(todayISO.slice(0, 7)) ?? todayISO.slice(0, 7);
  const monthOrders = orders.filter((o) => inMonthPlan({ months: o.months, source: o.source, status: o.status, closedDayISO: o.closedAt ? factoryDayISO(o.closedAt) : null }, monthLabel, monthStartISO));
  const requiredH = zeroCentres();
  let monthPieces = 0;
  for (const o of monthOrders) {
    monthPieces += o.planQty;
    for (const item of applicableItems(o)) {
      const qty = Math.max(0, o.planQty - ospOf(o, item));
      const per = perPiece(tierOf(o.mo, o.bom), item);
      if (!per || !(qty > 0)) continue;
      for (const c of WORK_CENTRES) requiredH[c] += per[c] * qty;
    }
  }
  // done = everything ever earned on the month's orders (an order carried over
  // from last month brings its work along, as its pieces are counted whole);
  // a row the Daily log's form recorded without an order number counts when
  // its project has no other open order it could belong to, this month on
  const monthMos = monthOrders.map((o) => o.mo);
  const monthMoSet = new Set(monthMos);
  const soleBoms = [...new Set(monthOrders.map((o) => o.bom))].filter((bom) => orders.every((o) => o.bom !== bom || o.status !== "open" || monthMoSet.has(o.mo)));
  const monthLedger = monthMos.length
    ? await prisma.handoverEntry.findMany({
      where: {
        item: { not: LV_ITEM },
        OR: [
          { mo: { in: monthMos } },
          { date: { gte: dayStart(monthStartISO) }, bom: { in: soleBoms }, OR: [{ mo: null }, { mo: "" }] },
        ],
      },
      select: { date: true, dept: true, mo: true, bom: true, item: true, qty: true },
    })
    : [];
  const doneH = zeroCentres();
  const doneBeforeH = zeroCentres();
  const monthStart = dayStart(monthStartISO);
  for (const e of monthLedger) {
    const got = earnedOfRecord(e.dept, e.qty, perPiece(tierOf(e.mo, e.bom), e.item));
    const before = e.date < monthStart;
    for (const c of WORK_CENTRES) {
      doneH[c] += got[c];
      if (before) doneBeforeH[c] += got[c];
    }
  }
  const cal = { hoursPerPersonDay: settings.shiftShortH, monthWd: workingDaysInclusive(monthStartISO, monthEndISO, holidaySet), leftWd: workingDaysInclusive(todayISO, monthEndISO, holidaySet) };
  const manpower = {
    monthLabel, ...cal, pieces: monthPieces,
    rows: manpowerPlan(
      WORK_CENTRES.map((c) => {
        const k = centres.find((x) => x.centre === c)!;
        return { centre: c, requiredH: requiredH[c], doneH: doneH[c], doneBeforeH: doneBeforeH[c], present: k.recent.days > 0 ? k.recent.people : null };
      }),
      cal,
    ),
  };

  const topLoss = loss.causes.find((c) => !c.planned) ?? null;
  const actions = cockpitActions({
    late, lateCount: late.length, coverage, load, centres: recentStats, manpower: manpower.rows,
    topLoss: topLoss ? { label: topLoss.label, hours: topLoss.hours } : null,
    todayRecorded: recordedDates.includes(todayISO),
    ddmm: (iso) => formatDate(iso),
  });

  // ---- today's figures, as the trend keeps them ----
  const fabrication = combinedStat(recentStats.filter((s) => (DEPT_CENTRES.Cut as readonly WorkCentre[]).includes(s.centre)));
  const snapshot: KpiSnapshotData = {
    late: late.length,
    adherence: Object.fromEntries(adherence.map((a) => [a.stage, a.rate])),
    coverageDays: coverage.days,
    efficiency: Object.fromEntries(recentStats.map((s) => [s.centre, s.efficiency])),
    fabEfficiency: fabrication.efficiency,
    unplannedH: loss.unplannedH,
  };
  const stored = await prisma.kpiSnapshot.findMany({ where: { date: { gte: dayStart(addDaysISO(todayISO, -TREND_DAYS)), lt: dayStart(todayISO) } }, orderBy: { date: "asc" } });
  const trend: KpiSnapshotPoint[] = [...stored.map((r) => ({ dateISO: toISODate(r.date), ...parseKpiSnapshot(r.data) })), { dateISO: todayISO, ...snapshot }];

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
    fabrication,
    load,
    coverage,
    manpower,
    losses,
    pricedShare: recentQty > 0 ? pricedQty / recentQty : null,
    actions,
    snapshot,
    trend,
  };
}

/** Keep the day's figures for the trend — rewritten while the day lasts, so
 *  the day keeps its last reading. Called after the cockpit is served and by
 *  the automations' hourly housekeeping; a failure only costs the point. */
export async function recordKpiSnapshot(c: Pick<CockpitData, "todayISO" | "snapshot">): Promise<void> {
  const date = dayStart(c.todayISO);
  const data = c.snapshot as object;
  try {
    await prisma.kpiSnapshot.upsert({ where: { date }, create: { date, data }, update: { data } });
  } catch (e) {
    console.error("kpis: could not keep today's snapshot", e);
  }
}

/** The cockpit without the shift log's figures — for an account the Shifts
 *  screen is closed to. Taken out on the server, so they never reach the
 *  browser. */
export function withoutFloor(c: CockpitData): CockpitData {
  return {
    ...c,
    centres: [],
    fabrication: { workedH: 0, earnedH: 0, efficiency: null },
    losses: { causes: [], unplannedH: 0, plannedH: 0, absentRate: null, overtimeH: 0, fromISO: null },
    pricedShare: null,
    manpower: { ...c.manpower, rows: c.manpower.rows.map((r) => ({ ...r, present: null, gap: null, tone: null })) },
    actions: c.actions.filter((a) => !isFloorAction(a)),
    snapshot: { ...c.snapshot, efficiency: {}, fabEfficiency: null, unplannedH: null },
    trend: c.trend.map((t) => ({ ...t, efficiency: {}, fabEfficiency: null, unplannedH: null })),
  };
}
