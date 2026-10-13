// A what-if scenario as data — pure, beside the simulator's arithmetic
// (lib/domain/whatif.ts):
//
//   parseScenario  checks a scenario before it is saved, from the Simulator's
//                  Save button or the assistant — a saved scenario is shared
//                  by everyone, so a malformed or oversized one never lands;
//   withKnobs      turns the few knobs a person (or the assistant) names —
//                  "two more welders, Fridays on, the laser down Sunday to
//                  Tuesday, rush MO 4471" — into a whole scenario, and
//                  knobsOfScenario reads them back out of one;
//   kpisOf, describeScenario, scenarioCost — how the Simulator sums one up.

import { deptLabel } from "./constants";
import { parseISODate, toISODate } from "./dates";
import { ETA_STAGES, type EtaStage } from "./eta";
import { defaultScenario, deriveJobs, WI_STAGES, type Downtime, type Scenario, type WhatIfInputs, type WhatIfResult, type WiStage } from "./whatif";

export const SCENARIO_LIMITS = {
  /** Workers added or taken away at one department. */
  workers: 500,
  shiftHoursMin: 1,
  shiftHoursMax: 24,
  /** Job and batch ids in the queue. */
  queue: 5000,
  idLength: 120,
  splits: 1000,
  batches: 50,
  holds: 1000,
  downtimes: 100,
  nameLength: 60,
} as const;

/** The name a scenario is saved under — trimmed, one line, 60 characters. */
export function scenarioName(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, SCENARIO_LIMITS.nameLength);
}

