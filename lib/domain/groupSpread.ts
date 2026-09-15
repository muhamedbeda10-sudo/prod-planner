// Recording a quantity on a MERGED BOM row — one row standing for several MOs.
//
// The planner types ONE number for the whole BOM and expects the app to close
// the orders under it the way he would by hand: fill the first MO until it is
// full, then start the second, then the third. Not spread evenly, not
// proportionally — one order finished before the next is touched, so an order
// either ships or is visibly the one still open.
//
// A correction runs the other way: it comes off the LAST MOs first, so undoing
// a quantity undoes the most recent filling rather than re-opening an order
// that was already closed.
//
// This is the rule on its own, away from the permission checks, the ledger
// writes and the tank minting it used to be buried in — it is the part with
// the behaviour worth pinning.

/** One member of the group, in the order it is shown on screen. */
export interface GroupMember {
  mo: string;
  /** Pieces this MO can still ACCEPT at this stage — its chain headroom
   *  (painted ≤ welded ≤ cut ≤ order qty, less OSP). Infinity when no
   *  quantity bounds it. */
  capAdd: number;
  /** Pieces that can be taken BACK off this MO without contradicting the
   *  stage after it. */
  capSub: number;
}

export interface GroupSpread {
  /** MO → signed pieces, in fill order. Only the MOs that take part appear. */
  alloc: { mo: string; qty: number }[];
  /** Pieces that found no room. 0 when the whole quantity fits. */
  left: number;
  /** How many of the requested pieces did fit — what the error message says. */
  fits: number;
}

/**
 * Spread `delta` over the group.
 *
 * Positive fills top-down, each MO to its own cap before the next is touched.
 * Negative comes off the last MOs first. An MO with no room is stepped over
 * rather than partly filled — the next one takes what it could not.
 *
 * Nothing is clamped: when the quantity does not fit, `left` says by how much
 * and the caller refuses the whole thing. A group must never half-save.
 */
export function spreadOverGroup(members: readonly GroupMember[], delta: number): GroupSpread {
  const alloc: { mo: string; qty: number }[] = [];
  let left = Math.abs(delta);
  if (delta === 0) return { alloc, left: 0, fits: 0 };

  const order = delta > 0 ? members : [...members].reverse();
  for (const m of order) {
    if (left === 0) break;
    const cap = Math.max(0, delta > 0 ? m.capAdd : m.capSub);
    const take = Math.min(left, cap);
    if (take > 0) {
      alloc.push({ mo: m.mo, qty: delta > 0 ? take : -take });
      left -= take;
    }
  }
  return { alloc, left, fits: Math.abs(delta) - left };
}

/** "35301-001 +29 · 35302-001 +5" — what the spread will do, for the planner
 *  to read BEFORE he saves it. Every MO in the group shares the same prefix
 *  (PF01/MO/…), so the segment after the last slash is the part that tells
 *  them apart, and the only part worth the width. */
export function spreadWords(spread: GroupSpread): string {
  return spread.alloc
    .map((a) => `${a.mo.split("/").pop()} ${a.qty > 0 ? "+" : "−"}${Math.abs(a.qty)}`)
    .join(" · ");
}

// ---- closing the orders that are finished ----

/** What "this order is done" means, per component, for one MO. */
export interface DeliveryLine {
  /** The order needs this component at all (rule + the planner's own N/A). */
  counts: boolean;
  /** Pieces the customer has received. */
  delivered: number;
}

/**
 * An order is FINISHED when every component it needs has reached the customer
 * in full — not merely painted, not merely welded. Delivery is the last word,
 * so an order that clears this can be closed without looking at anything else.
 *
 * An order with no quantity, or with no component that counts, is never
 * "finished" — there is nothing to have delivered, and closing it silently
 * would hide a row that needs a human's eye instead.
 */
export function isFullyDelivered(required: number, lines: readonly DeliveryLine[]): boolean {
  if (!(required > 0)) return false;
  const needed = lines.filter((l) => l.counts);
  if (needed.length === 0) return false;
  return needed.every((l) => l.delivered >= required);
}

