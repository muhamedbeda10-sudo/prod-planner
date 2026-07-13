// Execution sheet — per-MO order lines the operator records output against.
//
// Rows come from the plan schedule (which carries the MO detail), one row per
// MO × item with work due up to the selected day (oven date − lead). Done
// quantities are attributed per MO:
//   * entries recorded WITH an MO count directly against it;
//   * legacy entries without an MO are attributed FIFO across the BOM's MOs in
//     plan order, capped at each MO's total scheduled qty, excess to the last MO
//     (the same idea as the VBA AllocateMultiMO — display attribution only, the
//     raw entries are never modified).

import { dayNumber, dateFromDayNumber, toISODate } from "./dates";

export interface ExecScheduleRow {
  bom: string;
  mo: string;
  description?: string | null;
  item: string;
  ovenDate: Date;
  qty: number;
}

export interface ExecEntry {
  dept: string;
  bom: string;
  mo?: string | null;
  item: string;
  qty: number;
  date: Date;
}

export interface ExecRow {
  bom: string;
  mo: string;
  description: string;
  item: string;
  dueToDate: number; // scheduled with oven ≤ day + lead
  totalPlanned: number; // whole-plan scheduled qty for this MO×item
  doneToDate: number; // attributed output ≤ day (cut) / ≤ day (weld)
  doneToday: number; // attributed output on the selected day
  still: number; // max(0, dueToDate − doneToDate)
  cutReady?: number; // welding only: attributed cut (≤ day−1) − welded (≤ day)
}

const num = (m: Map<string, number>, k: string) => m.get(k) ?? 0;
const add = (m: Map<string, number>, k: string, q: number) => m.set(k, (m.get(k) ?? 0) + q);

/**
 * Attribute per-BOM|item quantities to MOs: direct MO entries first, then
 * FIFO for the no-MO remainder (caps per MO, excess to the last MO).
 * `caps` = bom|mo|item -> total scheduled; `moOrder` = bom -> MOs in plan order.
 */
export function attributeToMos(
  entries: { bom: string; mo?: string | null; item: string; qty: number }[],
  caps: Map<string, number>,
  moOrder: Map<string, string[]>
): Map<string, number> {
  const out = new Map<string, number>(); // bom|mo|item -> attributed qty
  const loose = new Map<string, number>(); // bom|item -> un-attributed total

  for (const e of entries) {
    const mo = (e.mo ?? "").trim();
    if (mo) add(out, `${e.bom}|${mo}|${e.item}`, e.qty);
    else add(loose, `${e.bom}|${e.item}`, e.qty);
  }

  for (const [key, total] of loose) {
    const [bom, item] = key.split("|");
    const mos = moOrder.get(bom) ?? [];
    if (mos.length === 0) continue; // unknown bom — nothing to attribute to
    let rest = total;
    for (let i = 0; i < mos.length && rest > 0; i++) {
      const k = `${bom}|${mos[i]}|${item}`;
      if (i === mos.length - 1) {
        add(out, k, rest); // excess to the last MO
        rest = 0;
      } else {
        const room = Math.max(0, num(caps, k) - num(out, k));
        const take = Math.min(rest, room);
        if (take > 0) {
          add(out, k, take);
          rest -= take;
        }
      }
    }
  }
  return out;
}

export interface CutTranche {
  bom: string;
  mo: string;
  description: string;
  item: string;
  deliveryISO: string; // the promised delivery (oven) date
  cutDueISO: string; // deliveryISO − leadCut
  qty: number; // this tranche's scheduled qty
  remaining: number; // qty − globally-done output allocated FIFO (earliest first)
}

export interface CutSchedule {
  dueNow: CutTranche[]; // cut-due exactly today (delivery in leadCut days)
  overdue: CutTranche[]; // cut-due date passed with work remaining — backlog WITH its date
}

/**
 * Split the active weekly schedule into date-stamped tranches and consume them
 * FIFO (earliest delivery first) with the GLOBAL done quantity per MO×item.
 * Whatever remains is either due today or overdue backlog carrying the original
 * delivery date. Re-importing a plan with new dates rebuilds all of this.
 */
