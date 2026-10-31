import "server-only";
import { cache } from "react";
import { holdView, type HoldView } from "@/lib/domain/hold";
import { prisma } from "@/lib/db";
import { loadMasterOrdersOf } from "./loads";
import { LV_ITEM, lvComplete, type LvState } from "@/lib/domain/lv";
import { shownStageTotal } from "@/lib/domain/trackerEdit";
import { isOdooExactOrder } from "@/lib/domain/trackerOdoo";
import { odooClosedOf } from "./odooClosings";

// The LV panels' tracker: one row per panel order, its position on the
// chain read off the ledger — the same ledger the transformers write, under
// the panel's own stage names and item code.

export interface LvTrackerRow {
  mo: string;
  bom: string;
  soi: string | null;
  urgent: boolean;
  customer: string | null;
  product: string | null;
  /** The plan it came from — "" the panels', "MB" the meter boxes'. */
  family: string;
  fgCode: string | null;
  secItem: string | null;
  ospEncloser: number;
  remarks: string | null;
  materialsRemarks: string | null;
  state: LvState;
  complete: number;
  remaining: number;
  achievement: number | null;
  status: string;
  /** ⏸ paused by the planner — tinted on the tracker, out of every stage's list. */
  hold: HoldView;
  priority: boolean;
  months: string[];
  /** Closed in Odoo: the Done rows of the ODOO log born from the panel's own
   *  painting — null for an order planned before ODOO_EXACT_FROM (not counted),
   *  undefined when not read (only getLvTrackerWithOdoo reads it). */
  odooClosed?: number | null;
}

/** Request-cached: the panels' dashboards and their stage table read it in one request. */
export const getLvTracker = cache(async (): Promise<LvTrackerRow[]> => {
  const [orders, sums] = await Promise.all([
    loadMasterOrdersOf("LV"), // the panels, whatever line is on screen — the Floor draws both lines
    prisma.handoverEntry.groupBy({
      by: ["mo", "dept"],
      where: { mo: { not: null }, item: LV_ITEM },
      _sum: { qty: true },
    }),
  ]);
  const done = new Map<string, number>();
  for (const s of sums) if (s.mo) done.set(`${s.mo}|${s.dept}`, s._sum.qty ?? 0);
  const g = (mo: string, dept: string) => done.get(`${mo}|${dept}`) ?? 0;

  return orders.map((o) => {
    const cap = (v: number) => shownStageTotal(v, o.planQty);
    // the enclosures bought in (OSP Encloser) are not our stages' to make —
    // what the panels' stages owe is the order less them, as a transformer's
    // OSP parts come off its targets
    const inHouse = Math.max(0, o.planQty - Math.max(0, o.ospEncloser));
    const state: LvState = {
      required: inHouse,
      punch: cap(g(o.mo, "Punching")),
      bend: cap(g(o.mo, "Bending")),
      weld: cap(g(o.mo, "Welding")),
      paint: cap(g(o.mo, "Painting")),
      delivered: cap(g(o.mo, "Delivered")),
    };
    const complete = lvComplete(state);
    return {
      mo: o.mo, bom: o.bom, soi: o.soi, urgent: o.urgent, customer: o.customer, product: o.product, family: o.family, fgCode: o.fgCode,
      secItem: o.secItem, ospEncloser: o.ospEncloser, remarks: o.remarks, materialsRemarks: o.materialsRemarks,
      state, complete,
      remaining: Math.max(0, inHouse - complete),
      // wholly bought in: nothing is left for our stages, so it is covered
      achievement: inHouse > 0 ? Math.min(1, complete / inHouse) : o.planQty > 0 ? 1 : null,
      status: o.status, hold: holdView(o), priority: o.priority,
      months: (o.months || o.source || "").split(",").map((s) => s.trim()).filter(Boolean),
    };
  });
});

/** The panels' tracker with Odoo's closings — the Plan Tracker screen's, the
 *  assistant's and its sheet's: the orders planned from October 2026 on count
 *  them exactly, as the transformers' do; the older ones read null. */
export const getLvTrackerWithOdoo = cache(async (): Promise<LvTrackerRow[]> => {
  const rows = await getLvTracker();
  const exact = new Set(rows.filter((r) => isOdooExactOrder({ months: r.months })).map((r) => r.mo));
  const closed = await odooClosedOf([...exact], "LV");
  return rows.map((r) => ({ ...r, odooClosed: exact.has(r.mo) ? closed(r.mo, LV_ITEM) : null }));
});
