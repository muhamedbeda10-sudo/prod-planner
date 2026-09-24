// PRODUCTION CONTROL — the arithmetic behind the dashboard's first screen.
//
// A production control engineer opens the day with five questions: where does
// the plan stand, where does the work sit, which stage is the bottleneck, will
// we finish in time, and which orders need a hand today. Every function here
// answers one of them from the tracker rows the app already keeps; the page
// only lays the answers out.

import { ITEMS, isPaintExempt, type Item } from "./constants";

/** What the dashboard needs of a tracker row — the tracker's own shape, narrowed. */
export interface ControlRow {
  mo: string;
  bom: string;
  soi: string | null;
  customer: string | null;
  required: number;
  complete: number;
  status: string;
  urgent: boolean;
  priority: boolean;
  onHold: boolean;
  months: string[];
  items: Record<Item, { cut: number; weld: number; paint: number; shp: number; delivered: number; osp: number; excluded: boolean; eligible: boolean }>;
}

/** Pieces of the required components, stage by stage, over the open orders.
 *  `need` is what the plant itself must make (OSP pieces are bought). */
export interface StagePieces {
  need: number;
  cut: number;
  weld: number;
  finished: number;
  delivered: number;
}

const needed = (r: ControlRow, it: Item) => r.items[it].eligible && !r.items[it].excluded;
const cap = (v: number, need: number) => Math.min(Math.max(0, v), need);

export function piecesOf(rows: readonly ControlRow[]): StagePieces {
  const p: StagePieces = { need: 0, cut: 0, weld: 0, finished: 0, delivered: 0 };
  for (const r of rows) {
    if (r.status !== "open") continue;
    for (const it of ITEMS) {
      if (!needed(r, it)) continue;
      const c = r.items[it];
      const need = Math.max(0, r.required - c.osp);
      p.need += need;
      p.cut += cap(c.cut, need);
      p.weld += cap(c.weld, need);
      p.finished += cap(isPaintExempt(it) ? c.shp : c.paint, need);
      p.delivered += cap(c.delivered, need);
    }
  }
  return p;
}

export type BacklogStage = "fab" | "weld" | "finish" | "deliver";
export const BACKLOG_LABEL: Record<BacklogStage, string> = {
  fab: "Waiting for fabrication",
  weld: "Waiting for welding",
  finish: "Waiting for finishing",
  deliver: "Finished, not delivered",
};

/** Pieces waiting at each stage: what the stage before has released and this
 *  one has not yet done. The largest queue is where the plant is stuck. */
export function backlogOf(p: StagePieces): Record<BacklogStage, number> {
  return {
    fab: Math.max(0, p.need - p.cut),
    weld: Math.max(0, p.cut - p.weld),
    finish: Math.max(0, p.weld - p.finished),
    deliver: Math.max(0, p.finished - p.delivered),
  };
}

/** The stage holding the most pieces — null when nothing waits anywhere. */
export function bottleneckOf(b: Record<BacklogStage, number>): BacklogStage | null {
  const order: BacklogStage[] = ["fab", "weld", "finish", "deliver"];
  let best: BacklogStage | null = null;
  for (const k of order) if (b[k] > 0 && (best === null || b[k] > b[best])) best = k;
  return best;
}

export interface PlanSummary {
  /** Orders on the month's plan, open or closed. */
  orders: number;
  /** Of those, the ones still open. */
  openOrders: number;
  required: number; // units (transformers) on the plan
  /** Units finished, counted by TANKS painted: the tank is the transformer's
   *  body and the piece the plant closes the order on. A unit is not held
   *  back by a cable box or a cover still in paint. */
  complete: number;
  delivered: number; // units the customer has received in full
  remaining: number;
  pct: number | null; // complete / required
  urgent: number;
  priority: number;
  onHold: number;
}

/** The orders the month's figures are read over: every order the plan of
 *  `monthLabel` carries, CLOSED ONES INCLUDED — closing a finished order
 *  must not pull the month's completion down. Before the month has a plan
 *  (or with no label), the open orders stand in. */