export function computeCutTranches(opts: {
  schedules: ExecScheduleRow[]; // the ACTIVE plan's schedule (carries ovenDate)
  entries: ExecEntry[]; // ALL entries — progress is global
  day: Date;
  lead: number; // leadCut
  dept?: string; // producing dept (default "Cut")
}): CutSchedule {
  const { schedules, entries, day, lead } = opts;
  const dept = opts.dept ?? "Cut";
  const dt = dayNumber(day);

  // caps + MO order for FIFO attribution of legacy no-MO entries
  const caps = new Map<string, number>();
  const moOrder = new Map<string, string[]>();
  const desc = new Map<string, string>();
  for (const s of schedules) {
    add(caps, `${s.bom}|${s.mo}|${s.item}`, s.qty);
    if (!moOrder.has(s.bom)) moOrder.set(s.bom, []);
    const list = moOrder.get(s.bom)!;
    if (!list.includes(s.mo)) list.push(s.mo);
    if (s.description && !desc.has(`${s.bom}|${s.mo}`)) desc.set(`${s.bom}|${s.mo}`, String(s.description));
  }
  const done = attributeToMos(
    entries.filter((e) => e.dept === dept && dayNumber(e.date) <= dt),
    caps,
    moOrder
  );

  // tranches per line, earliest delivery first
  const byLine = new Map<string, { ovenD: number; qty: number }[]>();
  for (const s of schedules) {
    const key = `${s.bom}|${s.mo}|${s.item}`;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key)!.push({ ovenD: dayNumber(s.ovenDate), qty: s.qty });
  }

  const dueNow: CutTranche[] = [];
  const overdue: CutTranche[] = [];
  for (const [key, tranches] of byLine) {
    tranches.sort((a, b) => a.ovenD - b.ovenD);
    const [bom, mo, item] = key.split("|");
    let credit = num(done, key); // global output consumes earliest tranches first
    for (const t of tranches) {
      const used = Math.min(credit, t.qty);
      credit -= used;
      const remaining = t.qty - used;
      if (remaining <= 0) continue;
      const cutDueD = t.ovenD - lead;
      if (cutDueD > dt) continue; // future — appears on its own day
      const row: CutTranche = {
        bom,
        mo,
        description: desc.get(`${bom}|${mo}`) ?? "",
        item,
        deliveryISO: toISODate(dateFromDayNumber(t.ovenD)),
        cutDueISO: toISODate(dateFromDayNumber(cutDueD)),
        qty: t.qty,
        remaining,
      };
      if (cutDueD === dt) dueNow.push(row);
      else overdue.push(row);
    }
  }

  const cmp = (a: CutTranche, b: CutTranche) =>
    a.deliveryISO < b.deliveryISO ? -1 : a.deliveryISO > b.deliveryISO ? 1 :
    a.bom < b.bom ? -1 : a.bom > b.bom ? 1 : a.mo < b.mo ? -1 : a.mo > b.mo ? 1 :
    a.item < b.item ? -1 : a.item > b.item ? 1 : 0;
  dueNow.sort(cmp);
  overdue.sort(cmp);
  return { dueNow, overdue };
}

export interface CascadeRow {
  bom: string;
  mo: string;
  description: string;
  item: string;
  target: number; // this week's target (PlanOrder.targetQty)
  scheduled: number; // total scheduled in the grid
  done: number; // attributed cut output ≤ day
  available: number; // unscheduled pool still open = max(0, target − max(scheduled, done))
  deliveryISO: string | null; // last promised delivery still open (from ANY plan, newest wins) — null = never scheduled
}

/**
 * Cascade — the UNSCHEDULED backlog under the scheduled work. Lines whose weekly
 * target exceeds what the grid scheduled; the operator may pull work from here
 * and every recorded qty shrinks the pool (done beyond the schedule eats it).
 */
