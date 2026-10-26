import "server-only";
import { prisma } from "@/lib/db";
import { factoryDayISO, toISODate } from "@/lib/domain/dates";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { LV_ITEM, LV_STAGES, type LvStage } from "@/lib/domain/lv";
import type { LvRate } from "@/lib/domain/lvStd";
import { DEFAULT_SHIFT, isShiftCode, lineHours } from "@/lib/domain/shifts";
import { HISTORY_DAYS, RECENT_DAYS, hoursStat, manpowerPlan, monthCalendar, monthOf, type CentreDay, type CockpitAction, type ManpowerRow } from "@/lib/domain/kpis";
import { LV_ITEM_ORDER, lvItemType, lvPlanLine, outputByType, type OutputByTypeData } from "@/lib/domain/outputByType";
import {
  FLOOR_TREND_WINDOW, efficiencyGrid, floorDays, floorRange, floorStat, productivityTrend as trendOf, recordedDates as datesWithHours,
  type FloorAttendance, type FloorStat, type HeatRow, type ProductivityPoint,
} from "@/lib/domain/floorKpis";
import { gapDays, productionActions, type GapDay } from "@/lib/domain/productionActions";
import { emptyShift, type LineFacts, type ShiftPart, type UnitDay, type VolumeRecord } from "@/lib/domain/productionDashboard";
import {
  LV_DEPT_STAGE_OF, LV_FLOOR_DEPTS, LV_FLOOR_DEPT_LABEL, lvDeptOfStage, lvDeptsOf, lvManpowerInputs, lvMonthProgress, lvPlanningActions, lvRateAt, lvWip, zeroLvDepts, zeroLvStages,
  type LvBefore, type LvDeptPace, type LvFloorDept, type LvFloorFilter, type LvManpowerCoverage, type LvMonthProgress, type LvWip,
} from "@/lib/domain/lvKpis";
import { lvBottleneck } from "@/lib/domain/trackerView";
import { getLvOrderRates } from "./lvStd";
import { getLvTracker, type LvTrackerRow } from "./lvTracker";
import { getLvDashboard, type LvDashboardData } from "./lvDashboard";
import { getSettings, getShiftHours } from "./data";
import { loadHolidays } from "./loads";

// The LV panels' dashboards, read from what the floor records: the shift
// log's hours in the panels' four departments, the panels moved per stage on
// the Daily log priced by the timings sheet's LV tab, and the panel orders'
// position on the chain. Every figure comes from the pure functions in
// lib/domain/lvKpis.ts — the pages and the assistant read these loaders, so
// they never disagree. The panels have no machines of their own (the
// punches are the fabrication bay's, recorded by department), so nothing
// here counts a stop.

const dayStart = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

interface LvRead {
  /** Each department's recorded days with the panels' earned hours. */
  all: CentreDay<LvFloorDept>[];
  attendance: FloorAttendance<LvFloorDept>[];
  /** Each department-day's people, hours and overtime by shift, and the shift hours of those absent. */
  split: Map<string, { day: ShiftPart; night: ShiftPart; absentH: number }>;
  /** Panels moved per stage per day, their order, and whether it is priced. */
  moves: { dateISO: string; stage: LvStage; qty: number; priced: boolean; mo: string | null }[];
}

/** The panels' departments day by day from `fromISO` to `toISO`: man-hours
 *  booked (the shift log), std-hours earned (the panels moved × their sheet
 *  row, under the department that moved them) and who came. */
