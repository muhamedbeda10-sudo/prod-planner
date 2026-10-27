// Production activity control — the planner's arithmetic the assistant shows
// its working with: priority (critical ratio, slack, the dispatch rules), the
// load against capacity week by week, input/output control, the constraint,
// stops ranked by cause, a rush order and the release checklist. Pure: the
// numbers are computed here, with tests, so the model only picks the tool and
// explains what came back (lib/server/ai/tools/planningControl.ts).
//
// Everything runs on the what-if model's jobs (one component of one order with
// its pieces still owed per station: Cut → Welding → Finishing) and its
// trailing station rates — the same inputs the forecast and the simulator use.

import { ETA_STAGES, etaQueueOrder, forecastEta, forecastEtaQueued, type EtaOrder, type EtaStage } from "./eta";
import { countWorkingDaysISO, dateForOffsetISO, offsetForDateISO, type WhatIfInputs, type WhatIfJob, type WiStage } from "./whatif";
import { addDaysISO as addDays, weekStartISO } from "./dateSlicer";
import { round1 as r1 } from "./shifts";
import type { ItemStageHours } from "./stdEngine";

export const CONTROL_STAGES = ETA_STAGES;
export type ControlStage = EtaStage;
export const STAGE_NAME: Record<ControlStage, string> = { cut: "Fabrication", weld: "Welding", finish: "Finishing (shot blast + paint)" };
/** The capacity rows behind each station (Admin → Standard times & capacity). */
const STAGE_DEPTS: Record<ControlStage, WiStage[]> = { cut: ["Cut"], weld: ["Welding"], finish: ["ShotBlast", "Painting"] };
/** The station a department's work belongs to (a panel's department to none). */
export const DEPT_STAGE: Readonly<Record<string, ControlStage>> = { Cut: "cut", Welding: "weld", ShotBlast: "finish", Painting: "finish" };

/** One piece's std hours at each station, priced as the forecast prices a job
 *  (lib/server/eta.ts): finishing = shot blast + paint. */
export const stagePerPc = (p: ItemStageHours): Record<ControlStage, number> => ({ cut: p.cut, weld: p.weld, finish: p.shb + p.paint });

/** Load bands: under 85% comfortable, up to 100% tight, past it overloaded. */
export const LOAD_TIGHT = 85;
export const LOAD_OVER = 100;
/** The top of the critical ratio's "on schedule" band (from 1). */
export const CR_ON_SCHEDULE = 1.1;

const r2 = (n: number) => Math.round(n * 100) / 100;
const r1n = (n: number | null) => (n === null ? null : r1(n));

// ---------------------------------------------------------------- formulas

export type CrStatus = "late" | "behind" | "on_schedule" | "ahead" | "done" | "unknown";

/** CR = time left to the due date ÷ remaining lead time. ≤ 0 late, < 1 behind,
 *  1–1.1 on schedule, above ahead. No remaining time: done (nothing left) or
 *  unknown (no forecast). */
export function criticalRatio(daysToDue: number | null, remainingDays: number | null): { cr: number | null; status: CrStatus } {
  if (remainingDays === null || daysToDue === null || !Number.isFinite(remainingDays)) return { cr: null, status: "unknown" };
  if (remainingDays <= 0) return { cr: null, status: "done" };
  const cr = daysToDue / remainingDays;
  return { cr: r2(cr), status: crStatus(cr) };
}

function crStatus(cr: number): Exclude<CrStatus, "done" | "unknown"> {
  if (cr <= 0) return "late";
  if (cr < 1) return "behind";
  if (cr <= CR_ON_SCHEDULE) return "on_schedule";
  return "ahead";
}

/** What the status asks of the planner. */
export const CR_ACTION: Record<CrStatus, string> = {
  late: "Expedite now",
  behind: "Expedite",
  on_schedule: "Run as planned",
  ahead: "Can wait",
  done: "Nothing left",
  unknown: "No forecast — check standard times, rates or due date",
};

/** Slack = time left − remaining work time; per operation = ÷ the operations left. */
export function slackTime(daysToDue: number, workDays: number, opsLeft: number): { slack: number; perOperation: number | null } {
  const slack = daysToDue - workDays;
  return { slack: r2(slack), perOperation: opsLeft > 0 ? r2(slack / opsLeft) : null };
}