export function computeCascade(opts: {
  orders: { bom: string; mo: string; description?: string | null; item: string; targetQty: number }[];
  schedules: ExecScheduleRow[];
  entries: ExecEntry[]; // this plan's entries
  day: Date;
  dept: "Cut" | "Welding";
  allSchedules?: (ExecScheduleRow & { planNo: number })[]; // EVERY plan's schedule — for the old-promise delivery date
}): CascadeRow[] {
  const { orders, schedules, entries, day, dept, allSchedules } = opts;
  const dt = dayNumber(day);

  const caps = new Map<string, number>(); // bom|mo|item -> scheduled total
  const moOrder = new Map<string, string[]>();
  for (const s of schedules) {
    add(caps, `${s.bom}|${s.mo}|${s.item}`, s.qty);
    if (!moOrder.has(s.bom)) moOrder.set(s.bom, []);
    const list = moOrder.get(s.bom)!;
    if (!list.includes(s.mo)) list.push(s.mo);
  }
  // orders may contain MOs that were never scheduled — they must be attributable too
  for (const o of orders) {
    if (!moOrder.has(o.bom)) moOrder.set(o.bom, []);
    const list = moOrder.get(o.bom)!;
    if (!list.includes(o.mo)) list.push(o.mo);
  }

  const done = attributeToMos(
    entries.filter((e) => e.dept === dept && dayNumber(e.date) <= dt),
    caps,
    moOrder
  );

  // target per MO×item + first description
  const target = new Map<string, number>();
  const desc = new Map<string, string>();
  const rowOrder: string[] = [];
  for (const o of orders) {
    const key = `${o.bom}|${o.mo}|${o.item}`;
    add(target, key, o.targetQty || 0);
    if (o.description && !desc.has(`${o.bom}|${o.mo}`)) desc.set(`${o.bom}|${o.mo}`, String(o.description));
    if (!rowOrder.includes(key)) rowOrder.push(key);
  }

  // the old promise: the newest plan that ever scheduled this line, consumed
  // FIFO by output — shown so an unscheduled line keeps its last known date
  const lines = allSchedules ? supersededTranches(allSchedules) : null;

  const rows: CascadeRow[] = [];
  for (const key of rowOrder) {
    const t = num(target, key);
    if (t <= 0) continue;
    const sched = num(caps, key);
    const d = num(done, key);
    const available = Math.max(0, t - Math.max(sched, d));
    if (available <= 0) continue; // fully scheduled (shown above) or already consumed
    const [bom, mo, item] = key.split("|");
    const ovenD = lines ? nextOpenDelivery(lines, key, d) : null;
    rows.push({
      bom,
      mo,
      description: desc.get(`${bom}|${mo}`) ?? "",
      item,
      target: t,
      scheduled: sched,
      done: d,
      available,
      deliveryISO: ovenD === null ? null : toISODate(dateFromDayNumber(ovenD)),
    });
  }
  return rows;
}

/** Per-line delivery tranches where the NEWEST plan that scheduled the line
 *  supersedes every older one — a weekly re-import re-promises the remaining
 *  work under new dates, so the old dates stop counting. `oldQty` is the
 *  superseded plans' total: output up to that amount is credited to the old
 *  (cancelled) promises and must not consume the new tranches. */
export function supersededTranches(schedules: (ExecScheduleRow & { planNo: number })[]) {
  const byLine = new Map<string, { maxPlan: number; tranches: { ovenD: number; qty: number }[]; oldQty: number }>();
  for (const s of schedules) {
    const key = `${s.bom}|${s.mo}|${s.item}`;
    let e = byLine.get(key);
    if (!e) {
      e = { maxPlan: s.planNo, tranches: [], oldQty: 0 };
      byLine.set(key, e);
    }
    if (s.planNo > e.maxPlan) {
      e.oldQty += e.tranches.reduce((t, x) => t + x.qty, 0);
      e.tranches = [];
      e.maxPlan = s.planNo;
    }
    if (s.planNo === e.maxPlan) e.tranches.push({ ovenD: dayNumber(s.ovenDate), qty: s.qty });
    else e.oldQty += s.qty;
  }
  for (const e of byLine.values()) e.tranches.sort((a, b) => a.ovenD - b.ovenD);
  return byLine;
}