export function planRowsOf<T extends Pick<ControlRow, "status" | "months">>(rows: readonly T[], monthLabel: string | null): T[] {
  const plan = monthLabel ? rows.filter((r) => r.months.includes(monthLabel)) : [];
  return plan.length > 0 ? plan : rows.filter((r) => r.status === "open");
}

/** Units of an order still to finish, by its tanks — the same yardstick as
 *  the plan's completion. */
export const tanksLeftOf = (r: ControlRow) => Math.max(0, r.required - tankUnitsOf(r));

/** A unit is delivered when every required component of it was delivered. */
export function deliveredUnitsOf(r: ControlRow): number {
  let m = Infinity;
  for (const it of ITEMS) {
    if (!needed(r, it)) continue;
    m = Math.min(m, cap(r.items[it].delivered + r.items[it].osp, r.required));
  }
  return Number.isFinite(m) ? m : 0;
}

/** Units of an order finished, by its tanks: painted (or bought) tanks, capped
 *  at the order. An order that needs no tank (a rare one) counts its
 *  complete units instead. */
export function tankUnitsOf(r: ControlRow): number {
  if (!needed(r, "TN")) return Math.min(r.complete, r.required);
  return cap(r.items.TN.paint + r.items.TN.osp, r.required);
}

export function planSummaryOf(rows: readonly ControlRow[], monthLabel: string | null = null): PlanSummary {
  const plan = planRowsOf(rows, monthLabel);
  const open = plan.filter((r) => r.status === "open");
  const required = plan.reduce((s, r) => s + r.required, 0);
  const complete = plan.reduce((s, r) => s + tankUnitsOf(r), 0);
  const delivered = plan.reduce((s, r) => s + deliveredUnitsOf(r), 0);
  return {
    orders: plan.length,
    openOrders: open.length,
    required,
    complete,
    delivered,
    remaining: Math.max(0, required - complete),
    pct: required > 0 ? complete / required : null,
    // flags are about work in progress — the plan's open orders only
    urgent: open.filter((r) => r.urgent).length,
    priority: open.filter((r) => r.priority).length,
    onHold: open.filter((r) => r.onHold).length,
  };
}

// ---- time: will the plan land? ----

/** dayNumber-free weekday test on an ISO day: the plant works Sat–Thu. */
const isFridayISO = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay() === 5;
const addDaysISO = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
export const monthEndISO = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
};

/** Working days from TOMORROW to the end of the month, Fridays and holidays off. */
export function workingDaysLeft(todayISO: string, holidayISOs: ReadonlySet<string>): number {
  const end = monthEndISO(todayISO);
  let n = 0;
  for (let d = addDaysISO(todayISO, 1); d <= end; d = addDaysISO(d, 1)) if (!isFridayISO(d) && !holidayISOs.has(d)) n++;
  return n;
}

/** Working days from `fromISO` to `toISO` inclusive. */
export function workingDaysBetween(fromISO: string, toISO: string, holidayISOs: ReadonlySet<string>): number {
  let n = 0;
  for (let d = fromISO; d <= toISO; d = addDaysISO(d, 1)) if (!isFridayISO(d) && !holidayISOs.has(d)) n++;
  return n;
}

export interface Pace {
  /** Tanks painted per working day over the trailing window. */
  actualPerDay: number | null;
  /** Tanks per working day the plan's remaining units need to land by month end. */
  requiredPerDay: number | null;
  daysLeft: number;
  /** actual / required — ≥ 1 means the month lands at this pace. */
  ratio: number | null;
  /** Working days the remaining units take at the actual pace. */
  daysNeeded: number | null;
}

/** The month's pace in the plan's own unit: tanks painted over the trailing
 *  window against the tanks the plan still owes. Cable boxes, covers and
 *  mono boxes are not mixed in — a tank is the unit the order closes on. */
export function paceOf(remainingUnits: number, finishedInWindow: number, windowWorkingDays: number, daysLeft: number): Pace {
  const actualPerDay = windowWorkingDays > 0 ? finishedInWindow / windowWorkingDays : null;
  const requiredPerDay = daysLeft > 0 ? remainingUnits / daysLeft : null;
  const ratio = actualPerDay !== null && requiredPerDay !== null && requiredPerDay > 0 ? actualPerDay / requiredPerDay : null;
  const daysNeeded = actualPerDay !== null && actualPerDay > 0 ? Math.ceil(remainingUnits / actualPerDay) : null;
  return { actualPerDay, requiredPerDay, daysLeft, ratio, daysNeeded };
}

