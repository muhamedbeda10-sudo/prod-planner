import "server-only";
import { getCockpit, getFloorPeriod, type CockpitData } from "@/lib/server/kpis";
import { OUTPUT_GROUPS, dailyOutput, isFloorAction, monthPace, weekChange, type KpiSnapshotData } from "@/lib/domain/kpis";
import { isFloorDept } from "@/lib/domain/floorKpis";
import { factoryDayISO, parseISODate } from "@/lib/domain/dates";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import type { ReadTool } from "./types";

// The planner's KPIs for the assistant — exactly what the Cockpit
// shows, from the same loader, so an answer never disagrees with the page.

const r2 = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);

type Picker = (p: KpiSnapshotData) => number | null | undefined;
/** The headline figures read against a week ago — the shift log's two only for the people who see Shifts. */
const WEEK_FIGURES: [string, Picker][] = [["planDeliveredOnItsDay", (p) => p.adherence.finish], ["linesBehind", (p) => p.late], ["weldingCoverageDays", (p) => p.coverageDays]];
const FLOOR_WEEK_FIGURES: [string, Picker][] = [["fabricationEfficiency", (p) => p.fabEfficiency], ["machineHoursLost", (p) => p.unplannedH]];

export const getKpisTool: ReadTool<Record<string, never>> = {
  kind: "read",
  name: "get_kpis",
  title: "Reading the planning cockpit",
  description:
    "The planner's KPIs as the Cockpit (the home page, /, a view of Plan Tracker) shows them, all in STANDARD HOURS (what the work is worth, never pieces) — the transformers only: " +
    "the decisions it flags today; the newest weekly plan — each stage's pieces due by today against done (adherence), and the lines behind with the stage they are stuck at (the oldest 20 of them; behindCount counts them all); " +
    "each work centre (laser / punch, bending, fin folding, welding, shot blast, painting) — earned std-hours against the man-hours the shift log booked there (efficiency, 100% = the standard pace) on the last recorded day and over the recent recorded days, people a day, machine availability, the daily trend, and Fabrication's three centres together; " +
    "the load ahead — each centre's remaining plan hours over the next 10 working days against what it can work (falling behind and when it catches up, or short at the end; not measured without booked hours); " +
    "welding coverage — days of cut parts waiting in front of the welders; the month's pace — each centre's share of the month's plan done against an even pace through its working days; each recorded day's output in standard hours by department against the man-hours booked; each headline figure against a week ago; the month's manpower — the people each centre needs for the month's plan (its standard hours over the working days × the net hours a person works) and from today for what is left, against the people who come; the losses — machine stops by cause, absence and overtime; and the daily trend of these. " +
    "Read it first for any question about how the plant is doing, its KPIs, efficiency, capacity or the morning's priorities. " +
    "For a person the Shifts screen is closed to, the shift log's figures (the centres, the losses) are left out.",
  schema: { type: "object", properties: {}, additionalProperties: false },
  tabs: ["dashboard"],
  status: () => "Reading the planning cockpit",
  async run(_input, ctx) {
    const c = await getCockpit(ctx.now);
    // the shift log's figures stay with the people who see Shifts, as on the page
    const floor = !ctx.hidden?.has("shifts");
    const pt = (t: CockpitData["trend"][number]) => ({
      day: t.dateISO, behind: t.late, coverageDays: t.coverageDays,
      adherence: Object.fromEntries(Object.entries(t.adherence).map(([k, v]) => [k, r2(v)])),
      ...(floor ? { unplannedH: t.unplannedH, efficiency: Object.fromEntries(Object.entries(t.efficiency).map(([k, v]) => [k, r2(v)])) } : {}),
    });
    return {
      ok: true,
      text: JSON.stringify({
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
            byCause: c.losses.causes.map((x) => ({ cause: x.label, planned: x.planned, hours: x.hours, stops: x.stops, share: r2(x.share) })),
            absentRate: r2(c.losses.absentRate), overtimeH: c.losses.overtimeH,
          },
          shareOfRecentOutputPriced: r2(c.pricedShare),
          // each recorded day's output in standard hours by department, against the man-hours booked
          dailyOutput: dailyOutput(c.centres).map((d) => ({ day: d.dateISO, fabricationH: d.Fabrication, weldingH: d.Welding, shotBlastH: d.ShotBlast, paintingH: d.Painting, earnedH: d.earnedH, bookedH: d.workedH, efficiency: r2(d.efficiency) })),
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
        trend: c.trend.map(pt),
      }),
      links: [{ label: "Cockpit", href: "/" }],
    };
  },
};

