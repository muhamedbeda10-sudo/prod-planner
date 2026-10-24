/* The what-if simulator's arithmetic — every scenario is the SAME flow-shop
 * and capacity math the live pages use, just with the knobs turned:
 *
 *   workers   more/fewer people per stage → capacity grows AND the trailing
 *             rate scales with it (double the welders ≈ double the std-hours
 *             a day welds through)
 *   Fridays   the day off becomes a working day → the same daily rates land
 *             on more calendar days, and the plan window gains capacity days
 *   queue     hand-reorder the JOBS → who waits for whom at every station
 *   splits    carve a job's quantity into prioritized batches
 *
 * The unit of work is a JOB — one component of one order (MO × item) with its
 * own remaining pieces per stage — so the TC of an order can jump the queue
 * while its TN waits, exactly like pieces move on the real floor. Splitting a
 * job hands the FIRST batch the most-advanced pieces (the ones closest to
 * done), which is what a foreman rushing a partial delivery actually does.
 *
 * Pure on purpose: the server sends one snapshot of inputs and the browser
 * re-runs scenarios instantly, no round trips.
 */

import { forecastEtaQueued, ETA_STAGES, type EtaStage, type EtaSegment, type StageBlackout } from "./eta";

export const WI_STAGES = ["Cut", "Welding", "ShotBlast", "Painting"] as const;
export type WiStage = (typeof WI_STAGES)[number];

// which capacity stages feed each ETA station (finishing = shot blast + paint)
const ETA_FEED: Record<EtaStage, WiStage[]> = {
  cut: ["Cut"],
  weld: ["Welding"],
  finish: ["ShotBlast", "Painting"],
};

/** PIECES still to pass each station (physical chain: cut ≤ weld ≤ finish). */
export interface StagePcs {
  cut: number;
  weld: number;
  finish: number;
}

/** One order-component: what the queue actually schedules. */
export interface WhatIfJob {
  id: string; // "MO|ITEM"
  mo: string;
  bom: string;
  item: string; // CF | TC | TN | CB
  dueISO: string | null; // the MO's latest scheduled delivery
  left: StagePcs; // pieces still owed per stage
  perPc: Record<EtaStage, number>; // std-hours ONE piece costs each station
  baselineDays: number | null; // job ETA in working days under today's reality
  blockedBy: EtaStage | null;
}

export interface WhatIfInputs {
  coverage?: import("./simulationReview").ForecastCoverage;
  todayISO: string;
  holidayISOs: string[];
  rates: Record<EtaStage, number>; // trailing std-h/working day (today's crew)
  rateSigma: Record<EtaStage, number>; // day-to-day scatter of those rates
  rateWindowDays: number;
  capacity: Partial<Record<WiStage, number>>; // mh per working day (Admin figure)
  jobs: WhatIfJob[]; // open jobs, queued FIFO by due date (the baseline queue)
  plan: {
    planNo: number;
    minISO: string;
    maxISO: string;
    requiredByStage: Record<WiStage, number>;
  } | null;
}

export interface Downtime {
  stage: EtaStage; // which station stands still
  fromISO: string; // first calendar day of the stoppage
  toISO: string; // last calendar day (inclusive)
}

export interface Scenario {
  /** Extra (or fewer) WORKERS per stage; hours each adds per day comes from shiftHours. */
  workersDelta: Record<WiStage, number>;
  shiftHours: number; // man-hours one worker adds per working day
  workFridays: boolean;
  queue: string[]; // job ids (or split-batch ids) in the order they get worked
  splits: Record<string, number[]>; // base job id → batch sizes (sum = its finish-left)
  /** base job id → the calendar day its material/parts arrive — it cannot start earlier. */
  holds: Record<string, string>;
  downtimes: Downtime[];
}

export const defaultScenario = (inputs: WhatIfInputs): Scenario => ({
  workersDelta: { Cut: 0, Welding: 0, ShotBlast: 0, Painting: 0 },
  shiftHours: 11,
  workFridays: false,
  queue: inputs.jobs.map((j) => j.id),
  splits: {},
  holds: {},
  downtimes: [],
});

/** A job as it enters the queue after splits — a whole job, or one batch. */
export interface DerivedJob extends WhatIfJob {
  baseId: string; // the unsplit job this came from (== id when unsplit)
  batch: number | null; // 1-based batch number, null when unsplit
}

