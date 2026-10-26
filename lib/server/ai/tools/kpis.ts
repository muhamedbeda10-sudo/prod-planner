import "server-only";
import { getCockpit, getFloorPeriod, getLossWaterfall, withoutFloor, type CockpitData, type FloorPeriod } from "@/lib/server/kpis";
import { getLvFloorPeriod, getLvPlanning, lvWithoutFloor, type LvFloorPeriod, type LvPlanningData } from "@/lib/server/lvKpis";
import { loadPlanningAll, loadProductionAll } from "@/lib/server/dashboards";
import { WORK_CENTRES, WORK_CENTRE_LABEL, type WorkCentre } from "@/lib/domain/shifts";
import { LOSS_DAYS } from "@/lib/domain/losses";
import { OUTPUT_GROUPS, dailyOutput, isFloorAction, monthPace, weekChange, type KpiSnapshotData, type OutputDay } from "@/lib/domain/kpis";
import { FLOOR_DEFAULT_DAYS, FLOOR_HISTORY_DAYS, FLOOR_MAX_DAYS, FLOOR_TREND_WINDOW, floorRequest } from "@/lib/domain/floorKpis";
import { LV_FLOOR_DEPTS, lvFloorDeptOf } from "@/lib/domain/lvKpis";
import { DASH_SCOPES, DASH_SCOPE_NAME, dashHref, resolveDashScope, type DashScope } from "@/lib/domain/dashboardScope";
import { DEFAULT_LINE } from "@/lib/domain/lines";
import { linePart, plantEfficiency } from "@/lib/domain/plantKpis";
import { factoryDayISO } from "@/lib/domain/dates";
import type { DowntimeCause } from "@/lib/domain/downtime";
import type { ReadTool, ToolCtx } from "./types";

// The planner's KPIs for the assistant, from the loaders the dashboards read,
// so an answer never disagrees with the page: get_kpis is the Planning
// dashboard as it stands today, get_floor_performance the Production
// dashboard for a period and a department — each for the transformers, the
// LV panels, or the whole plant (the dashboards' own All | TR | LV), with
// the same rules of combination (lib/domain/plantKpis.ts): efficiency from
// the sums, standard hours added, pieces never, nothing split between the
// lines without a record that says so.

const r2 = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);
const r1 = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

/** The scope a call asks for: its own `line`, else the line the app is on. */
const scopeOf = (line: unknown, ctx: ToolCtx): DashScope => resolveDashScope(line, ctx.line ?? DEFAULT_LINE);
const lineParam = { type: "string" as const, enum: [...DASH_SCOPES], description: "TR (the transformers), LV (the panels) or all (the whole plant — each line in its own terms, the plant's figures only where they add). Left out: the line the app is showing." };
const scopeWord = (s: DashScope) => (s === "all" ? DASH_SCOPE_NAME.all.toLowerCase() : s);

/** The plant's rules, said once in every combined answer. */
const PLANT_NOTES = [
  "Each line is judged in its own terms: the transformers on dated weekly promises (oven dates less lead days), the panels on the month's plan against an even pace through its working days — the panels' plan carries no delivery date, so nothing on LV is 'late' or 'behind its stage date'.",
  "Pieces are never added across the lines (a panel is not a tank; a component is not a transformer). Standard hours and people add, each line priced by its own sheet; the plant's efficiency is Σ earned ÷ Σ worked, never the mean of the two rates.",
  "The one shot-blast crew is booked on the transformers' side and earns the panels' blasting there. Machines and their stops are recorded by department on shared machines (the punches carry panels too), so stops are the plant's, counted once, never one line's.",
];

type Picker = (p: KpiSnapshotData) => number | null | undefined;
/** The headline figures read against a week ago — the shift log's two only for the people who see Shifts. */
const WEEK_FIGURES: [string, Picker][] = [["planDeliveredOnItsDay", (p) => p.adherence.finish], ["linesBehind", (p) => p.late], ["weldingCoverageDays", (p) => p.coverageDays]];
const FLOOR_WEEK_FIGURES: [string, Picker][] = [["fabricationEfficiency", (p) => p.fabEfficiency], ["machineHoursLost", (p) => p.unplannedH]];

