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
/** The panel types the plan sheet names — the ODOO tab's Product column on
 *  this line, where the transformers' Tank / Top Cover / Core Frame mean
 *  nothing. Free text is still accepted, so a new type needs no code change. */
export const LV_PRODUCTS = ["USS", "LSS"] as const;

/** The plans the LV line imports, each from its own sheet: the panels' plan
 *  (the line's main one, "") and the meter boxes' plan ("MB"). They share the
 *  tracker, the stages and the ledger; a plan's import only revises — and
 *  takes off the month — the orders of its own plan. */
export const LV_FAMILIES = ["", "MB"] as const;
export type LvFamily = (typeof LV_FAMILIES)[number];
export const LV_FAMILY_LABEL: Record<LvFamily, string> = { "": "LV panels", MB: "Meter boxes" };
export function isLvFamily(x: string): x is LvFamily {
  return (LV_FAMILIES as readonly string[]).includes(x);
}

export const LV_STAGES = ["Punching", "Bending", "Welding", "Painting"] as const;
export type LvStage = (typeof LV_STAGES)[number];

/** The panel stage a bay of the shared floor works — the fabrication bay's
 *  punches punch, the welding and painting bays weld and paint; shot blast
 *  takes no panels, and bending is one centre the floor never draws. */
export function lvStageAt(bay: string): LvStage | null {
  if (bay === "Cut") return "Punching";
  return bay === "Welding" || bay === "Painting" ? bay : null;
}

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
/** A stage's done-word, for the sentences the guards write. */
export const LV_STAGE_DONE: Record<LvChainStage, string> = {
  Punching: "punched",
  Bending: "bent",
  Welding: "welded",
  Painting: "painted",
  Delivered: "delivered",
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
      return "lv.tracker.punch";
    case "Bending":
      return "lv.tracker.bend";
    case "Welding":
      return "lv.tracker.weld";
    case "Painting":
      return "lv.tracker.paint";
    case "Delivered":
      return "lv.tracker.delivered";
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
  const done = LV_STAGE_DONE[stage];
  if (delta > 0 && delta > caps.add) {
    const i = LV_CHAIN.indexOf(stage);
    const before = i === 0 ? `the order is for ${s.required}` : `only ${upstream(s, stage)} ${LV_STAGE_DONE[LV_CHAIN[i - 1]]}`;
    return `Chain check: ${label} would have ${lvStageOf(s, stage) + delta} ${done} but ${before} — max extra now: ${caps.add}.`;
  }
  if (delta < 0 && -delta > caps.sub) {
    const i = LV_CHAIN.indexOf(stage);
    const after = i === LV_CHAIN.length - 1 ? 0 : downstream(s, stage);
    return `Chain check: ${label} cannot drop below ${after} ${done} — ${after} already went on to ${LV_CHAIN[Math.min(i + 1, LV_CHAIN.length - 1)].toLowerCase()}. Undo the later stage first.`;
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

/** Which department permission records a panel stage from its worklist —
 *  punching and bending are fabrication's, the rest their namesakes'. */
export function lvDeptPermKey(stage: LvStage): string {
  return `lv.${stage.toLowerCase()}`;
}

/** The LV worklists, one per stage, in shop-floor order — what the nav's
 *  Worklist tab unrolls into when the panels are on screen. */
export const LV_WORKLISTS: readonly { stage: LvStage; href: string; label: string }[] = [
  { stage: "Punching", href: "/worklist/punching", label: "Punching" },
  { stage: "Bending", href: "/worklist/bending", label: "Bending" },
  { stage: "Welding", href: "/worklist/welding", label: "Welding" },
  { stage: "Painting", href: "/worklist/painting", label: "Painting" },
];

/** What a stage's worklist has to do on one order: the panels the stage
 *  before it finished that this one has not — the order quantity for
 *  punching — less what is already done here. */
export function lvWaiting(s: LvState, stage: LvStage): number {
  const c = lvCaps(s, stage);
  return Number.isFinite(c.add) ? c.add : 0;
}

/**
 * The first link of the chain a state breaks, or null when it holds:
 *
 *   delivered ≤ painted ≤ welded ≤ bent ≤ punched ≤ order qty
 *
 * `lvChainError` judges one change at one stage; this judges the state as
 * a whole, which is what an EDIT or a DELETE of a log row needs — lowering
 * a punching row can leave the bending after it hanging, and only the whole
 * chain says so.
 */
export function lvChainViolation(s: LvState, label: string): string | null {
  const word = (st: LvChainStage) => LV_STAGE_DONE[st];
  for (let i = LV_CHAIN.length - 1; i > 0; i--) {
    const here = lvStageOf(s, LV_CHAIN[i]);
    const up = lvStageOf(s, LV_CHAIN[i - 1]);
    if (here > up) return `Chain check: ${label} would have ${here} ${word(LV_CHAIN[i])} but only ${up} ${word(LV_CHAIN[i - 1])} — ${word(LV_CHAIN[i])} must stay ≤ ${word(LV_CHAIN[i - 1])}.`;
  }
  if (s.required > 0 && s.punch > s.required) return `Chain check: order ${label} is for ${s.required} panels — punched would reach ${s.punch}.`;
  return null;
}