/** The next promised delivery still open for a line (day number, null = none):
 *  the newest plan's tranches consumed FIFO by `done` beyond the superseded
 *  plans' quantity. */
export function nextOpenDelivery(
  lines: ReturnType<typeof supersededTranches>,
  key: string,
  done: number
): number | null {
  const e = lines.get(key);
  if (!e) return null;
  let credit = Math.max(0, done - e.oldQty);
  for (const t of e.tranches) {
    const used = Math.min(credit, t.qty);
    credit -= used;
    if (t.qty - used > 0) return t.ovenD;
  }
  return null; // everything on the current promise is already done
}

export interface WeldQueueRow {
  planNo: number; // recording bucket (0 = global/balances) — progress itself is global per MO
  bom: string;
  mo: string; // "" when only known at BOM level
  description: string;
  item: string;
  cutToDate: number;
  weldedToDate: number;
  weldedToday: number;
  available: number; // cut − welded (never negative)
  deliveryISO: string | null; // next promised delivery still open for this line (null = no scheduled line)
  dueISO: string | null; // deliveryISO − lead: when THIS dept must finish (weld = D−1, paint = D)
  waitingSinceISO: string | null; // when the oldest still-waiting piece arrived from upstream
  ageDays: number | null; // day − waitingSince (WIP aging)
}

/**
 * Dept queue — purely what the UPSTREAM department produced and this
 * department hasn't consumed yet (Cut→Welding, Welding→Painting).
 * No schedule gating: a piece finished upstream TODAY is available today,
 * and WIP carried from any earlier plan stays in the queue until consumed.
 */