// ---- the orders that need a hand today ----

export type AttentionKind = "late" | "dueSoon" | "blocked" | "hold";
export interface AttentionRow {
  mo: string;
  bom: string;
  soi: string | null;
  customer: string | null;
  kind: AttentionKind;
  dueISO: string | null;
  etaISO: string | null;
  /** Calendar days the forecast lands after the promise (late), or until the promise (dueSoon). */
  days: number;
  remaining: number; // units still to finish
  urgent: boolean;
  priority: boolean;
}

export interface EtaLike {
  etaISO: string | null;
  dueISO: string | null;
  late: boolean;
  done: boolean;
  blockedBy: string | null;
}

const daysBetweenISO = (a: string, b: string) => Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000);

/** Late forecasts first (most late on top), then promises due within a week,
 *  then orders with no honest forecast, then holds — capped, urgent first
 *  within a kind. Done and closed orders never appear. */
export function attentionOf(rows: readonly ControlRow[], etas: ReadonlyMap<string, EtaLike>, todayISO: string, limit = 8): AttentionRow[] {
  const out: AttentionRow[] = [];
  for (const r of rows) {
    if (r.status !== "open") continue;
    const remaining = tanksLeftOf(r); // by tanks, like the plan's completion
    if (remaining === 0) continue;
    const e = etas.get(r.mo);
    const base = { mo: r.mo, bom: r.bom, soi: r.soi, customer: r.customer, remaining, urgent: r.urgent, priority: r.priority, dueISO: e?.dueISO ?? null, etaISO: e?.etaISO ?? null };
    if (r.onHold) { out.push({ ...base, kind: "hold", days: 0 }); continue; }
    if (!e || e.done) continue;
    if (e.late && e.etaISO && e.dueISO) out.push({ ...base, kind: "late", days: daysBetweenISO(e.dueISO, e.etaISO) });
    else if (e.blockedBy) out.push({ ...base, kind: "blocked", days: 0 });
    else if (e.dueISO) {
      const d = daysBetweenISO(todayISO, e.dueISO);
      if (d <= 7) out.push({ ...base, kind: "dueSoon", days: d });
    }
  }
  const rank: Record<AttentionKind, number> = { late: 0, dueSoon: 1, blocked: 2, hold: 3 };
  out.sort((a, b) =>
    rank[a.kind] - rank[b.kind]
    || Number(b.urgent) - Number(a.urgent)
    || (a.kind === "late" ? b.days - a.days : a.kind === "dueSoon" ? a.days - b.days : 0)
    || a.mo.localeCompare(b.mo));
  return out.slice(0, limit);
}

// ---- the backlog, day by day ----

export interface LedgerLike {
  mo: string | null;
  item: string;
  dept: string;
  dateISO: string;
  qty: number;
}

export interface BacklogPoint {
  dateISO: string;
  fab: number;
  weld: number;
  finish: number;
  deliver: number;
}

/** The backlog at each stage as it stood at the end of every day from
 *  `fromISO` to `toISO`, read off the ledger of the orders open TODAY — so the
 *  last point is exactly the backlog card, and the curve is how those orders'
 *  queues moved. Output is capped at each component's need, like the card. */
