// Plan Tracker — pure port of modTracker.ShowPlan.
//
// One row per RAW bom (all MOs of that bom merged; BomGroup is NOT used here).
//   Required   = sum of requiredQty deduped per (bom, mo)
//   target(it) = sum of targetQty for the item, capped at Required
//   pre(it)    = Required - target   (completed in previous weeks)
//   CutDone    = min(pre + logged Cut,      Required)
//   WeldDone   = min(pre + logged Welding,  Required)
//   PaintDone  = min(pre + logged Painting, Required)
//   Complete   = MIN(PaintDone across the 4 items) — counts once it left Painting
//   Remaining  = Required - Complete
//   Achievement = Complete / Required

import { ITEMS, type Item } from "./constants";

export interface TrackerOrderRow {
  bom: string;
  mo: string;
  description?: string | null;
  item: string;
  requiredQty: number;
  targetQty: number;
}

export interface TrackerLogRow {
  dept: string; // Cut | Welding
  bom: string;
  item: string;
  qty: number;
}

export interface TrackerItemCell {
  cutDone: number;
  weldDone: number;
  paintDone: number;
}

export interface TrackerRow {
  bom: string;
  moLabel: string;
  moCount: number;
  kva: string;
  required: number;
  items: Record<Item, TrackerItemCell>;
  complete: number;
  remaining: number;
  achievement: number | null; // fraction 0..1, or null when required = 0
}

export function computeTracker(
  orders: TrackerOrderRow[],
  logs: TrackerLogRow[]
): TrackerRow[] {
  // ---- aggregate Plan Orders per RAW bom ----
  const order = new Map<
    string,
    {
      bom: string;
      kva: string;
      required: number;
      target: Record<Item, number>;
      targetSeen: Set<Item>;
      mos: string[];
      moSet: Set<string>;
    }
  >();
  const moSeen = new Set<string>(); // bom|mo -> required counted once

  for (const o of orders) {
    const bom = (o.bom ?? "").trim();
    if (!bom) continue;
    let rec = order.get(bom);
    if (!rec) {
      rec = {
        bom,
        kva: (o.description ?? "").toString(),
        required: 0,
        target: { CF: 0, TC: 0, TN: 0, CB: 0 },
        targetSeen: new Set(),
        mos: [],
        moSet: new Set(),
      };
      order.set(bom, rec);
    }
    const mo = (o.mo ?? "").trim();
    const moKey = `${bom}|${mo}`;
    if (!moSeen.has(moKey)) {
      moSeen.add(moKey);
      rec.required += o.requiredQty || 0;
      if (!rec.moSet.has(mo)) {
        rec.moSet.add(mo);
        rec.mos.push(mo);
      }
    }
    if (o.item && (ITEMS as readonly string[]).includes(o.item)) {
      rec.target[o.item as Item] += o.targetQty || 0;
      rec.targetSeen.add(o.item as Item);
    }
  }

  // ---- logged production per dept|bom|item (RAW bom) ----
  const logged: Record<"Cut" | "Welding" | "Painting", Map<string, number>> = {
    Cut: new Map(),
    Welding: new Map(),
    Painting: new Map(),
  };
  for (const l of logs) {
    const dept = l.dept === "Cut" || l.dept === "Welding" || l.dept === "Painting" ? l.dept : null;
    if (!dept) continue;
    const key = `${(l.bom ?? "").trim()}|${l.item}`;
    logged[dept].set(key, (logged[dept].get(key) ?? 0) + (l.qty || 0));
  }
  const get = (m: Map<string, number>, k: string) => m.get(k) ?? 0;

  // ---- one row per bom ----
  const rows: TrackerRow[] = [];
  for (const rec of order.values()) {
    const req = rec.required;
    const items = {} as Record<Item, TrackerItemCell>;
    let complete = 0;
    let first = true;
    for (const it of ITEMS) {
      // Target defaults to Required only if the item never appeared in Plan Orders.
      let tg = rec.targetSeen.has(it) ? rec.target[it] : req;
      if (tg > req) tg = req;
      let pre = req - tg;
      if (pre < 0) pre = 0;
      let cutDone = pre + get(logged.Cut, `${rec.bom}|${it}`);
      if (cutDone > req) cutDone = req;
      let weldDone = pre + get(logged.Welding, `${rec.bom}|${it}`);
      if (weldDone > req) weldDone = req;
      let paintDone = pre + get(logged.Painting, `${rec.bom}|${it}`);
      if (paintDone > req) paintDone = req;
      items[it] = { cutDone, weldDone, paintDone };
      if (first) {
        complete = paintDone;
        first = false;
      } else if (paintDone < complete) {
        complete = paintDone;
      }
    }
    let remaining = req - complete;
    if (remaining < 0) remaining = 0;
    const moLabel =
      rec.mos.length > 1 ? `${rec.mos[0]} +${rec.mos.length - 1} MO` : rec.mos[0] ?? "";
    rows.push({
      bom: rec.bom,
      moLabel,
      moCount: rec.mos.length,
      kva: rec.kva,
      required: req,
      items,
      complete,
      remaining,
      achievement: req > 0 ? complete / req : null,
    });
  }
  return rows;
}
