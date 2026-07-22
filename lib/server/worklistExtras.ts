import "server-only";
import { prisma } from "@/lib/db";
import { applicableItems, ospOf, isPaintExempt, type Dept, type Item } from "@/lib/domain/constants";

/** A tracker-pushed line as shown on a dept worklist (qty clamped to the
 *  order's live remainder — recorded output shrinks it automatically). */
export interface PushedLineDTO {
  bom: string;
  mo: string;
  description: string;
  item: string;
  qty: number; // min(pushed qty, order remainder for this dept)
  done: number; // dept output on the whole order
  orderQty: number; // in-house qty (planQty − OSP)
}

/** A line the admin removed from this dept's worklist (restorable). */
export interface HiddenLineDTO {
  dept: string;
  bom: string;
  mo: string;
  item: string;
}

/** One open priority-order line for a dept: what this dept still owes on it. */
export interface PriorityLineDTO {
  bom: string;
  mo: string;
  description: string;
  item: string;
  need: number; // in-house qty (planQty − OSP)
  done: number; // dept output
  remaining: number; // need − done (> 0, or the row is not listed)
}

export interface WorklistExtras {
  pushed: PushedLineDTO[];
  hidden: HiddenLineDTO[];
  priority: PriorityLineDTO[];
}

/** The admin layers of a dept's worklist: tracker pushes, hidden lines and
 *  the priority-orders table. Hidden keys also filter the other two. */
export async function getWorklistExtras(dept: Dept): Promise<WorklistExtras> {
  const [pushes, hides, sums] = await Promise.all([
    prisma.worklistPush.findMany({ where: { dept }, orderBy: { id: "asc" } }),
    prisma.worklistLineHide.findMany({ where: { dept }, orderBy: { id: "asc" } }),
    prisma.handoverEntry.groupBy({
      by: ["mo", "item"],
      where: { dept, mo: { not: null } },
      _sum: { qty: true },
    }),
  ]);
  const pushMos = [...new Set(pushes.map((p) => p.mo))];
  const [pushOrders, priorityOrders] = await Promise.all([
    pushMos.length > 0 ? prisma.masterOrder.findMany({ where: { mo: { in: pushMos } } }) : Promise.resolve([]),
    prisma.masterOrder.findMany({ where: { priority: true, status: "open" }, orderBy: { mo: "asc" } }),
  ]);

  const done = new Map<string, number>(); // mo|item -> dept output
  for (const s of sums) if (s.mo) done.set(`${s.mo}|${s.item}`, s._sum.qty ?? 0);
  const hiddenKeys = new Set(hides.map((h) => `${h.bom}|${h.mo}|${h.item}`));
  const descOf = (o: { kva: string | null; rating: string | null }) =>
    [o.kva, o.rating].filter(Boolean).join(" · ");

  const byMo = new Map(pushOrders.map((o) => [o.mo, o]));
  const pushed: PushedLineDTO[] = [];
  for (const p of pushes) {
    const o = byMo.get(p.mo);
    if (!o || o.status !== "open") continue; // closed orders leave the daily screens
    if (hiddenKeys.has(`${p.bom}|${p.mo}|${p.item}`)) continue;
    const inhouse = Math.max(0, o.planQty - ospOf(o, p.item as Item));
    const d = done.get(`${p.mo}|${p.item}`) ?? 0;
    // output recorded SINCE the push (from any screen — tracker cells included)
    // consumes the pushed quantity automatically
    const open = p.qty - Math.max(0, d - p.baseDone);
    const qty = Math.min(open, Math.max(0, inhouse - d));
    if (qty <= 0) continue; // the pushed work is finished — the line retires itself
    pushed.push({ bom: p.bom, mo: p.mo, description: descOf(o), item: p.item, qty, done: d, orderQty: inhouse });
  }

  const priority: PriorityLineDTO[] = [];
  for (const o of priorityOrders) {
    for (const item of applicableItems(o)) {
      if (dept === "Painting" && isPaintExempt(item)) continue; // the core is never painted
      if (hiddenKeys.has(`${o.bom}|${o.mo}|${item}`)) continue;
      const need = Math.max(0, o.planQty - ospOf(o, item));
      const d = done.get(`${o.mo}|${item}`) ?? 0;
      const remaining = Math.max(0, need - d);
      if (remaining <= 0) continue;
      priority.push({ bom: o.bom, mo: o.mo, description: descOf(o), item, need, done: d, remaining });
    }
  }

  return {
    pushed,
    hidden: hides.map((h) => ({ dept: h.dept, bom: h.bom, mo: h.mo, item: h.item })),
    priority,
  };
}
