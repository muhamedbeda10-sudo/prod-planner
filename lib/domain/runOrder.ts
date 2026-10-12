// The APPROVED run order — the sequence the admin committed from the
// Simulator — as one dept sees it: each line cut down to what this dept still
// owes on it. A line leaves the list once that work is done, or while its
// order is closed or ON HOLD; a released order's lines come back at their old
// rank. The committed sequence itself is never touched here.

import { applicableItems, ospOf, isPaintExempt, type Dept, type Item, type ItemRuleFields } from "./constants";
import { isOnHold } from "./hold";

/** A committed run-order row, as stored (RunOrderEntry). */
export interface RunOrderEntryLite {
  rank: number;
  mo: string;
  item: string;
  batchQty: number | null;
  batchNo: number | null;
  appliedAt: Date;
}

/** The registry fields a run-order line reads off its order. */
export interface RunOrderMasterLite extends ItemRuleFields {
  mo: string;
  bom: string;
  status: string;
  holdAt: Date | string | null;
  planQty: number;
  ospCF: number;
  ospTC: number;
  ospTN: number;
  ospCB: number;
}

/** One line of the APPROVED run order, as one dept sees it. */
export interface RunOrderLineDTO {
  rank: number; // global position in the approved sequence
  bom: string;
  mo: string;
  description: string;
  item: string;
  remaining: number; // what THIS dept still owes on the line
  batchQty: number | null; // a rushed split: only this many go first
  batchNo: number | null;
  appliedAtISO: string;
}

export function computeRunOrderLines(opts: {
  dept: Dept;
  entries: readonly RunOrderEntryLite[]; // the committed sequence, in rank order
  orders: readonly RunOrderMasterLite[]; // a MO missing here drops its lines
  done: ReadonlyMap<string, number>; // this dept's output, mo|item -> qty
}): RunOrderLineDTO[] {
  const { dept, entries, orders, done } = opts;
  const byMo = new Map(orders.map((o) => [o.mo, o]));

  const out: RunOrderLineDTO[] = [];
  for (const e of entries) {
    const o = byMo.get(e.mo);
    if (!o || o.status !== "open" || isOnHold(o)) continue; // closed and held orders leave the daily screens
    const item = e.item as Item;
    if (!applicableItems(o).includes(item)) continue;
    if (dept === "Painting" && isPaintExempt(item)) continue; // the core is never painted
    const need = Math.max(0, o.planQty - ospOf(o, item));
    const d = done.get(`${e.mo}|${item}`) ?? 0;
    const remaining = Math.max(0, need - d);
    if (remaining <= 0) continue; // this dept's work on the line is finished
    out.push({
      rank: e.rank,
      bom: o.bom,
      mo: e.mo,
      description: [o.kva, o.rating].filter(Boolean).join(" · "),
      item: e.item,
      remaining,
      batchQty: e.batchQty,
      batchNo: e.batchNo,
      appliedAtISO: e.appliedAt.toISOString(),
    });
  }
  return out;
}