/** The transformers' Planning dashboard as the model reads it. */
function trPlanningView(c: CockpitData, floor: boolean) {
  const pt = (t: CockpitData["trend"][number]) => ({
    day: t.dateISO, behind: t.late, coverageDays: t.coverageDays,
    adherence: Object.fromEntries(Object.entries(t.adherence).map(([k, v]) => [k, r2(v)])),
    ...(floor ? { unplannedH: t.unplannedH, efficiency: Object.fromEntries(Object.entries(t.efficiency).map(([k, v]) => [k, r2(v)])) } : {}),
  });
  return {
    line: "TR",
    today: c.todayISO,
    lastRecordedDay: c.lastDayISO,
    decisions: c.actions.filter((a) => floor || !isFloorAction(a)).map((a) => `${a.tone}: ${a.text}`),
    weeklyPlan: {
      planNo: c.week.planNo, piecesRequired: c.week.req, piecesFinished: c.week.covered,
      adherence: c.week.adherence.map((a) => ({ stage: a.stage, dueByToday: a.due, done: a.done, rate: r2(a.rate) })),
      behindCount: c.week.lateCount,
      // the oldest 20 keep the answer readable; behindCount says how many there are
      behind: c.week.late.slice(0, 20).map((l) => ({ day: l.dayISO, bom: l.bom, soi: l.soi, item: l.item, stuckAt: l.stage, short: l.short, owed: l.owed })),
      days: c.week.days.map((d) => ({ day: d.iso, required: d.req, finished: d.covered })),
    },
    ...(floor ? {
      centres: c.centres.map((k) => ({
        centre: k.centre,
        lastDay: { earnedH: k.last.earnedH, workedH: k.last.workedH, efficiency: r2(k.last.efficiency) },
        recent: { days: k.recent.days, earnedH: k.recent.earnedH, workedH: k.recent.workedH, efficiency: r2(k.recent.efficiency), peopleADay: k.recent.people, stoppedH: k.recent.downtimeH, availability: r2(k.recent.availability) },
        trend: k.trend.map((t) => ({ day: t.dateISO, efficiency: r2(t.efficiency) })),
      })),
      fabrication: { earnedH: c.fabrication.earnedH, workedH: c.fabrication.workedH, efficiency: r2(c.fabrication.efficiency) },
      losses: {
        unplannedH: c.losses.unplannedH, plannedMaintenanceH: c.losses.plannedH, since: c.losses.fromISO,
        byCause: c.losses.causes.map(lossRow),
        absentRate: r2(c.losses.absentRate), overtimeH: c.losses.overtimeH,
      },
      shareOfRecentOutputPriced: r2(c.pricedShare),
      // each recorded day's output in standard hours by department, against the man-hours booked
      dailyOutput: dailyOutput(c.centres).map(outputRow),
    } : {}),
    loadAhead: c.load.map((l) => ({
      centre: l.centre, measured: l.measured, loadRate: r2(l.loadRate), behindH: l.behindH, shortFrom: l.shortFromISO, clears: l.clearsISO, shortAtEndH: l.shortH,
      days: l.days.map((d) => ({ day: d.dayISO, dueH: d.dueH, capacityH: l.measured ? d.capacityH : null })),
    })),
    manpower: {
      month: c.manpower.monthLabel, workingDays: c.manpower.monthWd, workingDaysLeft: c.manpower.leftWd, hoursPerPersonDay: c.manpower.hoursPerPersonDay, transformersPlanned: c.manpower.pieces,
      centres: c.manpower.rows.map((m) => ({
        centre: m.centre, requiredH: m.requiredH, doneH: m.doneH, leftH: m.leftH, peopleNeeded: m.needed, peopleNeededFromToday: m.neededNow,
        ...(floor ? { peoplePresent: m.present, gap: m.gap } : {}),
      })),
    },
    monthPace: monthPace(c.manpower.rows, c.manpower).map((p) => ({ centre: p.centre, planH: p.requiredH, doneH: p.doneH, doneShare: r2(p.doneShare), evenPaceShare: r2(p.expectedShare), aheadH: p.aheadH })),
    weekChange: Object.fromEntries([...WEEK_FIGURES, ...(floor ? FLOOR_WEEK_FIGURES : [])].map(([k, pick]) => {
      const w = weekChange(c.trend, c.todayISO, pick);
      return [k, w ? { now: r2(w.now), weekAgo: r2(w.before), weekAgoDay: w.beforeISO } : null];
    })),
    weldingCoverage: {
      days: c.coverage.days, band: c.coverage.band, waitingWeldH: c.coverage.wipH, weldEarnedADay: c.coverage.ratePerDay,
      byItem: c.coverage.byItem.map((b) => ({ item: b.item, pcs: b.pcs, weldH: b.weldH })),
    },
    // the work between the stages, netted project by project — pieces, where they stand (not since when)
    workBetweenStages: {
      cutNotWelded: c.wip.cutNotWelded, weldedNotFinished: c.wip.weldedNotFinished, returnsOpen: c.wip.returnsOpen, onHold: c.wip.held,
    },
    trend: c.trend.map(pt),
  };
}