async function readLvDeptDays(fromISO: string, toISO: string): Promise<LvRead> {
  const until = { gte: dayStart(fromISO), lt: dayStart(addDaysISO(toISO, 1)) };
  const [hrs, shiftRows, ledger, orders] = await Promise.all([
    getShiftHours(),
    prisma.shiftEntry.findMany({ where: { date: until, dept: { in: [...LV_FLOOR_DEPTS] } }, select: { date: true, dept: true, present: true, shift: true, overtimeH: true } }),
    prisma.handoverEntry.findMany({ where: { date: until, item: LV_ITEM }, select: { date: true, dept: true, mo: true, qty: true } }),
    // each panel order with its sheet row — the one resolution every panels' loader uses
    getLvOrderRates(),
  ]);
  const rateOf = new Map<string, LvRate | null>(orders.map((o) => [o.mo, o.rate]));

  const days = new Map<string, CentreDay<LvFloorDept>>();
  const cell = (iso: string, d: LvFloorDept) => {
    const k = `${iso}|${d}`;
    if (!days.has(k)) days.set(k, { dateISO: iso, centre: d, workedH: 0, people: 0, earnedH: 0, machineH: 0, downtimeH: 0 });
    return days.get(k)!;
  };
  const attendance = new Map<string, FloorAttendance<LvFloorDept>>();
  const split: LvRead["split"] = new Map();
  for (const r of shiftRows) {
    const d = r.dept as LvFloorDept;
    const iso = toISODate(r.date);
    const a = attendance.get(`${iso}|${d}`) ?? { dateISO: iso, centre: d, rows: 0, absent: 0, overtimeH: 0 };
    a.rows += 1;
    if (!r.present) a.absent += 1;
    else if (r.overtimeH > 0) a.overtimeH += r.overtimeH;
    attendance.set(`${iso}|${d}`, a);
    const shift = isShiftCode(r.shift) ? r.shift : DEFAULT_SHIFT;
    const sp = split.get(`${iso}|${d}`) ?? { day: emptyShift(), night: emptyShift(), absentH: 0 };
    split.set(`${iso}|${d}`, sp);
    if (!r.present) {
      // the hours an absent worker's shift would have given
      sp.absentH += lineHours({ present: true, shift, overtimeH: 0 }, hrs);
      continue;
    }
    const h = lineHours({ present: true, shift, overtimeH: r.overtimeH }, hrs);
    const c = cell(iso, d);
    c.workedH += h;
    c.people += 1;
    const part = shift === "S11" ? sp.night : sp.day;
    part.people += 1;
    part.hours += h;
    if (r.overtimeH > 0) part.overtimeH += r.overtimeH;
  }
  const moves: LvRead["moves"] = [];
  for (const e of ledger) {
    if (!(LV_STAGES as readonly string[]).includes(e.dept)) continue;
    const stage = e.dept as LvStage;
    const iso = toISODate(e.date);
    const rate = e.mo ? rateOf.get(e.mo) ?? null : null;
    moves.push({ dateISO: iso, stage, qty: e.qty, priced: !!rate, mo: e.mo });
    if (!rate) continue;
    const dept = lvDeptOfStage(stage);
    if (dept) cell(iso, dept).earnedH += lvRateAt(rate, dept) * e.qty;
  }
  return { all: [...days.values()], attendance: [...attendance.values()], moves, split };
}

/** The panels' unit-days of a read (a department is its own unit), and the
 *  panels moved per stage — `componentOf` names a move's plan. The panels
 *  have no machines of their own: no machine hours and no stops here. */
function lvFactsOf(read: LvRead, fromISO: string, toISO: string, componentOf: (mo: string | null) => string): Pick<LineFacts, "days" | "volume"> {
  const inRange = (iso: string) => iso >= fromISO && iso <= toISO;
  const att = new Map(read.attendance.map((a) => [`${a.dateISO}|${a.centre}`, a]));
  const at = new Map(read.all.map((d) => [`${d.dateISO}|${d.centre}`, d]));
  const keys = new Set([...at.keys(), ...att.keys()].filter((k) => inRange(k.slice(0, 10))));
  const days: UnitDay[] = [...keys].map((k) => {
    const [dateISO, dept] = k.split("|") as [string, LvFloorDept];
    const d = at.get(k), a = att.get(k), sp = read.split.get(k);
    return {
      line: "LV", dept, unit: dept, dateISO,
      workedH: d?.workedH ?? 0, earnedH: d?.earnedH ?? 0, people: d?.people ?? 0,
      overtimeH: a?.overtimeH ?? 0, rows: a?.rows ?? 0, absent: a?.absent ?? 0, absentH: sp?.absentH ?? 0,
      day: sp?.day ?? emptyShift(), night: sp?.night ?? emptyShift(),
      machineH: 0, downtimeH: 0, stops: {}, notSet: null,
    };
  });
  const volume: VolumeRecord[] = read.moves.filter((m) => inRange(m.dateISO)).map((m) => {
    const dept = lvDeptOfStage(m.stage);
    return { line: "LV", dateISO: m.dateISO, stage: m.stage, depts: dept ? [dept] : [], component: componentOf(m.mo), qty: m.qty, priced: m.priced };
  });
  return { days, volume };
}

/** The panels' unit-days and moves over a stretch, alone — the Production
 *  dashboard's stretch before, and its figures without the cards around them
 *  (the moves unnamed by plan: only whether they are priced counts there). */