/** Available time = machines (or people) × hours a shift × shifts a day × days. */
export const availableTime = (units: number, hoursPerShift: number, shiftsPerDay: number, days: number) => units * hoursPerShift * shiftsPerDay * days;
/** Rated capacity = available × utilization × efficiency (both as fractions). */
export const ratedCapacity = (available: number, utilization: number, efficiency: number) => r2(available * utilization * efficiency);
/** The drum's time: available less the setups it must make. */
export const drumTime = (available: number, setups: number, setupHours: number) => Math.max(0, available - setups * setupHours);
/** Backlog at the end of a period = at its start + what came in − what went out. */
export const ioBacklog = (start: number, input: number, output: number) => start + input - output;
/** The pace a feeding centre must hold: the constraint's rate × the parts it makes per constraint unit. */
export const matchedRate = (constraintRate: number, partsPerUnit: number) => constraintRate * partsPerUnit;

/** Load as a % of capacity: null without a capacity figure; work against zero capacity is infinite. */
export function loadPct(load: number, capacity: number | null): number | null {
  if (capacity === null) return null;
  if (capacity <= 0) return load > 0 ? Infinity : 0;
  return r1((load / capacity) * 100);
}

/** How a load against no working hours at all reads — beyond capacity, not a number. */
export const BEYOND_CAPACITY = "beyond capacity (no working hours in the window)";
/** A load % as words. */
export const pctText = (pct: number) => (Number.isFinite(pct) ? `${pct}%` : BEYOND_CAPACITY);

export type LoadStatus = "ok" | "tight" | "overloaded" | "no_capacity";
export function loadStatus(pct: number | null): LoadStatus {
  if (pct === null) return "no_capacity";
  if (pct > LOAD_OVER) return "overloaded";
  if (pct >= LOAD_TIGHT) return "tight";
  return "ok";
}

// ---------------------------------------------------------------- calendar

/** Working days from today to the due date: today counts as the first (due
 *  today = 1); a date passed is 0 for yesterday and negative before it. A due
 *  date with no working day left before it (today a Friday or a holiday, due
 *  today) is 0 too: no work can move the order before it falls due. */
export function workingDaysToDue(dueISO: string, todayISO: string, holidays: Set<string>): number {
  if (dueISO >= todayISO) return offsetForDateISO(dueISO, todayISO, holidays, false);
  return 0 - countWorkingDaysISO(addDays(dueISO, 1), addDays(todayISO, -1), holidays, false);
}

/** The calendar arithmetic a list asks of many jobs, worked out once per date:
 *  working days to a due date, and the date a forecast's working days land on. */
export function plantCalendar(todayISO: string, holidays: Set<string>) {
  const toDue = new Map<string, number>();
  const dates = new Map<number, string>();
  return {
    todayISO,
    daysToDue(dueISO: string): number {
      let d = toDue.get(dueISO);
      if (d === undefined) toDue.set(dueISO, (d = workingDaysToDue(dueISO, todayISO, holidays)));
      return d;
    },
    /** The working-day offset a date ends (passed dates pin to 0). */
    offsetOf(iso: string): number {
      return iso < todayISO ? 0 : Math.max(0, this.daysToDue(iso));
    },
    dateFor(days: number): string {
      if (days <= 0) return todayISO;
      const key = Math.ceil(days);
      let iso = dates.get(key);
      if (iso === undefined) dates.set(key, (iso = dateForOffsetISO(key, todayISO, holidays, false)));
      return iso;
    },
  };
}
export type PlantCalendar = ReturnType<typeof plantCalendar>;

export interface PlantWeek {
  fromISO: string;
  toISO: string;
  /** Working days of the week still ahead (from today in the current week). */
  workingDays: number;
}

/** The plant's weeks, Saturday to Friday, from the current one; the current
 *  week counts its working days from today. */
export function plantWeeks(todayISO: string, count: number, holidays: Set<string>): PlantWeek[] {
  const start = weekStartISO(todayISO);
  return Array.from({ length: count }, (_, i) => {
    const fromISO = addDays(start, i * 7);
    const toISO = addDays(fromISO, 6);
    return { fromISO, toISO, workingDays: countWorkingDaysISO(i === 0 ? todayISO : fromISO, toISO, holidays, false) };
  });
}

/** The past plant weeks, oldest first, each whole (the current week up to
 *  yesterday — left out on its first day, a Saturday, with nothing past in it). */
export function pastPlantWeeks(todayISO: string, count: number, holidays: Set<string>): PlantWeek[] {
  const current = plantWeeks(todayISO, 1, holidays)[0];
  const weeks = Array.from({ length: count + 1 }, (_, k) => {
    const i = count - k;
    const fromISO = addDays(current.fromISO, -7 * i);
    const toISO = i === 0 ? addDays(todayISO, -1) : addDays(fromISO, 6);
    return { fromISO, toISO, workingDays: countWorkingDaysISO(fromISO, toISO, holidays, false) };
  }).filter((w) => w.toISO >= w.fromISO);
  return weeks.slice(-count);
}