/** The panels' Planning dashboard as the model reads it. */
function lvPlanningView(d: LvPlanningData, floor: boolean) {
  const m = d.month;
  return {
    line: "LV",
    today: d.todayISO,
    lastRecordedDay: d.lastDayISO,
    decisions: d.actions.map((a) => `${a.tone}: ${a.text}`),
    month: {
      month: m.monthLabel, workingDays: m.monthWd, workingDaysLeft: m.leftWd, orders: m.orders, panelsPlanned: m.panels, painted: m.complete, remaining: m.remaining,
      doneShare: r2(m.pace.doneShare), evenPaceShare: r2(m.pace.expectedShare), panelsAheadOfPace: m.pace.aheadH, tone: m.pace.tone,
      byStage: m.byStage.map((b) => ({ stage: b.stage, planned: b.required, done: b.done })),
    },
    open: d.open,
    // netted order by order along the chain — panels, where they stand (not since when)
    workBetweenStages: { notStarted: d.wip.notStarted, waitingBend: d.wip.waitingBend, waitingWeld: d.wip.waitingWeld, waitingPaint: d.wip.waitingPaint, waitingDelivery: d.wip.waitingDelivery, onHoldPanels: d.wip.onHold, ordersOnHold: d.wip.heldOrders },
    urgentOrdersShort: d.urgentStuck.slice(0, 20),
    manpower: {
      hoursPerPersonDay: d.manpower.hoursPerPersonDay,
      coverage: d.manpower.coverage,
      departments: d.manpower.rows.map((r) => ({ dept: r.centre, requiredH: r.requiredH, doneH: r.doneH, leftH: r.leftH, peopleNeeded: r.needed, peopleNeededFromToday: r.neededNow, ...(floor ? { peoplePresent: r.present, gap: r.gap } : {}) })),
    },
    ...(floor ? { departmentsRecent: d.depts.map((x) => ({ dept: x.dept, days: x.days, earnedH: r1(x.earnedH), workedH: r1(x.workedH), efficiency: r2(x.efficiency), peopleADay: x.people })) } : {}),
    panelsMovedPerDay: d.days.days.map((x) => ({ day: x.dateISO, ...x.byStage })),
    notAvailable: [
      "Load ahead over the next working days, lines behind their stage date and welding's coverage in days: the panels' plan carries no delivery dates, and the chain has no lead days — the month's pace is the panels' yardstick.",
      "Machine stops: recorded by department on shared machines, so none is the panels' alone (see the transformers' side or the plant).",
      "Panels whose order has no row on the timings sheet earn no hours: see manpower.coverage before reading the people needed as complete.",
    ],
  };
}