// ---- how much room one MO has at one stage ----

/** One MO's ledger position for one component, as both the tracker and the
 *  recording action already hold it. */
export interface ChainState {
  required: number;
  cut: number;
  weld: number;
  paint: number;
  shp: number;
  delivered: number;
  osp: number;
  /** The order needs this component (rule + the planner's own N/A). */
  eligible: boolean;
  /** CF is shot blasted, not painted — its finishing stage is SHB. */
  paintExempt: boolean;
}

/**
 * The chain guard as a pair of numbers: how many pieces this MO can still take
 * at `dept`, and how many can be taken back off it.
 *
 * Painted ≤ welded ≤ cut ≤ order quantity, the core's shot blast ≤ welded, and
 * delivered ≤ finished. Cutting also respects OSP — outsourced pieces are
 * never made in-house. An order with no quantity has no ceiling to cut
 * against, which is why `add` can be Infinity there.
 *
 * It lives here so the tracker's preview and the action that actually writes
 * are the same rule rather than two readings of it.
 */
export function capsFor(m: ChainState, dept: string): { add: number; sub: number } {
  const finished = m.paintExempt ? m.shp : m.paint;
  const add = !m.eligible ? 0
    : dept === "Cut" ? (m.required > 0 ? Math.max(0, m.required - m.osp - m.cut) : Number.POSITIVE_INFINITY)
    : dept === "Welding" ? Math.max(0, m.cut - m.weld)
    : dept === "Painting" ? Math.max(0, m.weld - m.paint)
    : dept === "ShotBlast" ? Math.max(0, m.weld - m.shp)
    : Math.max(0, finished - m.delivered);
  const sub = dept === "Cut" ? Math.max(0, m.cut - m.weld)
    : dept === "Welding" ? Math.max(0, m.weld - Math.max(m.paint, m.paintExempt ? m.shp : 0))
    : dept === "Painting" ? Math.max(0, m.paint - m.delivered)
    : dept === "ShotBlast" ? Math.max(0, m.shp - m.delivered)
    : m.delivered;
  return { add, sub };
}

// ---- the spec columns on a merged BOM row ----

/**
 * What a group of MOs says about one spec column: the value when they agree,
 * `""` when none of them carries it, and `null` when they disagree.
 *
 * Setting a spec on the group row writes the SAME value to every MO under it,
 * so the three readings are what the row has to tell apart before that: a
 * value to show, an empty cell to fill, or a genuine disagreement the planner
 * is about to overwrite.
 */
export function agreedSpec(values: readonly (string | null | undefined)[]): string | null {
  const seen = [...new Set(values.map((v) => v?.trim() ?? "").filter((v) => v !== ""))];
  return seen.length === 0 ? "" : seen.length === 1 ? seen[0] : null;
}


// ---- FINS on a merged row ----

/** One member of a merged BOM, as the Fins column sees it. */
export interface FinsRow {
  mo: string;
  /** The order quantity — the most tanks this MO could ever have finned. */
  required: number;
  /** The Fins column as it stands. Free text, so it may be anything. */
  fins: string | null;
}

/**
 * Fins is not a spec, it is a COUNT: how many of the order's tanks carry fins.
 * The registry writes it at or below the order quantity on every BOM that has
 * it (39 tanks, 28 finned; 36 tanks, 32 finned), so a merged row spreads a
 * typed total exactly as it spreads a stage quantity — each MO filled to its
 * own quantity before the next is touched, a correction off the last MOs
 * first.
 *
 * Null when any MO's Fins is written as text rather than a number: there is no
 * arithmetic to do then, and guessing would overwrite what the planner wrote.
 * Those groups stay per-MO.
 */
export function finsGroup(rows: readonly FinsRow[]): { members: GroupMember[]; current: number } | null {
  const members: GroupMember[] = [];
  let current = 0;
  for (const r of rows) {
    const raw = (r.fins ?? "").trim();
    const n = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    current += n;
    members.push({ mo: r.mo, capAdd: Math.max(0, r.required - n), capSub: n });
  }
  return { members, current };
}
