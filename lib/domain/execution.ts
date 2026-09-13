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

import { dayNumber, dateFromDayNumber, toISODate, parseISODate } from "./dates";
import { isPaintExempt } from "./constants";

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
  deptDone?: number | null; // dept output on the WHOLE order (enriched by the server layer)
  orderQty?: number | null; // whole order qty (planQty − OSP) — enriched by the server layer
  remaining: number; // qty − globally-done output allocated FIFO (earliest first)
  /** Present = an admin re-dated this row. Holds the ORIGINAL delivery ISO
   *  ("" = the line was date-less) — reverting restores exactly that. */
  overrideOrigISO?: string;
}

export interface CutSchedule {
  dueNow: CutTranche[]; // cut-due exactly today (delivery in leadCut days)
  overdue: CutTranche[]; // cut-due date passed with work remaining — backlog WITH its date
}

/**
 * Split the weekly schedules into date-stamped tranches and consume them
 * FIFO (earliest delivery first) with the GLOBAL done quantity per MO×item.
 * Whatever remains is either due today or overdue backlog carrying the original
 * delivery date — FROM ANY WEEK: pass every plan's schedule and a line scheduled
 * weeks ago stays on the worklist under its promised date until it is done or a
 * NEWER plan reschedules it (newest plan supersedes, output credited to the
 * superseded promises never consumes the new tranches — same convention as the
 * dept queues).
 */
