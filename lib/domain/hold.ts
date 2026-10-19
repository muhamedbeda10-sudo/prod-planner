// An order ON HOLD: the planner paused it. It keeps its place on the tracker
// — tinted, with the reason — and leaves every worklist queue and the ETA
// until it is released. Nothing about its logs changes; a hold is a state,
// like closed, not a record.

import { factoryDayISO } from "./dates";

export interface HoldFields {
  holdAt: Date | string | null;
  holdNote: string | null;
  holdBy: string | null;
}

/** What the tracker rows and worklists carry about a hold. */
export interface HoldView {
  onHold: boolean;
  holdNote: string | null;
  /** ISO day the hold was put on, or null. */
  holdSinceISO: string | null;
  holdBy: string | null;
}

export function isOnHold(o: { holdAt: Date | string | null }): boolean {
  return o.holdAt !== null && o.holdAt !== undefined;
}

export function holdView(o: HoldFields): HoldView {
  const at = o.holdAt ? new Date(o.holdAt) : null;
  return {
    onHold: at !== null,
    holdNote: at ? o.holdNote?.trim() || null : null,
    holdSinceISO: at ? factoryDayISO(at) : null,
    holdBy: at ? o.holdBy : null,
  };
}

/** One line for a tooltip or a strip: the reason, who, since when. */
export function holdLabel(h: HoldView): string {
  if (!h.onHold) return "";
  const parts = [h.holdNote ? `On hold — ${h.holdNote}` : "On hold"];
  const who = [h.holdBy, h.holdSinceISO ? `since ${h.holdSinceISO}` : ""].filter(Boolean).join(", ");
  if (who) parts.push(`(${who})`);
  return parts.join(" ");
}

/** A held order as a worklist lists it: out of the queue, named once so
 *  nobody wonders where it went. */
export interface HeldOrderDTO {
  mo: string;
  bom: string;
  description: string;
  hold: HoldView;
}

/** The open orders on hold, by MO — the strip a worklist names them in. */
export function heldOrders(orders: readonly (HoldFields & { mo: string; bom: string; status: string; kva?: string | null; rating?: string | null })[]): HeldOrderDTO[] {
  return orders
    .filter((o) => o.status === "open" && isOnHold(o))
    .sort((a, b) => a.mo.localeCompare(b.mo))
    .map((o) => ({ mo: o.mo, bom: o.bom, description: [o.kva, o.rating].filter(Boolean).join(" · "), hold: holdView(o) }));
}