export function backlogSeries(rows: readonly ControlRow[], ledger: readonly LedgerLike[], fromISO: string, toISO: string): BacklogPoint[] {
  // need per (mo|item), open orders' required components only
  const need = new Map<string, number>();
  const finishDept = new Map<string, string>();
  for (const r of rows) {
    if (r.status !== "open") continue;
    for (const it of ITEMS) {
      if (!needed(r, it)) continue;
      need.set(`${r.mo}|${it}`, Math.max(0, r.required - r.items[it].osp));
      finishDept.set(`${r.mo}|${it}`, isPaintExempt(it) ? "ShotBlast" : "Painting");
    }
  }
  // cumulative output per key and stage as of the day before the window,
  // then the window's rows bucketed by day
  const stageOf = (key: string, dept: string): "cut" | "weld" | "finished" | "delivered" | null =>
    dept === "Cut" ? "cut" : dept === "Welding" ? "weld" : dept === "Delivered" ? "delivered" : dept === finishDept.get(key) ? "finished" : null;
  const cum = new Map<string, { cut: number; weld: number; finished: number; delivered: number }>();
  const byDay = new Map<string, LedgerLike[]>();
  for (const e of ledger) {
    if (!e.mo) continue;
    const key = `${e.mo}|${e.item}`;
    if (!need.has(key)) continue;
    if (e.dateISO < fromISO) {
      const s = stageOf(key, e.dept);
      if (!s) continue;
      const c = cum.get(key) ?? { cut: 0, weld: 0, finished: 0, delivered: 0 };
      c[s] += e.qty;
      cum.set(key, c);
    } else if (e.dateISO <= toISO) {
      (byDay.get(e.dateISO) ?? byDay.set(e.dateISO, []).get(e.dateISO)!).push(e);
    }
  }
  const out: BacklogPoint[] = [];
  for (let d = fromISO; d <= toISO; d = addDaysISO(d, 1)) {
    for (const e of byDay.get(d) ?? []) {
      const key = `${e.mo}|${e.item}`;
      const s = stageOf(key, e.dept);
      if (!s) continue;
      const c = cum.get(key) ?? { cut: 0, weld: 0, finished: 0, delivered: 0 };
      c[s] += e.qty;
      cum.set(key, c);
    }
    const p: StagePieces = { need: 0, cut: 0, weld: 0, finished: 0, delivered: 0 };
    for (const [key, n] of need) {
      const c = cum.get(key) ?? { cut: 0, weld: 0, finished: 0, delivered: 0 };
      p.need += n;
      p.cut += cap(c.cut, n);
      p.weld += cap(c.weld, n);
      p.finished += cap(c.finished, n);
      p.delivered += cap(c.delivered, n);
    }
    const b = backlogOf(p);
    out.push({ dateISO: d, fab: b.fab, weld: b.weld, finish: b.finish, deliver: b.deliver });
  }
  return out;
}

// ---- load against capacity ----

export type LoadStage = "cut" | "weld" | "finish";
export const LOAD_LABEL: Record<LoadStage, string> = { cut: "Fabrication", weld: "Welding", finish: "Finishing" };

export interface StageLoad {
  stage: LoadStage;
  /** Standard hours queued: every open order's remaining pieces × the std-hours a piece costs here. */
  queuedHours: number;
  /** Std-hours this stage earned per working day over the trailing window — its actual pace. */
  earnedPerDay: number;
  /** Man-hours a day the admin set as the stage's capacity; null when none is set. */
  capacityPerDay: number | null;
  /** Man-hours a day the shift log recorded over its last days; null when nothing is logged. */
  recordedPerDay: number | null;
  /** Working days the queue takes at the actual pace; null when the pace is 0. */
  daysOfWork: number | null;
  /** earned / capacity — how much of the set capacity is turning into output. */
  utilisation: number | null;
}

export function stageLoadOf(stage: LoadStage, queuedHours: number, earnedPerDay: number, capacityPerDay: number | null, recordedPerDay: number | null): StageLoad {
  return {
    stage,
    queuedHours,
    earnedPerDay,
    capacityPerDay,
    recordedPerDay,
    daysOfWork: earnedPerDay > 0 ? queuedHours / earnedPerDay : null,
    utilisation: capacityPerDay !== null && capacityPerDay > 0 ? earnedPerDay / capacityPerDay : null,
  };
}

// ---- the same, component by component ----

export interface ItemPieces {
  item: Item;
  pieces: StagePieces;
  backlog: Record<BacklogStage, number>;
  bottleneck: BacklogStage | null;
}

/** Pieces through each stage and waiting at each stage, per component, over
 *  the open orders — only the components some open order needs. */