export function computeDeptQueue(opts: {
  schedules: (ExecScheduleRow & { planNo: number })[];
  entries: (ExecEntry & { planNo: number })[];
  day: Date;
  fromDept: string; // upstream producer, e.g. "Cut"
  toDept: string; // this dept (consumer), e.g. "Welding"
  lead?: number; // days before delivery THIS dept must finish (weld 1, paint 0)
  inhouseCap?: Map<string, number>; // bom|mo|item -> planQty − OSP; the outsourced share never reaches our queues
}): WeldQueueRow[] {
  const { schedules, entries, day, fromDept, toDept, inhouseCap } = opts;
  const lead = opts.lead ?? 0;
  const dt = dayNumber(day);
  const rows: WeldQueueRow[] = [];

  // GLOBAL aggregation: progress is per MO across every plan and the setup
  // balances — one line per MO×item regardless of which week produced it.
  const caps = new Map<string, number>();
  const moOrder = new Map<string, string[]>();
  const desc = new Map<string, string>();
  for (const s of schedules) {
    add(caps, `${s.bom}|${s.mo}|${s.item}`, s.qty);
    if (!moOrder.has(s.bom)) moOrder.set(s.bom, []);
    const list = moOrder.get(s.bom)!;
    if (!list.includes(s.mo)) list.push(s.mo);
    if (s.description && !desc.has(`${s.bom}|${s.mo}`)) desc.set(`${s.bom}|${s.mo}`, String(s.description));
  }

  const past = entries.filter((e) => dayNumber(e.date) <= dt);
  const cutAttr = attributeToMos(past.filter((e) => e.dept === fromDept), caps, moOrder);
  const weldAttr = attributeToMos(past.filter((e) => e.dept === toDept), caps, moOrder);
  const weldToday = attributeToMos(
    entries.filter((e) => e.dept === toDept && dayNumber(e.date) === dt),
    caps,
    moOrder
  );

  // delivery tranches per line — the newest plan's schedule supersedes older
  // ones (a re-import re-promises the remaining work), and this dept's own
  // output consumes the current tranches FIFO, so the date shown is the next
  // promised delivery this line still has to serve.
  const lines = supersededTranches(schedules);
  const nextDelivery = (key: string) => nextOpenDelivery(lines, key, num(weldAttr, key));

  // WIP aging: when did the oldest STILL-WAITING piece arrive from upstream?
  // The line's dated upstream entries (direct MO match; BOM-level rows use the
  // no-MO entries) are consumed FIFO by this dept's total output.
  const upstreamDates = new Map<string, { d: number; qty: number }[]>();
  for (const e of past) {
    if (e.dept !== fromDept) continue;
    const k = `${e.bom}|${(e.mo ?? "").trim()}|${e.item}`;
    if (!upstreamDates.has(k)) upstreamDates.set(k, []);
    upstreamDates.get(k)!.push({ d: dayNumber(e.date), qty: e.qty });
  }
  const waitingSince = (key: string, consumed: number): number | null => {
    const list = upstreamDates.get(key);
    if (!list) return null;
    list.sort((a, b) => a.d - b.d);
    let credit = consumed;
    for (const t of list) {
      const used = Math.min(credit, t.qty);
      credit -= used;
      if (t.qty - used > 0) return t.d;
    }
    return null;
  };

  const keys = new Set([...cutAttr.keys(), ...weldToday.keys()]);
  for (const key of keys) {
    const [bom, mo, item] = key.split("|");
    const cut = num(cutAttr, key);
    const welded = num(weldAttr, key);
    // OSP: only the in-house share needs this dept — upstream credit beyond it
    // (setup balances, pieces later outsourced) must not create work here
    const cap = inhouseCap?.get(key);
    const available = Math.max(0, (cap === undefined ? cut : Math.min(cut, cap)) - welded);
    const today = num(weldToday, key);
    if (available <= 0 && today <= 0) continue;
    const ovenD = nextDelivery(key);
    const since = available > 0 ? waitingSince(key, welded) : null;
    rows.push({
      planNo: 0, // recording bucket — global progress
      bom,
      mo,
      description: desc.get(`${bom}|${mo}`) ?? "",
      item,
      cutToDate: cut,
      weldedToDate: welded,
      weldedToday: today,
      available,
      deliveryISO: ovenD === null ? null : toISODate(dateFromDayNumber(ovenD)),
      dueISO: ovenD === null ? null : toISODate(dateFromDayNumber(ovenD - lead)),
      waitingSinceISO: since === null ? null : toISODate(dateFromDayNumber(since)),
      ageDays: since === null ? null : Math.max(0, dt - since),
    });
  }

  // BOM-level fallback: output logged on codes with no MO breakdown anywhere
  // (unknown/legacy codes) must still reach the queue.
  const loose = new Map<string, { cut: number; weld: number; today: number }>();
  for (const e of past) {
    if ((e.mo ?? "").trim()) continue;
    if (moOrder.has(e.bom)) continue; // already attributed above
    const k = `${e.bom}|${e.item}`;
    const cur = loose.get(k) ?? { cut: 0, weld: 0, today: 0 };
    if (e.dept === fromDept) cur.cut += e.qty;
    if (e.dept === toDept) {
      cur.weld += e.qty;
      if (dayNumber(e.date) === dt) cur.today += e.qty;
    }
    loose.set(k, cur);
  }
  for (const [k, v] of loose) {
    const available = Math.max(0, v.cut - v.weld);
    if (available <= 0 && v.today <= 0) continue;
    const [bom, item] = k.split("|");
    const since = available > 0 ? waitingSince(`${bom}||${item}`, v.weld) : null;
    rows.push({
      planNo: 0, bom, mo: "", description: "", item, cutToDate: v.cut, weldedToDate: v.weld, weldedToday: v.today, available,
      deliveryISO: null, dueISO: null,
      waitingSinceISO: since === null ? null : toISODate(dateFromDayNumber(since)),
      ageDays: since === null ? null : Math.max(0, dt - since),
    });
  }

  // earliest open delivery first (undated lines last), then bom/mo/item
  return rows.sort((a, b) => {
    const da = a.deliveryISO ?? "9999-99-99";
    const db = b.deliveryISO ?? "9999-99-99";
    if (da !== db) return da < db ? -1 : 1;
    return a.bom < b.bom ? -1 : a.bom > b.bom ? 1 : a.mo < b.mo ? -1 : a.mo > b.mo ? 1 : a.item < b.item ? -1 : a.item > b.item ? 1 : 0;
  });
}

