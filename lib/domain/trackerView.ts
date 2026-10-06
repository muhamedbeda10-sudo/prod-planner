import { ITEMS, isPaintExempt, type Item } from "@/lib/domain/constants";

// How the Plan Tracker reads a row at a glance. Display only: the figures are
// the tracker's own; this only says which cell to draw the eye to.

export type MakeStage = "Cut" | "Welding" | "Finish";

export interface ItemProgress {
  eligible: boolean;
  excluded: boolean;
  osp: number;
  cut: number;
  weld: number;
  paint: number;
  shp: number;
}

/**
 * The row's bottleneck: of the components the order still owes, the one
 * furthest from finished (lowest share through its last making stage —
 * painting, or shot blast for the core), at the first stage it has not
 * cleared. Ties go to the earlier stage, then to the tracker's item order.
 * Null when every needed component is made (delivery is the customer's pace,
 * not a bottleneck of the shop), and when nothing has started at all — an
 * order not begun is waiting as a whole, not held back by one cell.
 */
export function rowBottleneck(required: number, items: Record<Item, ItemProgress>): { item: Item; stage: MakeStage } | null {
  let best: { item: Item; stage: MakeStage; share: number; stageIdx: number } | null = null;
  for (const it of ITEMS) {
    const c = items[it];
    if (!c || !c.eligible || c.excluded) continue;
    const target = Math.max(0, required - c.osp);
    if (target <= 0) continue;
    const finish = isPaintExempt(it) ? c.shp : c.paint;
    const stages: [MakeStage, number][] = [["Cut", c.cut], ["Welding", c.weld], ["Finish", finish]];
    const stageIdx = stages.findIndex(([, v]) => v < target);
    if (stageIdx < 0) continue;
    const share = Math.min(1, finish / target);
    if (!best || share < best.share || (share === best.share && stageIdx < best.stageIdx)) {
      best = { item: it, stage: stages[stageIdx][0], share, stageIdx };
    }
  }
  if (!best) return null;
  const started = ITEMS.some((it) => {
    const c = items[it];
    return !!c && c.eligible && !c.excluded && (c.cut > 0 || c.weld > 0 || c.paint > 0 || c.shp > 0);
  });
  return started ? { item: best.item, stage: best.stage } : null;
}

/** A component's progress through its last making stage, 0–1; null when the
 *  order does not need it (or needs none of it). */
export function itemFinishShare(required: number, it: Item, c: ItemProgress): number | null {
  if (!c.eligible || c.excluded) return null;
  const target = Math.max(0, required - c.osp);
  if (target <= 0) return null;
  return Math.min(1, (isPaintExempt(it) ? c.shp : c.paint) / target);
}
