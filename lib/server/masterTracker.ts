import "server-only";
import { cache } from "react";
import { holdView, type HoldView } from "@/lib/domain/hold";
import { prisma } from "@/lib/db";
import { loadMasterOrders, loadSettingsRow } from "./loads";
import { ODOO_ENTRY_SELECT, odooRowsOfOrders } from "./odooClosings";
import { ITEMS, applicableItems, isPaintExempt, itemEligible, ospOf, parseExcludedItems, type Item } from "@/lib/domain/constants";
import { shownStageTotal } from "@/lib/domain/trackerEdit";
import { exactOdooClosings, isOdooExactOrder, odooPlanMonth, trackerOdooQuantities, type OdooUnallocatedQuantity } from "@/lib/domain/trackerOdoo";

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
  items: Record<Item, { cut: number; weld: number; paint: number; shp: number; delivered: number; osp: number; excluded: boolean; eligible: boolean; odooClosed?: number; odooTracked?: boolean }>;
  odooUnallocated?: OdooUnallocatedQuantity[];
  /** Planned from ODOO_EXACT_FROM on: its Odoo closings are counted exactly,
   *  each Done row on the MO it was recorded against. */
  odooExact?: boolean;
  /** The original monthly plan owns a carried MO's allocated Odoo quantity. */
  odooPlanMonth?: string | null;
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

/** `odoo: "exact"` reads Odoo's closings only for the orders that count them
 *  exactly (planned from ODOO_EXACT_FROM on) — what the Plan Tracker screen
 *  shows; allocating every closing in the log to the older orders was the
 *  sheet's heaviest work. `"all"` also allocates the older orders' closings,
 *  with the pools and the plan month: the auto-close, the assistant and the
 *  trace read it. Both give an exact order the same numbers. */
async function computeMasterTracker({ odoo: mode = "all" }: { odoo?: "all" | "exact" } = {}): Promise<MasterTrackerRow[]> {
  const [orders, sums, settings] = await Promise.all([
    loadMasterOrders(),
    prisma.handoverEntry.groupBy({
      by: ["mo", "dept", "item"],
      where: { mo: { not: null } },
      _sum: { qty: true },
    }),
    mode === "all" ? loadSettingsRow() : null,
  ]);
  const withEligible = orders.map((o) => ({ ...o, eligibleItems: applicableItems(o) }));
  const exactOrders = withEligible.filter((o) => isOdooExactOrder(o));
  const exactMos = new Set(exactOrders.map((o) => o.mo));
  let odooProgress: { counts: Map<string, Partial<Record<Item, number>>>; tracked: Set<string>; unallocated: OdooUnallocatedQuantity[] };
  if (mode === "all") {
    const odoo = await prisma.odooEntry.findMany({ where: { line: "TR" }, select: ODOO_ENTRY_SELECT });
    const ledgerIds = odoo.flatMap((row) => row.ledgerId === null ? [] : [row.ledgerId]);
    const ledgers = ledgerIds.length ? await prisma.handoverEntry.findMany({ where: { id: { in: ledgerIds } }, select: { id: true, mo: true, bom: true, item: true } }) : [];
    odooProgress = trackerOdooQuantities(withEligible, odoo, ledgers, settings?.odooTrackingFrom);
  } else {
    const exact = await odooRowsOfOrders([...exactMos], "TR");
    const counts = exactOdooClosings(exactOrders, exact.entries, exact.ledgers);
    odooProgress = { counts, tracked: new Set(), unallocated: [] }; // every exact order is tracked (below)
  }

  const done = new Map<string, number>(); // mo|dept|item -> qty
  for (const s of sums) {
    if (!s.mo) continue;
    done.set(`${s.mo}|${s.dept}|${s.item}`, s._sum.qty ?? 0);
  }
  const g = (mo: string, dept: string, item: string) => done.get(`${mo}|${dept}|${item}`) ?? 0;
  // each MO's unallocated Odoo pools, gathered once instead of scanning every pool per order
  const poolsOf = new Map<string, OdooUnallocatedQuantity[]>();
  for (const pool of odooProgress.unallocated) for (const mo of pool.mos) {
    const list = poolsOf.get(mo);
    if (list) list.push(pool); else poolsOf.set(mo, [pool]);
  }

  return orders.map((o) => {
    const excluded = parseExcludedItems(o.excludedItems);
    const items = {} as MasterTrackerRow["items"];
    let welded = Infinity;
    let complete = Infinity;
    for (const it of ITEMS) {
      const cap = (v: number) => shownStageTotal(v, o.planQty);
      const osp = ospOf(o, it);
      const cut = cap(g(o.mo, "Cut", it));
      const weld = cap(g(o.mo, "Welding", it));
      const paint = cap(g(o.mo, "Painting", it));
      const shp = cap(g(o.mo, "ShotBlast", it)); // the core's real final stage after welding
      const delivered = cap(g(o.mo, "Delivered", it)); // what the customer received
      const eligible = itemEligible(it, o); // AR/MB when the KVA/rating rule matches, or the planner forced them on
      const isExcluded = excluded.has(it);
      items[it] = { cut, weld, paint, shp, delivered, osp, excluded: isExcluded, eligible, odooClosed: odooProgress.counts.get(o.mo)?.[it] ?? 0, odooTracked: exactMos.has(o.mo) || odooProgress.tracked.has(JSON.stringify([o.mo, it])) };
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
      odooExact: exactMos.has(o.mo),
      ...(mode === "all" ? { odooPlanMonth: odooPlanMonth(o), odooUnallocated: poolsOf.get(o.mo) ?? [] } : {}),
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

/** The whole sheet with Odoo's closings, computed once per request — the
 *  auto-close, the assistant, the trace and the what-if ETA base read it. */
export const getMasterTracker = cache(() => computeMasterTracker());

/** The Plan Tracker screen's rows: the same sheet with Odoo's closings of the
 *  exactly-counted orders only (the older ones read as not tracked). */
export const getTrackerSheet = cache(() => computeMasterTracker({ odoo: "exact" }));
