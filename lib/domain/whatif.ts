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

import { forecastEtaQueued, ETA_STAGES, type EtaOrder, type EtaStage } from "./eta";

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
  }[];
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

export function simulate(inputs: WhatIfInputs, scenario: Scenario): WhatIfResult {
  const holidays = new Set(inputs.holidayISOs);

  // ---- capacity per stage under the scenario ----
  const scenarioCap: Partial<Record<WiStage, number>> = {};
  for (const s of WI_STAGES) {
    const base = inputs.capacity[s];
    const delta = scenario.workersDelta[s] * scenario.shiftHours;
    if (base !== undefined) scenarioCap[s] = Math.max(0, base + delta);
    else if (delta > 0) scenarioCap[s] = delta;
  }

  // ---- rates scale with the crew ----
  // the trailing rate is what TODAY'S crew does per day; changing the crew
  // scales it proportionally against the capacity it was achieved with
  const scenarioRates: Record<EtaStage, number> = { cut: 0, weld: 0, finish: 0 };
  for (const es of ETA_STAGES) {
    const baseCap = ETA_FEED[es].reduce((a, s) => a + (inputs.capacity[s] ?? 0), 0);
    const newCap = ETA_FEED[es].reduce((a, s) => a + (scenarioCap[s] ?? 0), 0);
    // no capacity figure to scale against → the rate stays what it is
    scenarioRates[es] = baseCap > 0 ? inputs.rates[es] * (newCap / baseCap) : inputs.rates[es];
  }

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
    };
  });

  return { stages, planWorkingDays, orders };
}