export const getKpisTool: ReadTool<{ line?: DashScope }> = {
  kind: "read",
  name: "get_kpis",
  title: "Reading the Planning dashboard",
  description:
    "The planner's KPIs as the Planning dashboard (the home page, /, the first place of the Dashboards tab) shows them, for one line or the whole plant (line: TR, LV or all — the page's own All | TR | LV; left out, the line the app is on). " +
    "TR (the transformers), all in STANDARD HOURS (what the work is worth, never pieces): the decisions it flags today; the newest weekly plan — each stage's pieces due by today against done (adherence), and the lines behind with the stage they are stuck at (the oldest 20; behindCount counts them all); " +
    "each work centre (laser / punch, bending, fin folding, welding, shot blast, painting) — earned std-hours against the man-hours the shift log booked there (efficiency, 100% = the standard pace) on the last recorded day and over the recent recorded days, people a day, machine availability, the daily trend, and Fabrication's three centres together; " +
    "the load ahead — each centre's remaining plan hours over the next 10 working days against what it can work (falling behind and when it catches up, or short at the end; not measured without booked hours); " +
    "welding coverage — days of cut parts waiting in front of the welders; the work between the stages (cut not welded, welded not finished, returns open, orders on hold — pieces netted project by project); the month's pace; each recorded day's output by department against the man-hours booked; each headline figure against a week ago; the month's manpower — the people each centre needs for the month's plan and from today for what is left, against the people who come; the losses — machine stops by cause, absence and overtime; and the daily trend. " +
    "LV (the panels): the month's plan through the four stages (punched, bent, welded, painted; the panel is finished when painted) against an even pace through the month's working days, the panels waiting between the stages (netted order by order), the urgent orders still short with the stage they are stuck at, the people each of the panels' four departments needs for the month (priced by the timings sheet's LV tab; coverage says how many orders it prices) against who comes, each department's recent efficiency, and the panels moved per stage per day. The panels have no delivery dates, so no load ahead and nothing 'late'. " +
    "all (the whole plant): both views, the plant's people short and recent efficiency from the sums, both lines' decisions tagged by line, and the rules of combination (pieces never added across lines; stops the plant's, counted once; one shot-blast crew on the transformers' side). " +
    "Read it first for any question about how the plant is doing, its KPIs, efficiency, capacity or the morning's priorities. " +
    "The floor's figures here are over its last 7 recorded days, as the Planning dashboard's tiles read them; for another period or one department (the Production dashboard) use get_floor_performance. " +
    "For a person the Shifts screen is closed to, the shift log's figures (the centres, the losses, who is present) are left out.",
  schema: { type: "object", properties: { line: lineParam }, additionalProperties: false },
  tabs: ["dashboard"],
  status: (i) => `Reading the Planning dashboard${i?.line ? ` (${i.line})` : ""}`,
  async run(input, ctx) {
    const scope = scopeOf(input.line, ctx);
    // the shift log's figures stay with the people who see Shifts, as on the page
    const floor = !ctx.hidden.has("shifts");
    const link = (s: DashScope) => ({ label: `Planning dashboard (${scopeWord(s)})`, href: dashHref("/", s) });
    if (scope === "LV") {
      const d = await getLvPlanning({}, ctx.now);
      return { ok: true, text: JSON.stringify(lvPlanningView(floor ? d : lvWithoutFloor(d), floor)), links: [link("LV")] };
    }
    if (scope === "TR") {
      const c = await getCockpit(ctx.now);
      return { ok: true, text: JSON.stringify(trPlanningView(floor ? c : withoutFloor(c), floor)), links: [link("TR")] };
    }
    // the plant as the page assembles it (lib/server/dashboards.ts): stripped, merged, summed by the same rules
    const { tr, lv, actions, summary } = await loadPlanningAll(floor, {}, ctx.now);
    return {
      ok: true,
      text: JSON.stringify({
        line: "all",
        today: tr.todayISO,
        decisions: actions.map((a) => `${a.line} ${a.tone}: ${a.text}`),
        plant: {
          ...(floor ? {
            peopleShortFromToday: { ...summary.peopleShort, note: "Each line's own departments, so they add." },
            efficiencyRecentDays: { TR: r2(summary.recentEfficiency.TR), LV: r2(summary.recentEfficiency.LV), plant: r2(summary.recentEfficiency.plant), note: "Each over its last recorded days; the plant's is Σ earned ÷ Σ worked." },
          } : {}),
          planProgress: { TR: tr.week.adherence.find((a) => a.stage === "finish") ?? null, LV: { month: lv.month.monthLabel, painted: lv.month.complete, planned: lv.month.panels, doneShare: r2(lv.month.pace.doneShare), evenPaceShare: r2(lv.month.pace.expectedShare) }, note: "Judged per line — no single percentage." },
          notes: PLANT_NOTES,
        },
        transformers: trPlanningView(tr, floor),
        lvPanels: lvPlanningView(lv, floor),
      }),
      links: [link("all"), link("TR"), link("LV")],
    };
  },
};