/** A real calendar day written YYYY-MM-DD. */
export function isDayISO(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const d = parseISODate(v);
  return d !== null && toISODate(d) === v;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= SCENARIO_LIMITS.idLength;

export type ScenarioCheck = { ok: true; scenario: Scenario } | { ok: false; error: string };

/** A scenario as it may be saved, or what is wrong with it. Missing knobs
 *  take reality's value; anything malformed is refused, not guessed. */
export function parseScenario(raw: unknown): ScenarioCheck {
  if (!isObject(raw)) return { ok: false, error: "The scenario is not readable." };
  const L = SCENARIO_LIMITS;

  const workersDelta = { Cut: 0, Welding: 0, ShotBlast: 0, Painting: 0 } as Record<WiStage, number>;
  if (raw.workersDelta !== undefined) {
    if (!isObject(raw.workersDelta)) return { ok: false, error: "The workers' change is not readable." };
    for (const [k, v] of Object.entries(raw.workersDelta)) {
      if (!(WI_STAGES as readonly string[]).includes(k)) return { ok: false, error: `Unknown department ${k} in the workers' change.` };
      if (typeof v !== "number" || !Number.isInteger(v) || Math.abs(v) > L.workers) return { ok: false, error: `The workers added at ${deptLabel(k)} must be a whole number within ±${L.workers}.` };
      workersDelta[k as WiStage] = v;
    }
  }

  const shiftHours = raw.shiftHours === undefined ? 11 : raw.shiftHours;
  if (typeof shiftHours !== "number" || !Number.isFinite(shiftHours) || shiftHours < L.shiftHoursMin || shiftHours > L.shiftHoursMax) {
    return { ok: false, error: `The hours a worker adds a day must be between ${L.shiftHoursMin} and ${L.shiftHoursMax}.` };
  }
  if (raw.workFridays !== undefined && typeof raw.workFridays !== "boolean") return { ok: false, error: "Fridays must be on or off." };

  const queue: string[] = [];
  if (raw.queue !== undefined) {
    if (!Array.isArray(raw.queue) || raw.queue.length > L.queue) return { ok: false, error: `The queue must be a list of at most ${L.queue} jobs.` };
    const seen = new Set<string>();
    for (const id of raw.queue) {
      if (!isId(id)) return { ok: false, error: "The queue holds an unreadable job." };
      if (seen.has(id)) return { ok: false, error: `The queue holds ${id} twice.` };
      seen.add(id);
      queue.push(id);
    }
  }

  const splits: Record<string, number[]> = {};
  if (raw.splits !== undefined) {
    if (!isObject(raw.splits) || Object.keys(raw.splits).length > L.splits) return { ok: false, error: `At most ${L.splits} split jobs.` };
    for (const [id, sizes] of Object.entries(raw.splits)) {
      if (!isId(id)) return { ok: false, error: "A split names an unreadable job." };
      if (!Array.isArray(sizes) || sizes.length < 2 || sizes.length > L.batches || !sizes.every((n) => typeof n === "number" && Number.isInteger(n) && n > 0)) {
        return { ok: false, error: `The split of ${id} must be 2 to ${L.batches} batches of whole pieces.` };
      }
      splits[id] = sizes as number[];
    }
  }

  const holds: Record<string, string> = {};
  if (raw.holds !== undefined) {
    if (!isObject(raw.holds) || Object.keys(raw.holds).length > L.holds) return { ok: false, error: `At most ${L.holds} material holds.` };
    for (const [id, day] of Object.entries(raw.holds)) {
      if (!isId(id) || !isDayISO(day)) return { ok: false, error: `The material hold of ${String(id).slice(0, 40)} needs a real day.` };
      holds[id] = day;
    }
  }

  const downtimes: Downtime[] = [];
  if (raw.downtimes !== undefined) {
    if (!Array.isArray(raw.downtimes) || raw.downtimes.length > L.downtimes) return { ok: false, error: `At most ${L.downtimes} stoppages.` };
    for (const d of raw.downtimes) {
      if (!isObject(d) || !(ETA_STAGES as readonly string[]).includes(d.stage as string) || !isDayISO(d.fromISO) || !isDayISO(d.toISO)) {
        return { ok: false, error: "A stoppage needs its station (cut, weld or finish) and two real days." };
      }
      if (d.toISO < d.fromISO) return { ok: false, error: `A stoppage ends (${d.toISO}) before it starts (${d.fromISO}).` };
      downtimes.push({ stage: d.stage as EtaStage, fromISO: d.fromISO, toISO: d.toISO });
    }
  }

  return { ok: true, scenario: { workersDelta, shiftHours, workFridays: raw.workFridays === true, queue, splits, holds, downtimes } };
}

/** The knobs a scenario is built from, in a person's terms. Each one given
 *  replaces that knob of the scenario it starts from; one left out keeps it. */
export interface ScenarioKnobs {
  workersDelta?: Partial<Record<WiStage, number>>;
  shiftHours?: number;
  workFridays?: boolean;
  downtimes?: Downtime[];
  /** The day a job's material arrives — it cannot start before. */
  holds?: { job: string; untilISO: string }[];
  /** A job's pieces carved into batches, the first rushed ahead. */
  splits?: { job: string; batches: number[] }[];
  /** Jobs to work first, in this order: a job ("MO|ITEM"), one of its
   *  batches ("MO|ITEM#1"), or an MO — all of its jobs, in queue order. */
  first?: string[];
}

/** A scenario from the one it starts at and the knobs named, or what is wrong
 *  with them — every job named must be an open job of today's queue. */
export function withKnobs(inputs: WhatIfInputs, start: Scenario, k: ScenarioKnobs): ScenarioCheck {
  const jobs = new Map(inputs.jobs.map((j) => [j.id, j]));
  const sc: Scenario = {
    ...start,
    workersDelta: { ...start.workersDelta },
    splits: { ...start.splits },
    holds: { ...start.holds },
    downtimes: [...start.downtimes],
    queue: [...start.queue],
  };
  if (k.workersDelta) for (const s of WI_STAGES) if (k.workersDelta[s] !== undefined) sc.workersDelta[s] = k.workersDelta[s]!;
  if (k.shiftHours !== undefined) sc.shiftHours = k.shiftHours;
  if (k.workFridays !== undefined) sc.workFridays = k.workFridays;
  if (k.downtimes) sc.downtimes = k.downtimes.map((d) => ({ ...d }));
  if (k.holds) {
    sc.holds = {};
    for (const h of k.holds) {
      if (!jobs.has(h.job)) return { ok: false, error: `${h.job} is not an open job — a job is "MO|ITEM", as simulate_scenario lists them.` };
      sc.holds[h.job] = h.untilISO;
    }
  }
  if (k.splits) {
    sc.splits = {};
    for (const s of k.splits) {
      const j = jobs.get(s.job);
      if (!j) return { ok: false, error: `${s.job} is not an open job — a job is "MO|ITEM", as simulate_scenario lists them.` };
      const total = s.batches.reduce((a, b) => a + b, 0);
      if (total !== j.left.finish) return { ok: false, error: `The batches of ${s.job} add up to ${total}; it still owes ${j.left.finish} piece(s).` };
      sc.splits[s.job] = [...s.batches];
    }
  }

  // the queue over the jobs as they now stand, the way the Simulator keeps
  // it: a job split since takes its batches in its own place, a split undone
  // puts the job back where its first batch was, a job no longer open drops
  // out, and a job new since joins the back
  const derivedJobs = deriveJobs(inputs, sc);
  const known = new Set(derivedJobs.map((j) => j.id));
  const idsOfBase = new Map<string, string[]>();
  for (const j of derivedJobs) idsOfBase.set(j.baseId, [...(idsOfBase.get(j.baseId) ?? []), j.id]);
  const named = new Set(sc.queue);
  const queue: string[] = [];
  const seen = new Set<string>();
  const put = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      queue.push(id);
    }
  };
  for (const id of sc.queue) {
    if (known.has(id)) put(id);
    else for (const x of idsOfBase.get(id.split("#")[0]) ?? []) if (!named.has(x)) put(x);
  }
  for (const j of derivedJobs) put(j.id);

  if (k.first && k.first.length > 0) {
    const front: string[] = [];
    const unknown: string[] = [];
    for (const want of k.first) {
      const ids = known.has(want) ? [want] : queue.filter((id) => id.split("|")[0] === want || id.split("#")[0] === want);
      if (ids.length === 0) unknown.push(want);
      for (const id of ids) if (!front.includes(id)) front.push(id);
    }
    if (unknown.length > 0) return { ok: false, error: `Not open in today's queue: ${unknown.join(", ")}.` };
    sc.queue = [...front, ...queue.filter((id) => !front.includes(id))];
  } else {
    sc.queue = queue;
  }
  return parseScenario(sc);
}