export interface WhatIfResult {
  stages: {
    dept: WiStage;
    required: number;
    baselineAvailable: number | null;
    available: number | null; // scenario
    load: number | null; // scenario required/available
  }[];
  planWorkingDays: number; // scenario (Fridays may count)
  jobs: {
    id: string;
    baseId: string;
    batch: number | null;
    mo: string;
    bom: string;
    item: string;
    qty: number; // pieces this row delivers (its finish-left)
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
  makespan: number; // working days until the LAST job clears (0 = all done)
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

/** How many working days from today come strictly before `iso` — where a
 *  window that opens on that date starts. The day before is asked for, so a
 *  window opening on a day off (a Friday, a holiday) starts after the last
 *  working day before it instead of swallowing that day too. */
export function workdaysBeforeISO(iso: string, todayISO: string, holidays: Set<string>, fridaysWork: boolean): number {
  const dayBefore = new Date(parse(iso) - DAY).toISOString().slice(0, 10);
  return offsetForDateISO(dayBefore, todayISO, holidays, fridaysWork);
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

/** Apply the scenario's splits: each base job becomes its batches, the FIRST
 *  batch taking the most-advanced pieces (fewest stations left to visit) —
 *  rushing a partial delivery starts from what is closest to done. */
export function deriveJobs(inputs: WhatIfInputs, scenario: Scenario): DerivedJob[] {
  const out: DerivedJob[] = [];
  for (const j of inputs.jobs) {
    const sizes = scenario.splits[j.id];
    if (!sizes || sizes.length < 2 || sizes.reduce((a, b) => a + b, 0) !== j.left.finish) {
      out.push({ ...j, baseId: j.id, batch: null });
      continue;
    }
    let { cut, weld, finish } = j.left;
    for (let b = 0; b < sizes.length; b++) {
      const q = sizes[b];
      // the pieces NOT in this batch (still behind it) keep their arrears;
      // this batch carries only what its own most-advanced q pieces still owe
      const behind = finish - q;
      const bWeld = Math.max(0, weld - behind);
      const bCut = Math.max(0, cut - behind);
      out.push({
        ...j,
        id: `${j.id}#${b + 1}`,
        baseId: j.id,
        batch: b + 1,
        left: { cut: bCut, weld: bWeld, finish: q },
      });
      cut -= bCut;
      weld -= bWeld;
      finish -= q;
    }
  }
  return out;
}

const hoursOf = (j: DerivedJob): Record<EtaStage, number> => ({
  cut: j.left.cut * j.perPc.cut,
  weld: j.left.weld * j.perPc.weld,
  finish: j.left.finish * j.perPc.finish,
});

/** The scenario's downtimes as blackout windows on the working-day axis
 *  (a downtime that falls entirely on days off vanishes by itself). */
export function blackoutsOf(scenario: Scenario, todayISO: string, holidays: Set<string>): Partial<Record<EtaStage, StageBlackout[]>> {
  const out: Partial<Record<EtaStage, StageBlackout[]>> = {};
  for (const d of scenario.downtimes) {
    if (!d.fromISO || !d.toISO || d.toISO < d.fromISO) continue;
    const start = workdaysBeforeISO(d.fromISO, todayISO, holidays, scenario.workFridays);
    const end = offsetForDateISO(d.toISO, todayISO, holidays, scenario.workFridays);
    if (end <= start) continue; // already past, or all days off
    (out[d.stage] ??= []).push({ start, end });
  }
  for (const s of Object.keys(out) as EtaStage[]) {
    const bls = out[s]!.sort((a, b) => a.start - b.start);
    // merge overlaps so the station walker can assume disjoint windows
    const merged: StageBlackout[] = [];
    for (const b of bls) {
      const last = merged[merged.length - 1];
      if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
      else merged.push({ ...b });
    }
    out[s] = merged;
  }
  return out;
}

/** A job's earliest start on the axis, from its material-hold date. */
export function releaseOf(holdISO: string | undefined, todayISO: string, holidays: Set<string>, fridaysWork: boolean): number {
  if (!holdISO) return 0;
  return workdaysBeforeISO(holdISO, todayISO, holidays, fridaysWork);
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
  const derived = deriveJobs(inputs, scenario);
  const byId = new Map(derived.map((j) => [j.id, j]));
  const queue: DerivedJob[] = scenario.queue.map((id) => byId.get(id)!).filter(Boolean);
  // anything the queue doesn't mention (fresh splits, new jobs) joins the back
  for (const j of derived) if (!queue.includes(j)) queue.push(j);

  const blackouts = blackoutsOf(scenario, inputs.todayISO, holidays);
  const results = forecastEtaQueued(
    queue.map((j) => ({
      id: j.id,
      dueISO: j.dueISO,
      hours: hoursOf(j),
      release: releaseOf(scenario.holds[j.baseId], inputs.todayISO, holidays, scenario.workFridays),
    })),
    scenarioRates,
    blackouts
  );
  const jobs = results.map((r) => {
    const j = byId.get(r.id)!;
    const done = j.left.cut <= 0 && j.left.weld <= 0 && j.left.finish <= 0;
    const baselineISO =
      done || j.baselineDays === null ? null : dateForOffsetISO(j.baselineDays, inputs.todayISO, holidays, false);
    const etaISO =
      done || r.days === null ? null : dateForOffsetISO(r.days, inputs.todayISO, holidays, scenario.workFridays);
    return {
      id: j.id,
      baseId: j.baseId,
      batch: j.batch,
      mo: j.mo,
      bom: j.bom,
      item: j.item,
      qty: j.left.finish,
      dueISO: j.dueISO,
      baselineISO,
      etaISO,
      deltaDays: etaISO && baselineISO ? Math.round((parse(etaISO) - parse(baselineISO)) / DAY) : 0,
      late: !!etaISO && !!j.dueISO && etaISO > j.dueISO,
      done,
      blockedBy: r.blockedBy,
      segments: done ? [] : r.segments,
      dueOffset: j.dueISO ? offsetForDateISO(j.dueISO, inputs.todayISO, holidays, scenario.workFridays) : null,
    };
  });
  const makespan = jobs.reduce((m, o) => Math.max(m, o.segments.length ? o.segments[o.segments.length - 1].end : 0), 0);

  return { stages, planWorkingDays, jobs, makespan };
}

/* ---------------------------- queue optimizer ---------------------------- */

// what "best" means, in order: fewest late jobs, then the least total
// lateness (working days), then the earliest overall finish
type QueueScore = [late: number, latenessWd: number, makespan: number];
const better = (a: QueueScore, b: QueueScore) =>
  a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] - 1e-9 : a[2] < b[2] - 1e-9;

/** The best queue this scenario's knobs allow: starts from the due-date order
 *  and moves one job at a time to wherever it helps, until nothing does.
 *  Deterministic, and never returns something worse than the due-date queue.
 *  Splits are respected — batches are moved like any other job. */
export function optimizeQueue(inputs: WhatIfInputs, scenario: Scenario): string[] {
  return searchQueue(inputs, scenario, Infinity, () => 0).queue;
}

/** The same search with a time limit — for a caller that cannot wait as long
 *  as a person at the screen does (the assistant, inside one request). Past
 *  the limit it stops and returns the best queue found so far, still never
 *  worse than the due-date order; `complete` says whether it got to the end. */
export function optimizeQueueWithin(
  inputs: WhatIfInputs,
  scenario: Scenario,
  budgetMs: number,
  now: () => number = Date.now,
): { queue: string[]; complete: boolean } {
  return searchQueue(inputs, scenario, budgetMs, now);
}

function searchQueue(inputs: WhatIfInputs, scenario: Scenario, budgetMs: number, now: () => number): { queue: string[]; complete: boolean } {
  const until = now() + budgetMs;
  const { rates } = scenarioPhysics(inputs, scenario);
  const holidays = new Set(inputs.holidayISOs);
  const derived = deriveJobs(inputs, scenario);
  const byId = new Map(derived.map((j) => [j.id, j]));
  const dueOff = new Map(
    derived.map((j) => [
      j.id,
      j.dueISO ? offsetForDateISO(j.dueISO, inputs.todayISO, holidays, scenario.workFridays) : null,
    ])
  );

  const blackouts = blackoutsOf(scenario, inputs.todayISO, holidays);
  const score = (ids: string[]): QueueScore => {
    const results = forecastEtaQueued(
      ids.map((id) => {
        const j = byId.get(id)!;
        return {
          id: j.id,
          dueISO: j.dueISO,
          hours: hoursOf(j),
          release: releaseOf(scenario.holds[j.baseId], inputs.todayISO, holidays, scenario.workFridays),
        };
      }),
      rates,
      blackouts
    );
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

  // start from the FIFO-by-due-date order over the derived jobs
  let queue = derived.map((j) => j.id);
  let best = score(queue);

  // insertion local search: try every (job, position) move, keep the best
  // improvement, repeat until a full pass finds nothing (capped for safety)
  for (let pass = 0; pass < 6; pass++) {
    let improved = false;
    for (let i = 0; i < queue.length; i++) {
      // the clock is read once per job moved — cheap next to the n tries
      if (now() > until) return { queue, complete: false };
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
  return { queue, complete: true };
}
