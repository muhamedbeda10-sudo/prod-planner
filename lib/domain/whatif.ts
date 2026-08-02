/* The what-if simulator's arithmetic — every scenario is the SAME flow-shop
 * and capacity math the live pages use, just with the knobs turned:
 *
 *   workers   more/fewer people per stage → capacity grows AND the trailing
 *             rate scales with it (double the welders ≈ double the std-hours
 *             a day welds through)
 *   Fridays   the day off becomes a working day → the same daily rates land
 *             on more calendar days, and the plan window gains capacity days
 *   queue     hand-reorder the orders → who waits for whom at every station
 *
 * Pure on purpose: the server sends one snapshot of inputs and the browser
 * re-runs scenarios instantly, no round trips.
 */

import { forecastEtaQueued, ETA_STAGES, type EtaOrder, type EtaStage, type EtaSegment } from "./eta";

export const WI_STAGES = ["Cut", "Welding", "ShotBlast", "Painting"] as const;
export type WiStage = (typeof WI_STAGES)[number];

// which capacity stages feed each ETA station (finishing = shot blast + paint)
const ETA_FEED: Record<EtaStage, WiStage[]> = {
  cut: ["Cut"],
  weld: ["Welding"],
  finish: ["ShotBlast", "Painting"],
};

export interface WhatIfOrder extends EtaOrder {
  bom: string;
  baselineDays: number | null; // ETA in working days under today's reality
  blockedBy: EtaStage | null;
}

export interface WhatIfInputs {
  todayISO: string;
  holidayISOs: string[];
  rates: Record<EtaStage, number>; // trailing std-h/working day (today's crew)
  rateWindowDays: number;
  capacity: Partial<Record<WiStage, number>>; // mh per working day (Admin figure)
  orders: WhatIfOrder[]; // open orders, queued FIFO by due date (the baseline queue)
  plan: {
    planNo: number;
    minISO: string;
    maxISO: string;
    requiredByStage: Record<WiStage, number>;
  } | null;
}

export interface Scenario {
  /** Extra (or fewer) WORKERS per stage; hours each adds per day comes from shiftHours. */
  workersDelta: Record<WiStage, number>;
  shiftHours: number; // man-hours one worker adds per working day
  workFridays: boolean;
  queue: string[]; // MO ids in the order they should be worked
}

export const defaultScenario = (inputs: WhatIfInputs): Scenario => ({
  workersDelta: { Cut: 0, Welding: 0, ShotBlast: 0, Painting: 0 },
  shiftHours: 11,
  workFridays: false,
  queue: inputs.orders.map((o) => o.id),
});

export interface WhatIfResult {
  stages: {
    dept: WiStage;
    required: number;
    baselineAvailable: number | null;
    available: number | null; // scenario
    load: number | null; // scenario required/available
  }[];
  planWorkingDays: number; // scenario (Fridays may count)
  orders: {
    id: string;
    bom: string;
    dueISO: string | null;
    baselineISO: string | null; // null = done or blocked
    etaISO: string | null;
    deltaDays: number; // CALENDAR days scenario lands after baseline (negative = earlier)
    late: boolean; // scenario ETA after due
    done: boolean;
    blockedBy: EtaStage | null;
    segments: EtaSegment[]; // station-by-station occupancy, for the timeline
    dueOffset: number | null; // the due date as a working-day offset on the same axis
  }[];
  makespan: number; // working days until the LAST order clears (0 = all done)
}

const DAY = 86400000;
const parse = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const isWorkday = (t: number, holidays: Set<string>, fridaysWork: boolean) => {
  const d = new Date(t);
  if (!fridaysWork && d.getUTCDay() === 5) return false;
  return !holidays.has(d.toISOString().slice(0, 10));
};

/** Working days in [fromISO, toISO], inclusive. */
export function countWorkingDaysISO(fromISO: string, toISO: string, holidays: Set<string>, fridaysWork: boolean): number {
  let n = 0;
  for (let t = parse(fromISO); t <= parse(toISO); t += DAY) if (isWorkday(t, holidays, fridaysWork)) n++;
  return n;
}