// ---------------------------------------------------------------- job measures

/** The std hours a job still owes one station. */
export const stageHours = (j: Pick<WhatIfJob, "left" | "perPc">, s: ControlStage) => Math.max(0, j.left[s]) * (j.perPc[s] || 0);
const prevStage = (s: ControlStage): ControlStage | null => (s === "cut" ? null : s === "weld" ? "cut" : "weld");

/** Pieces already through the station before this one and waiting here. */
export function arrivedPcs(j: Pick<WhatIfJob, "left">, s: ControlStage): number {
  const p = prevStage(s);
  return Math.max(0, p ? j.left[s] - j.left[p] : j.left[s]);
}

/** The std hours waiting in front of each station now: at Fabrication every
 *  piece not cut yet, at the others the pieces the station before has passed on. */
export function queueNow(jobs: readonly Pick<WhatIfJob, "left" | "perPc">[]): Record<ControlStage, number> {
  const q: Record<ControlStage, number> = { cut: 0, weld: 0, finish: 0 };
  for (const j of jobs) for (const s of CONTROL_STAGES) q[s] += arrivedPcs(j, s) * (j.perPc[s] || 0);
  return q;
}

/** Days of pure work left (each station's hours at its whole station's
 *  rate) — the setup + run part, no queue. Null when a station needed has no rate. */
export function workDaysLeft(j: Pick<WhatIfJob, "left" | "perPc">, rates: Record<ControlStage, number>): number | null {
  let days = 0;
  for (const s of CONTROL_STAGES) {
    const h = stageHours(j, s);
    if (h <= 0) continue;
    if (!(rates[s] > 0)) return null;
    days += h / rates[s];
  }
  return days;
}

// ---------------------------------------------------------------- dispatch list

export const DISPATCH_RULES = ["CR", "EDD", "SLACK", "SPT", "LWR", "FOR"] as const;
export type DispatchRule = (typeof DISPATCH_RULES)[number];
export const RULE_TEXT: Record<DispatchRule, string> = {
  CR: "Critical ratio — lowest first (time left ÷ forecast lead time)",
  EDD: "Earliest due date first",
  SLACK: "Least slack first (time left − remaining work days)",
  SPT: "Shortest processing time at this station first",
  LWR: "Least work remaining (all stations) first",
  FOR: "Fewest operations remaining first",
};

export interface DispatchRow {
  id: string;
  mo: string;
  bom: string;
  item: string;
  dueISO: string | null;
  daysToDue: number | null;
  /** Pieces this station still owes, and those already waiting at it. */
  pcsLeft: number;
  pcsArrived: number;
  stageHours: number;
  totalHours: number;
  opsLeft: number;
  /** The forecast's working days until the job clears (queue included). */
  forecastDays: number | null;
  forecastISO: string | null;
  cr: number | null;
  status: CrStatus;
  action: string;
  slack: number | null;
  slackPerOperation: number | null;
  priority: boolean;
  urgent: boolean;
  /** On a machine right now — finish it rather than break the setup. */
  running: boolean;
}

export interface DispatchContext {
  calendar: PlantCalendar;
  rates: Record<ControlStage, number>;
  priorityMos?: ReadonlySet<string>;
  urgentMos?: ReadonlySet<string>;
  runningIds?: ReadonlySet<string>;
}

export function dispatchRow(j: WhatIfJob, stage: ControlStage, c: DispatchContext): DispatchRow {
  const daysToDue = j.dueISO ? c.calendar.daysToDue(j.dueISO) : null;
  const forecastDays = j.blockedBy ? null : j.baselineDays;
  const { cr, status } = criticalRatio(daysToDue, forecastDays);
  const work = workDaysLeft(j, c.rates);
  const opsLeft = CONTROL_STAGES.filter((s) => j.left[s] > 0).length;
  const slack = daysToDue !== null && work !== null ? slackTime(daysToDue, work, opsLeft) : null;
  return {
    id: j.id, mo: j.mo, bom: j.bom, item: j.item, dueISO: j.dueISO, daysToDue,
    pcsLeft: j.left[stage], pcsArrived: arrivedPcs(j, stage),
    stageHours: r1(stageHours(j, stage)),
    totalHours: r1(CONTROL_STAGES.reduce((a, s) => a + stageHours(j, s), 0)),
    opsLeft, forecastDays: r1n(forecastDays),
    forecastISO: forecastDays === null ? null : c.calendar.dateFor(forecastDays),
    cr, status, action: CR_ACTION[status],
    slack: slack?.slack ?? null, slackPerOperation: slack?.perOperation ?? null,
    priority: c.priorityMos?.has(j.mo) ?? false, urgent: c.urgentMos?.has(j.mo) ?? false,
    running: c.runningIds?.has(j.id) ?? false,
  };
}

