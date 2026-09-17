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
  orders: number;
  required: number; // units (transformers) on the open orders
  complete: number; // units finished — every required component through its last stage
  delivered: number; // units the customer has received in full
  remaining: number;
  pct: number | null; // complete / required
  urgent: number;
  priority: number;
  onHold: number;
}

/** A unit is delivered when every required component of it was delivered. */
export function deliveredUnitsOf(r: ControlRow): number {
  let m = Infinity;
  for (const it of ITEMS) {
    if (!needed(r, it)) continue;
    m = Math.min(m, cap(r.items[it].delivered + r.items[it].osp, r.required));
  }
  return Number.isFinite(m) ? m : 0;
}

export function planSummaryOf(rows: readonly ControlRow[]): PlanSummary {
  const open = rows.filter((r) => r.status === "open");
  const required = open.reduce((s, r) => s + r.required, 0);
  const complete = open.reduce((s, r) => s + Math.min(r.complete, r.required), 0);
  const delivered = open.reduce((s, r) => s + deliveredUnitsOf(r), 0);
  return {
    orders: open.length,
    required,
    complete,
    delivered,
    remaining: Math.max(0, required - complete),
    pct: required > 0 ? complete / required : null,
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
  /** Pieces finished per working day over the trailing window. */
  actualPerDay: number | null;
  /** Pieces per working day the remaining work needs to land by month end. */
  requiredPerDay: number | null;
  daysLeft: number;
  /** actual / required — ≥ 1 means the month lands at this pace. */
  ratio: number | null;
  /** Working days the remaining pieces take at the actual pace. */
  daysNeeded: number | null;
}

export function paceOf(remainingPieces: number, finishedInWindow: number, windowWorkingDays: number, daysLeft: number): Pace {
  const actualPerDay = windowWorkingDays > 0 ? finishedInWindow / windowWorkingDays : null;
  const requiredPerDay = daysLeft > 0 ? remainingPieces / daysLeft : null;
  const ratio = actualPerDay !== null && requiredPerDay !== null && requiredPerDay > 0 ? actualPerDay / requiredPerDay : null;
  const daysNeeded = actualPerDay !== null && actualPerDay > 0 ? Math.ceil(remainingPieces / actualPerDay) : null;
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
    const remaining = Math.max(0, r.required - r.complete);
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