/** A calendar date → its working-day offset on the same axis dateForOffsetISO
 *  uses (the offset whose ceil lands on that date). Dates in the past pin
 *  to 0. */
export function offsetForDateISO(iso: string, todayISO: string, holidays: Set<string>, fridaysWork: boolean): number {
  const target = parse(iso);
  let t = parse(todayISO);
  while (!isWorkday(t, holidays, fridaysWork)) t += DAY;
  if (target < t) return 0; // already past
  let offset = 1; // the first working day carries offset 1
  while (t < target) {
    t += DAY;
    if (isWorkday(t, holidays, fridaysWork)) offset++;
  }
  return offset;
}

/** Working-day offset from today → calendar date (day 1 ends on the first
 *  working day). Mirrors the live ETA column's mapping. */
export function dateForOffsetISO(days: number, todayISO: string, holidays: Set<string>, fridaysWork: boolean): string {
  let t = parse(todayISO);
  while (!isWorkday(t, holidays, fridaysWork)) t += DAY;
  let left = Math.max(0, Math.ceil(days) - 1);
  while (left > 0) {
    t += DAY;
    if (isWorkday(t, holidays, fridaysWork)) left--;
  }
  return new Date(t).toISOString().slice(0, 10);
}

/** Capacity per stage and station rates under a scenario's knobs — the rates
 *  scale with the crew: what TODAY'S crew does per day, proportional to the
 *  capacity figure it was achieved with. */
function scenarioPhysics(inputs: WhatIfInputs, scenario: Scenario): {
  cap: Partial<Record<WiStage, number>>;
  rates: Record<EtaStage, number>;
} {
  const cap: Partial<Record<WiStage, number>> = {};
  for (const s of WI_STAGES) {
    const base = inputs.capacity[s];
    const delta = scenario.workersDelta[s] * scenario.shiftHours;
    if (base !== undefined) cap[s] = Math.max(0, base + delta);
    else if (delta > 0) cap[s] = delta;
  }
  const rates: Record<EtaStage, number> = { cut: 0, weld: 0, finish: 0 };
  for (const es of ETA_STAGES) {
    const baseCap = ETA_FEED[es].reduce((a, s) => a + (inputs.capacity[s] ?? 0), 0);
    const newCap = ETA_FEED[es].reduce((a, s) => a + (cap[s] ?? 0), 0);
    // no capacity figure to scale against → the rate stays what it is
    rates[es] = baseCap > 0 ? inputs.rates[es] * (newCap / baseCap) : inputs.rates[es];
  }
  return { cap, rates };
}

