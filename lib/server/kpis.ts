import "server-only";
import { prisma } from "@/lib/db";
import { factoryDayISO, toISODate } from "@/lib/domain/dates";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { formatDate } from "@/lib/domain/format";
import { LV_ITEM } from "@/lib/domain/lv";
import { applicableItems, finishDeptOf, isPaintExempt, ospOf, type Item } from "@/lib/domain/constants";
import { itemCentreHoursFor, tierForOrder } from "@/lib/domain/stdEngine";
import {
  DEFAULT_SHIFT, DEPT_CENTRES, SHIFT_DEPTS, WORK_CENTRES, centreOf, deptCentre, isShiftCode, isWorkCentre, lineHours, machineWorkCentre, round1, type WorkCentre,
} from "@/lib/domain/shifts";
import { sectionDept } from "@/lib/domain/tanks";
import { parseWorkerSections } from "@/lib/domain/workers";
import { downtimeByCause, downtimeLabel, isDowntimeCode, minuteHours, stopsByMachine, type DowntimeCause, type DowntimeCode, type MachineStopRank } from "@/lib/domain/downtime";
import { biggestLoss, explainChange, lossWaterfall, type LossChange, type LossDay, type LossWaterfall } from "@/lib/domain/losses";
import { downtimeHoursInRange, downtimeWindowWhere, elapsedStopHours, splitDowntimeDays } from "@/lib/domain/downtimePeriods";
import { gapDays, productionActions, type GapDay, type OpenStopView } from "@/lib/domain/productionActions";
import { getQualityPeriod, type QualityPeriod } from "./quality";
import { FACTOR_MAX, FACTOR_MIN, MIN_CALIBRATION_DAYS } from "@/lib/domain/calibration";
import {
  HISTORY_DAYS, RECENT_DAYS, centreCells, centreStat, cockpitActions, combinedStat, dailyOutput, earnedOfRecord, inMonthPlan, isFloorAction, lateLines, loadAhead, manpowerPlan, monthCalendar, parseKpiSnapshot, planAdherence, stageDueISO, weldingCoverage, workingDaysFrom, zeroCentres,
  type CentreDay, type CentreHours, type CentreStat, type CockpitAction, type Coverage, type CoverageInput, type KpiSnapshotData, type KpiSnapshotPoint,
  type LateLine, type LoadAhead, type ManpowerRow, type OutputDay, type OutputGroup, type PlanCell, type Stage, type StageAdherence, OUTPUT_GROUP_LABEL,
} from "@/lib/domain/kpis";
import {
  FLOOR_TREND_WINDOW, centresOf, efficiencyGrid, floorDays, floorPieces, floorRange, floorStat, groupProductivity, groupsOf, ledgerGroups, productivityTrend, recordedDates as datesWithHours,
  type FloorAttendance, type FloorDept, type FloorStat, type GroupProductivity, type HeatRow, type LedgerPieces, type ProductivityPoint,
} from "@/lib/domain/floorKpis";
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
    /** Every line behind, oldest first — the page shows the first few and
     *  exports them all. */
    late: (LateLine & { soi: string | null })[];
    /** How many, so a reader of a prefix knows what it is a prefix of. */
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
  /** The work between the stages, netted project by project over the open
   *  orders: cut and not welded (welding's coverage), welded and not finished,
   *  the pieces sent back and not re-delivered, and what the orders on hold
   *  keep out of the queues. */
  wip: {
    cutNotWelded: { item: string; pcs: number }[];
    weldedNotFinished: { item: string; pcs: number }[];
    returnsOpen: { count: number; qty: number };
    held: { orders: number; pieces: number };
  };
  actions: CockpitAction[];
  /** Today's figures as the trend keeps them. */
  snapshot: KpiSnapshotData;
  /** The stored days, today's as it reads now. */
  trend: KpiSnapshotPoint[];
}

const dayStart = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Every centre's recorded days from `fromISO` to `toISO` (today when left
 *  out) — worked man-hours from the shift log, earned standard hours from the
 *  Daily log, machine hours and stops — with what the cockpit's other figures
 *  need from the same reads. Both ends bound the reads, so a past period reads
 *  only its own days. */