export async function getLvFloorFacts(fromISO: string, toISO: string): Promise<Pick<LineFacts, "days" | "volume">> {
  return lvFactsOf(await readLvDeptDays(fromISO, toISO), fromISO, toISO, () => "LV panels");
}

// ------------------------------------------------------------- production

export interface LvDeptProductivity extends FloorStat {
  dept: LvFloorDept;
  /** Panels the department moved on its recorded days. */
  panels: number;
  panelsPerPersonDay: number | null;
}

export interface LvOutputDay {
  dateISO: string;
  byDept: Record<LvFloorDept, number>;
  earnedH: number;
  workedH: number;
  efficiency: number | null;
}

export interface LvFloorPeriod {
  fromISO: string;
  toISO: string;
  dept: LvFloorFilter;
  clamped: boolean;
  dates: string[];
  grid: HeatRow<LvFloorDept>[];
  summary: FloorStat;
  groups: LvDeptProductivity[];
  trend: ProductivityPoint[];
  window: number;
  output: LvOutputDay[];
  /** Panels moved per stage in the period, priced or not. */
  moved: Record<LvStage, number>;
  /** Share of the period's panels whose order the timings sheet prices. */
  pricedShare: number | null;
  /** Days whose two records disagree — panels moved with no hours, hours with no panels. */
  gapDays: GapDay[];
  /** What needs intervention on the panels' side, worst first. No stop is
   *  ever here: the machines are recorded by department, the punches shared. */
  actions: CockpitAction[];
  /** What the period moved, plan by plan and panel type by type, against the
   *  plan of the month the period ends in — every stage, whatever the
   *  department picked. */
  byType: OutputByTypeData<LvStage>;
}

/** The panels' floor over a period and a department — the Production
 *  dashboard's LV side and the assistant's period question, from one read. */
export async function getLvFloorPeriod(q: { fromISO: string; toISO: string; dept: LvFloorFilter; clamped?: boolean }, now = new Date()): Promise<LvFloorPeriod> {
  return (await getLvFloorPeriodWithFacts(q, now)).period;
}

/** getLvFloorPeriod with the period's unit-days and panels moved from the
 *  same read — the Production dashboard's figures (every department). */
