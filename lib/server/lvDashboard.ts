import "server-only";
import { prisma } from "@/lib/db";
import { dateFromDayNumber, dayNumber, toISODate } from "@/lib/domain/dates";
import { LV_CHAIN, LV_ITEM, type LvChainStage } from "@/lib/domain/lv";
import { getLvTracker } from "./lvTracker";

// The LV panels' dashboard — the panels' side of the plan's dashboard (a view of the Plan Tracker tab).
//
// A transformer's dashboard is six components against a daily target per
// department; a panel is one thing through four stages, so its dashboard is
// simpler: how many panels each stage moved on each of the last days, and
// where the open orders stand on the chain. No targets yet — nobody has set
// a panels-a-day figure — so the numbers are shown without a line to beat.

export interface LvDashboardDay {
  dateISO: string;
  byStage: Record<LvChainStage, number>;
}

export interface LvDashboardData {
  /** The days shown, oldest first: the last two weeks, or the period asked for. */
  days: LvDashboardDay[];
  fromISO: string;
  toISO: string;
  /** A period was asked for (from → to), rather than the default two weeks. */
  ranged: boolean;
  /** The period asked for was longer than the cap and was cut to it. */
  clamped: boolean;
  /** Totals per stage over those days. */
  period: Record<LvChainStage, number>;
  /** This calendar month, per stage. */
  month: Record<LvChainStage, number>;
  monthLabel: string;
  open: {
    orders: number;
    panels: number;
    /** Panels at each stage across the open orders — the chain as it stands. */
    byStage: Record<LvChainStage, number>;
    urgent: number;
  };
}

const DAYS = 14;
/** The longest period drawn day by day — a quarter is a chart, not a table. */
const MAX_DAYS = 62;
const zero = (): Record<LvChainStage, number> => ({ Punching: 0, Bending: 0, Welding: 0, Painting: 0, Delivered: 0 });

/** The panels' dashboard for the last two weeks, or for one day or a period
 *  when `opts` names it — the same day-or-period the transformer dashboard
 *  answers, which is what makes it the panels' report too. */
export async function getLvDashboard(opts?: { from?: Date | null; to?: Date | null }): Promise<LvDashboardData> {
  const todayNum = dayNumber(new Date());
  let from = todayNum - (DAYS - 1);
  let today = todayNum;
  let ranged = false;
  let clamped = false;
  if (opts?.from && opts?.to) {
    ranged = true;
    from = dayNumber(opts.from);
    today = dayNumber(opts.to);
    if (today < from) [from, today] = [today, from];
    if (today - from >= MAX_DAYS) { today = from + MAX_DAYS - 1; clamped = true; }
  }
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const since = new Date(Math.min(dateFromDayNumber(from).getTime(), monthStart.getTime()));

  const [entries, tracker] = await Promise.all([
    prisma.handoverEntry.findMany({
      where: { item: LV_ITEM, date: { gte: since } },
      select: { date: true, dept: true, qty: true },
    }),
    getLvTracker(),
  ]);

  const byDay = new Map<number, Record<LvChainStage, number>>();
  const period = zero();
  const month = zero();
  for (const e of entries) {
    const stage = e.dept as LvChainStage;
    if (!(LV_CHAIN as readonly string[]).includes(stage)) continue;
    const d = dayNumber(e.date);
    if (d >= from && d <= today) {
      if (!byDay.has(d)) byDay.set(d, zero());
      byDay.get(d)![stage] += e.qty;
      period[stage] += e.qty;
    }
    if (e.date >= monthStart) month[stage] += e.qty;
  }
  const days: LvDashboardDay[] = [];
  for (let d = from; d <= today; d++) days.push({ dateISO: toISODate(dateFromDayNumber(d)), byStage: byDay.get(d) ?? zero() });

  const openRows = tracker.filter((r) => r.status === "open");
  const open = { orders: openRows.length, panels: 0, byStage: zero(), urgent: 0 };
  for (const r of openRows) {
    open.panels += r.state.required;
    open.byStage.Punching += r.state.punch;
    open.byStage.Bending += r.state.bend;
    open.byStage.Welding += r.state.weld;
    open.byStage.Painting += r.state.paint;
    open.byStage.Delivered += r.state.delivered;
    if (r.urgent) open.urgent += 1;
  }

  return {
    days, period, month, open, ranged, clamped,
    fromISO: toISODate(dateFromDayNumber(from)), toISO: toISODate(dateFromDayNumber(today)),
    monthLabel: monthStart.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
  };
}