/** A day's output, as both tools give it. */
const outputRow = (d: OutputDay) => ({ day: d.dateISO, fabricationH: d.Fabrication, weldingH: d.Welding, shotBlastH: d.ShotBlast, paintingH: d.Painting, earnedH: d.earnedH, bookedH: d.workedH, efficiency: r2(d.efficiency) });
/** The stops by cause, as both tools give them. */
const lossRow = (x: DowntimeCause) => ({ cause: x.label, planned: x.planned, hours: x.hours, stops: x.stops, share: r2(x.share) });

/** The transformers' floor over a period as the model reads it. */
function trFloorView(f: FloorPeriod) {
  const s = f.summary;
  const q = f.quality;
  return {
    line: "TR",
    from: f.fromISO, to: f.toISO, dept: f.dept, periodAdjusted: f.clamped, recordedDays: f.dates.length,
    interventions: f.actions.map((a) => `${a.tone}: ${a.text}`),
    summary: {
      efficiency: r2(s.efficiency), earnedH: s.earnedH, bookedH: s.workedH, personDays: s.personDays, peopleADay: s.people,
      stdHPerPersonDay: r1(s.stdPerPersonDay), attendance: r2(s.attendance), overtimeH: s.overtimeH, overtimeShare: r2(s.overtimeShare),
      machineAvailability: r2(s.availability), stoppedH: s.downtimeH,
    },
    departments: f.groups.map((g) => ({
      dept: g.group, recordedDays: g.days, peopleADay: g.people, bookedH: g.workedH, earnedH: g.earnedH, efficiency: r2(g.efficiency),
      stdHPerPersonDay: r1(g.stdPerPersonDay), pieces: g.pieces, piecesPerPersonDay: r1(g.piecesPerPersonDay),
      overtimeShare: r2(g.overtimeShare), attendance: r2(g.attendance), machineAvailability: r2(g.availability), stoppedH: g.downtimeH,
    })),
    centres: f.grid.map((r) => ({ centre: r.centre, efficiency: r2(r.total), days: r.cells.filter((c) => c.efficiency !== null).map((c) => ({ day: c.dateISO, efficiency: r2(c.efficiency), earnedH: c.earnedH, bookedH: c.workedH })) })),
    trend: f.trend.map((p) => ({ day: p.dateISO, efficiency: r2(p.efficiency), [`rolling${f.window}`]: r2(p.rolling), stdHPerPersonDay: r1(p.stdPerPersonDay) })),
    dailyOutput: f.output.map(outputRow),
    losses: { unplannedH: f.losses.unplannedH, plannedMaintenanceH: f.losses.plannedH, byCause: f.losses.causes.map(lossRow) },
    machines: { stoppedNow: f.stops.open, mostStopped: f.stops.byMachine, note: "Stops are recorded on the machine, by department; the punches carry the panels too, so a stop is never one line's." },
    quality: {
      tankTracking: q.tankTracking,
      tanks: q.tanks ? { waitingTest: q.tanks.waitingTest, inRepair: q.tanks.inRepair, readyToPaint: q.tanks.readyToPaint, weldedInPeriod: q.tanks.weldedInPeriod, paintedInPeriod: q.tanks.paintedInPeriod, leakTestFirstPass: { ...q.tanks.firstPass, rate: r2(q.tanks.firstPass.rate), note: "Over the tanks whose FIRST leak test fell in the period; a re-test never flatters it." }, weldToTestDays: q.tanks.weldToTest, testToPaintDays: q.tanks.testToPaint } : null,
      returns: { ...q.returns, byWeek: q.returnsByWeek },
    },
    daysWithDisagreeingRecords: f.gapDays,
    shareOfPiecesPriced: r2(f.pricedShare),
  };
}