export async function getLvFloorPeriodWithFacts(q: { fromISO: string; toISO: string; dept: LvFloorFilter; clamped?: boolean }, now = new Date()): Promise<{ period: LvFloorPeriod; facts: Pick<LineFacts, "days" | "volume"> }> {
  const { fromISO, toISO, clamped } = floorRange(q.fromISO, q.toISO, factoryDayISO(now));
  const depts = lvDeptsOf(q.dept);
  const [read, tracker] = await Promise.all([readLvDeptDays(fromISO, toISO), getLvTracker()]);
  const days = floorDays(read.all, read.attendance, depts, fromISO, toISO);
  // the item card: each panel moved under its order's plan and type, against the month the period ends in
  const orderOf = new Map(tracker.map((r) => [r.mo, r]));
  const month = monthOf(toISO);
  const byType = {
    monthLabel: month.monthLabel,
    groups: outputByType(
      LV_STAGES,
      read.moves.filter((m) => m.dateISO >= fromISO && m.dateISO <= toISO).map((m) => ({ ...lvItemType(m.mo ? orderOf.get(m.mo) : undefined), stage: m.stage, qty: m.qty })),
      tracker.filter((r) => r.months.includes(month.monthLabel)).map(lvPlanLine),
      LV_ITEM_ORDER,
    ),
  };
  const dates = datesWithHours(days);
  // the period's moves bucketed once by stage — what the departments, the totals, the gaps and the coverage all read
  const stages = new Set(depts.map((d) => LV_DEPT_STAGE_OF[d]));
  const inPeriod = read.moves.filter((m) => stages.has(m.stage) && m.dateISO >= fromISO && m.dateISO <= toISO);
  const byStage = new Map<LvStage, { qty: number; priced: number; days: { dateISO: string; qty: number }[] }>();
  const movedTotals = zeroLvStages();
  let qty = 0, priced = 0;
  for (const m of inPeriod) {
    const v = byStage.get(m.stage) ?? { qty: 0, priced: 0, days: [] };
    v.qty += m.qty;
    if (m.priced) v.priced += m.qty;
    v.days.push({ dateISO: m.dateISO, qty: m.qty });
    byStage.set(m.stage, v);
    movedTotals[m.stage] += m.qty;
    qty += m.qty;
    if (m.priced) priced += m.qty;
  }
  const groups: LvDeptProductivity[] = depts
    .map((dept) => {
      const mine = days.filter((d) => d.centre === dept);
      const s = floorStat(mine);
      const booked = new Set(datesWithHours(mine));
      const panels = Math.max(0, (byStage.get(LV_DEPT_STAGE_OF[dept])?.days ?? []).filter((m) => booked.has(m.dateISO)).reduce((t, m) => t + m.qty, 0));
      return { ...s, dept, panels, panelsPerPersonDay: s.personDays > 0 ? panels / s.personDays : null };
    })
    .filter((g) => g.days > 0);
  const byDay = new Map<string, LvOutputDay>();
  for (const d of days) {
    if (!(d.workedH > 0)) continue;
    const o = byDay.get(d.dateISO) ?? { dateISO: d.dateISO, byDept: zeroLvDepts(), earnedH: 0, workedH: 0, efficiency: null };
    o.byDept[d.centre] += d.earnedH;
    o.earnedH += d.earnedH;
    o.workedH += d.workedH;
    byDay.set(d.dateISO, o);
  }
  const output = [...byDay.values()].sort((a, b) => a.dateISO.localeCompare(b.dateISO)).map((o) => ({ ...o, efficiency: o.workedH > 0 ? o.earnedH / o.workedH : null }));
  // a day whose records disagree: panels moved (priced or not) against the hours booked — one rule with the transformers'
  const gaps: GapDay[] = gapDays(inPeriod, days, factoryDayISO(now));
  const pricedShare = qty > 0 ? priced / qty : null;
  // each department's own share of priced panels — a slow reading on unpriced panels is not judged
  const pricedOf = (dept: LvFloorDept) => { const v = byStage.get(LV_DEPT_STAGE_OF[dept]); return v && v.qty > 0 ? v.priced / v.qty : null; };
  const actions = productionActions({
    openStops: [],
    depts: groups.map((g) => ({ label: LV_FLOOR_DEPT_LABEL[g.dept], days: g.days, efficiency: g.efficiency, pricedShare: pricedOf(g.dept) })),
    gapDays: gaps,
    pricedShare,
    hrefs: { stops: "/shifts", shifts: "/shifts", standardTimes: "/admin/standard-times", dailyLog: "/handover" },
  });
  const period: LvFloorPeriod = {
    fromISO, toISO, dept: q.dept, clamped: clamped || !!q.clamped, dates,
    grid: efficiencyGrid(days, depts, dates),
    summary: floorStat(days),
    groups,
    trend: trendOf(days, FLOOR_TREND_WINDOW),
    window: FLOOR_TREND_WINDOW,
    output,
    moved: movedTotals,
    pricedShare,
    gapDays: gaps,
    actions,
    byType,
  };
  // each panel moved under its order's plan — the plan the output card names it by
  return { period, facts: lvFactsOf(read, fromISO, toISO, (mo) => lvItemType(mo ? orderOf.get(mo) : undefined).item) };
}

// --------------------------------------------------------------- planning

export interface LvPlanningData {
  todayISO: string;
  lastDayISO: string | null;
  month: LvMonthProgress & { monthWd: number; leftWd: number };
  open: { orders: number; panels: number; urgent: number; onHold: number };
  wip: LvWip;
  /** The urgent open orders still short, the most short first. */
  urgentStuck: { mo: string; bom: string; product: string | null; remaining: number; stage: LvStage | null }[];
  manpower: { hoursPerPersonDay: number; rows: ManpowerRow<LvFloorDept>[]; coverage: LvManpowerCoverage };
  /** Each department over its last recorded days — the shift log's side. */
  depts: (LvDeptPace & { workedH: number; earnedH: number; people: number })[];
  actions: CockpitAction[];
  /** The panels moved per stage over the last two weeks (or the period asked for). */
  days: LvDashboardData;
}

const urgentOrder = (a: { remaining: number; mo: string }, b: typeof a) => b.remaining - a.remaining || a.mo.localeCompare(b.mo);

/** The panels' Planning dashboard: the month's plan against its pace, the
 *  work between the stages, the people the month needs, and what needs a
 *  decision — the panels' answer to "will we make the plan?". */
