import "server-only";
import type { MasterOrder } from "@prisma/client";
import { prisma } from "@/lib/db";
import { DELIVERED_STAGE, SHOTBLAST_STAGE, applicableItems, isPaintExempt, ospOf, type Item } from "@/lib/domain/constants";
import { capsFor, spreadOverGroup } from "@/lib/domain/groupSpread";

// Recording on a BOM group row: the member orders in the order given, their
// totals per stage for one component, and how a change spreads over them.
// ONE place for it, shared by the action that writes it (recordGroupOutput in
// app/worklist/actions.ts) and the assistant's preview of the same record —
// so what the approval card says is what the action does.

export interface GroupMember {
  mo: string;
  /** Not in the registry: still recordable, as the worklists always allowed. */
  o: MasterOrder | undefined;
  /** The order needs this component (AR/MB only by rule or the planner's tick). */
  eligible: boolean;
  cut: number;
  weld: number;
  paint: number;
  shp: number;
  delivered: number;
}

/** The members in the given order, or null when one of them is on another BOM. */
export async function loadGroupMembers(bom: string, item: string, mos: readonly string[]): Promise<GroupMember[] | null> {
  const [orders, sums] = await Promise.all([
    prisma.masterOrder.findMany({ where: { mo: { in: [...mos] } } }),
    prisma.handoverEntry.groupBy({ by: ["mo", "dept"], where: { mo: { in: [...mos] }, item }, _sum: { qty: true } }),
  ]);
  const orderOf = new Map(orders.map((o) => [o.mo, o]));
  const sumOf = (mo: string, d: string) => sums.find((s) => s.mo === mo && s.dept === d)?._sum.qty ?? 0;
  const members: GroupMember[] = [];
  for (const mo of mos) {
    const o = orderOf.get(mo);
    if (o && o.bom !== bom) return null;
    // AR/MB the order doesn't need (rule or manual N/A) can't receive output
    const eligible = o ? applicableItems(o).includes(item as Item) : !["AR", "MB"].includes(item);
    members.push({
      mo,
      o,
      eligible,
      cut: sumOf(mo, "Cut"),
      weld: sumOf(mo, "Welding"),
      paint: sumOf(mo, "Painting"),
      shp: sumOf(mo, SHOTBLAST_STAGE),
      delivered: sumOf(mo, DELIVERED_STAGE),
    });
  }
  return members;
}

/** The group's total at one stage. */
export function groupTotal(members: readonly GroupMember[], dept: string): number {
  return members.reduce((s, m) => {
    switch (dept) {
      case "Cut": return s + m.cut;
      case "Welding": return s + m.weld;
      case "Painting": return s + m.paint;
      case SHOTBLAST_STAGE: return s + m.shp;
      default: return s + m.delivered;
    }
  }, 0);
}

/** How a change of `delta` pieces lands on the members: each takes up to its
 *  own chain headroom in the order given, a reduction comes off the last
 *  ones first — the tracker's own rule (lib/domain/groupSpread). */
export function spreadGroupChange(members: readonly GroupMember[], dept: string, item: string, delta: number): ReturnType<typeof spreadOverGroup> {
  const caps = (m: GroupMember) => capsFor({
    required: m.o?.planQty ?? 0,
    cut: m.cut, weld: m.weld, paint: m.paint, shp: m.shp, delivered: m.delivered,
    osp: ospOf(m.o ?? {}, item as Item),
    eligible: m.eligible,
    paintExempt: isPaintExempt(item),
  }, dept);
  return spreadOverGroup(
    members.map((m) => { const c = caps(m); return { mo: m.mo, capAdd: c.add, capSub: c.sub }; }),
    delta,
  );
}