async function readCentreDays(fromISO: string, toISO?: string, now = new Date()) {
  const from = dayStart(fromISO);
  const stopNow = now, stopToday = toISO ?? factoryDayISO(stopNow);
  // up to the end of the last day, whatever time a row's date carries
  const until = { gte: from, lt: dayStart(addDaysISO(stopToday, 1)) };
  const [std, hrs, orders, shiftRows, ledger, stops, machines, lvShotBlast] = await Promise.all([
    getStdData(),
    getShiftHours(),
    loadMasterOrdersOf("TR"),
    // the transformers' four departments only: the panels' rows are read by lib/server/lvKpis.ts
    prisma.shiftEntry.findMany({ where: { date: until, dept: { in: [...SHIFT_DEPTS] } }, select: { date: true, dept: true, present: true, shift: true, overtimeH: true, center: true, worker: { select: { depts: true } } } }),
    prisma.handoverEntry.findMany({ where: { date: until, item: { not: LV_ITEM } }, select: { date: true, dept: true, mo: true, bom: true, item: true, qty: true } }),
    prisma.machineDowntime.findMany({ where: downtimeWindowWhere(fromISO, stopToday), select: { date: true, hours: true, startTime: true, endTime: true, endsNextDay: true, isOpen: true, endDate: true, reasonCode: true, reason: true, customName: true, customDept: true, customCentre: true, machine: { select: { code: true, name: true, dept: true, center: true } } } }),
    prisma.machine.findMany({ where: { active: true }, select: { dept: true, center: true, hoursPerDay: true } }),
    // the one shot-blast crew blasts the LV panels as well — its booked hours
    // cover both, so the panels' shot-blast hours count on its side (as the calibration does)
    lvShotBlastSince(fromISO, stopToday),
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
  // the shift log's rows per centre-day — who came and the overtime — for the floor's period figures
  const attendance = new Map<string, FloorAttendance>();
  let absent = 0, rowsRecent = 0, overtimeH = 0;
  // what the loss waterfall needs beside: absence and overtime hours, stops by cause
  const losses = new Map<string, { absentH: number; overtimeH: number; stops: Partial<Record<DowntimeCode, number>> }>();
  const lossCell = (iso: string, c: WorkCentre) => {
    const k = `${iso}|${c}`;
    if (!losses.has(k)) losses.set(k, { absentH: 0, overtimeH: 0, stops: {} });
    return losses.get(k)!;
  };
  const recordedDates = [...new Set(shiftRows.map((r) => toISODate(r.date)))].sort();
  const recentDates = new Set(recordedDates.slice(-RECENT_DAYS));
  for (const r of shiftRows) {
    const iso = toISODate(r.date);
    // the worker's sections in this row's department (legacy codes translated, unknown ones dropped)
    const sections = parseWorkerSections(r.worker.depts).filter((s) => sectionDept(s) === r.dept);
    const c = centreOf(r.dept, sections, r.center) ?? deptCentre(r.dept);
    if (!c) continue; // the LV panels — not the transformers' figures
    const shift = isShiftCode(r.shift) ? r.shift : DEFAULT_SHIFT;
    const a = attendance.get(`${iso}|${c}`) ?? { dateISO: iso, centre: c, rows: 0, absent: 0, overtimeH: 0 };
    a.rows += 1;
    if (!r.present) a.absent += 1;
    else if (r.overtimeH > 0) a.overtimeH += r.overtimeH;
    attendance.set(`${iso}|${c}`, a);
    if (recentDates.has(iso)) {
      rowsRecent += 1;
      if (!r.present) absent += 1;
      // Both day and night overtime contribute to resource effort.
      else if (r.overtimeH > 0) overtimeH += r.overtimeH;
    }
    if (!r.present) {
      // the hours an absent worker's shift would have given (the cockpit's
      // own days stay those with someone present)
      lossCell(iso, c).absentH += lineHours({ present: true, shift, overtimeH: 0 }, hrs);
      continue;
    }
    const d = cell(iso, c);
    d.workedH += lineHours({ present: true, shift, overtimeH: r.overtimeH }, hrs);
    d.people += 1;
    if (r.overtimeH > 0) lossCell(iso, c).overtimeH += r.overtimeH;
  }
  let pricedQty = 0, recentQty = 0;
  // each record's pieces, the departments whose output they are, and whether they carry standard hours
  const pieces: LedgerPieces[] = [];
  for (const e of ledger) {
    const iso = toISODate(e.date);
    const per = perPiece(tierOf(e.mo, e.bom), e.item);
    const got = earnedOfRecord(e.dept, e.qty, per);
    const groups = ledgerGroups(e.dept);
    if (groups.length > 0 && recentDates.has(iso)) {
      recentQty += e.qty;
      if (per) pricedQty += e.qty;
    }
    if (groups.length > 0) pieces.push({ dateISO: iso, groups, pieces: e.qty, priced: !!per });
    for (const c of WORK_CENTRES) if (got[c] !== 0) cell(iso, c).earnedH += got[c];
  }
  for (const [iso, h] of lvShotBlast) cell(iso, "ShotBlast").earnedH += h;
  const machineH = zeroCentres();
  for (const m of machines) {
    const c = machineWorkCentre(m.dept, m.center);
    if (c) machineH[c] += m.hoursPerDay ?? 0;
  }
  for (const s of stops) {
    const c = stopCentre(s);
    if (!c) continue;
    const code: DowntimeCode = s.reasonCode && isDowntimeCode(s.reasonCode) ? s.reasonCode : "OTHER";
    for (const day of splitDowntimeDays(s, fromISO, stopToday, stopNow)) {
      const iso = toISODate(day.date);
      cell(iso, c).downtimeH += day.hours;
      const l = lossCell(iso, c);
      l.stops[code] = (l.stops[code] ?? 0) + day.hours;
    }
  }
  const all: CentreDay[] = [];
  for (const [, m] of days) for (const [, d] of m) {
    if (d.workedH > 0) d.machineH = machineH[d.centre];
    all.push(d);
  }
  return { std, orders, stops, days, all, losses, recordedDates, tierByBom, tierOf, perPiece, absent, rowsRecent, overtimeH, pricedQty, recentQty, lvShotBlast, attendance: [...attendance.values()], pieces };
}

/** Where the hours went, the last `days` days against the `days` before:
 *  one centre's (or the floor's, null) waterfall now and then, and what
 *  moved its efficiency. */
export async function getLossWaterfall(o: { centre: WorkCentre | null; days: number; now?: Date }): Promise<{
  fromISO: string; toISO: string; beforeFromISO: string; now: LossWaterfall; before: LossWaterfall; change: LossChange; biggest: string | null;
}> {
  const at = o.now ?? new Date();
  // whole days only: today is still being logged, and would read as slow
  const toISO = addDaysISO(factoryDayISO(at), -1);
  const fromISO = addDaysISO(toISO, -(o.days - 1));
  const beforeFromISO = addDaysISO(fromISO, -o.days);
  const { all, losses } = await readCentreDays(beforeFromISO, undefined, at);
  const lossDays: LossDay[] = all.map((d) => {
    const l = losses.get(`${d.dateISO}|${d.centre}`);
    return { dateISO: d.dateISO, centre: d.centre, workedH: d.workedH, earnedH: d.earnedH, machineH: d.machineH, absentH: l?.absentH ?? 0, overtimeH: l?.overtimeH ?? 0, stops: l?.stops ?? {} };
  });
  // a day a centre's whole crew was absent has no cell of its own: its absence still counts
  const seen = new Set(all.map((d) => `${d.dateISO}|${d.centre}`));
  for (const [k, l] of losses) {
    if (seen.has(k) || l.absentH <= 0) continue;
    const [dateISO, centre] = k.split("|") as [string, WorkCentre];
    lossDays.push({ dateISO, centre, workedH: 0, earnedH: 0, machineH: 0, absentH: l.absentH, overtimeH: 0, stops: {} });
  }
  const inNow = (d: LossDay) => d.dateISO >= fromISO && d.dateISO <= toISO;
  const now = lossWaterfall(lossDays.filter(inNow), o.centre);
  const before = lossWaterfall(lossDays.filter((d) => d.dateISO < fromISO), o.centre);
  return { fromISO, toISO, beforeFromISO, now, before, change: explainChange(before, now), biggest: biggestLoss(now) };
}

/** The centre a stop belongs to: its machine's, else the one typed on it. */
function stopCentre(s: { machine: { dept: string; center: string } | null; customCentre: string | null }): WorkCentre | null {
  return s.machine ? machineWorkCentre(s.machine.dept, s.machine.center) : s.customCentre && isWorkCentre(s.customCentre) ? s.customCentre : null;
}

/** The LV panels' shot-blast std-hours by day from `fromISO` to `toISO`. */
async function lvShotBlastSince(fromISO: string, toISO: string): Promise<Map<string, number>> {
  // groupBy: Prisma's `distinct` dedupes in memory after reading every row
  const rows = await prisma.handoverEntry.groupBy({ by: ["date"], where: { date: { gte: dayStart(fromISO), lt: dayStart(addDaysISO(toISO, 1)) }, item: LV_ITEM } });
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
  const [read, settings, holidays, plan, returnsOpen] = await Promise.all([
    readCentreDays(fromISO), getSettings(), loadHolidays(),
    // the transformers' plan, whichever line is on screen
    withLine("TR", () => getWeeklyPlanTracker()),
    prisma.returnEntry.aggregate({ where: { status: "open" }, _count: { _all: true }, _sum: { qty: true } }),
  ]);
  const { orders, stops, days, all, recordedDates, tierByBom, tierOf, perPiece, absent, rowsRecent, overtimeH, pricedQty, recentQty, lvShotBlast } = read;
  const holidaySet = new Set(holidays.map((h) => toISODate(h.date)));
  // the month's calendar — one rule with the panels' month (lib/server/lvKpis.ts)
  const { monthLabel, monthStartISO, ...cal } = monthCalendar(todayISO, holidaySet, settings.shiftShortH);

  const workedDates = [...new Set(all.filter((d) => d.workedH > 0).map((d) => d.dateISO))].sort();
  const lastDayISO = workedDates.at(-1) ?? null;
  const recentWorked = new Set(workedDates.slice(-RECENT_DAYS));
  const centres: CentreKpi[] = WORK_CENTRES.map((c) => ({
    centre: c,
    last: centreStat(c, all.filter((d) => d.dateISO === lastDayISO)),
    recent: centreStat(c, all.filter((d) => recentWorked.has(d.dateISO))),
    trend: centreCells(all, c, workedDates),
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
      where: { dept: { in: ["Cut", "Welding", "Painting", "ShotBlast"] }, item: { not: LV_ITEM }, bom: { in: openBoms } },
      _sum: { qty: true },
    })
    : [];
  const byBomItem = new Map<string, { bom: string; item: string; cut: number; weld: number; finish: number }>();
  for (const s of sums) {
    const k = `${s.bom}|${s.item}`;
    const v = byBomItem.get(k) ?? { bom: s.bom, item: s.item, cut: 0, weld: 0, finish: 0 };
    const qty = s._sum.qty ?? 0;
    if (s.dept === "Cut") v.cut += qty;
    else if (s.dept === "Welding") v.weld += qty;
    else if (s.dept === finishDeptOf(s.item)) v.finish += qty;
    byBomItem.set(k, v);
  }
  const wip = new Map<string, CoverageInput>();
  const weldedNotFinished = new Map<string, number>();
  for (const v of byBomItem.values()) {
    const pcs = Math.max(0, v.cut - v.weld);
    const unfinished = Math.max(0, v.weld - v.finish);
    if (unfinished > 0) weldedNotFinished.set(v.item, (weldedNotFinished.get(v.item) ?? 0) + unfinished);
    if (!(pcs > 0)) continue;
    const per = perPiece(tierByBom.get(v.bom) ?? null, v.item);
    const w = wip.get(v.item) ?? { item: v.item, pcs: 0, weldH: 0 };
    w.pcs += pcs;
    w.weldH += pcs * (per?.Welding ?? 0);
    wip.set(v.item, w);
  }
  const heldOrders = orders.filter((o) => o.status === "open" && o.holdAt);
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
      late,
      lateCount: late.length,
    },
    centres,
    fabrication,
    load,
    coverage,
    manpower,
    losses,
    pricedShare: recentQty > 0 ? pricedQty / recentQty : null,
    wip: {
      cutNotWelded: coverage.byItem.map((b) => ({ item: b.item, pcs: b.pcs })),
      weldedNotFinished: [...weldedNotFinished.entries()].map(([item, pcs]) => ({ item, pcs })).sort((a, b) => b.pcs - a.pcs),
      returnsOpen: { count: returnsOpen._count._all, qty: returnsOpen._sum.qty ?? 0 },
      held: { orders: heldOrders.length, pieces: heldOrders.reduce((s, o) => s + o.planQty, 0) },
    },
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

export interface FloorPeriod {
  fromISO: string;
  toISO: string;
  dept: FloorDept;
  /** The period asked for was moved to fit the floor's limits (floorRange). */
  clamped: boolean;
  /** The recorded days of the period (days with booked hours), oldest first. */
  dates: string[];
  grid: HeatRow[];
  summary: FloorStat;
  groups: GroupProductivity[];
  trend: ProductivityPoint[];
  /** Recorded days the trend's rolling line covers. */
  window: number;
  output: OutputDay[];
  losses: { causes: DowntimeCause[]; unplannedH: number; plannedH: number };
  /** The stops still open now, and the machines that stood still the most in the period. */
  stops: { open: OpenStopView[]; byMachine: MachineStopRank[] };
  /** Days whose two records disagree — output with no hours, hours with no output. */
  gapDays: GapDay[];
  /** Share of the period's records that carry standard hours. */
  pricedShare: number | null;
  /** Quality and rework over the period — the transformers' returns and tanks. */
  quality: QualityPeriod;
  /** What needs intervention in production, worst first. */
  actions: CockpitAction[];
}

/** The floor's performance over a period the planner picks, one department or
 *  all — the cockpit's floor section and the assistant's period question
 *  (both resolve the request with floorRequest). Reads only the period's own
 *  days; today's trend point is the cockpit's own (getCockpit). */
export async function getFloorPeriod(q: { fromISO: string; toISO: string; dept: FloorDept; clamped?: boolean }, now = new Date()): Promise<FloorPeriod> {
  const { fromISO, toISO, clamped } = floorRange(q.fromISO, q.toISO, factoryDayISO(now));
  const centres = centresOf(q.dept);
  const keep = new Set<WorkCentre>(centres);
  const [read, quality] = await Promise.all([readCentreDays(fromISO, toISO, now), getQualityPeriod(fromISO, toISO)]);
  const days = floorDays(read.all, read.attendance, centres, fromISO, toISO);
  const groupList = groupsOf(q.dept);
  const { pieces, pricedShare } = floorPieces(read.pieces, groupList, fromISO, toISO);
  // each department's own share of priced pieces, in one pass — a slow reading on unpriced output is not judged
  const pricedByGroup = new Map<OutputGroup, { qty: number; priced: number }>();
  for (const p of pieces) {
    const v = pricedByGroup.get(p.group) ?? { qty: 0, priced: 0 };
    v.qty += p.pieces;
    pricedByGroup.set(p.group, v);
  }
  for (const r of read.pieces) {
    if (r.dateISO < fromISO || r.dateISO > toISO || !r.priced) continue;
    for (const g of r.groups) if (pricedByGroup.has(g)) pricedByGroup.get(g)!.priced += r.pieces;
  }
  const pricedOf = (g: OutputGroup) => { const v = pricedByGroup.get(g); return v && v.qty > 0 ? Math.min(1, v.priced / v.qty) : null; };
  const dates = datesWithHours(days);
  const stops = read.stops.filter((s) => {
    const c = stopCentre(s);
    return c !== null && keep.has(c);
  });
  const machineName = (s: (typeof stops)[number]) => s.machine?.code ?? s.customName ?? "Unlisted equipment";
  const machineDept = (s: (typeof stops)[number]) => s.machine?.dept ?? s.customDept ?? "";
  const open: OpenStopView[] = stops
    .filter((s) => s.isOpen)
    .map((s) => ({ machine: machineName(s), dept: machineDept(s), cause: downtimeLabel(s.reasonCode, s.reason), hours: minuteHours(elapsedStopHours(s, now)), sinceISO: toISODate(s.date) }))
    .sort((a, b) => b.hours - a.hours);
  const byMachine = stopsByMachine(stops.map((s) => ({ machine: machineName(s), dept: machineDept(s), hours: downtimeHoursInRange(s, fromISO, toISO, now), reasonCode: s.reasonCode })));
  // a day whose records disagree: output is what the Daily log recorded (pieces, priced or not), hours what the shift log booked
  const gaps: GapDay[] = gapDays(pieces.map((p) => ({ dateISO: p.dateISO, qty: p.pieces })), days, factoryDayISO(now));
  const groups = groupProductivity(days, pieces, groupList);
  const actions = productionActions({
    openStops: open,
    depts: groups.map((g) => ({ label: OUTPUT_GROUP_LABEL[g.group], days: g.days, efficiency: g.efficiency, pricedShare: pricedOf(g.group) })),
    gapDays: gaps,
    returns: { open: quality.returns.open.count, onUrgent: quality.returns.openOnUrgent },
    tanksInRepair: quality.tanks?.inRepair ?? 0,
    pricedShare,
    hrefs: { stops: "/shifts?view=downtime", shifts: "/shifts", returns: "/worklist/cut", repair: "/worklist/welding", standardTimes: "/admin/standard-times", dailyLog: "/handover" },
  });
  return {
    fromISO,
    toISO,
    dept: q.dept,
    // moved here, or already when the request was read (floorRequest)
    clamped: clamped || !!q.clamped,
    dates,
    grid: efficiencyGrid(days, centres, dates),
    summary: floorStat(days),
    groups,
    trend: productivityTrend(days, FLOOR_TREND_WINDOW),
    window: FLOOR_TREND_WINDOW,
    output: dailyOutput(centres.map((centre) => ({ centre, trend: days.filter((d) => d.centre === centre && d.workedH > 0) }))),
    losses: downtimeByCause(stops.map((s) => ({ ...s, hours: downtimeHoursInRange(s, fromISO, toISO, now) }))),
    stops: { open, byMachine },
    gapDays: gaps,
    pricedShare,
    quality,
    actions,
  };
}
