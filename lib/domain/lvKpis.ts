// The LV panels' KPIs — pure, so the panels' Planning and Production
// dashboards and the assistant compute every figure with one tested
// function from the same records.
//
// A panel is ONE thing through four stages (punched, bent, welded, painted,
// then delivered), planned month by month with no delivery date of its own,
// so the panels' figures are not the transformers' with the names changed:
//   - the plan is the MONTH's orders, judged against an even pace through the
//     month's working days (no oven dates, no lead days, no weekly burn-up);
//   - the work between stages is read off the chain, netted order by order
//     (punched − bent is waiting for bending), never by adding stage outputs;
//   - the hours are the panels' own: the timings sheet's LV tab prices a
//     panel per stage (lib/domain/lvStd.ts), and the shift log books the
//     panels' four departments. The shot-blast crew is the transformers'
//     and blasts the panels too: its hours stay on the transformers' side.
//   - the machines are recorded by DEPARTMENT, and the punches are shared
//     with the transformers, so no stop is the panels' alone.

import { floorActions, monthPace, type ManpowerCalendar, type ManpowerInput, type ManpowerRow, type MonthPaceRow, type CockpitAction } from "./kpis";
import { LV_STAGES, lvStageOf, lvWaiting, type LvState, type LvStage } from "./lv";
import { LV_DEPT_STAGE, type LvRate } from "./lvStd";
import type { RosterDept } from "./shifts";

/** The panels' four departments on the shift log, in shop-floor order. */
export const LV_FLOOR_DEPTS = ["Punching", "Bending", "WeldingLV", "PaintingLV"] as const satisfies readonly RosterDept[];
export type LvFloorDept = (typeof LV_FLOOR_DEPTS)[number];
export function isLvFloorDept(x: unknown): x is LvFloorDept {
  return typeof x === "string" && (LV_FLOOR_DEPTS as readonly string[]).includes(x);
}
export const LV_FLOOR_DEPT_LABEL: Record<LvFloorDept, string> = { Punching: "Punching", Bending: "Bending", WeldingLV: "Welding (LV)", PaintingLV: "Painting (LV)" };
/** The stage of the chain each department's output is recorded under. */
export const LV_DEPT_STAGE_OF: Record<LvFloorDept, LvStage> = { Punching: "Punching", Bending: "Bending", WeldingLV: "Welding", PaintingLV: "Painting" };

/** The Production dashboard's department filter on the panels. */
export type LvFloorFilter = "all" | LvFloorDept;
/** A filter as a link or the assistant may write it: a department's own
 *  name, or the stage it works ("Welding" → WeldingLV); anything else is all. */
export function lvFloorDeptOf(x: unknown): LvFloorFilter {
  if (typeof x !== "string" || x === "all") return "all";
  return isLvFloorDept(x) ? x : lvDeptOfStage(x) ?? "all";
}
/** A record with a zero for each of the panels' departments. */
export const zeroLvDepts = (): Record<LvFloorDept, number> => Object.fromEntries(LV_FLOOR_DEPTS.map((d) => [d, 0])) as Record<LvFloorDept, number>;
/** A record with a zero for each stage of the chain. */
export const zeroLvStages = (): Record<LvStage, number> => Object.fromEntries(LV_STAGES.map((s) => [s, 0])) as Record<LvStage, number>;
export function lvDeptsOf(f: LvFloorFilter): LvFloorDept[] {
  return f === "all" ? [...LV_FLOOR_DEPTS] : [f];
}
/** The department that records a stage of the chain — none for delivery. */
export function lvDeptOfStage(stage: string): LvFloorDept | null {
  return LV_FLOOR_DEPTS.find((d) => LV_DEPT_STAGE_OF[d] === stage) ?? null;
}

/** The std-hours one panel is worth at a department, off its sheet row —
 *  the column the timings sheet gives that department (lvStd's own map). */
export function lvRateAt(rate: LvRate, dept: LvFloorDept): number {
  return rate[LV_DEPT_STAGE[dept]!];
}

// ------------------------------------------------------------ between stages

/** Panels waiting between the stages of the chain, over the open orders —
 *  netted order by order, so a stage's output is never added to the next's. */
export interface LvWip {
  /** Planned and not punched yet (orders not on hold). */
  notStarted: number;
  waitingBend: number;
  waitingWeld: number;
  waitingPaint: number;
  /** Painted and not delivered yet. */
  waitingDelivery: number;
  /** Panels still to make on the orders the planner paused — out of the queues. */
  onHold: number;
  /** Orders counted, and those on hold. */
  orders: number;
  heldOrders: number;
}

