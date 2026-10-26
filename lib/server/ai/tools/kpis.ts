import "server-only";
import { getCockpit, getLossWaterfall, type CockpitData } from "@/lib/server/kpis";
import { WORK_CENTRES, WORK_CENTRE_LABEL, type WorkCentre } from "@/lib/domain/shifts";
import { LOSS_DAYS } from "@/lib/domain/losses";
import { dailyOutput, isFloorAction, monthPace, weekChange, type KpiSnapshotData } from "@/lib/domain/kpis";
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

/** Why a centre (or the floor) earned less than it worked — and what moved it. */
export const explainEfficiencyTool: ReadTool<{ centre?: WorkCentre; days?: number }> = {
  kind: "read",
  name: "explain_efficiency",
  title: "Finding where the hours went",
  description:
    "Why a work centre (or the whole floor) earned fewer standard hours than its people were rostered for, over the last 7, 14 or 30 days: the walk from rostered man-hours down to earned standard hours — absence, overtime added, worked hours, the man-hours idled by machine stops (by cause: breakdowns, no material, no operator, setup, planned maintenance …), and what is left (work slower than the standard, or work not on the Daily log) — and, against the same number of days before, which of those moved the efficiency and by how many points. " +
    "Read it for any \"why\" about efficiency, output falling short, lost hours or where to act first; draw the steps as a waterfall chart.",
  schema: {
    type: "object",
    properties: {
      centre: { type: "string", enum: [...WORK_CENTRES], description: "One work centre; leave out for the whole floor." },
      days: { type: "integer", minimum: 7, maximum: 30, description: "The stretch, in calendar days up to today — 7, 14 (default) or 30 — compared with the same number of days before it." },
    },
    additionalProperties: false,
  },
  // the shift log's figures — as on the Cockpit, only for the people who see Shifts
  tabs: ["dashboard", "shifts"],
  status: () => "Finding where the hours went",
  async run(i, ctx) {
    // to the nearest of the stretches the Cockpit offers
    const days = i.days ? [...LOSS_DAYS].sort((a, b) => Math.abs(a - i.days!) - Math.abs(b - i.days!))[0] : 14;
    const w = await getLossWaterfall({ centre: i.centre ?? null, days, now: ctx.now });
    const view = (x: typeof w.now) => ({
      recordedDays: x.days, rosteredH: x.rosteredH, absentH: x.absentH, overtimeH: x.overtimeH, workedH: x.workedH,
      stopsManH: x.stopsH, slowerOrNotLoggedH: x.performanceH, earnedStdH: x.earnedH, efficiency: x.efficiency === null ? null : Math.round(x.efficiency * 1000) / 10,
    });
    return {
      ok: true,
      text: JSON.stringify({
        centre: i.centre ? WORK_CENTRE_LABEL[i.centre] : "the whole floor",
        from: w.fromISO, to: w.toISO, comparedWithFrom: w.beforeFromISO,
        now: view(w.now),
        before: view(w.before),
        waterfall: w.now.steps.map((s) => ({ name: s.label, value: s.hours, total: s.total })),
        stopsByCause: w.now.stops.map((s) => ({ cause: s.label, planned: s.planned, machineH: s.machineH, manH: s.manH })),
        whatMoved: w.change.drivers,
        summary: [w.change.text, w.biggest].filter(Boolean).join(" "),
        note: "Stops are machine-hours turned into the man-hours they idled (the centre's people's hours against its machines'), never more than the hours not earned. 'Slower or not logged' is what remains — slower than the standard, or work done but not on the Daily log.",
      }),
    };
  },
};

export const KPI_TOOLS = [getKpisTool, explainEfficiencyTool] as const;
