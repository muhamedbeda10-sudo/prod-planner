// What it takes to meet the deadlines — the what-if model searched
// for the cheapest way to bring the late orders (or the ones named) back on
// time: first what costs nothing (the order the jobs are worked in), then one
// step at a time the addition that rescues the most per man-hour — a worker
// more at a stage, an hour more on the shift, Fridays worked — until they
// all make their day, nothing helps any more, or the time is up. Pure and
// deterministic for a given clock; the assistant
// calls it.

import { optimizeQueueWithin, simulate, WI_STAGES, type Scenario, type WhatIfInputs, type WhatIfResult, type WiStage } from "./whatif";
import { deptLabel } from "./constants";

export interface DeadlineScore {
  /** Target orders finishing after their due day. */
  late: number;
  /** Their days past due, summed. */
  lateDays: number;
  /** Target orders the model cannot finish (a station without a rate). */
  blocked: number;
  /** The target orders, each with its finish and due day. */
  orders: { mo: string; etaISO: string | null; dueISO: string | null; late: boolean }[];
}

export interface DeadlineStep {
  /** What changes, in a person's words: "+1 Welding", "12 h shifts". */
  change: string;
  kind: "queue" | "worker" | "fridays";
  stage?: WiStage;
  /** Man-hours a week the step adds (0 for the order of the jobs). */
  costMhWeek: number;
  after: DeadlineScore;
}

export interface DeadlinePlan {
  before: DeadlineScore;
  after: DeadlineScore;
  steps: DeadlineStep[];
  scenario: Scenario;
  /** Every target order on time (those the model cannot finish aside). */
  met: boolean;
  /** The search reached its end before its time ran out. */
  complete: boolean;
  /** Man-hours a week the plan adds over the scenario it started from. */
  costMhWeek: number;
}

export const DEADLINE_LIMITS = { workersPerStage: 6, steps: 14 } as const;

