// An LV panel on the floor.
//
// A transformer is six components, each cut, welded and painted on its own,
// so its tracker is a grid. A panel is ONE thing that passes four stages in
// order — punched, bent, welded, painted — and is then delivered, so its
// tracker is a row of five cells and one chain rule:
//
//   delivered ≤ painted ≤ welded ≤ bent ≤ punched ≤ order qty
//
// The stages are recorded in the same ledger as the transformers', under
// their own department names and one item code for "the panel", so the
// daily log, its corrections and its audit trail need nothing new.

import type { GroupMember } from "./groupSpread";

/** The ledger's item code for a whole panel — the panel is its own component. */
export const LV_ITEM = "PNL";

/** The four production stages, in the order a panel passes them. */
export const LV_STAGES = ["Punching", "Bending", "Welding", "Painting"] as const;
export type LvStage = (typeof LV_STAGES)[number];

export const LV_DELIVERED = "Delivered";
/** The whole chain a cell can sit on: the stages, then delivery. */
export const LV_CHAIN = [...LV_STAGES, LV_DELIVERED] as const;
export type LvChainStage = (typeof LV_CHAIN)[number];

export function isLvChainStage(x: string): x is LvChainStage {
  return (LV_CHAIN as readonly string[]).includes(x);
}

export const LV_STAGE_LABEL: Record<LvChainStage, string> = {
  Punching: "Punching",
  Bending: "Bending",
  Welding: "Welding",
  Painting: "Painting",
  Delivered: "Delivered",
};
/** Column heads — short, the way the transformer tracker writes its own. */
export const LV_STAGE_SHORT: Record<LvChainStage, string> = {
  Punching: "Punch",
  Bending: "Bend",
  Welding: "Weld",
  Painting: "Paint",
  Delivered: "Dlvd",
};

/** Which tracker permission records a panel stage. Punching and bending are
 *  the panel's fabrication, so they sit behind the Fab column's key; the
 *  rest map to their namesakes. */
export function lvPermKey(stage: LvChainStage): string {
  switch (stage) {
    case "Punching":
    case "Bending":
      return "tracker.cut";
    case "Welding":
      return "tracker.weld";
    case "Painting":
      return "tracker.paint";
    case "Delivered":
      return "tracker.delivered";
  }
}

/** One panel order's position on the chain, all-time totals per stage. */
export interface LvState {
  required: number;
  punch: number;
  bend: number;
  weld: number;
  paint: number;
  delivered: number;
}

const FIELD: Record<LvChainStage, keyof LvState> = {
  Punching: "punch",
  Bending: "bend",
  Welding: "weld",
  Painting: "paint",
  Delivered: "delivered",
};

export function lvStageOf(s: LvState, stage: LvChainStage): number {
  return s[FIELD[stage]];
}

/** The stage before this one on the chain — the order quantity for punching. */
function upstream(s: LvState, stage: LvChainStage): number {
  const i = LV_CHAIN.indexOf(stage);
  return i === 0 ? (s.required > 0 ? s.required : Number.POSITIVE_INFINITY) : lvStageOf(s, LV_CHAIN[i - 1]);
}
/** The stage after this one — nothing after delivery. */
function downstream(s: LvState, stage: LvChainStage): number {
  const i = LV_CHAIN.indexOf(stage);
  return i === LV_CHAIN.length - 1 ? 0 : lvStageOf(s, LV_CHAIN[i + 1]);
}

/**
 * The chain guard as a pair of numbers: how many more panels this order can
 * take at `stage`, and how many can be taken back off it. A stage can only
 * reach what the stage before it reached, and can only drop to what the
 * stage after it already consumed. Punching is bounded by the order quantity
 * — unbounded while the order has none.
 */
export function lvCaps(s: LvState, stage: LvChainStage): { add: number; sub: number } {
  const here = lvStageOf(s, stage);
  const up = upstream(s, stage);
  return {
    add: Number.isFinite(up) ? Math.max(0, up - here) : Number.POSITIVE_INFINITY,
    sub: Math.max(0, here - downstream(s, stage)),
  };
}

/** Why a change of `delta` at `stage` cannot be made, or null when it can —
 *  the sentence the cell shows. */
export function lvChainError(s: LvState, stage: LvChainStage, delta: number, label: string): string | null {
  if (delta === 0) return null;
  const caps = lvCaps(s, stage);
  const short = LV_STAGE_SHORT[stage].toLowerCase();
  if (delta > 0 && delta > caps.add) {
    const i = LV_CHAIN.indexOf(stage);
    const before = i === 0 ? `the order is for ${s.required}` : `only ${upstream(s, stage)} ${LV_STAGE_SHORT[LV_CHAIN[i - 1]].toLowerCase()}ed`;
    return `Chain check: ${label} would have ${lvStageOf(s, stage) + delta} ${short}ed but ${before} — max extra now: ${caps.add}.`;
  }
  if (delta < 0 && -delta > caps.sub) {
    const i = LV_CHAIN.indexOf(stage);
    const after = i === LV_CHAIN.length - 1 ? 0 : downstream(s, stage);
    return `Chain check: ${label} cannot drop below ${after} ${short}ed — ${after} already went on to ${LV_STAGE_SHORT[LV_CHAIN[Math.min(i + 1, LV_CHAIN.length - 1)]].toLowerCase()}. Undo the later stage first.`;
  }
  return null;
}

/** The members of a merged BOM row as the group spread needs them: each
 *  MO's room at `stage`, in the order shown. */
export function lvGroupMembers(rows: readonly { mo: string; state: LvState }[], stage: LvChainStage): GroupMember[] {
  return rows.map((r) => {
    const c = lvCaps(r.state, stage);
    return { mo: r.mo, capAdd: c.add, capSub: c.sub };
  });
}

/** A panel order is finished when every panel has been delivered. */
export function lvComplete(s: LvState): number {
  return s.required > 0 ? Math.min(s.paint, s.required) : s.paint;
}
