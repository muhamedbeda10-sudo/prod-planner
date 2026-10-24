import "server-only";
import { getCockpit } from "@/lib/server/kpis";
import type { ReadTool } from "./types";

// The planner's KPIs for the assistant — exactly what the Planning cockpit
// shows, from the same loader, so an answer never disagrees with the page.

const r2 = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);

export const getKpisTool: ReadTool<Record<string, never>> = {
  kind: "read",
  name: "get_kpis",
  title: "Reading the planning cockpit",
  description:
    "The planner's KPIs as the Planning cockpit (/cockpit) shows them, all in STANDARD HOURS (what the work is worth, never pieces): " +
    "the decisions it flags today; the newest weekly plan — each stage's pieces due by today against done (adherence), and the lines behind with the stage they are stuck at; " +
    "each work centre (laser / punch, bending, fin folding, welding, shot blast, painting) — earned std-hours against the man-hours the shift log booked there (efficiency, 100% = the standard pace) on the last recorded day and over the recent recorded days, people a day, machine availability, the daily trend; " +
    "the load ahead — each centre's remaining plan hours over the next 10 working days against what it can work (behind now and when it catches up, or short at the end); " +
    "welding coverage — days of cut parts waiting in front of the welders; the losses — machine stops by cause, absence and overtime; and the daily trend of these. " +
    "Read it first for any question about how the plant is doing, its KPIs, efficiency, capacity or the morning's priorities.",
  schema: { type: "object", properties: {}, additionalProperties: false },
  tabs: ["cockpit"],
  status: () => "Reading the planning cockpit",
  async run() {
    const c = await getCockpit();
    return {
      ok: true,
      text: JSON.stringify({
        today: c.todayISO,
        lastRecordedDay: c.lastDayISO,
        decisions: c.actions.map((a) => `${a.tone}: ${a.text}`),
        weeklyPlan: {
          planNo: c.week.planNo, piecesRequired: c.week.req, piecesFinished: c.week.covered,
          adherence: c.week.adherence.map((a) => ({ stage: a.stage, dueByToday: a.due, done: a.done, rate: r2(a.rate) })),
          behindCount: c.week.lateCount,
          behind: c.week.late.map((l) => ({ day: l.dayISO, bom: l.bom, soi: l.soi, item: l.item, stuckAt: l.stage, short: l.short, owed: l.owed })),
          days: c.week.days.map((d) => ({ day: d.iso, required: d.req, finished: d.covered })),
        },
        centres: c.centres.map((k) => ({
          centre: k.centre,
          lastDay: { earnedH: k.last.earnedH, workedH: k.last.workedH, efficiency: r2(k.last.efficiency) },
          recent: { days: k.recent.days, earnedH: k.recent.earnedH, workedH: k.recent.workedH, efficiency: r2(k.recent.efficiency), peopleADay: k.recent.people, stoppedH: k.recent.downtimeH, availability: r2(k.recent.availability) },
          trend: k.trend.map((t) => ({ day: t.dateISO, efficiency: r2(t.efficiency) })),
        })),
        loadAhead: c.load.map((l) => ({ centre: l.centre, loadRate: r2(l.loadRate), behindH: l.behindH, clears: l.clearsISO, shortAtEndH: l.shortH, days: l.days })),
        weldingCoverage: c.coverage,
        losses: { ...c.losses, absentRate: r2(c.losses.absentRate) },
        shareOfRecentOutputPriced: r2(c.pricedShare),
        trend: c.trend,
      }),
      links: [{ label: "Planning cockpit", href: "/cockpit" }],
    };
  },
};

export const KPI_TOOLS = [getKpisTool] as const;