const nullsLast = (a: number | null, b: number | null) => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b);
const dueOrder = (a: { dueISO: string | null }, b: { dueISO: string | null }) => (a.dueISO ?? "9999").localeCompare(b.dueISO ?? "9999");

/** The rule's order, lowest value first (a more negative CR before a less
 *  negative one); ties by due date, then job. Nothing to compare goes last. */
export function compareByRule(rule: DispatchRule): (a: DispatchRow, b: DispatchRow) => number {
  const key: Record<DispatchRule, (r: DispatchRow) => number | null> = {
    CR: (r) => (r.status === "late" && r.cr === 0 ? -1e-9 * (r.daysToDue ?? 0) : r.cr),
    EDD: (r) => (r.dueISO ? Date.parse(r.dueISO) : null),
    SLACK: (r) => r.slack,
    SPT: (r) => r.stageHours,
    LWR: (r) => r.totalHours,
    FOR: (r) => r.opsLeft,
  };
  return (a, b) => nullsLast(key[rule](a), key[rule](b)) || dueOrder(a, b) || a.id.localeCompare(b.id);
}

/** The station's dispatch list: every job that still owes it work, in the
 *  rule's order — the ones already at the station first, then those still
 *  upstream. A job running on a machine keeps its place on top. */
export function dispatchList(jobs: readonly WhatIfJob[], stage: ControlStage, rule: DispatchRule, c: DispatchContext): DispatchRow[] {
  const rows = jobs.filter((j) => j.left[stage] > 0).map((j) => dispatchRow(j, stage, c));
  const cmp = compareByRule(rule);
  return rows.sort((a, b) => Number(b.running) - Number(a.running) || Number(b.pcsArrived > 0) - Number(a.pcsArrived > 0) || cmp(a, b));
}

/** Named orders' priority, each job at the station it is at now (the first it
 *  still owes), in the rule's order — a job running on a machine on top. */
export function dispatchByCurrentStation(jobs: readonly WhatIfJob[], rule: DispatchRule, c: Omit<DispatchContext, "runningIds"> & { running?: Partial<Record<ControlStage, ReadonlySet<string>>> }): (DispatchRow & { station: ControlStage })[] {
  const rows = jobs.flatMap((j) => {
    const at = CONTROL_STAGES.find((s) => j.left[s] > 0);
    return at ? [{ ...dispatchRow(j, at, { ...c, runningIds: c.running?.[at] }), station: at }] : [];
  });
  const cmp = compareByRule(rule);
  return rows.sort((a, b) => Number(b.running) - Number(a.running) || cmp(a, b));
}

/** How many of the rows fall in each status — the list's headline. */
export function statusCounts(rows: readonly Pick<DispatchRow, "status">[]): Record<CrStatus, number> {
  const out: Record<CrStatus, number> = { late: 0, behind: 0, on_schedule: 0, ahead: 0, done: 0, unknown: 0 };
  for (const r of rows) out[r.status]++;
  return out;
}

// ---------------------------------------------------------------- load profile

export interface LoadWeek extends PlantWeek {
  /** Std hours owed by this week's due dates (the current week carries what is past due too). */
  loadH: number;
  pastDueH: number;
  /** The stations' man-hours (Admin capacity × working days); null = no figure. */
  availableH: number | null;
  /** What the station really earns in those days (trailing rate × days). */
  demonstratedH: number;
  loadPct: number | null;
  atPacePct: number | null;
  status: LoadStatus;
  /** Running totals from the current week: owed − available (positive = short). */
  cumShortH: number | null;
  top: { id: string; mo: string; item: string; hours: number; dueISO: string | null }[];
}

export interface StageLoad {
  stage: ControlStage;
  name: string;
  capacityPerDay: number | null;
  ratePerDay: number;
  weeks: LoadWeek[];
  undatedH: number;
  beyondH: number;
}

/** A station's man-hours a working day, from its capacity rows; null when none is set. */
export function stageCapacityPerDay(capacity: Partial<Record<WiStage, number>>, stage: ControlStage): number | null {
  const set = STAGE_DEPTS[stage].filter((d) => capacity[d] !== undefined);
  return set.length ? set.reduce((a, d) => a + (capacity[d] ?? 0), 0) : null;
}

/** A station's load over all the weeks of its profile: the hours due, the
 *  hours available (null without a capacity figure), their % and band. */