export function lvWip(rows: readonly { state: LvState; onHold: boolean }[]): LvWip {
  const w: LvWip = { notStarted: 0, waitingBend: 0, waitingWeld: 0, waitingPaint: 0, waitingDelivery: 0, onHold: 0, orders: rows.length, heldOrders: 0 };
  const gap = (a: number, b: number) => Math.max(0, a - b);
  for (const { state: raw, onHold } of rows) {
    // a stage over-recorded past the order's quantity owes the next stage no more than the order does
    const c = (v: number) => cap(v, raw.required);
    const s: LvState = { required: raw.required, punch: c(raw.punch), bend: c(raw.bend), weld: c(raw.weld), paint: c(raw.paint), delivered: c(raw.delivered) };
    if (onHold) {
      w.heldOrders += 1;
      w.onHold += gap(s.required, s.paint);
      continue;
    }
    // what each stage's worklist owes on the order — the chain's own rule (lvWaiting)
    w.notStarted += lvWaiting(s, "Punching");
    w.waitingBend += lvWaiting(s, "Bending");
    w.waitingWeld += lvWaiting(s, "Welding");
    w.waitingPaint += lvWaiting(s, "Painting");
    w.waitingDelivery += gap(s.paint, s.delivered);
  }
  return w;
}

// -------------------------------------------------------------- the month

export interface LvStageProgress {
  stage: LvStage;
  required: number;
  /** Panels through the stage, each order capped at its own quantity. */
  done: number;
}

export interface LvMonthProgress {
  monthLabel: string;
  /** Orders with a quantity; one without has nothing to judge the month on. */
  orders: number;
  panels: number;
  /** Painted — the panel is finished when painted; delivery is the customer's. */
  complete: number;
  remaining: number;
  /** Of the painted, painted before the month began (orders carried over). */
  paintedBefore: number;
  byStage: LvStageProgress[];
  /** Where the month stands against an even pace through its working days (monthPace's own rule). */
  pace: MonthPaceRow<"panels">;
}

/** A stage's figure held to the order's quantity; an order without one is not capped. */
export const cap = (v: number, required: number) => (required > 0 ? Math.min(v, required) : v);

/** What the chain had done on an order before the month began — the panels
 *  a carried-over order brought along, per stage (uncapped, as the ledger sums them). */
export type LvBefore = Partial<Record<LvStage, number>>;

/** The month's plan through the chain: what it asks, what each stage has
 *  done of it, and where that stands against the month's working days — the
 *  same even-pace rule the transformers' month card uses, in panels: work a
 *  carried-over order brought from before the month starts the pace there
 *  (`before`), so the month owes only the rest. An order with no quantity
 *  is left out — there is nothing to judge it on. */
export function lvMonthProgress(rows: readonly { state: LvState; before?: LvBefore }[], monthLabel: string, cal: Pick<ManpowerCalendar, "monthWd" | "leftWd">): LvMonthProgress {
  const planned = rows.filter((r) => r.state.required > 0);
  const panels = planned.reduce((s, r) => s + r.state.required, 0);
  const doneAt = (stage: LvStage) => planned.reduce((s, r) => s + cap(lvStageOf(r.state, stage), r.state.required), 0);
  const byStage = LV_STAGES.map((stage) => ({ stage, required: panels, done: doneAt(stage) }));
  const complete = doneAt("Painting");
  const paintedBefore = planned.reduce((s, r) => s + Math.min(cap(r.before?.Painting ?? 0, r.state.required), cap(r.state.paint, r.state.required)), 0);
  return {
    monthLabel,
    orders: planned.length,
    panels,
    complete,
    remaining: Math.max(0, panels - complete),
    paintedBefore,
    byStage,
    pace: monthPace<"panels">([{ centre: "panels", requiredH: panels, doneH: complete, doneBeforeH: paintedBefore }], cal)[0],
  };
}

// ------------------------------------------------------------- the people

export interface LvManpowerCoverage {
  orders: number;
  /** Orders whose panel the timings sheet prices. */
  priced: number;
  panels: number;
  pricedPanels: number;
}

/** The month's plan in standard hours per department — each order's panels
 *  × its sheet row, what the stages have done of it priced the same way —
 *  with how much of the plan the sheet covers (an unpriced order asks no
 *  hours, so the people needed read low, never high). */
