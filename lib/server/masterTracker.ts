import "server-only";
import { holdView, type HoldView } from "@/lib/domain/hold";
import { prisma } from "@/lib/db";
import { loadMasterOrders } from "./loads";
import { ITEMS, isPaintExempt, itemEligible, ospOf, parseExcludedItems, type Item } from "@/lib/domain/constants";

// Plan Tracker on the MONTHLY registry: one row per MO. Progress is GLOBAL —
// setup balances plus every logged output, regardless of week — capped at the
// order's plan qty. Complete = MIN of each component's FINAL stage: Painting
// for TC/TN/CB, Welding for the paint-exempt core (CF is never painted).
// OSP quantities (outsourced components) count as covered: our depts never
// make them, so they credit the final stage when computing sets.

export interface MasterTrackerRow {
  mo: string;
  bom: string;
  soi: string | null;
  /** The plan sheet's customer column (PRI / SEC …). */
  customer: string | null;
  urgent: boolean;
  kva: string | null;
  rating: string | null;
  /** The plan sheet's own spec columns, shown beside KVA. */
  fins: string | null;
  crcSize: string | null;
  colorRal: string | null;
  /** Typed on the tracker — no plan sheet carries it. */
  sfm: string | null;
  required: number; // planQty
  // eligible = the order needs this component by rule (base four always; AR/MB
  // only when KVA/rating match). excluded = admin marked it N/A. A component
  // gates completion only when eligible && !excluded.
  items: Record<Item, { cut: number; weld: number; paint: number; shp: number; delivered: number; osp: number; excluded: boolean; eligible: boolean }>;
  welded: number; // MIN (weld + osp) over the REQUIRED items
  complete: number; // MIN (paint + osp) over the REQUIRED items — drives Left + Achievement
  remaining: number;
  achievement: number | null;
  status: string; // open | closed
  /** ⏸ paused by the planner — tinted on the tracker, out of every queue. */
  hold: HoldView;
  priority: boolean; // ⭐ flagged by the admin — shows on every dept worklist
  months: string[]; // every monthly plan the MO appeared in (e.g. ["July 2026", "August 2026"])
  /** A qty a plan import brought and held back for the planner: the sheet's
   *  figure and the plan it came with. Null when nothing is waiting. */
  pendingQty: { to: number; month: string | null } | null;
}

export async function getMasterTracker(): Promise<MasterTrackerRow[]> {
  const [orders, sums] = await Promise.all([
    loadMasterOrders(),
    prisma.handoverEntry.groupBy({
      by: ["mo", "dept", "item"],
      where: { mo: { not: null } },
      _sum: { qty: true },
    }),
  ]);

  const done = new Map<string, number>(); // mo|dept|item -> qty
  for (const s of sums) {
    if (!s.mo) continue;
    done.set(`${s.mo}|${s.dept}|${s.item}`, s._sum.qty ?? 0);
  }
  const g = (mo: string, dept: string, item: string) => done.get(`${mo}|${dept}|${item}`) ?? 0;

  return orders.map((o) => {
    const excluded = parseExcludedItems(o.excludedItems);
    const items = {} as MasterTrackerRow["items"];
    let welded = Infinity;
    let complete = Infinity;
    for (const it of ITEMS) {
      const cap = (v: number) => (o.planQty > 0 ? Math.min(v, o.planQty) : v);
      const osp = ospOf(o, it);
      const cut = cap(g(o.mo, "Cut", it));
      const weld = cap(g(o.mo, "Welding", it));
      const paint = cap(g(o.mo, "Painting", it));
      const shp = cap(g(o.mo, "ShotBlast", it)); // the core's real final stage after welding
      const delivered = cap(g(o.mo, "Delivered", it)); // what the customer received
      const eligible = itemEligible(it, o); // AR/MB when the KVA/rating rule matches, or the planner forced them on
      const isExcluded = excluded.has(it);
      items[it] = { cut, weld, paint, shp, delivered, osp, excluded: isExcluded, eligible };
      // a component gates completion only when the order needs it and it isn't N/A
      if (!eligible || isExcluded) continue;
      welded = Math.min(welded, cap(weld + osp));
      // final stage = SHOT BLAST for the paint-exempt core (CF), Painting otherwise
      complete = Math.min(complete, cap((isPaintExempt(it) ? shp : paint) + osp));
    }
    if (!Number.isFinite(welded)) welded = 0;
    if (!Number.isFinite(complete)) complete = 0;
    return {
      mo: o.mo,
      bom: o.bom,
      soi: o.soi,
      customer: o.customer,
      urgent: o.urgent,
      kva: o.kva,
      fins: o.fins,
      crcSize: o.crcSize,
      colorRal: o.colorRal,
      sfm: o.sfm,
      rating: o.rating,
      required: o.planQty,
      items,
      welded,
      complete,
      remaining: Math.max(0, o.planQty - complete),
      achievement: o.planQty > 0 ? complete / o.planQty : null,
      status: o.status,
      hold: holdView(o),
      priority: o.priority,
      // months CSV is backfilled from source by the migration; keep the
      // fallback for rows created before either existed
      months: (o.months || o.source || "").split(",").map((s) => s.trim()).filter(Boolean),
      pendingQty: o.pendingPlanQty !== null ? { to: o.pendingPlanQty, month: o.pendingQtyMonth } : null,
    };
  });
}