export function windowLoad(s: StageLoad): { loadH: number; availableH: number | null; pct: number | null; status: LoadStatus } {
  const loadH = s.weeks.reduce((a, w) => a + w.loadH, 0);
  const availableH = s.capacityPerDay === null ? null : s.weeks.reduce((a, w) => a + (w.availableH ?? 0), 0);
  const pct = loadPct(loadH, availableH);
  return { loadH: r1(loadH), availableH: r1n(availableH), pct, status: loadStatus(pct) };
}

/** Infinite loading by due week: every job's hours land in the week its order
 *  is due (past due in the current week), set against each week's capacity. */
export function loadProfile(inputs: Pick<WhatIfInputs, "jobs" | "rates" | "capacity" | "todayISO" | "holidayISOs">, weekCount: number, topN = 5): StageLoad[] {
  const holidays = new Set(inputs.holidayISOs);
  const weeks = plantWeeks(inputs.todayISO, weekCount, holidays);
  const last = weeks[weeks.length - 1].toISO;
  return CONTROL_STAGES.map((stage) => {
    const perDay = stageCapacityPerDay(inputs.capacity, stage);
    const buckets = weeks.map(() => ({ load: 0, pastDue: 0, jobs: [] as LoadWeek["top"] }));
    let undatedH = 0;
    let beyondH = 0;
    for (const j of inputs.jobs) {
      const h = stageHours(j, stage);
      if (h <= 0) continue;
      if (!j.dueISO) { undatedH += h; continue; }
      if (j.dueISO > last) { beyondH += h; continue; }
      const i = Math.max(0, weeks.findIndex((w) => j.dueISO! <= w.toISO));
      buckets[i].load += h;
      if (j.dueISO < inputs.todayISO) buckets[i].pastDue += h;
      buckets[i].jobs.push({ id: j.id, mo: j.mo, item: j.item, hours: r1(h), dueISO: j.dueISO });
    }
    let cumLoad = 0;
    let cumCap = 0;
    const rows: LoadWeek[] = weeks.map((w, i) => {
      const availableH = perDay === null ? null : r1(perDay * w.workingDays);
      const demonstratedH = r1(inputs.rates[stage] * w.workingDays);
      const pct = loadPct(buckets[i].load, availableH);
      cumLoad += buckets[i].load;
      cumCap += availableH ?? 0;
      return {
        ...w, loadH: r1(buckets[i].load), pastDueH: r1(buckets[i].pastDue), availableH, demonstratedH,
        loadPct: pct, atPacePct: loadPct(buckets[i].load, demonstratedH), status: loadStatus(pct),
        cumShortH: perDay === null ? null : r1(cumLoad - cumCap),
        top: buckets[i].jobs.sort((a, b) => b.hours - a.hours).slice(0, topN),
      };
    });
    return { stage, name: STAGE_NAME[stage], capacityPerDay: perDay, ratePerDay: r1(inputs.rates[stage]), weeks: rows, undatedH: r1(undatedH), beyondH: r1(beyondH) };
  });
}

// ---------------------------------------------------------------- input / output

export interface IoWeekIn extends PlantWeek {
  plannedInput: number | null;
  actualInput: number | null;
  plannedOutput: number | null;
  actualOutput: number;
}

export interface IoWeek extends IoWeekIn {
  backlogStart: number | null;
  backlogEnd: number | null;
  cumInputVariance: number | null;
  cumOutputVariance: number | null;
}

export type IoDiagnosis = "upstream" | "internal" | "on_plan" | "no_plan";

/** I/O control for one station, oldest week first. The queue standing in
 *  front of it now closes the last week; each earlier week's backlog is walked
 *  back from it (start = end − input + output). Input below plan points
 *  upstream; input on plan with output below points inside the station. */