/** The panels' floor over a period as the model reads it. */
function lvFloorView(f: LvFloorPeriod) {
  const s = f.summary;
  return {
    line: "LV",
    from: f.fromISO, to: f.toISO, dept: f.dept, periodAdjusted: f.clamped, recordedDays: f.dates.length,
    interventions: f.actions.map((a) => `${a.tone}: ${a.text}`),
    summary: {
      efficiency: r2(s.efficiency), earnedH: s.earnedH, bookedH: s.workedH, personDays: s.personDays, peopleADay: s.people,
      stdHPerPersonDay: r1(s.stdPerPersonDay), attendance: r2(s.attendance), overtimeH: s.overtimeH, overtimeShare: r2(s.overtimeShare),
    },
    departments: f.groups.map((g) => ({
      dept: g.dept, recordedDays: g.days, peopleADay: g.people, bookedH: g.workedH, earnedH: g.earnedH, efficiency: r2(g.efficiency),
      stdHPerPersonDay: r1(g.stdPerPersonDay), panels: g.panels, panelsPerPersonDay: r1(g.panelsPerPersonDay), overtimeShare: r2(g.overtimeShare), attendance: r2(g.attendance),
    })),
    departmentDays: f.grid.map((r) => ({ dept: r.centre, efficiency: r2(r.total), days: r.cells.filter((c) => c.efficiency !== null).map((c) => ({ day: c.dateISO, efficiency: r2(c.efficiency), earnedH: c.earnedH, bookedH: c.workedH })) })),
    trend: f.trend.map((p) => ({ day: p.dateISO, efficiency: r2(p.efficiency), [`rolling${f.window}`]: r2(p.rolling), stdHPerPersonDay: r1(p.stdPerPersonDay) })),
    dailyOutput: f.output.map((d) => ({ day: d.dateISO, hoursByDept: Object.fromEntries(LV_FLOOR_DEPTS.map((x) => [x, r1(d.byDept[x])])), earnedH: r1(d.earnedH), bookedH: r1(d.workedH), efficiency: r2(d.efficiency) })),
    panelsMovedPerStage: f.moved,
    daysWithDisagreeingRecords: f.gapDays,
    shareOfPanelsPriced: r2(f.pricedShare),
    notAvailable: [
      "Machine stops and availability: recorded by department on shared machines — the plant's, under line=all or TR.",
      "Quality (leak test, returns): the panels are recorded as quantities, with no serial, test or return of their own.",
    ],
  };
}

/** The floor's performance over a period and a department — the Production dashboard's
 *  Floor performance section, from the same loaders and the same reading of the request. */