export function lvManpowerInputs(
  rows: readonly { state: LvState; rate: LvRate | null; before?: LvBefore }[],
  present: Partial<Record<LvFloorDept, number | null>>,
): { inputs: ManpowerInput<LvFloorDept>[]; coverage: LvManpowerCoverage } {
  const req = zeroLvDepts(), done = zeroLvDepts(), doneBefore = zeroLvDepts();
  const coverage: LvManpowerCoverage = { orders: rows.length, priced: 0, panels: 0, pricedPanels: 0 };
  for (const r of rows) {
    coverage.panels += r.state.required;
    if (!r.rate) continue;
    coverage.priced += 1;
    coverage.pricedPanels += r.state.required;
    for (const d of LV_FLOOR_DEPTS) {
      const h = lvRateAt(r.rate, d);
      const stage = LV_DEPT_STAGE_OF[d];
      const did = cap(lvStageOf(r.state, stage), r.state.required);
      req[d] += h * r.state.required;
      done[d] += h * did;
      doneBefore[d] += h * Math.min(did, cap(r.before?.[stage] ?? 0, r.state.required));
    }
  }
  return {
    inputs: LV_FLOOR_DEPTS.map((d) => ({ centre: d, requiredH: req[d], doneH: done[d], doneBeforeH: doneBefore[d], present: present[d] ?? null })),
    coverage,
  };
}

// ---------------------------------------------------------------- decisions

/** One department's recent pace, as the decisions read it. */
export interface LvDeptPace {
  dept: LvFloorDept;
  days: number;
  efficiency: number | null;
}

export interface LvActionInputs {
  month: LvMonthProgress;
  wip: LvWip;
  /** Urgent open orders still short, with the stage they are stuck at. */
  urgentStuck: readonly { mo: string; bom: string; remaining: number; stage: LvStage | null }[];
  manpower: readonly ManpowerRow<LvFloorDept>[];
  depts: readonly LvDeptPace[];
  coverage: LvManpowerCoverage;
  todayRecorded: boolean;
}

/** What needs a decision on the panels today, worst first — never more than six. */
export function lvPlanningActions(i: LvActionInputs): CockpitAction[] {
  const out: CockpitAction[] = [];
  const p = i.month.pace;
  if (p.tone === "bad") {
    out.push({ tone: "bad", href: "/tracker", text: `${i.month.monthLabel}'s plan is behind its pace: ${i.month.complete} of ${i.month.panels} panels painted (${Math.round((p.doneShare ?? 0) * 100)}%) where an even pace stands at ${Math.round(p.expectedShare * 100)}% — ${Math.ceil(Math.abs(p.aheadH))} panels behind.` });
  } else if (p.tone === "warn") {
    out.push({ tone: "warn", href: "/tracker", text: `${i.month.monthLabel}'s plan is a little behind its pace: ${Math.round((p.doneShare ?? 0) * 100)}% painted against ${Math.round(p.expectedShare * 100)}% expected by today.` });
  }
  if (i.urgentStuck.length > 0) {
    const first = i.urgentStuck[0];
    out.push({ tone: "bad", href: "/tracker", text: `${i.urgentStuck.length} urgent panel order${i.urgentStuck.length === 1 ? " is" : "s are"} still short — ${first.mo} (${first.bom}) owes ${first.remaining}${first.stage ? `, stuck at ${first.stage.toLowerCase()}` : ", not started"}.` });
  }
  // the chain's gaps: a stage starved, or parts piling in front of one
  const gaps: [number, string, string][] = [
    [i.wip.waitingBend, "bending", "/worklist/bending"],
    [i.wip.waitingWeld, "welding", "/worklist/welding"],
    [i.wip.waitingPaint, "painting", "/worklist/painting"],
  ];
  const biggest = gaps.sort((a, b) => b[0] - a[0])[0];
  if (biggest && biggest[0] > 0 && biggest[0] >= Math.max(10, i.wip.orders)) {
    out.push({ tone: "warn", href: biggest[2], text: `${biggest[0]} panels wait in front of ${biggest[1]} — the biggest queue on the chain.` });
  }
  // the shift log's side — the same rule as the transformers' cockpit, in the panels' words
  const floor = floorActions({
    manpower: i.manpower, centres: i.depts.map((d) => ({ centre: d.dept, days: d.days, efficiency: d.efficiency })), todayRecorded: i.todayRecorded,
    label: LV_FLOOR_DEPT_LABEL, words: { work: "panels", finish: "to finish them", standard: "the panels' standard", where: " on the panels" },
  });
  out.push(...floor.filter((a) => a.tone !== "info"));
  if (i.wip.heldOrders > 0) out.push({ tone: "info", href: "/tracker?status=hold", text: `${i.wip.heldOrders} panel order${i.wip.heldOrders === 1 ? "" : "s"} on hold — ${i.wip.onHold} panels out of every queue until released.` });
  if (i.coverage.orders > 0 && i.coverage.priced < i.coverage.orders) {
    out.push({ tone: "info", href: "/admin/standard-times", text: `${i.coverage.orders - i.coverage.priced} of ${i.coverage.orders} panel orders have no row on the timings sheet — their hours and people read as nothing.` });
  }
  out.push(...floor.filter((a) => a.tone === "info"));
  return out.slice(0, 6);
}