export function ioReport(weeks: readonly IoWeekIn[], backlogNow: number | null, tolerance = 0.1): { weeks: IoWeek[]; diagnosis: IoDiagnosis; backlogGrowing: boolean | null; backlogTrendH: number | null; reading: string } {
  const out: IoWeek[] = weeks.map((w) => ({ ...w, backlogStart: null, backlogEnd: null, cumInputVariance: null, cumOutputVariance: null }));
  let end = backlogNow;
  for (let i = out.length - 1; i >= 0; i--) {
    const w = out[i];
    w.backlogEnd = r1n(end);
    // walked back: start = end − input + output (end = ioBacklog(start, input, output))
    end = end === null || w.actualInput === null ? null : end - w.actualInput + w.actualOutput;
    w.backlogStart = r1n(end);
  }
  let pi = 0, ai = 0, po = 0, ao = 0;
  let inPlanned = true, outPlanned = true;
  for (const w of out) {
    if (w.plannedInput === null || w.actualInput === null) inPlanned = false;
    if (w.plannedOutput === null) outPlanned = false;
    pi += w.plannedInput ?? 0; ai += w.actualInput ?? 0; po += w.plannedOutput ?? 0; ao += w.actualOutput;
    w.cumInputVariance = inPlanned ? r1(ai - pi) : null;
    w.cumOutputVariance = outPlanned ? r1(ao - po) : null;
  }
  const first = out[0]?.backlogStart ?? null;
  const lastEnd = out[out.length - 1]?.backlogEnd ?? null;
  const backlogGrowing = first === null || lastEnd === null ? null : lastEnd > first * 1.1 && lastEnd - first > 1;
  for (const w of out) Object.assign(w, { plannedInput: r1n(w.plannedInput), actualInput: r1n(w.actualInput), plannedOutput: r1n(w.plannedOutput), actualOutput: r1(w.actualOutput) });
  let diagnosis: IoDiagnosis;
  if (!outPlanned || po <= 0) diagnosis = "no_plan";
  else if (inPlanned && pi > 0 && ai - pi < -tolerance * pi) diagnosis = "upstream";
  else if (ao - po < -tolerance * po) diagnosis = "internal";
  else diagnosis = "on_plan";
  const reading = {
    upstream: "Input is below plan: the station cannot make work it never received — look at the stage before it, material issue or releases.",
    internal: "Input came in on plan but output fell short: the cause is inside the station (people, machines, rework or the standards).",
    on_plan: "Input and output are within 10% of plan.",
    no_plan: "No weekly plan covers these weeks, so only the actual flow and backlog can be read.",
  }[diagnosis] + (backlogGrowing ? " The queue in front of it is growing — every order through it will wait longer." : "");
  return { weeks: out, diagnosis, backlogGrowing, backlogTrendH: first === null || lastEnd === null ? null : r1(lastEnd - first), reading };
}

// ---------------------------------------------------------------- the constraint

export interface ConstraintEvidence {
  stage: ControlStage;
  name: string;
  openH: number;
  ratePerDay: number;
  /** Open work ÷ the station's real pace — the demand against its capacity. */
  daysOfWork: number | null;
  queueH: number;
  queueDays: number | null;
  nearLoadPct: number | null;
  /** Machine-hours lost to unplanned stops; null when not read (the Shifts screen closed). */
  lostH: number | null;
  backlogTrendH: number | null;
}

/** One station's evidence: its open work and queue against its real pace, its
 *  load over the profile's weeks, its lost hours and how its queue moved. */
export function stationEvidence(stage: ControlStage, o: { jobs: readonly WhatIfJob[]; rate: number; queueH: number; load: StageLoad; lostH: number | null; backlogTrendH: number | null }): ConstraintEvidence {
  const openH = o.jobs.reduce((a, j) => a + stageHours(j, stage), 0);
  return {
    stage, name: STAGE_NAME[stage], openH: r1(openH), ratePerDay: r1(o.rate),
    daysOfWork: o.rate > 0 ? r1(openH / o.rate) : null,
    queueH: r1(o.queueH), queueDays: o.rate > 0 ? r1(o.queueH / o.rate) : null,
    nearLoadPct: windowLoad(o.load).pct,
    lostH: r1n(o.lostH), backlogTrendH: o.backlogTrendH,
  };
}

/** Rank the stations by the days of open work they hold at their real pace —
 *  the one with the most is the drum the rest must follow. */
export function rankConstraint(rows: readonly ConstraintEvidence[]): { ranked: ConstraintEvidence[]; constraint: ConstraintEvidence | null; evidence: string[]; subordinate: { stage: ControlStage; name: string; shareOfDrum: number | null }[] } {
  const ranked = [...rows].sort((a, b) => nullsLast(a.daysOfWork === null ? null : -a.daysOfWork, b.daysOfWork === null ? null : -b.daysOfWork));
  const constraint = ranked.find((r) => r.daysOfWork !== null && r.daysOfWork > 0) ?? null;
  const evidence: string[] = [];
  if (constraint) {
    evidence.push(`${constraint.name} holds ${r1(constraint.daysOfWork!)} working days of open work at its real pace (${constraint.openH} std h ÷ ${constraint.ratePerDay} std h/day) — the most of any station.`);
    if (constraint.queueDays !== null) evidence.push(`${constraint.queueH} std h already wait in front of it (${r1(constraint.queueDays)} days).`);
    if (constraint.nearLoadPct !== null) evidence.push(`Its load over the coming weeks is ${pctText(constraint.nearLoadPct)} of its capacity.`);
    if (constraint.lostH !== null && constraint.lostH > 0) evidence.push(`${constraint.lostH} machine-hours were lost to stops there lately.`);
    if (constraint.backlogTrendH !== null && constraint.backlogTrendH > 0) evidence.push(`Its queue grew by ${constraint.backlogTrendH} std h over the weeks read.`);
  }
  for (const r of rows) if (r.daysOfWork === null && r.openH > 0) evidence.push(`${r.name} has open work but no recorded pace — it cannot be ranked.`);
  const subordinate = constraint
    ? rows.filter((r) => r.stage !== constraint.stage).map((r) => ({ stage: r.stage, name: r.name, shareOfDrum: r.daysOfWork === null ? null : r2(r.daysOfWork / constraint.daysOfWork!) }))
    : [];
  return { ranked, constraint, evidence, subordinate };
}