export const getFloorPerformanceTool: ReadTool<{ from?: string; to?: string; dept?: string; line?: DashScope }> = {
  kind: "read",
  name: "get_floor_performance",
  title: "Reading the floor's performance",
  description:
    `How the floor worked over a period the person names (a week, a month, from one date to another — at most ${FLOOR_MAX_DAYS} days, starting within the last ${FLOOR_HISTORY_DAYS}; the last ${FLOOR_DEFAULT_DAYS} days if none is named), for one line or the whole plant (line: TR, LV or all; left out, the line the app is on) and for every department or one — the Production dashboard (Dashboards → Production), all in STANDARD HOURS: ` +
    "TR (the transformers; departments Fabrication = laser / punch, bending and fin folding; Welding; ShotBlast; Painting): efficiency (earned std-hours ÷ the man-hours the shift log booked; 100% = the standard pace), each centre's efficiency day by day and over the period, " +
    "productivity — standard hours and pieces one person turned out on a recorded day, people a day, attendance, overtime share, machine availability — by department (shot blast's pieces are every painted piece, as on Shifts), " +
    `the floor's efficiency each day with its rolling ${FLOOR_TREND_WINDOW}-recorded-day figure, each day's output by department against the hours booked, the machine stops by cause, the machines stopped now and the most stopped, quality and rework (the tanks' leak test passed first time, their waits welding → test → painting while tanks are tracked piece by piece; the pieces sent back upstream), the days whose records disagree (output with no hours, hours with no output), and what needs intervention. ` +
    "LV (the panels; departments Punching, Bending, WeldingLV, PaintingLV — or the stage names Welding / Painting): the same efficiency, productivity (in standard hours and in panels), attendance, overtime, each department day by day, output day by day and the panels moved per stage — priced by the timings sheet's LV tab (shareOfPanelsPriced says how far). No stop and no quality figure is the panels' own. " +
    "all (the whole plant): both views and the plant's efficiency from the sums (Σ earned ÷ Σ worked, both lines), its standard hours and man-hours added, its stops counted once, both lines' interventions tagged by line — pieces per line, never added. " +
    "Use it for any question about productivity, efficiency, output, stops, quality or lost time over a period other than the last few recorded days (\"last month\", \"since the 1st\", \"welding in September\", \"compare TR and LV\"); get_kpis has today's cockpit. periodAdjusted says the period asked for was moved to fit the limits.",
  schema: {
    type: "object",
    properties: {
      from: { type: "string", description: "First day, YYYY-MM-DD (the factory's calendar)." },
      to: { type: "string", description: "Last day, YYYY-MM-DD; today when left out." },
      dept: { type: "string", enum: ["all", ...OUTPUT_GROUPS, ...LV_FLOOR_DEPTS], description: "One department, or all (the default). The transformers' four, or the panels' four (Welding / Painting read as the panels' department of that stage when line is LV). Under all, the department is read on each line that has it." },
      line: lineParam,
    },
    additionalProperties: false,
  },
  // the shift log's figures: closed with the Shifts screen, as the Production dashboard is
  tabs: ["shifts"],
  status: (i) => `Reading the floor's performance${i?.line ? ` (${i.line})` : ""}`,
  async run(input, ctx) {
    const scope = scopeOf(input.line, ctx);
    const req = floorRequest(input, factoryDayISO(ctx.now));
    // the section's own period needs no dates, so the link does not pin the page to a past week
    const period = !req.isDefault || req.clamped ? { from: req.fromISO, to: req.toISO } : {};
    const href = (s: DashScope, dept?: string | null) => dashHref("/dashboards/production", s, { ...period, dept: dept && dept !== "all" ? dept : null });
    const lvDept = lvFloorDeptOf(input.dept);
    if (scope === "LV") {
      const f = await getLvFloorPeriod({ ...req, dept: lvDept }, ctx.now);
      return { ok: true, text: JSON.stringify(lvFloorView(f)), links: [{ label: "Production dashboard (LV)", href: href("LV", f.dept) }] };
    }
    if (scope === "TR") {
      const f = await getFloorPeriod(req, ctx.now);
      return { ok: true, text: JSON.stringify(trFloorView(f)), links: [{ label: "Production dashboard (TR)", href: href("TR", f.dept) }] };
    }
    // the plant as the page assembles it (lib/server/dashboards.ts): the department read on each line that has it
    const { tr, lv, actions } = await loadProductionAll(req, lvDept, ctx.now);
    const plant = plantEfficiency([linePart("TR", tr), linePart("LV", lv)]);
    return {
      ok: true,
      text: JSON.stringify({
        line: "all",
        from: tr.fromISO, to: tr.toISO, periodAdjusted: tr.clamped || lv.clamped,
        dept: { asked: typeof input.dept === "string" ? input.dept : "all", TR: tr.dept, LV: lv.dept, note: input.dept && input.dept !== "all" && tr.dept === "all" && lv.dept === "all" ? "The department asked for belongs to neither line; every department is shown." : "A department is read on the line that has it; the other line shows every department." },
        interventions: actions.map((a) => `${a.line} ${a.tone}: ${a.text}`),
        plant: {
          efficiency: r2(plant.efficiency), earnedH: plant.earnedH, bookedH: plant.workedH, personDays: plant.personDays, stdHPerPersonDay: r1(plant.stdPerPersonDay),
          machineStops: { unplannedH: tr.losses.unplannedH, plannedMaintenanceH: tr.losses.plannedH, availability: r2(tr.summary.availability), byCause: tr.losses.causes.map(lossRow), stoppedNow: tr.stops.open, mostStopped: tr.stops.byMachine, note: "Recorded by department on shared machines — the plant's, counted once." },
          coverage: plant.notes,
          notes: PLANT_NOTES,
        },
        transformers: trFloorView(tr),
        lvPanels: lvFloorView(lv),
      }),
      links: [{ label: "Production dashboard (whole plant)", href: href("all") }, { label: "Production dashboard (TR)", href: href("TR", tr.dept) }, { label: "Production dashboard (LV)", href: href("LV", lv.dept) }],
    };
  },
};

