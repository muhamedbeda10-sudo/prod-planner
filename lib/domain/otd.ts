// On-Time Delivery — the promise vs what actually left Painting.
//
// Per MO:
//   promise    = the LAST oven date of the NEWEST plan that scheduled it
//                (a re-import re-promises, so the latest plan's dates rule)
//   delivered  = the day MIN painted across the four components reached planQty
//   on time    = delivered ≤ promise
//   late       = delivered after the promise (lateness = delivered − promise)
//   open-late  = promise passed and the order is still not fully painted
//                (lateness so far = today − promise, grows daily)
//   upcoming   = promise still in the future — not counted in OTD%
//
// OTD% = on time / (on time + late + open-late)

import { ITEMS, SHEET_ITEMS } from "./constants";
import { TANK_ITEM } from "./tanks";
import { dayNumber, dateFromDayNumber, toISODate } from "./dates";

export interface OtdOrder {
  mo: string;
  planQty: number;
  osp?: Partial<Record<(typeof ITEMS)[number], number>>; // outsourced share per component — satisfied without in-house painting
  excluded?: string[]; // components this project doesn't need at all
  /** The components this order actually needs. Defaults to the four base
   *  components; the server passes the order's applicable set (base + AR/MB when
   *  its KVA/rating rule matches, minus N/A). */
  items?: readonly string[];
}
export interface OtdSchedule {
  planNo: number;
  mo: string;
  ovenDate: Date;
}
export interface OtdPaintLog {
  mo: string | null;
  item: string;
  qty: number;
  date: Date;
}

export interface OtdRow {
  mo: string;
  promisedISO: string;
  completedISO: string | null;
  status: "ontime" | "late" | "open-late" | "upcoming";
  latenessDays: number;
}

export interface OtdStats {
  due: number; // promises whose date has passed
  onTime: number;
  late: number; // finished, but after the promise
  openLate: number; // promise passed, still unfinished
  upcoming: number;
  otdPct: number | null;
  avgLatenessDays: number | null; // over late + open-late
  worst: OtdRow[]; // most-late first
}

export function computeOtd(
  orders: OtdOrder[],
  schedules: OtdSchedule[],
  paintings: OtdPaintLog[],
  day: Date
): OtdStats {
  const dt = dayNumber(day);

  // newest plan per MO → promise = that plan's last oven date
  const newestPlan = new Map<string, number>();
  for (const s of schedules) {
    const cur = newestPlan.get(s.mo);
    if (cur === undefined || s.planNo > cur) newestPlan.set(s.mo, s.planNo);
  }
  const promise = new Map<string, number>();
  for (const s of schedules) {
    if (newestPlan.get(s.mo) !== s.planNo) continue;
    const d = dayNumber(s.ovenDate);
    const cur = promise.get(s.mo);
    if (cur === undefined || d > cur) promise.set(s.mo, d);
  }

  // painting log per MO × item, date-ordered — NEGATIVE rows (corrections /
  // returns) count too, so the net total here always matches the tracker
  const paintByLine = new Map<string, { d: number; qty: number }[]>();
  for (const p of paintings) {
    const mo = (p.mo ?? "").trim();
    if (!mo || !p.qty) continue;
    const k = `${mo}|${p.item}`;
    if (!paintByLine.has(k)) paintByLine.set(k, []);
    paintByLine.get(k)!.push({ d: dayNumber(p.date), qty: p.qty });
  }
  for (const list of paintByLine.values()) list.sort((a, b) => a.d - b.d);

  /** day the item's cumulative NET painted reached `need` and STAYED there
   *  (null = not yet). A later negative correction that drops the net back
   *  below the need cancels the completion date. */
  const reachedOn = (mo: string, item: string, need: number): number | null => {
    let cum = 0;
    let reached: number | null = null;
    for (const e of paintByLine.get(`${mo}|${item}`) ?? []) {
      cum += e.qty;
      if (cum >= need) {
        if (reached === null) reached = e.d;
      } else {
        reached = null; // fell back below the need — not delivered after all
      }
    }
    return reached;
  };

  const rows: OtdRow[] = [];
  for (const o of orders) {
    const prom = promise.get(o.mo);
    if (prom === undefined || !(o.planQty > 0)) continue; // never promised a date

    let completed: number | null = null;
    let anyNeed = false;
    let unreached = false;
    for (const it of o.items ?? SHEET_ITEMS) {
      if (o.excluded?.includes(it)) continue; // project doesn't need this component
      const need = o.planQty - (o.osp?.[it as (typeof ITEMS)[number]] ?? 0);
      if (need <= 0) continue; // fully outsourced component — nothing to paint in-house
      anyNeed = true;
      const r = reachedOn(o.mo, it, need);
      if (r === null) {
        unreached = true;
        break;
      }
      completed = completed === null ? r : Math.max(completed, r);
    }
    if (unreached) completed = null;
    else if (!anyNeed) completed = prom; // everything outsourced — counts as delivered on the promise

    const promisedISO = toISODate(dateFromDayNumber(prom));
    if (completed !== null) {
      rows.push({
        mo: o.mo,
        promisedISO,
        completedISO: toISODate(dateFromDayNumber(completed)),
        status: completed <= prom ? "ontime" : "late",
        latenessDays: Math.max(0, completed - prom),
      });
    } else if (prom < dt) {
      rows.push({ mo: o.mo, promisedISO, completedISO: null, status: "open-late", latenessDays: dt - prom });
    } else {
      rows.push({ mo: o.mo, promisedISO, completedISO: null, status: "upcoming", latenessDays: 0 });
    }
  }

  const onTime = rows.filter((r) => r.status === "ontime").length;
  const late = rows.filter((r) => r.status === "late").length;
  const openLate = rows.filter((r) => r.status === "open-late").length;
  const upcoming = rows.filter((r) => r.status === "upcoming").length;
  const due = onTime + late + openLate;
  const lateRows = rows.filter((r) => r.status === "late" || r.status === "open-late");
  return {
    due,
    onTime,
    late,
    openLate,
    upcoming,
    otdPct: due > 0 ? onTime / due : null,
    avgLatenessDays: lateRows.length > 0 ? lateRows.reduce((s, r) => s + r.latenessDays, 0) / lateRows.length : null,
    worst: [...lateRows].sort((a, b) => b.latenessDays - a.latenessDays).slice(0, 8),
  };
}

/** The components a promise is judged on: the tank alone when the order has
 *  one — the piece the order closes on, the same yardstick as the plan's
 *  completion; else its remaining base components (never AR / MB — a
 *  bracket or a mono box lagging does not make a transformer late). */
export function otdGateItems(applicable: readonly string[]): string[] {
  if (applicable.includes(TANK_ITEM)) return [TANK_ITEM];
  return applicable.filter((it) => (SHEET_ITEMS as readonly string[]).includes(it));
}