// ---------------------------------------------------------------- Pareto

/** Causes ranked with each one's running share — the first ones to reach 80% are the vital few. */
export function withCumulative<T extends { hours: number }>(rows: readonly T[]): (T & { share: number; cumShare: number; vital: boolean })[] {
  const sorted = [...rows].sort((a, b) => b.hours - a.hours);
  const total = sorted.reduce((a, r) => a + r.hours, 0);
  let cum = 0;
  return sorted.map((r) => {
    const before = cum;
    cum += r.hours;
    return { ...r, share: total > 0 ? r2(r.hours / total) : 0, cumShare: total > 0 ? r2(cum / total) : 0, vital: total > 0 && before / total < 0.8 };
  });
}

// ---------------------------------------------------------------- rush order

export interface RushJob {
  id: string;
  item: string;
  qty: number;
  perPc: Record<ControlStage, number>;
}

export interface RushPlacement { finishDays: number | null; finishISO: string | null; feasible: boolean | null; pushed: PushedJob[] }

export interface RushOutcome {
  /** Where the new order lands queued by its due date, and rushed to the front. */
  atDuePosition: RushPlacement;
  expedited: RushPlacement;
  requestedISO: string;
  blockedBy: ControlStage | null;
}

export interface PushedJob { id: string; mo: string; dueISO: string | null; beforeISO: string | null; afterISO: string | null; nowLate: boolean }

const asOrder = (j: WhatIfJob): EtaOrder => ({ id: j.id, dueISO: j.dueISO, hours: { cut: stageHours(j, "cut"), weld: stageHours(j, "weld"), finish: stageHours(j, "finish") } });

/** Would a new order make its date? Queue it by its due date (how the floor
 *  works today) and again at the front (expedited); each with the jobs it
 *  delays and those it makes late. Nothing is changed. */
export function simulateRush(inputs: Pick<WhatIfInputs, "jobs" | "rates" | "todayISO" | "holidayISOs">, rush: readonly RushJob[], requestedISO: string): RushOutcome {
  const cal = plantCalendar(inputs.todayISO, new Set(inputs.holidayISOs));
  const toISO = (d: number | null) => (d === null ? null : cal.dateFor(d));
  const base = inputs.jobs.map(asOrder);
  // today's forecast of each job, as the model already holds it
  const baseline = new Map(inputs.jobs.map((j) => [j.id, j.blockedBy ? null : j.baselineDays]));
  const extra: EtaOrder[] = rush.map((j) => ({ id: j.id, dueISO: requestedISO, hours: { cut: j.qty * j.perPc.cut, weld: j.qty * j.perPc.weld, finish: j.qty * j.perPc.finish } }));
  const extraIds = new Set(extra.map((e) => e.id));
  const reqOffset = cal.offsetOf(requestedISO);
  const meta = new Map(inputs.jobs.map((j) => [j.id, j]));

  const read = (results: { id: string; days: number | null; blockedBy: ControlStage | null }[]): { placement: RushPlacement; blocked: ControlStage | null } => {
    const mine = results.filter((r) => extraIds.has(r.id));
    const blocked = mine.find((r) => r.blockedBy)?.blockedBy ?? null;
    const finish = blocked ? null : Math.max(0, ...mine.map((r) => r.days ?? 0));
    const pushed: PushedJob[] = [];
    for (const r of results) {
      if (extraIds.has(r.id)) continue;
      const before = baseline.get(r.id) ?? null;
      if (before === null || r.days === null || r.days <= before + 1e-9) continue;
      const j = meta.get(r.id)!;
      const beforeISO = toISO(before), afterISO = toISO(r.days);
      if (beforeISO === afterISO) continue; // the same day — not a delay anyone sees
      const due = j.dueISO ? cal.offsetOf(j.dueISO) : null;
      pushed.push({ id: r.id, mo: j.mo, dueISO: j.dueISO, beforeISO, afterISO, nowLate: due !== null && Math.ceil(before) <= due && Math.ceil(r.days) > due });
    }
    pushed.sort((a, b) => Number(b.nowLate) - Number(a.nowLate) || dueOrder(a, b));
    return { placement: { finishDays: r1n(finish), finishISO: toISO(finish), feasible: finish === null ? null : Math.ceil(finish) <= reqOffset, pushed }, blocked };
  };

  const atDue = read(forecastEta([...base, ...extra], inputs.rates));
  // the new order at the front of the queue, the rest in today's order (by due date)
  const front = read(forecastEtaQueued([...extra, ...[...base].sort(etaQueueOrder)], inputs.rates));
  return { atDuePosition: atDue.placement, expedited: front.placement, requestedISO, blockedBy: atDue.blocked };
}