/** The scenario a saved one's data stands for today — unreadable knobs fall
 *  back to reality, the way the Simulator loads one. */
export function loadScenario(inputs: WhatIfInputs, raw: unknown): Scenario {
  const d = defaultScenario(inputs);
  if (!isObject(raw)) return d;
  const r = raw as Partial<Scenario>;
  return {
    workersDelta: { ...d.workersDelta, ...(isObject(r.workersDelta) ? r.workersDelta : {}) },
    shiftHours: typeof r.shiftHours === "number" && r.shiftHours >= 1 ? r.shiftHours : d.shiftHours,
    workFridays: !!r.workFridays,
    queue: Array.isArray(r.queue) && r.queue.length ? r.queue.filter((x): x is string => typeof x === "string") : d.queue,
    splits: isObject(r.splits) ? (r.splits as Scenario["splits"]) : {},
    holds: isObject(r.holds) ? (r.holds as Scenario["holds"]) : {},
    downtimes: Array.isArray(r.downtimes) ? (r.downtimes as Scenario["downtimes"]) : [],
  };
}

/** The headline figures of one run: orders still to finish, late, on time,
 *  the day the last one clears, and the most loaded department of the plan. */
export function kpisOf(result: WhatIfResult) {
  const byMo = new Map<string, { late: boolean; blocked: boolean; anyActive: boolean }>();
  for (const j of result.jobs) {
    const cur = byMo.get(j.mo) ?? { late: false, blocked: false, anyActive: false };
    if (j.blockedBy) cur.blocked = true;
    else if (!j.done) {
      cur.anyActive = true;
      if (j.late) cur.late = true;
    }
    byMo.set(j.mo, cur);
  }
  const active = [...byMo.values()].filter((m) => m.anyActive && !m.blocked);
  const late = active.filter((m) => m.late).length;
  const activeJobs = result.jobs.filter((j) => !j.done && !j.blockedBy);
  const lastEta = activeJobs.reduce<string | null>((m, j) => (j.etaISO && (!m || j.etaISO > m) ? j.etaISO : m), null);
  const worst = result.stages
    .filter((s) => s.required > 0 && s.load !== null)
    .reduce<(typeof result.stages)[number] | null>((w, s) => (!w || s.load! > w.load! ? s : w), null);
  return { active: active.length, late, onTime: active.length - late, lastEta, worst };
}