export function computeCutTranches(opts: {
  schedules: (ExecScheduleRow & { planNo?: number })[]; // ALL plans' schedules (carries ovenDate)
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

  // per-line tranches with supersession: only the NEWEST plan's dates count
  const byLine = supersededTranches(schedules.map((s) => ({ ...s, planNo: s.planNo ?? 0 })));

  const dueNow: CutTranche[] = [];
  const overdue: CutTranche[] = [];
  for (const [key, line] of byLine) {
    const [bom, mo, item] = key.split("|");
    // output credited to superseded promises must not consume the new tranches
    let credit = Math.max(0, num(done, key) - line.oldQty);
    for (const t of line.tranches) {
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

/**
 * SILENT CAP: a weekly promise can exceed the order's real quantity (e.g. a
 * shared BOM's total written on one MO row). The worklist must never ask for
 * more than the order still needs — per line (BOM×MO×item), the shown
 * remaining is capped at orderQty − deptDone (earliest promises keep their
 * share first) and rows left with nothing are dropped without a trace.
 * Lines with an unknown order (not in the registry) are left as promised.
 */
export function capTranchesToOrder(sched: CutSchedule): CutSchedule {
  const all = [...sched.overdue, ...sched.dueNow];
  const byLine = new Map<string, CutTranche[]>();
  for (const r of all) {
    const key = `${r.bom}|${r.mo}|${r.item}`;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key)!.push(r);
  }
  const capped = new Map<CutTranche, number>(); // row -> capped remaining
  for (const rows of byLine.values()) {
    if (rows[0].orderQty == null) {
      for (const r of rows) capped.set(r, r.remaining);
      continue;
    }
    let room = Math.max(0, rows[0].orderQty - (rows[0].deptDone ?? 0));
    for (const r of [...rows].sort((a, b) => (a.deliveryISO < b.deliveryISO ? -1 : 1))) {
      const take = Math.min(r.remaining, room);
      room -= take;
      capped.set(r, take);
    }
  }
  const rebuild = (rows: CutTranche[]) =>
    rows.map((r) => ({ ...r, remaining: capped.get(r) ?? r.remaining })).filter((r) => r.remaining > 0);
  return { dueNow: rebuild(sched.dueNow), overdue: rebuild(sched.overdue) };
}

/** One admin date override, as stored: origISO "" = the line was date-less.
 *  qty/baseDone matter only for "" rows: qty = pieces scheduled on that date
 *  (null = the whole pool), baseDone = dept output at scheduling time. */
export interface WorklistDateOverrideRow {
  bom: string;
  mo: string;
  item: string;
  origISO: string;
  newISO: string;
  qty?: number | null;
  baseDone?: number;
}

/**
 * Apply the admin's date overrides on top of the computed worklist:
 *  - a DATED row whose (line, original date) matches an override is re-dated
 *    and re-bucketed (a future date moves it to `postponed`);
 *  - a DATE-LESS row (remarked/unscheduled/pushed) may be scheduled in PARTS:
 *    each origISO="" override becomes a dated tranche of its qty, allocated
 *    earliest-date-first; output recorded since scheduling (done − baseDone)
 *    consumes those tranches earliest-first, and whatever pool is left stays
 *    date-less. A qty-less override takes the whole pool (legacy behaviour);
 *  - every touched row carries overrideOrigISO so the UI can offer "revert".
 * Overrides that match nothing (stale after a re-import) are simply ignored.
 */
export function applyWorklistDateOverrides(opts: {
  dueNow: CutTranche[];
  overdue: CutTranche[];
  undated: CascadeRow[]; // rows with deliveryISO null (remarked + unscheduled)
  overrides: WorklistDateOverrideRow[];
  day: Date;
  lead: number;
}): { dueNow: CutTranche[]; overdue: CutTranche[]; postponed: CutTranche[]; undated: CascadeRow[] } {
  const dt = dayNumber(opts.day);
  // dated-row moves: one override per (line, original date) — last one wins
  const moveOvr = new Map(
    opts.overrides.filter((o) => o.origISO !== "").map((o) => [`${o.bom}|${o.mo}|${o.item}|${o.origISO}`, o.newISO])
  );
  // date-less scheduling: SEVERAL per line, applied in date order
  const partOvr = new Map<string, WorklistDateOverrideRow[]>();
  for (const o of opts.overrides) {
    if (o.origISO !== "") continue;
    const key = `${o.bom}|${o.mo}|${o.item}`;
    if (!partOvr.has(key)) partOvr.set(key, []);
    partOvr.get(key)!.push(o);
  }
  for (const list of partOvr.values()) list.sort((a, b) => (a.newISO < b.newISO ? -1 : 1));

  const dueNow: CutTranche[] = [];
  const overdue: CutTranche[] = [];
  const postponed: CutTranche[] = [];
  const place = (row: CutTranche) => {
    const cutDueD = dayNumber(parseISODate(row.deliveryISO)!) - opts.lead;
    if (cutDueD > dt) postponed.push(row);
    else if (cutDueD === dt) dueNow.push(row);
    else overdue.push(row);
  };
  const redate = (row: CutTranche, newISO: string, origISO: string): CutTranche => ({
    ...row,
    deliveryISO: newISO,
    cutDueISO: toISODate(dateFromDayNumber(dayNumber(parseISODate(newISO)!) - opts.lead)),
    overrideOrigISO: origISO,
  });

  for (const r of [...opts.overdue, ...opts.dueNow]) {
    // an already-overridden row keeps its ORIGINAL date as the override key
    const orig = r.overrideOrigISO ?? r.deliveryISO;
    const newISO = moveOvr.get(`${r.bom}|${r.mo}|${r.item}|${orig}`);
    place(newISO === undefined ? r : redate(r, newISO, orig));
  }

  const undated: CascadeRow[] = [];
  for (const r of opts.undated) {
    const tranches = partOvr.get(`${r.bom}|${r.mo}|${r.item}`);
    if (!tranches || r.available <= 0) {
      undated.push(r);
      continue;
    }
    // output recorded SINCE the first scheduling consumes tranches
    // earliest-first (the same FIFO rule as the weekly promises)
    const withQty = tranches.filter((t) => t.qty != null);
    const base = withQty.length > 0 ? Math.min(...withQty.map((t) => t.baseDone ?? 0)) : 0;
    let consumed = Math.max(0, r.done - base);
    let poolLeft = r.available;
    for (const t of tranches) {
      const q = t.qty ?? poolLeft; // qty-less override = the whole remaining pool
      // qty-less rows never consume: their pool is already done-adjusted
      const used = t.qty == null ? 0 : Math.min(consumed, q);
      consumed -= used;
      const remaining = Math.min(q - used, poolLeft);
      if (remaining <= 0) continue;
      poolLeft -= remaining;
      place(
        redate(
          {
            bom: r.bom,
            mo: r.mo,
            description: r.description,
            item: r.item,
            deliveryISO: t.newISO,
            cutDueISO: t.newISO, // overwritten by redate
            qty: q,
            remaining,
            deptDone: r.done,
            orderQty: r.target,
          },
          t.newISO,
          "" // was date-less — revert restores the pool
        )
      );
    }
    // whatever wasn't scheduled stays in the date-less bucket
    if (poolLeft > 0) undated.push({ ...r, available: poolLeft });
  }

  const cmp = (a: CutTranche, b: CutTranche) =>
    a.deliveryISO < b.deliveryISO ? -1 : a.deliveryISO > b.deliveryISO ? 1 :
    a.bom < b.bom ? -1 : a.bom > b.bom ? 1 : a.mo < b.mo ? -1 : a.mo > b.mo ? 1 :
    a.item < b.item ? -1 : a.item > b.item ? 1 : 0;
  dueNow.sort(cmp);
  overdue.sort(cmp);
  postponed.sort(cmp);
  return { dueNow, overdue, postponed, undated };
}

/** MOs the weekly plan carries but the planner left UNTOUCHED — present in the
 *  plan orders, yet with NO scheduled dates and NO remark on any of their rows.
 *  Convention: these are "not this week" — they must not appear in the backlog
 *  and must not be offered for scheduling. A schedule row OR a remark on any
 *  item row keeps the MO in play. */
export function untouchedWeeklyMos(
  planOrders: { mo: string; remark?: string | null }[],
  schedules: { mo: string }[]
): Set<string> {
  const scheduled = new Set(schedules.map((s) => s.mo));
  const remarked = new Set(
    planOrders.filter((o) => (o.remark ?? "").trim() !== "").map((o) => o.mo)
  );
  const out = new Set<string>();
  for (const o of planOrders) {
    if (!scheduled.has(o.mo) && !remarked.has(o.mo)) out.add(o.mo);
  }
  return out;
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
  remark?: string | null; // the weekly plan's remark that keeps a date-less line on the worklist
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
    const nd = lines ? nextOpenDelivery(lines, key, d) : null;
    rows.push({
      bom,
      mo,
      description: desc.get(`${bom}|${mo}`) ?? "",
      item,
      target: t,
      scheduled: sched,
      done: d,
      available,
      deliveryISO: nd === null ? null : toISODate(dateFromDayNumber(nd.d)),
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

/** The next promised delivery still open for a line (null = none): the newest
 *  plan's tranches consumed FIFO by `done` beyond the superseded plans'
 *  quantity. Returns the day number AND how many pieces of that tranche are
 *  still open (the "due on that date" quantity). */
export function nextOpenDelivery(
  lines: ReturnType<typeof supersededTranches>,
  key: string,
  done: number
): { d: number; open: number; qty: number } | null {
  const e = lines.get(key);
  if (!e) return null;
  let credit = Math.max(0, done - e.oldQty);
  for (const t of e.tranches) {
    const used = Math.min(credit, t.qty);
    credit -= used;
    if (t.qty - used > 0) return { d: t.ovenD, open: t.qty - used, qty: t.qty };
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
  dueQty: number | null; // still-open pieces of that delivery (counts down as output is recorded)
  dueTotal: number | null; // that delivery's full planned qty (the fraction's denominator)
  waitingSinceISO: string | null; // when the oldest still-waiting piece arrived from upstream
  ageDays: number | null; // day − waitingSince (WIP aging)
  orderQty?: number | null; // whole order qty (planQty − OSP) — enriched by the server layer
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
  skipItems?: (item: string) => boolean; // components this dept never handles (e.g. painting skips the core CF)
}): WeldQueueRow[] {
  const { schedules, entries, day, fromDept, toDept, inhouseCap } = opts;
  const skipItems = opts.skipItems ?? (() => false);
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
  // no-MO entries) are consumed FIFO by this dept's total output. Negative
  // ledger rows (returns) count as consumption — the piece left the queue.
  const upstreamDates = new Map<string, { d: number; qty: number }[]>();
  const returnedQty = new Map<string, number>();
  for (const e of past) {
    if (e.dept !== fromDept) continue;
    const k = `${e.bom}|${(e.mo ?? "").trim()}|${e.item}`;
    if (e.qty < 0) {
      add(returnedQty, k, -e.qty);
      continue;
    }
    if (!upstreamDates.has(k)) upstreamDates.set(k, []);
    upstreamDates.get(k)!.push({ d: dayNumber(e.date), qty: e.qty });
  }
  const waitingSince = (key: string, consumed: number): number | null => {
    const list = upstreamDates.get(key);
    if (!list) return null;
    list.sort((a, b) => a.d - b.d);
    let credit = consumed + num(returnedQty, key);
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
    if (skipItems(item)) continue; // this dept doesn't handle this component (e.g. paint skips CF)
    const cut = num(cutAttr, key);
    const welded = num(weldAttr, key);
    // OSP: only the in-house share needs this dept — upstream credit beyond it
    // (setup balances, pieces later outsourced) must not create work here
    const cap = inhouseCap?.get(key);
    const available = Math.max(0, (cap === undefined ? cut : Math.min(cut, cap)) - welded);
    const today = num(weldToday, key);
    if (available <= 0 && today <= 0) continue;
    const nd = nextDelivery(key);
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
      deliveryISO: nd === null ? null : toISODate(dateFromDayNumber(nd.d)),
      dueISO: nd === null ? null : toISODate(dateFromDayNumber(nd.d - lead)),
      dueQty: nd === null ? null : nd.open,
      dueTotal: nd === null ? null : nd.qty,
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
    if (skipItems(item)) continue; // this dept doesn't handle this component
    const since = available > 0 ? waitingSince(`${bom}||${item}`, v.weld) : null;
    rows.push({
      planNo: 0, bom, mo: "", description: "", item, cutToDate: v.cut, weldedToDate: v.weld, weldedToday: v.today, available,
      deliveryISO: null, dueISO: null, dueQty: null, dueTotal: null,
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
  // the core (CF) is never painted — it must not show up in the painting queue
  return computeDeptQueue({ ...opts, fromDept: "Welding", toDept: "Painting", lead: 0, skipItems: isPaintExempt });
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

// ---------------------------------------------------------------------------
// "Why isn't this line on the worklist?" — the plan-vs-screen diagnosis.
//
// Several rules legitimately keep a scheduled line off the fabrication screen
// (its day hasn't come, the order is closed, the component is N/A, the output
// already covers it…). Each is deliberate, but together they are invisible:
// the planner sees a line in the weekly sheet and nothing on the worklist.
// This turns every drop into a stated reason.
// ---------------------------------------------------------------------------