// ---------------------------------------------------------------- release checklist

export type CheckStatus = "ok" | "blocked" | "warn" | "unknown";
export interface ReleaseCheck { check: string; status: CheckStatus; detail: string }

export interface ReleaseFacts {
  found: boolean;
  status?: string;
  onHold?: { note: string | null } | null;
  pendingQty?: number | null;
  /** Components with work left but no standard time. */
  missingTimes?: string[];
  dueISO?: string | null;
  /** The MATERIAL tab's nesting lines for the order (or its BOM); "not_checked"
   *  when the Material screen is closed to the person asking. */
  nesting?: { lines: number; nested: number } | "not_checked";
  /** The order's sheets against the Physical Material table (Odoo's stock and
   *  the store's count) — lib/domain/materialCoverage.ts stockCheck; null when not read. */
  stock?: { status: CheckStatus; detail: string } | null;
  /** The first station's load over the release window. */
  firstStationLoad?: { pct: number | null; status: LoadStatus; weeks: string } | null;
  alreadyStarted?: boolean;
}

/** Release only what can be worked: material, documents (the nesting) and
 *  capacity at the first station — each check with its own verdict. */
export function releaseChecklist(f: ReleaseFacts): { verdict: "ready" | "ready_with_checks" | "not_ready"; checks: ReleaseCheck[] } {
  const checks: ReleaseCheck[] = [];
  const add = (check: string, status: CheckStatus, detail: string) => checks.push({ check, status, detail });
  if (!f.found) {
    add("Order", "blocked", "No such order in the registry.");
    return { verdict: "not_ready", checks };
  }
  add("Order open", f.status === "open" ? "ok" : "blocked", f.status === "open" ? "Open." : `Status is ${f.status}.`);
  add("Not on hold", f.onHold ? "blocked" : "ok", f.onHold ? `On hold${f.onHold.note ? `: ${f.onHold.note}` : ""}.` : "Not on hold.");
  if (f.pendingQty !== undefined) add("Quantity settled", f.pendingQty === null ? "ok" : "warn", f.pendingQty === null ? "No plan quantity waiting for a decision." : `A plan import is holding back a different quantity (${f.pendingQty}) — decide it first.`);
  if (f.missingTimes) add("Standard times", f.missingTimes.length ? "warn" : "ok", f.missingTimes.length ? `No standard time for ${f.missingTimes.join(", ")} — its load and dates cannot be priced.` : "Every component left is priced.");
  if (f.dueISO !== undefined) add("Due date", f.dueISO ? "ok" : "warn", f.dueISO ? `Due ${f.dueISO} (latest weekly-plan date).` : "No weekly plan dates it — priority cannot be computed.");
  const n = f.nesting;
  if (n === "not_checked") add("Nesting / drawings", "unknown", "Not checked — the Material screen is not opened for this person.");
  else if (n && n.lines === 0) add("Nesting / drawings", "blocked", "No line on the MATERIAL tab's nesting sheet for this order.");
  else if (n && n.nested < n.lines) add("Nesting / drawings", "warn", `${n.nested} of ${n.lines} nesting lines carry the actual nesting.`);
  else if (n) add("Nesting / drawings", "ok", `All ${n.lines} nesting lines are nested.`);
  add("Material stock", f.stock?.status ?? "unknown", f.stock?.detail ?? "Not checked against the stock — check the sheets are in the store before releasing.");
  const l = f.firstStationLoad;
  if (l && (l.status === "no_capacity" || l.pct === null)) add("Fabrication capacity", "unknown", "No capacity figure for Fabrication.");
  else if (l && l.pct !== null) add("Fabrication capacity", l.status === "overloaded" ? "warn" : "ok", `Fabrication is at ${pctText(l.pct)} of its capacity ${l.weeks} (${l.status}).`);
  if (f.alreadyStarted) add("Already on the floor", "warn", "Fabrication has already recorded pieces of this order — it is released in practice.");
  const verdict = checks.some((c) => c.status === "blocked") ? "not_ready" : checks.some((c) => c.status !== "ok") ? "ready_with_checks" : "ready";
  return { verdict, checks };
}