const r1 = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

/** The floor's performance over a period and a department — the Cockpit's
 *  Floor performance section, from the same loader. */
export const getFloorPerformanceTool: ReadTool<{ from?: string; to?: string; dept?: string }> = {
  kind: "read",
  name: "get_floor_performance",
  title: "Reading the floor's performance",
  description:
    "How the transformer floor worked over a period the person names (a week, a month, from one date to another — at most 92 days; the last 7 days if none is named), for every department or one (Fabrication = laser / punch, bending and fin folding; Welding; ShotBlast; Painting) — the Cockpit's Floor performance section, all in STANDARD HOURS: " +
    "efficiency (earned std-hours ÷ the man-hours the shift log booked; 100% = the standard pace), each centre's efficiency day by day and over the period, " +
    "productivity — standard hours and pieces one person turned out on a recorded day, people a day, attendance, overtime share, machine availability — by department, " +
    "the floor's efficiency each day with its rolling 7-recorded-day figure, each day's output by department against the hours booked, and the machine stops by cause. " +
    "Use it for any question about productivity, efficiency or output over a period other than the last few days (\"last month\", \"since the 1st\", \"welding in September\"); get_kpis has today's cockpit.",
  schema: {
    type: "object",
    properties: {
      from: { type: "string", description: "First day, YYYY-MM-DD (the factory's calendar)." },
      to: { type: "string", description: "Last day, YYYY-MM-DD; today when left out." },
      dept: { type: "string", enum: ["all", ...OUTPUT_GROUPS], description: "One department, or all (the default)." },
    },
    additionalProperties: false,
  },
  // the shift log's figures: closed to a person the Shifts screen is closed to
  tabs: ["dashboard", "shifts"],
  status: () => "Reading the floor's performance",
  async run(input, ctx) {
    const today = factoryDayISO(ctx.now);
    const to = input.to && parseISODate(input.to) ? input.to : today;
    const from = input.from && parseISODate(input.from) ? input.from : addDaysISO(to, -6);
    const dept = isFloorDept(input.dept) ? input.dept : "all";
    const f = await getFloorPeriod({ fromISO: from, toISO: to, dept }, ctx.now);
    const s = f.summary;
    return {
      ok: true,
      text: JSON.stringify({
        from: f.fromISO, to: f.toISO, dept: f.dept, recordedDays: f.dates.length,
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
        trend: f.trend.map((p) => ({ day: p.dateISO, efficiency: r2(p.efficiency), rolling7: r2(p.rolling), stdHPerPerson: r1(p.stdPerPersonDay) })),
        dailyOutput: f.output.map((d) => ({ day: d.dateISO, fabricationH: d.Fabrication, weldingH: d.Welding, shotBlastH: d.ShotBlast, paintingH: d.Painting, earnedH: d.earnedH, bookedH: d.workedH })),
        stops: { unplannedH: f.losses.unplannedH, plannedMaintenanceH: f.losses.plannedH, byCause: f.losses.causes.map((x) => ({ cause: x.label, planned: x.planned, hours: x.hours, stops: x.stops })) },
        shareOfPiecesPriced: r2(f.pricedShare),
      }),
      links: [{ label: "Floor performance", href: `/?from=${f.fromISO}&to=${f.toISO}${f.dept === "all" ? "" : `&dept=${f.dept}`}` }],
    };
  },
};

export const KPI_TOOLS = [getKpisTool, getFloorPerformanceTool] as const;