export function piecesByItem(rows: readonly ControlRow[]): ItemPieces[] {
  const out: ItemPieces[] = [];
  for (const it of ITEMS) {
    const p: StagePieces = { need: 0, cut: 0, weld: 0, finished: 0, delivered: 0 };
    for (const r of rows) {
      if (r.status !== "open" || !needed(r, it)) continue;
      const c = r.items[it];
      const need = Math.max(0, r.required - c.osp);
      p.need += need;
      p.cut += cap(c.cut, need);
      p.weld += cap(c.weld, need);
      p.finished += cap(isPaintExempt(it) ? c.shp : c.paint, need);
      p.delivered += cap(c.delivered, need);
    }
    if (p.need === 0) continue;
    const backlog = backlogOf(p);
    out.push({ item: it, pieces: p, backlog, bottleneck: bottleneckOf(backlog) });
  }
  return out;
}

// ---- promises ahead ----

export interface PromiseDay {
  dateISO: string;
  /** Units promised for that day on open orders with work left. */
  units: number;
  /** Of those, units whose forecast lands late or cannot be made. */
  atRisk: number;
  orders: number;
}

export interface PromisesAhead {
  days: PromiseDay[];
  /** Promises already past with work still left: orders and units. */
  overdue: { orders: number; units: number };
  /** Open orders with work left and no scheduled delivery at all. */
  unscheduled: number;
}

/** The promises of the next `span` days, day by day, from the latest scheduled
 *  delivery of every open order that still has work left; overdue ones and
 *  the never-scheduled counted beside. */
export function promisesAhead(rows: readonly ControlRow[], etas: ReadonlyMap<string, EtaLike>, todayISO: string, span = 14): PromisesAhead {
  const byDay = new Map<string, PromiseDay>();
  for (let i = 0; i < span; i++) {
    const d = addDaysISO(todayISO, i);
    byDay.set(d, { dateISO: d, units: 0, atRisk: 0, orders: 0 });
  }
  const overdue = { orders: 0, units: 0 };
  let unscheduled = 0;
  for (const r of rows) {
    if (r.status !== "open") continue;
    const left = tanksLeftOf(r);
    if (left === 0) continue;
    const e = etas.get(r.mo);
    const due = e?.dueISO ?? null;
    if (!due) { unscheduled += 1; continue; }
    if (due < todayISO) { overdue.orders += 1; overdue.units += left; continue; }
    const day = byDay.get(due);
    if (!day) continue; // beyond the span
    day.units += left;
    day.orders += 1;
    if (e && (e.late || e.blockedBy || r.onHold)) day.atRisk += left;
  }
  return { days: [...byDay.values()], overdue, unscheduled };
}

// ---- by customer ----

export interface CustomerStanding {
  customer: string;
  orders: number;
  required: number;
  complete: number;
  delivered: number;
  urgent: number;
}

export function byCustomer(rows: readonly ControlRow[]): CustomerStanding[] {
  const map = new Map<string, CustomerStanding>();
  for (const r of rows) {
    if (r.status !== "open") continue;
    const key = (r.customer ?? "").trim() || "—";
    const c = map.get(key) ?? { customer: key, orders: 0, required: 0, complete: 0, delivered: 0, urgent: 0 };
    c.orders += 1;
    c.required += r.required;
    c.complete += tankUnitsOf(r);
    c.delivered += deliveredUnitsOf(r);
    if (r.urgent) c.urgent += 1;
    map.set(key, c);
  }
  return [...map.values()].sort((a, b) => b.required - a.required || a.customer.localeCompare(b.customer));
}

// ---- this month against last ----

export interface MonthCompare {
  dept: string;
  mtd: number;
  lastMonth: number;
  /** What this month closes at if the run-rate so far holds; null before any working day has passed. */
  projected: number | null;
}

export function monthCompareOf(dept: string, mtd: number, lastMonth: number, elapsedWd: number, monthWd: number): MonthCompare {
  return { dept, mtd, lastMonth, projected: elapsedWd > 0 ? Math.round((mtd / elapsedWd) * monthWd) : null };
}

/** The first day of the month `iso` falls in, and of the month before. */
export function monthBoundsISO(iso: string): { thisStart: string; lastStart: string; lastEnd: string } {
  const d = new Date(`${iso}T00:00:00Z`);
  const thisStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const lastStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  const lastEnd = new Date(thisStart.getTime() - 86400000);
  const f = (x: Date) => x.toISOString().slice(0, 10);
  return { thisStart: f(thisStart), lastStart: f(lastStart), lastEnd: f(lastEnd) };
}