/** Cut→Welding queue (back-compat wrapper over computeDeptQueue).
 *  Welding is due the day BEFORE delivery (leadWeld, default 1). */
export function computeWeldingQueue(opts: {
  schedules: (ExecScheduleRow & { planNo: number })[];
  entries: (ExecEntry & { planNo: number })[];
  day: Date;
  lead?: number;
  inhouseCap?: Map<string, number>;
}): WeldQueueRow[] {
  return computeDeptQueue({ ...opts, fromDept: "Cut", toDept: "Welding", lead: opts.lead ?? 1 });
}

/** Welding→Painting queue: everything welded, not yet painted.
 *  Painting is due ON the delivery day itself (lead 0). */
export function computePaintingQueue(opts: {
  schedules: (ExecScheduleRow & { planNo: number })[];
  entries: (ExecEntry & { planNo: number })[];
  day: Date;
  inhouseCap?: Map<string, number>;
}): WeldQueueRow[] {
  return computeDeptQueue({ ...opts, fromDept: "Welding", toDept: "Painting", lead: 0 });
}

export function computeExecutionRows(opts: {
  schedules: ExecScheduleRow[];
  entries: ExecEntry[]; // this plan's handover entries (both depts)
  day: Date;
  lead: number;
  dept: "Cut" | "Welding";
  leadCut?: number; // welding only — for the cut-side due (unused in v1 attribution)
}): ExecRow[] {
  const { schedules, entries, day, lead, dept } = opts;
  const dt = dayNumber(day);

  // per-MO schedule maps, keeping plan order
  const due = new Map<string, number>(); // bom|mo|item -> due ≤ dt+lead
  const caps = new Map<string, number>(); // bom|mo|item -> total scheduled
  const moOrder = new Map<string, string[]>();
  const desc = new Map<string, string>();
  const rowOrder: string[] = [];
  const seen = new Set<string>();

  for (const s of schedules) {
    const key = `${s.bom}|${s.mo}|${s.item}`;
    add(caps, key, s.qty);
    if (dayNumber(s.ovenDate) <= dt + lead) add(due, key, s.qty);
    if (!moOrder.has(s.bom)) moOrder.set(s.bom, []);
    const list = moOrder.get(s.bom)!;
    if (!list.includes(s.mo)) list.push(s.mo);
    if (s.description && !desc.has(`${s.bom}|${s.mo}`)) desc.set(`${s.bom}|${s.mo}`, String(s.description));
    if (!seen.has(key)) {
      seen.add(key);
      rowOrder.push(key);
    }
  }

  // attribute done quantities (to-date, and today separately)
  const deptEntries = entries.filter((e) => e.dept === dept);
  const doneToDate = attributeToMos(
    deptEntries.filter((e) => dayNumber(e.date) <= dt),
    caps,
    moOrder
  );
  const doneToday = attributeToMos(
    deptEntries.filter((e) => dayNumber(e.date) === dt),
    caps,
    moOrder
  );

  // welding: attributed cut output up to yesterday
  let cutToYesterday: Map<string, number> | null = null;
  let weldToDate: Map<string, number> | null = null;
  if (dept === "Welding") {
    cutToYesterday = attributeToMos(
      entries.filter((e) => e.dept === "Cut" && dayNumber(e.date) <= dt - 1),
      caps,
      moOrder
    );
    weldToDate = doneToDate;
  }

  const rows: ExecRow[] = [];
  for (const key of rowOrder) {
    const d = num(due, key);
    if (d <= 0) continue; // nothing due yet for this line
    const [bom, mo, item] = key.split("|");
    const done = num(doneToDate, key);
    const row: ExecRow = {
      bom,
      mo,
      description: desc.get(`${bom}|${mo}`) ?? "",
      item,
      dueToDate: d,
      totalPlanned: num(caps, key),
      doneToDate: done,
      doneToday: num(doneToday, key),
      still: Math.max(0, d - done),
    };
    if (cutToYesterday && weldToDate) {
      row.cutReady = Math.max(0, num(cutToYesterday, key) - num(weldToDate, key));
    }
    rows.push(row);
  }
  return rows;
}