const DAY = 86_400_000;
const daysLate = (eta: string, due: string) => Math.max(0, Math.round((Date.parse(`${eta}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / DAY));

/** How the target orders fare in one run: an order finishes with its last job. */
export function deadlineScore(result: WhatIfResult, targets: ReadonlySet<string> | null): DeadlineScore {
  const byMo = new Map<string, { eta: string | null; due: string | null; blocked: boolean }>();
  for (const j of result.jobs) {
    if (j.done || (targets && !targets.has(j.mo))) continue;
    const cur = byMo.get(j.mo) ?? { eta: null, due: null, blocked: false };
    if (!j.etaISO || j.blockedBy) cur.blocked = true;
    if (j.etaISO && (!cur.eta || j.etaISO > cur.eta)) cur.eta = j.etaISO;
    if (j.dueISO && (!cur.due || j.dueISO > cur.due)) cur.due = j.dueISO;
    byMo.set(j.mo, cur);
  }
  let late = 0, lateDays = 0, blocked = 0;
  const orders: DeadlineScore["orders"] = [];
  for (const [mo, m] of [...byMo].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!targets && !m.due) continue; // an order with no due day has no deadline to meet
    const isLate = !m.blocked && !!m.eta && !!m.due && m.eta > m.due;
    if (m.blocked) blocked++;
    if (isLate) {
      late++;
      lateDays += daysLate(m.eta!, m.due!);
    }
    orders.push({ mo, etaISO: m.blocked ? null : m.eta, dueISO: m.due, late: isLate });
  }
  return { late, lateDays, blocked, orders };
}

const better = (a: DeadlineScore, b: DeadlineScore) => a.late !== b.late ? a.late < b.late : a.lateDays < b.lateDays;
/** How much a step rescued: whole orders count far above days. */
const gain = (from: DeadlineScore, to: DeadlineScore) => (from.late - to.late) * 1000 + (from.lateDays - to.lateDays);

/** The people a stage has today, near enough: its man-hours a day over a shift. */
const crewOf = (inputs: WhatIfInputs, sc: Scenario, s: WiStage) => Math.max(0, (inputs.capacity[s] ?? 0) / Math.max(1, sc.shiftHours) + sc.workersDelta[s]);

/** The cheapest set of changes, from `start`, that brings the target orders
 *  (`mos`; none named: every order with a due day) back on time — or as near
 *  as the knobs allow within `budgetMs`. */
export function planForDeadlines(
  inputs: WhatIfInputs,
  start: Scenario,
  o: { mos?: readonly string[]; budgetMs?: number; now?: () => number; allowFridays?: boolean } = {},
): DeadlinePlan {
  const now = o.now ?? Date.now;
  const until = now() + (o.budgetMs ?? 4000);
  const targets = o.mos && o.mos.length > 0 ? new Set(o.mos) : null;
  const score = (sc: Scenario) => deadlineScore(simulate(inputs, sc), targets);
  const before = score(start);
  let sc: Scenario = { ...start, workersDelta: { ...start.workersDelta }, queue: [...start.queue] };
  let cur = before;
  const steps: DeadlineStep[] = [];
  let complete = true;
  const done = () => cur.late === 0;

  // 1. free: the order the jobs are worked in — the what-if model's own search,
  //    and the target orders first, whichever serves them better
  if (!done()) {
    const tries: Scenario[] = [];
    const q = optimizeQueueWithin(inputs, sc, Math.max(0, (until - now()) * 0.35), now);
    if (!q.complete) complete = false;
    tries.push({ ...sc, queue: q.queue });
    if (targets) tries.push({ ...sc, queue: [...sc.queue.filter((id) => targets.has(id.split("|")[0])), ...sc.queue.filter((id) => !targets.has(id.split("|")[0]))] });
    for (const t of tries) {
      const s = score(t);
      if (better(s, cur)) {
        sc = t;
        cur = s;
      }
    }
    if (cur !== before) steps.push({ change: targets ? "Work the jobs in a better order (these orders first where it helps)" : "Work the jobs in a better order", kind: "queue", costMhWeek: 0, after: cur });
  }

  // 2. one addition at a time — the one that rescues the most per man-hour
  while (!done() && steps.length < DEADLINE_LIMITS.steps) {
    if (now() > until) {
      complete = false;
      break;
    }
    type Cand = { sc: Scenario; step: Omit<DeadlineStep, "after"> };
    const cands: Cand[] = [];
    // one worker may not move a finish by a whole day: a stage is tried with
    // one, two … more, so a step that needs several is still found
    for (const s of WI_STAGES) {
      if ((inputs.capacity[s] ?? 0) <= 0) continue;
      for (let k = 1; sc.workersDelta[s] + k <= DEADLINE_LIMITS.workersPerStage; k++) {
        cands.push({ sc: { ...sc, workersDelta: { ...sc.workersDelta, [s]: sc.workersDelta[s] + k } }, step: { change: `+${k} ${deptLabel(s)}`, kind: "worker", stage: s, costMhWeek: k * sc.shiftHours * 5 } });
      }
    }
    const crew = WI_STAGES.reduce((a, s) => a + crewOf(inputs, sc, s), 0);
    if (o.allowFridays !== false && !sc.workFridays) {
      cands.push({ sc: { ...sc, workFridays: true }, step: { change: "Work Fridays", kind: "fridays", costMhWeek: Math.max(1, crew) * sc.shiftHours } });
    }
    let best: { c: Cand; s: DeadlineScore; per: number } | null = null;
    for (const c of cands) {
      // the time is checked between runs too: a round is many of them
      if (now() > until) {
        complete = false;
        break;
      }
      const s = score(c.sc);
      const g = gain(cur, s);
      if (g <= 0) continue;
      const per = g / c.step.costMhWeek;
      if (!best || per > best.per) best = { c, s, per };
    }
    if (!best) break;
    sc = best.c.sc;
    cur = best.s;
    steps.push({ ...best.c.step, after: cur });
  }

  // 3. the order again, for the crew it now has
  if (steps.some((s) => s.kind !== "queue") && now() < until) {
    const q = optimizeQueueWithin(inputs, sc, Math.max(0, until - now()), now);
    if (!q.complete) complete = false;
    const t = { ...sc, queue: q.queue };
    const s = score(t);
    if (better(s, cur)) {
      sc = t;
      cur = s;
      steps.push({ change: "Re-order the jobs for the added crew", kind: "queue", costMhWeek: 0, after: cur });
    }
  }

  return { before, after: cur, steps, scenario: sc, met: cur.late === 0, complete, costMhWeek: steps.reduce((a, s) => a + s.costMhWeek, 0) };
}

/** The plan in a sentence. */
export function describePlan(p: DeadlinePlan): string {
  const n = p.before.late;
  if (n === 0) return p.before.blocked ? `Nothing is late — ${p.before.blocked} order(s) cannot be timed (a station without a rate).` : "Nothing is late — every order makes its due day as things stand.";
  const what = p.steps.map((s) => s.change).join(", then ");
  if (p.met) return `${n} late order${n === 1 ? "" : "s"} back on time with: ${what}${p.costMhWeek ? ` (about ${Math.round(p.costMhWeek)} man-hours a week more)` : " — at no extra cost"}.`;
  if (p.steps.length === 0) return `None of the changes tried brings any of the ${n} late order${n === 1 ? "" : "s"} back on time — they need material, a split or a new due day.`;
  return `${what} bring${p.steps.length === 1 ? "s" : ""} the late orders from ${n} to ${p.after.late} (${p.after.lateDays} days late in all)${p.complete ? "" : " — the search ran out of time"}; the rest need more than the knobs give.`;
}
