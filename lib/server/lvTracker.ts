import "server-only";
import { prisma } from "@/lib/db";
import { loadMasterOrdersOf } from "./loads";
import { LV_ITEM, lvComplete, type LvState } from "@/lib/domain/lv";

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
  priority: boolean;
  months: string[];
}

export async function getLvTracker(): Promise<LvTrackerRow[]> {
  const [orders, sums] = await Promise.all([
    loadMasterOrdersOf("LV"), // the panels, whatever the toggle says — the Floor draws both lines
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
    const cap = (v: number) => (o.planQty > 0 ? Math.min(v, o.planQty) : v);
    const state: LvState = {
      required: o.planQty,
      punch: cap(g(o.mo, "Punching")),
      bend: cap(g(o.mo, "Bending")),
      weld: cap(g(o.mo, "Welding")),
      paint: cap(g(o.mo, "Painting")),
      delivered: cap(g(o.mo, "Delivered")),
    };
    const complete = lvComplete(state);
    return {
      mo: o.mo, bom: o.bom, soi: o.soi, urgent: o.urgent, customer: o.customer, product: o.product, fgCode: o.fgCode,
      secItem: o.secItem, ospEncloser: o.ospEncloser, remarks: o.remarks, materialsRemarks: o.materialsRemarks,
      state, complete,
      remaining: Math.max(0, o.planQty - complete),
      achievement: o.planQty > 0 ? complete / o.planQty : null,
      status: o.status, priority: o.priority,
      months: (o.months || o.source || "").split(",").map((s) => s.trim()).filter(Boolean),
    };
  });
}