/** Man-hours a day the scenario's extra workers add (negative: take away). */
export const scenarioCost = (sc: Scenario) => WI_STAGES.reduce((a, s) => a + sc.workersDelta[s] * sc.shiftHours, 0);

/** The queue runs in an order of its own, not today's plain one. */
export const queueEdited = (sc: Scenario, inputs: WhatIfInputs) => sc.queue.some((id, i) => inputs.jobs[i]?.id !== id);

/** A scenario's knobs in the terms withKnobs takes them — what is sent back,
 *  one changed, to change it: stoppages, holds and splits as whole lists (a
 *  list given replaces the one there). A hold or a split that no longer does
 *  anything — its job no longer open, or the batches no longer adding up to
 *  what the job still owes — is left out. */
export function knobsOfScenario(sc: Scenario, inputs: WhatIfInputs) {
  const jobs = new Map(inputs.jobs.map((j) => [j.id, j]));
  return {
    workersDelta: Object.fromEntries(WI_STAGES.filter((s) => sc.workersDelta[s] !== 0).map((s) => [s, sc.workersDelta[s]])) as Partial<Record<WiStage, number>>,
    shiftHours: sc.shiftHours,
    workFridays: sc.workFridays,
    downtimes: sc.downtimes.map((d) => ({ ...d })),
    holds: Object.entries(sc.holds).filter(([job]) => jobs.has(job)).map(([job, untilISO]) => ({ job, untilISO })),
    splits: Object.entries(sc.splits)
      .filter(([job, batches]) => batches.reduce((a, b) => a + b, 0) === jobs.get(job)?.left.finish)
      .map(([job, batches]) => ({ job, batches: [...batches] })),
    queueEdited: queueEdited(sc, inputs),
  };
}

/** One line that names a scenario: "+2 Welding · Fridays on · queue edited · 1 split". */
export function describeScenario(sc: Scenario, inputs: WhatIfInputs): string {
  const parts: string[] = [];
  for (const s of WI_STAGES) if (sc.workersDelta[s] !== 0) parts.push(`${sc.workersDelta[s] > 0 ? "+" : ""}${sc.workersDelta[s]} ${deptLabel(s)}`);
  if (sc.shiftHours !== 11) parts.push(`${sc.shiftHours}h shifts`);
  if (sc.workFridays) parts.push("Fridays on");
  if (queueEdited(sc, inputs)) parts.push("queue edited");
  const splits = Object.keys(sc.splits).length;
  if (splits) parts.push(`${splits} split${splits === 1 ? "" : "s"}`);
  const holds = Object.keys(sc.holds).length;
  if (holds) parts.push(`${holds} hold${holds === 1 ? "" : "s"}`);
  if (sc.downtimes.length) parts.push(`${sc.downtimes.length} stoppage${sc.downtimes.length === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "reality as-is";
}