export async function getLvPlanning(o: { from?: Date | null; to?: Date | null } = {}, now = new Date()): Promise<LvPlanningData> {
  const todayISO = factoryDayISO(now);
  const [tracker, rated, settings, holidays, read, days] = await Promise.all([
    getLvTracker(), getLvOrderRates(), getSettings(), loadHolidays(), readLvDeptDays(addDaysISO(todayISO, -HISTORY_DAYS), todayISO), getLvDashboard(o, now),
  ]);
  const rates = new Map(rated.map((o) => [o.mo, o.rate]));
  const rateOf = (r: LvTrackerRow) => rates.get(r.mo) ?? null;

  // the month's calendar — one rule with the transformers' month (lib/server/kpis.ts)
  const { monthLabel, monthStartISO, ...cal } = monthCalendar(todayISO, new Set(holidays.map((h) => toISODate(h.date))), settings.shiftShortH);

  const open = tracker.filter((r) => r.status === "open");
  // the month's orders: those the month's plan brought or carried (a closed
  // one was this month's work too — an order never joins a later plan)
  const monthRows = tracker.filter((r) => r.months.includes(monthLabel));
  // what the chain had done on them before the month began — a carried-over
  // order's earlier work starts the month's pace there (monthPace's rule)
  const beforeRows = monthRows.length
    ? await prisma.handoverEntry.groupBy({ by: ["mo", "dept"], where: { item: LV_ITEM, mo: { in: monthRows.map((r) => r.mo) }, date: { lt: dayStart(monthStartISO) } }, _sum: { qty: true } })
    : [];
  const before = new Map<string, LvBefore>();
  for (const b of beforeRows) {
    if (!b.mo || !(LV_STAGES as readonly string[]).includes(b.dept)) continue;
    const cur = before.get(b.mo) ?? {};
    cur[b.dept as LvStage] = (cur[b.dept as LvStage] ?? 0) + (b._sum.qty ?? 0);
    before.set(b.mo, cur);
  }
  const monthInputs = monthRows.map((r) => ({ state: r.state, rate: rateOf(r), before: before.get(r.mo) }));
  const month = lvMonthProgress(monthInputs, monthLabel, cal);

  // who comes lately, department by department
  const workedDates = datesWithHours(read.all);
  const recent = new Set(workedDates.slice(-RECENT_DAYS));
  const depts = LV_FLOOR_DEPTS.map((dept) => {
    const s = hoursStat(read.all.filter((d) => d.centre === dept && recent.has(d.dateISO)));
    return { dept, days: s.days, efficiency: s.efficiency, workedH: s.workedH, earnedH: s.earnedH, people: s.people };
  });
  const present = Object.fromEntries(depts.map((d) => [d.dept, d.days > 0 ? d.people : null])) as Partial<Record<LvFloorDept, number | null>>;
  const { inputs, coverage } = lvManpowerInputs(monthInputs, present);
  const manpowerRows = manpowerPlan(inputs, cal);

  const wip = lvWip(open.map((r) => ({ state: r.state, onHold: r.hold.onHold })));
  const urgentStuck = open
    .filter((r) => r.urgent && !r.hold.onHold && r.remaining > 0)
    .map((r) => ({ mo: r.mo, bom: r.bom, product: r.product, remaining: r.remaining, stage: lvBottleneck(r.state) }))
    .sort(urgentOrder);

  const actions = lvPlanningActions({
    month, wip, urgentStuck, manpower: manpowerRows, depts, coverage,
    todayRecorded: read.attendance.some((a) => a.dateISO === todayISO),
  });

  return {
    todayISO,
    lastDayISO: workedDates.at(-1) ?? null,
    month: { ...month, monthWd: cal.monthWd, leftWd: cal.leftWd },
    open: { orders: open.length, panels: open.reduce((s, r) => s + r.state.required, 0), urgent: open.filter((r) => r.urgent).length, onHold: wip.heldOrders },
    wip,
    urgentStuck,
    manpower: { hoursPerPersonDay: cal.hoursPerPersonDay, rows: manpowerRows, coverage },
    depts,
    actions,
    days,
  };
}

/** The panels' planning without the shift log's figures — for an account the
 *  Shifts screen is closed to. Taken out on the server. */
export function lvWithoutFloor(d: LvPlanningData): LvPlanningData {
  return {
    ...d,
    depts: [],
    manpower: { ...d.manpower, rows: d.manpower.rows.map((r) => ({ ...r, present: null, gap: null, tone: null })) },
    actions: d.actions.filter((a) => !a.floor),
  };
}
