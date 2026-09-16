import "server-only";
import { prisma } from "@/lib/db";
import { dateFromDayNumber, dayNumber, toISODate } from "@/lib/domain/dates";
import { LV_CHAIN, LV_ITEM, type LvChainStage } from "@/lib/domain/lv";
import { getLvTracker } from "./lvTracker";

// The LV panels' dashboard — the panels' side of the Dashboard tab.
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
  /** The last `DAYS` calendar days, oldest first. */
  days: LvDashboardDay[];
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
const zero = (): Record<LvChainStage, number> => ({ Punching: 0, Bending: 0, Welding: 0, Painting: 0, Delivered: 0 });

export async function getLvDashboard(): Promise<LvDashboardData> {
  const today = dayNumber(new Date());
  const from = today - (DAYS - 1);
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
    days, period, month, open,
    monthLabel: monthStart.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
  };
}
