import "server-only";
import { prisma } from "@/lib/db";
import { ITEMS, isPaintExempt, type Item } from "@/lib/domain/constants";

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
  urgent: boolean;
  kva: string | null;
  required: number; // planQty
  items: Record<Item, { cut: number; weld: number; paint: number; delivered: number; osp: number; excluded: boolean }>;
  welded: number; // MIN (weld + osp) over the REQUIRED items
  complete: number; // MIN (paint + osp) over the REQUIRED items — drives Left + Achievement
  remaining: number;
  achievement: number | null;
  status: string; // open | closed
  priority: boolean; // ⭐ flagged by the admin — shows on every dept worklist
}

export async function getMasterTracker(): Promise<MasterTrackerRow[]> {
  const [orders, sums] = await Promise.all([
    prisma.masterOrder.findMany({ orderBy: [{ urgent: "desc" }, { mo: "asc" }] }),
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
    const ospOf: Record<Item, number> = { CF: o.ospCF, TC: o.ospTC, TN: o.ospTN, CB: o.ospCB };
    const excluded = new Set((o.excludedItems ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    const items = {} as MasterTrackerRow["items"];
    let welded = Infinity;
    let complete = Infinity;
    for (const it of ITEMS) {
      const cap = (v: number) => (o.planQty > 0 ? Math.min(v, o.planQty) : v);
      const osp = ospOf[it];
      const cut = cap(g(o.mo, "Cut", it));
      const weld = cap(g(o.mo, "Welding", it));
      const paint = cap(g(o.mo, "Painting", it));
      const delivered = cap(g(o.mo, "Delivered", it)); // what the customer received
      const isExcluded = excluded.has(it);
      items[it] = { cut, weld, paint, delivered, osp, excluded: isExcluded };
      if (isExcluded) continue; // this project doesn't need the component — it can't gate completion
      welded = Math.min(welded, cap(weld + osp));
      // final stage = Welding for the paint-exempt core (CF), Painting otherwise
      complete = Math.min(complete, cap((isPaintExempt(it) ? weld : paint) + osp));
    }
    if (!Number.isFinite(welded)) welded = 0;
    if (!Number.isFinite(complete)) complete = 0;
    return {
      mo: o.mo,
      bom: o.bom,
      soi: o.soi,
      urgent: o.urgent,
      kva: o.kva,
      required: o.planQty,
      items,
      welded,
      complete,
      remaining: Math.max(0, o.planQty - complete),
      achievement: o.planQty > 0 ? complete / o.planQty : null,
      status: o.status,
      priority: o.priority,
    };
  });
}