/** Why a centre (or the floor) earned less than it worked — and what moved it. */
export const explainEfficiencyTool: ReadTool<{ centre?: WorkCentre; days?: number }> = {
  kind: "read",
  name: "explain_efficiency",
  title: "Finding where the hours went",
  description:
    "Why a transformer work centre (or the whole transformer floor) earned fewer standard hours than its people were rostered for, over the last 7, 14 or 30 days: the walk from rostered man-hours down to earned standard hours — absence, overtime added, worked hours, the man-hours idled by machine stops (by cause: breakdowns, no material, no operator, setup, planned maintenance …), and what is left (work slower than the standard, or work not on the Daily log) — and, against the same number of days before, which of those moved the efficiency and by how many points. " +
    "Read it for any \"why\" about efficiency, output falling short, lost hours or where to act first; draw the steps as a waterfall chart. The transformers' centres only: the panels' departments have no machines of their own, so their shortfall is read on get_floor_performance (line LV) as attendance, overtime and the share of panels priced.",
  schema: {
    type: "object",
    properties: {
      centre: { type: "string", enum: [...WORK_CENTRES], description: "One work centre; leave out for the whole floor." },
      days: { type: "integer", minimum: 7, maximum: 30, description: "The stretch, in calendar days up to today — 7, 14 (default) or 30 — compared with the same number of days before it." },
    },
    additionalProperties: false,
  },
  // the shift log's figures — as on the Production dashboard, only for the people who see Shifts
  tabs: ["shifts"],
  status: () => "Finding where the hours went",
  async run(i, ctx) {
    // to the nearest of the stretches the Production dashboard offers
    const days = i.days ? [...LOSS_DAYS].sort((a, b) => Math.abs(a - i.days!) - Math.abs(b - i.days!))[0] : 14;
    const w = await getLossWaterfall({ centre: i.centre ?? null, days, now: ctx.now });
    const view = (x: typeof w.now) => ({
      recordedDays: x.days, rosteredH: x.rosteredH, absentH: x.absentH, overtimeH: x.overtimeH, workedH: x.workedH,
      stopsManH: x.stopsH, slowerOrNotLoggedH: x.performanceH, earnedStdH: x.earnedH, efficiency: x.efficiency === null ? null : Math.round(x.efficiency * 1000) / 10,
    });
    return {
      ok: true,
      text: JSON.stringify({
        centre: i.centre ? WORK_CENTRE_LABEL[i.centre] : "the whole transformer floor",
        from: w.fromISO, to: w.toISO, comparedWithFrom: w.beforeFromISO,
        now: view(w.now),
        before: view(w.before),
        waterfall: w.now.steps.map((s) => ({ name: s.label, value: s.hours, total: s.total })),
        stopsByCause: w.now.stops.map((s) => ({ cause: s.label, planned: s.planned, machineH: s.machineH, manH: s.manH })),
        whatMoved: w.change.drivers,
        summary: [w.change.text, w.biggest].filter(Boolean).join(" "),
        note: "Stops are machine-hours turned into the man-hours they idled (the centre's people's hours against its machines'), never more than the hours not earned. 'Slower or not logged' is what remains — slower than the standard, or work done but not on the Daily log; it is not, by itself, the people's fault.",
      }),
      // the card lives on the transformers' Production dashboard
      links: [{ label: "Production dashboard (TR)", href: dashHref("/dashboards/production", "TR") }],
    };
  },
};

export const KPI_TOOLS = [getKpisTool, getFloorPerformanceTool, explainEfficiencyTool] as const;