export function simulate(inputs: WhatIfInputs, scenario: Scenario): WhatIfResult {
  const holidays = new Set(inputs.holidayISOs);
  const { cap: scenarioCap, rates: scenarioRates } = scenarioPhysics(inputs, scenario);

  // ---- the plan's week under the scenario ----
  let planWorkingDays = 0;
  const stages: WhatIfResult["stages"] = [];
  if (inputs.plan) {
    planWorkingDays = countWorkingDaysISO(inputs.plan.minISO, inputs.plan.maxISO, holidays, scenario.workFridays);
    const baselineDays = countWorkingDaysISO(inputs.plan.minISO, inputs.plan.maxISO, holidays, false);
    for (const dept of WI_STAGES) {
      const required = inputs.plan.requiredByStage[dept];
      const basePerDay = inputs.capacity[dept];
      const scenPerDay = scenarioCap[dept];
      const available = scenPerDay !== undefined ? scenPerDay * planWorkingDays : null;
      stages.push({
        dept,
        required,
        baselineAvailable: basePerDay !== undefined ? basePerDay * baselineDays : null,
        available,
        load: available ? required / available : null,
      });
    }
  }

  // ---- ETAs under the scenario, in the hand-picked queue order ----
  const byId = new Map(inputs.orders.map((o) => [o.id, o]));
  const queue = scenario.queue.map((id) => byId.get(id)!).filter(Boolean);
  // anything not mentioned keeps its baseline place at the back
  for (const o of inputs.orders) if (!scenario.queue.includes(o.id)) queue.push(o);

  const results = forecastEtaQueued(queue, scenarioRates);
  const orders = results.map((r) => {
    const o = byId.get(r.id)!;
    const done = ETA_STAGES.every((s) => o.hours[s] <= 0);
    const baselineISO =
      done || o.baselineDays === null ? null : dateForOffsetISO(o.baselineDays, inputs.todayISO, holidays, false);
    const etaISO =
      done || r.days === null ? null : dateForOffsetISO(r.days, inputs.todayISO, holidays, scenario.workFridays);
    return {
      id: r.id,
      bom: o.bom,
      dueISO: o.dueISO,
      baselineISO,
      etaISO,
      deltaDays: etaISO && baselineISO ? Math.round((parse(etaISO) - parse(baselineISO)) / DAY) : 0,
      late: !!etaISO && !!o.dueISO && etaISO > o.dueISO,
      done,
      blockedBy: r.blockedBy,
      segments: done ? [] : r.segments,
      dueOffset: o.dueISO ? offsetForDateISO(o.dueISO, inputs.todayISO, holidays, scenario.workFridays) : null,
    };
  });
  const makespan = orders.reduce((m, o) => Math.max(m, o.segments.length ? o.segments[o.segments.length - 1].end : 0), 0);

  return { stages, planWorkingDays, orders, makespan };
}

/* ---------------------------- queue optimizer ---------------------------- */

// what "best" means, in order: fewest late orders, then the least total
// lateness (working days), then the earliest overall finish
type QueueScore = [late: number, latenessWd: number, makespan: number];
const better = (a: QueueScore, b: QueueScore) =>
  a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] - 1e-9 : a[2] < b[2] - 1e-9;

/** The best queue this scenario's knobs allow: starts from the due-date order
 *  and moves one order at a time to wherever it helps, until nothing does.
 *  Deterministic, and never returns something worse than the due-date queue. */
export function optimizeQueue(inputs: WhatIfInputs, scenario: Scenario): string[] {
  const { rates } = scenarioPhysics(inputs, scenario);
  const holidays = new Set(inputs.holidayISOs);
  const byId = new Map(inputs.orders.map((o) => [o.id, o]));
  const dueOff = new Map(
    inputs.orders.map((o) => [
      o.id,
      o.dueISO ? offsetForDateISO(o.dueISO, inputs.todayISO, holidays, scenario.workFridays) : null,
    ])
  );

  const score = (ids: string[]): QueueScore => {
    const results = forecastEtaQueued(ids.map((id) => byId.get(id)!), rates);
    let late = 0, lateness = 0, makespan = 0;
    for (const r of results) {
      if (r.days === null || r.segments.length === 0) continue; // done or blocked — not schedulable
      const end = r.segments[r.segments.length - 1].end;
      makespan = Math.max(makespan, end);
      const due = dueOff.get(r.id);
      if (due !== null && due !== undefined && end > due) {
        late++;
        lateness += end - due;
      }
    }
    return [late, lateness, makespan];
  };

  // start from the FIFO-by-due-date order (the baseline queue)
  let queue = inputs.orders.map((o) => o.id);
  let best = score(queue);

  // insertion local search: try every (order, position) move, keep the best
  // improvement, repeat until a full pass finds nothing (capped for safety)
  for (let pass = 0; pass < 6; pass++) {
    let improved = false;
    for (let i = 0; i < queue.length; i++) {
      for (let j = 0; j < queue.length; j++) {
        if (i === j) continue;
        const cand = [...queue];
        const [moved] = cand.splice(i, 1);
        cand.splice(j, 0, moved);
        const s = score(cand);
        if (better(s, best)) {
          queue = cand;
          best = s;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return queue;
}
