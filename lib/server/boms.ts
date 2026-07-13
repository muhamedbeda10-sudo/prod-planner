import "server-only";
import { prisma } from "@/lib/db";
import { buildBomClassifier, type BomStatus } from "@/lib/domain/normalizeBoms";
import { computeReallocations } from "@/lib/domain/reallocate";
import { getGrouperForPlan } from "./data";
import { getKnownBoms } from "./handover";

export interface BomReviewRow {
  bom: string;
  count: number;
  status: BomStatus;
  corrected?: string;
  candidates: string[];
  message: string;
}

/** Classify every distinct handover BOM against the known Plan Orders codes. */
export async function getBomReview(): Promise<BomReviewRow[]> {
  const [known, grouped] = await Promise.all([
    getKnownBoms(),
    prisma.handoverEntry.groupBy({ by: ["bom"], _count: { bom: true } }),
  ]);
  const classify = buildBomClassifier(known);
  return grouped
    .map((g) => {
      const c = classify(g.bom);
      return {
        bom: g.bom,
        count: g._count.bom,
        status: c.status,
        corrected: c.corrected,
        candidates: c.candidates,
        message: c.message,
      };
    })
    .sort((a, b) => {
      const rank = (s: BomStatus) => (s === "unknown" ? 0 : s === "ambiguous" ? 1 : s === "corrected" ? 2 : 3);
      return rank(a.status) - rank(b.status) || a.bom.localeCompare(b.bom);
    });
}

export interface ReallocProposalView {
  dept: string;
  item: string;
  fromBom: string;
  toBom: string;
  qty: number;
}

/** Freshly compute reallocation proposals for a plan (does not persist). */
export async function computePlanReallocations(planNo: number): Promise<ReallocProposalView[]> {
  const [orders, handover, grouper] = await Promise.all([
    prisma.planOrder.findMany({ where: { planNo } }),
    prisma.handoverEntry.findMany({ where: { planNo } }),
    getGrouperForPlan(planNo),
  ]);
  const raw = computeReallocations(
    orders.map((o) => ({ bom: o.bom, item: o.item, targetQty: o.targetQty })),
    handover.map((h) => ({ id: h.id, date: h.date, dept: h.dept, bom: h.bom, item: h.item, qty: h.qty })),
    grouper
  );
  // aggregate per dept|item|from|to
  const agg = new Map<string, ReallocProposalView>();
  for (const m of raw) {
    const k = `${m.dept}|${m.item}|${m.fromBom}|${m.toBom}`;
    const cur = agg.get(k);
    if (cur) cur.qty += m.qty;
    else agg.set(k, { dept: m.dept, item: m.item, fromBom: m.fromBom, toBom: m.toBom, qty: m.qty });
  }
  return [...agg.values()];
}

export async function getReallocationMoves(planNo: number) {
  return prisma.reallocationMove.findMany({ where: { planNo }, orderBy: [{ status: "asc" }, { id: "asc" }] });
}
