import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { getWhatIfInputs } from "@/lib/server/whatif";
import { applyRunOrder, clearRunOrder, deleteScenario, saveScenario, type RunOrderLine } from "@/app/simulate/actions";
import { defaultScenario, optimizeQueueWithin, simulate, type Scenario, type WhatIfInputs, type WhatIfResult } from "@/lib/domain/whatif";
import { describeScenario, knobsOfScenario, kpisOf, loadScenario, scenarioCost, scenarioName, withKnobs, type ScenarioKnobs } from "@/lib/domain/whatifScenario";
import { describePlan, planForDeadlines } from "@/lib/domain/deadlinePlan";
import type { AiChange } from "@/lib/domain/aiActions";
import type { ArraySchema, ObjectSchema } from "@/lib/domain/aiInput";
import { formOf, type ReadTool, type ToolCtx, type WriteTool } from "./types";

// The what-if engine, run by the assistant alone (there is no Simulator
// screen): run a scenario — workers added or taken away, Fridays, stoppages,
// material holds, split batches, jobs rushed to the front, the queue
// optimised — against today's open jobs; keep one as the chat's working
// scenario, what the next what-if builds on (nothing in the plant moves, so
// no card); keep one under a name for everyone (What-if — save and delete
// scenarios); and, for an admin, make one THE run order every worklist
// follows. Saving and the run order go through the app's own actions as the
// person; each is undone by putting back what was there.

const TABS = ["simulate"] as const;
const NO_SAVE = "Saving and deleting scenarios needs the \"What-ifs — save and delete scenarios\" permission (Users & Permissions).";
const ADMIN_ONLY = "Only an admin sets the run order the worklists follow.";
/** The largest working scenario a chat keeps, as JSON — room for an edited
 *  queue of some 1500 orders, far beyond the plant's open book. */
const MAX_KEPT_CHARS = 200_000;

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, k) => x === b[k]);

/** A scenario as a chat keeps it: its job order only when someone changed it
 *  (else the day's own order is used when it is read again, so an order
 *  imported tomorrow takes its place by its due day), and nothing at all
 *  when it is the plant as it stands. */
export function keptForm(inputs: WhatIfInputs, scenario: Scenario): Scenario | null {
  const d = defaultScenario(inputs);
  const queueChanged = !sameList(scenario.queue, d.queue);
  const kept: Scenario = { ...scenario, queue: queueChanged ? scenario.queue : [] };
  const plain = !queueChanged && scenario.workFridays === d.workFridays && scenario.shiftHours === d.shiftHours
    && Object.values(scenario.workersDelta).every((v) => v === 0)
    && Object.keys(scenario.splits).length === 0 && Object.keys(scenario.holds).length === 0 && scenario.downtimes.length === 0;
  return plain ? null : kept;
}

/** Keep a scenario as the chat's working one — on the person's own chat,
 *  and for the calls after this one; what is wrong, or null. */
async function keepOnChat(inputs: WhatIfInputs, scenario: Scenario, ctx: ToolCtx): Promise<string | null> {
  if (!ctx.working || ctx.conversationId === null) return "A working scenario is kept only in a chat the person is in.";
  const kept = keptForm(inputs, scenario);
  if (kept && JSON.stringify(kept).length > MAX_KEPT_CHARS) return "This scenario is too large to keep on the chat — narrow its holds, splits or job order.";
  const row = await prisma.aiConversation.updateMany({ where: { id: ctx.conversationId, userId: ctx.user.id }, data: { scenario: kept === null ? Prisma.DbNull : (kept as unknown as Prisma.InputJsonValue) } });
  if (row.count === 0) return "This chat is not there any more.";
  ctx.working.scenario = kept;
  return null;
}

/** The chat's working scenario as kept on the conversation — what a change
 *  built "from the chat" stands on, read again when it is approved. */
async function keptOnChat(ctx: ToolCtx): Promise<unknown> {
  if (ctx.conversationId === null) return null;
  const row = await prisma.aiConversation.findFirst({ where: { id: ctx.conversationId, userId: ctx.user.id }, select: { scenario: true } });
  return row?.scenario ?? null;
}

const FROM_CHAT = {
  type: "boolean",
  description: "true = build it on this chat's working scenario exactly as kept (its queue too — the only way to save or apply a queue optimised, rushed or found by plan_for_deadlines), with any knobs given turned on top. Not with saved.",
} as const;

/** How long the queue optimiser may search inside one request. */
const OPTIMIZE_MS = 8000;
/** Run-order lines the app takes at most (app/simulate/actions.ts). */
const MAX_RUN_ORDER = 500;

const DAY = { type: "string", format: "date" } as const;
const WORKERS = { type: "integer", minimum: -500, maximum: 500 } as const;
const JOB = { type: "string", minLength: 3, maxLength: 120, description: "A job: \"MO|ITEM\", as simulate_scenario lists them." } as const;

export const KNOB_PROPS: ObjectSchema["properties"] = {
  saved: { type: "string", minLength: 1, maxLength: 60, description: "Start from this saved scenario (its exact name — list_scenarios). Leave out to start from the plant as it stands." },
  workersDelta: {
    type: "object",
    properties: { Cut: WORKERS, Welding: WORKERS, ShotBlast: WORKERS, Painting: WORKERS },
    additionalProperties: false,
    description: "Workers added (+) or taken away (−) per department (Cut = Fabrication).",
  },
  shiftHours: { type: "number", minimum: 1, maximum: 24, description: "Man-hours one worker adds a working day (11 unless the person says otherwise)." },
  workFridays: { type: "boolean", description: "true = Fridays become working days." },
  downtimes: {
    type: "array",
    maxItems: 20,
    items: { type: "object", properties: { stage: { type: "string", enum: ["cut", "weld", "finish"] }, fromISO: DAY, toISO: DAY }, required: ["stage", "fromISO", "toISO"], additionalProperties: false },
    description: "Stoppages — nothing passes the station from the first day to the last (inclusive). cut = Fabrication, weld = Welding, finish = Shot Blast and Painting. Replaces the starting scenario's stoppages.",
  },
  holds: {
    type: "array",
    maxItems: 100,
    items: { type: "object", properties: { job: JOB, untilISO: DAY }, required: ["job", "untilISO"], additionalProperties: false },
    description: "Material holds — the job cannot start before the day its material arrives. Replaces the starting scenario's holds.",
  },
  splits: {
    type: "array",
    maxItems: 100,
    items: {
      type: "object",
      properties: { job: JOB, batches: { type: "array", minItems: 2, maxItems: 10, items: { type: "integer", minimum: 1, maximum: 100000 } } },
      required: ["job", "batches"],
      additionalProperties: false,
    },
    description: "Split a job's pieces into batches, the first rushed ahead with the pieces closest to done; the batches add up to the pieces the job still owes. Replaces the starting scenario's splits.",
  },
  first: {
    type: "array",
    maxItems: 100,
    items: { type: "string", minLength: 1, maxLength: 120 },
    description: "Work these first, in this order: a job \"MO|ITEM\", a batch \"MO|ITEM#1\", or an MO (all of its jobs).",
  } satisfies ArraySchema,
};

const OPTIMIZE = { type: "boolean", description: "Reorder the queue for the fewest late jobs, then the least lateness (the optimiser). Not with first." } as const;

export const FROM = {
  type: "string",
  enum: ["chat", "plant"],
  description:
    "What it starts from: chat (the default) = this chat's working scenario (keep_scenario keeps one), else the plant; plant = the plant as it stands, nothing turned. Not with saved.",
} as const;

interface KnobInput extends ScenarioKnobs {
  saved?: string;
}

/** A scenario that may start from the chat's working one. */
export interface StartInput extends KnobInput {
  from?: "chat" | "plant";
  optimize?: boolean;
}

/** The input's knobs, apart from the starting scenario's name. */
function knobsOf(i: KnobInput): ScenarioKnobs {
  return {
    workersDelta: i.workersDelta, shiftHours: i.shiftHours, workFridays: i.workFridays,
    downtimes: i.downtimes, holds: i.holds, splits: i.splits, first: i.first,
  };
}

export function parseStartInput(r: Record<string, unknown>): StartInput | string {
  if (r.optimize === true && Array.isArray(r.first) && r.first.length > 0) return "Either rush jobs with first, or let optimize order the queue — not both.";
  if (r.saved !== undefined && r.from !== undefined) return "Start from a saved scenario (saved), or from the chat's or the plant (from) — not both.";
  return r as unknown as StartInput;
}

/** The chat's working scenario a call starts from — null when it starts
 *  from a saved one or the plant, or there is none (an automation, a chat
 *  that has kept none). */
export function workingStart(i: StartInput, ctx: ToolCtx): unknown {
  return i.saved || i.from === "plant" ? null : (ctx.working?.scenario ?? null);
}

interface Built {
  inputs: WhatIfInputs;
  scenario: Scenario;
  /** The saved scenario it started from, as stored — null from the plant as it stands or the chat's. */
  from: unknown;
  /** What it started from, in words. */
  start: string;
}

/** The scenario the input names: its starting point (a saved scenario, the
 *  chat's working one, or the plant as it stands) with the knobs turned. The
 *  chat's is read against today's jobs as a saved one is. */
export async function buildScenario(i: KnobInput, working: unknown = null, snapshot?: WhatIfInputs): Promise<Built | { error: string }> {
  const inputs = snapshot ?? await getWhatIfInputs();
  let start = defaultScenario(inputs);
  let from: unknown = null;
  let named = "the plant as it stands";
  if (i.saved) {
    const row = await prisma.simScenario.findUnique({ where: { name: scenarioName(i.saved) }, select: { data: true } });
    if (!row) return { error: `No saved scenario is called "${i.saved}" — list_scenarios has their names.` };
    start = loadScenario(inputs, row.data);
    from = row.data;
    named = `the saved scenario "${scenarioName(i.saved)}"`;
  } else if (working !== null) {
    const own = withKnobs(inputs, loadScenario(inputs, working), {});
    if (!own.ok) return { error: `This chat's working scenario cannot be read against today's jobs (${own.error}) — start from the plant (from: plant) or a saved scenario.` };
    start = own.scenario;
    named = "this chat's working scenario";
  }
  const built = withKnobs(inputs, start, knobsOf(i));
  if (!built.ok) return { error: built.error };
  return { inputs, scenario: built.scenario, from, start: named };
}

/** The scenario with its queue optimised, when asked. */
function optimised(b: Built, optimize: boolean | undefined): { scenario: Scenario; optimized: { complete: boolean } | null } {
  if (!optimize) return { scenario: b.scenario, optimized: null };
  const o = optimizeQueueWithin(b.inputs, b.scenario, OPTIMIZE_MS);
  return { scenario: { ...b.scenario, queue: o.queue }, optimized: { complete: o.complete } };
}

const kpiView = (r: WhatIfResult) => {
  const k = kpisOf(r);
  return { ordersOpen: k.active, ordersLate: k.late, ordersOnTime: k.onTime, ordersBlocked: k.blocked, ordersUndated: k.undated, lastClearsISO: k.lastEta };
};

const MAX_JOB_ROWS = 60;
/** Holds and splits listed among a scenario's knobs — what a call takes back. */
const MAX_KNOB_ROWS = 100;

type JobsShown = "late" | "changed" | "all";

/** What a scenario does against today's reality, and its knobs — the answer
 *  of simulate_scenario and keep_scenario. */
function scenarioReport(b: Built, scenario: Scenario, ctx: ToolCtx, o: { show?: JobsShown; optimized: { complete: boolean } | null }) {
  const { inputs } = b;
  const result = simulate(inputs, scenario);
  const baseline = simulate(inputs, defaultScenario(inputs));
  const open = result.jobs.filter((j) => !j.done);
  const show = o.show ?? null;
  const listed = open.filter((j) => (show === "all" ? true : show === "late" ? j.late : show === "changed" ? j.deltaDays !== 0 : j.late || j.deltaDays !== 0));
  const knobs = knobsOfScenario(scenario, inputs);
  return {
    today: ctx.todayISO,
    startedFrom: b.start,
    scenario: describeScenario(scenario, inputs),
    knobs: { ...knobs, holds: knobs.holds.slice(0, MAX_KNOB_ROWS), splits: knobs.splits.slice(0, MAX_KNOB_ROWS) },
    addedManHoursADay: scenarioCost(scenario),
    ...(o.optimized ? { queueOptimised: o.optimized.complete ? "yes" : "partly — the best order found in the time allowed" } : {}),
    reality: kpiView(baseline),
    withScenario: kpiView(result),
    weeklyPlan: inputs.plan
      ? {
          planNo: inputs.plan.planNo, fromISO: inputs.plan.minISO, toISO: inputs.plan.maxISO, workingDays: result.planWorkingDays,
          departments: result.stages.map((s) => ({
            dept: s.dept, requiredH: Math.round(s.required), availableH: s.available === null ? null : Math.round(s.available),
            loadPct: s.load === null ? null : Math.round(s.load * 100),
          })),
        }
      : null,
    jobs: listed.slice(0, MAX_JOB_ROWS).map((j) => ({
      job: j.id, bom: j.bom, qty: j.qty, due: j.dueISO, today: j.baselineISO, scenario: j.etaISO,
      ...(j.deltaDays ? { movesDays: j.deltaDays } : {}), ...(j.late ? { late: true } : {}), ...(j.blockedBy ? { blockedAt: j.blockedBy } : {}),
    })),
    jobsListed: Math.min(listed.length, MAX_JOB_ROWS),
    jobsMatching: listed.length,
    openJobs: open.length,
    queueFront: scenario.queue.slice(0, 15),
  };
}

// ------------------------------------------------------------------ reads

export const listScenariosTool: ReadTool<Record<string, never>> = {
  kind: "read",
  name: "list_scenarios",
  title: "Looking at the saved scenarios",
  description: "The what-if scenarios saved for everyone (name, who saved it and when, what it changes), and the run order the worklists follow now, if one is set.",
  schema: { type: "object", properties: {}, additionalProperties: false },
  tabs: TABS,
  async run() {
    const [rows, live, liveCount, inputs] = await Promise.all([
      prisma.simScenario.findMany({ orderBy: { updatedAt: "desc" }, take: 100, select: { name: true, data: true, savedBy: true, updatedAt: true } }),
      prisma.runOrderEntry.findFirst({ orderBy: { appliedAt: "desc" }, select: { appliedAt: true, appliedBy: true } }),
      prisma.runOrderEntry.count(),
      getWhatIfInputs(),
    ]);
    return {
      ok: true,
      text: JSON.stringify({
        scenarios: rows.map((r) => ({ name: r.name, savedBy: r.savedBy, savedAt: r.updatedAt.toISOString(), changes: describeScenario(loadScenario(inputs, r.data), inputs) })),
        runOrder: live ? { jobs: liveCount, setBy: live.appliedBy, setAt: live.appliedAt.toISOString() } : null,
      }),
    };
  },
};

interface SimulateInput extends StartInput {
  show?: JobsShown;
}

export const simulateScenarioTool: ReadTool<SimulateInput> = {
  kind: "read",
  name: "simulate_scenario",
  title: "Running a what-if scenario",
  description:
    "Run a what-if on the plant's model — it changes nothing, not even this chat's working scenario (keep_scenario keeps one). Start from this chat's working scenario (the default; the plant as it stands when there is none), the plant (from: plant) or a saved scenario, and turn the knobs: workers per department, hours a worker adds, Fridays, stoppages, material holds, split batches, jobs rushed to the front, or the optimised queue. Returns the scenario and its knobs against today's reality: orders late and when the last clears, the weekly plan's load per department, and the jobs that are late or move (each with its due day, today's forecast and the scenario's). A job is one component of one order, \"MO|ITEM\".",
  schema: {
    type: "object",
    properties: {
      ...KNOB_PROPS,
      from: FROM,
      optimize: OPTIMIZE,
      show: { type: "string", enum: ["late", "changed", "all"], description: "Which jobs to list: late = late under the scenario, changed = their date moves, all = every open job (at most 60 rows). Default: late and changed." },
    },
    additionalProperties: false,
  },
  tabs: TABS,
  parse: (r) => parseStartInput(r) as SimulateInput | string,
  status: (i) => (i.optimize ? "Optimising the queue" : "Running the scenario"),
  async run(i, ctx) {
    const built = await buildScenario(i, workingStart(i, ctx));
    if ("error" in built) return { ok: false, text: built.error };
    const { scenario, optimized } = optimised(built, i.optimize);
    return { ok: true, text: JSON.stringify(scenarioReport(built, scenario, ctx, { show: i.show, optimized })) };
  },
};

export const keepScenarioTool: ReadTool<StartInput> = {
  kind: "read",
  name: "keep_scenario",
  title: "Keeping the what-if for this chat",
  description:
    "Make a what-if this chat's working scenario — what the next what-if, comparison or deadline search starts from — and say what it does. Nothing in the plant changes and no card is needed: it is kept on this chat alone. Use it when the person asks for a what-if (\"add two welders\", \"and Fridays too\"), so the next question builds on it; weigh variants without keeping them with simulate_scenario. Built like simulate_scenario: from the working scenario (the default), the plant as it stands (from: plant — start afresh) or a saved scenario, with the knobs turned. A knob given replaces that knob of the start — stoppages, holds and splits as whole lists, so send back the result's knobs with the one change; a knob left out keeps it. Returns what it does against today's reality.",
  schema: { type: "object", properties: { ...KNOB_PROPS, from: FROM, optimize: OPTIMIZE }, additionalProperties: false },
  tabs: TABS,
  keeps: true,
  // a chat's own — never in an automation, where there is no chat
  liveOnly: true,
  // the reads beside it would start from the scenario it replaces
  serial: true,
  parse: parseStartInput,
  status: (i) => (i.optimize ? "Optimising the queue" : "Running the what-if"),
  async run(i, ctx) {
    if (!ctx.working || ctx.conversationId === null) return { ok: false, text: "A working scenario is kept only in a chat the person is in." };
    const built = await buildScenario(i, workingStart(i, ctx));
    if ("error" in built) return { ok: false, text: built.error };
    const { scenario, optimized } = optimised(built, i.optimize);
    // the person's own chat alone; the calls after this one start from it
    const wrong = await keepOnChat(built.inputs, scenario, ctx);
    if (wrong) return { ok: false, text: wrong };
    return {
      ok: true,
      text: JSON.stringify({ kept: "This chat's working scenario now — the next what-if starts from it.", ...scenarioReport(built, scenario, ctx, { optimized }) }),
    };
  },
};

interface DeadlineInput extends StartInput {
  mos?: string[];
  fridays?: boolean;
  keep?: boolean;
}

/** How long the deadline search may take inside one request. */
const DEADLINE_MS = 5000;

/** The cheapest way to meet the deadlines — searched on the what-if model. */
export const planForDeadlinesTool: ReadTool<DeadlineInput> = {
  kind: "read",
  name: "plan_for_deadlines",
  title: "Finding what it takes to meet the deadlines",
  description:
    "What it takes to bring the late orders back on time — or only the orders named — searched on the plant's what-if model: first what costs nothing (the order the jobs are worked in), then one step at a time the addition that rescues the most per man-hour: more workers at a department, or Fridays worked (overtime for today's crew is not in the model). Returns each step with what it does (late orders and days late after it), the man-hours a week it adds, the knobs of the result and the orders still late, if any. It changes nothing in the plant; keep: true keeps the result as this chat's working scenario exactly (its job order too). Starts like simulate_scenario (the chat's working scenario, the plant, or a saved scenario, with knobs turned).",
  schema: {
    type: "object",
    properties: {
      ...KNOB_PROPS,
      from: FROM,
      mos: { type: "array", maxItems: 50, items: { type: "string", minLength: 3, maxLength: 60 }, description: "Only these orders (their MOs) must make their due day; leave out for every order with a due day." },
      fridays: { type: "boolean", description: "May it suggest working Fridays (default yes)." },
      keep: { type: "boolean", description: "true = keep the result as this chat's working scenario, exactly as found (its job order too, which its knobs alone cannot carry) — so the next question, save_scenario or apply_run_order (fromChat) builds on it." },
    },
    additionalProperties: false,
  },
  tabs: TABS,
  // kept, it changes what the reads beside it start from
  serial: true,
  parse: (r) => {
    const base = parseStartInput(r);
    if (typeof base === "string") return base;
    return {
      ...base,
      ...(Array.isArray(r.mos) && r.mos.length ? { mos: [...new Set((r.mos as string[]).map((m) => m.trim()).filter(Boolean))] } : {}),
      ...(r.fridays === false ? { fridays: false } : {}),
      ...(r.keep === true ? { keep: true } : {}),
    };
  },
  status: () => "Searching for what meets the deadlines",
  async run(i, ctx) {
    const built = await buildScenario(i, workingStart(i, ctx));
    if ("error" in built) return { ok: false, text: built.error };
    if (i.mos) {
      const open = new Set(built.inputs.jobs.map((j) => j.mo));
      const unknown = i.mos.filter((m) => !open.has(m));
      if (unknown.length) return { ok: false, text: `Not open in today's queue: ${unknown.join(", ")}.` };
    }
    const p = planForDeadlines(built.inputs, built.scenario, { mos: i.mos, budgetMs: DEADLINE_MS, allowFridays: i.fridays !== false });
    const knobs = knobsOfScenario(p.scenario, built.inputs);
    const keepError = i.keep ? await keepOnChat(built.inputs, p.scenario, ctx) : null;
    return {
      ok: true,
      text: JSON.stringify({
        startedFrom: built.start,
        summary: describePlan(p),
        before: { lateOrders: p.before.late, daysLate: p.before.lateDays, cannotTime: p.before.blocked },
        steps: p.steps.map((s) => ({ change: s.change, addsManHoursAWeek: Math.round(s.costMhWeek), lateOrdersAfter: s.after.late, daysLateAfter: s.after.lateDays })),
        after: { lateOrders: p.after.late, daysLate: p.after.lateDays, stillLate: p.after.orders.filter((o) => o.late).map((o) => ({ mo: o.mo, due: o.dueISO, finishes: o.etaISO })) },
        met: p.met,
        searchComplete: p.complete,
        addsManHoursAWeek: Math.round(p.costMhWeek),
        scenario: describeScenario(p.scenario, built.inputs),
        knobs: { ...knobs, holds: knobs.holds.slice(0, MAX_KNOB_ROWS), splits: knobs.splits.slice(0, MAX_KNOB_ROWS) },
        ...(i.keep ? { kept: keepError ?? "This chat's working scenario now — exactly as found, its job order too." } : {}),
      }),
    };
  },
};

// ------------------------------------------------------- saved scenarios

interface SaveInput extends KnobInput {
  name: string;
  optimize?: boolean;
  fromChat?: boolean;
}

const SAVE_SCHEMA: ObjectSchema = {
  type: "object",
  properties: { name: { type: "string", minLength: 1, maxLength: 60, description: "The name to save it under — an existing name is overwritten." }, ...KNOB_PROPS, optimize: OPTIMIZE, fromChat: FROM_CHAT },
  required: ["name"],
  additionalProperties: false,
};

/** A change's scenario: on the chat's working one as kept (fromChat), or
 *  from the plant or a saved one — the knobs turned on top either way. */
async function changeScenario(i: KnobInput & { fromChat?: boolean }, ctx: ToolCtx): Promise<Built | { error: string }> {
  if (!i.fromChat) return buildScenario(i);
  const kept = await keptOnChat(ctx);
  if (kept === null) return { error: "This chat keeps no working scenario — keep one with keep_scenario first, or build it from the knobs." };
  const built = await buildScenario(i, kept);
  // what the change stands on: the kept scenario must still be so when it is approved
  return "error" in built ? built : { ...built, from: kept, start: "this chat's working scenario" };
}

const fromChatOrSaved = (r: Record<string, unknown>): string | null => (r.fromChat === true && r.saved !== undefined ? "Build it on the chat's working scenario (fromChat) or a saved one (saved) — not both." : null);

const savedLine = (inputs: WhatIfInputs, row: { data: unknown; savedBy: string | null } | null) =>
  row ? `${describeScenario(loadScenario(inputs, row.data), inputs)}${row.savedBy ? ` (saved by ${row.savedBy})` : ""}` : "—";

export const saveScenarioTool: WriteTool<SaveInput> = {
  kind: "write",
  name: "save_scenario",
  title: "Save a what-if scenario",
  description:
    "Save a what-if scenario under a name, for everyone to load — this chat's working scenario exactly as kept (fromChat: its queue too), or built from the plant as it stands or a saved one, with the knobs turned (optionally the optimised queue). A scenario of that name is overwritten. Show it to the person first (keep_scenario, or simulate_scenario).",
  area: "simulator",
  risk: "low",
  tabs: TABS,
  schema: SAVE_SCHEMA,
  parse: (r) => fromChatOrSaved(r) ?? (r.optimize === true && Array.isArray(r.first) && r.first.length > 0 ? "Either rush jobs with first, or let optimize order the queue — not both." : { ...(r as unknown as SaveInput), name: scenarioName(r.name) }),
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, "simulator.edit")) return { error: NO_SAVE };
    const built = await changeScenario(i, ctx);
    if ("error" in built) return built;
    const existing = await prisma.simScenario.findUnique({ where: { name: i.name }, select: { data: true, savedBy: true } });
    const what = `${describeScenario(built.scenario, built.inputs)}${i.optimize ? " · queue optimised" : ""}`;
    return {
      title: `Save scenario "${i.name}"`,
      summary: `Save the scenario "${i.name}" (${what}) for everyone${existing ? `, replacing the one saved${existing.savedBy ? ` by ${existing.savedBy}` : ""}` : ""}.`,
      changes: [{ label: i.name, before: savedLine(built.inputs, existing), after: what }],
      // what it overwrites, and what it is built from, must still be so
      snapshot: { name: i.name, existing: existing?.data ?? null, from: built.from },
    };
  },
  async execute(i, ctx) {
    const built = await changeScenario(i, ctx);
    if ("error" in built) return { ok: false, error: built.error };
    let scenario = built.scenario;
    if (i.optimize) scenario = { ...scenario, queue: optimizeQueueWithin(built.inputs, scenario, OPTIMIZE_MS).queue };
    const before = await prisma.simScenario.findUnique({ where: { name: i.name }, select: { data: true } });
    const r = await saveScenario(formOf({ name: i.name, data: JSON.stringify(scenario) }));
    if (!r.ok) return { ok: false, error: r.error };
    return {
      ok: true,
      message: `Saved "${i.name}" — it is on the list of saved scenarios.`,
      undo: { tool: "restore_scenario", input: { name: i.name, data: before ? JSON.stringify(before.data) : null } },
    };
  },
};

export const deleteScenarioTool: WriteTool<{ name: string }> = {
  kind: "write",
  name: "delete_scenario",
  title: "Delete a saved scenario",
  description: "Delete a saved what-if scenario, by its exact name.",
  area: "simulator",
  risk: "destructive",
  tabs: TABS,
  schema: { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 60 } }, required: ["name"], additionalProperties: false },
  parse: (r) => ({ name: scenarioName(r.name) }),
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, "simulator.edit")) return { error: NO_SAVE };
    const row = await prisma.simScenario.findUnique({ where: { name: i.name }, select: { data: true, savedBy: true } });
    if (!row) return { error: `No saved scenario is called "${i.name}".` };
    const inputs = await getWhatIfInputs();
    return {
      title: `Delete scenario "${i.name}"`,
      summary: `Delete the saved scenario "${i.name}"${row.savedBy ? ` (saved by ${row.savedBy})` : ""}.`,
      changes: [{ label: i.name, before: savedLine(inputs, row), after: "deleted" }],
      snapshot: { name: i.name, data: row.data },
    };
  },
  async execute(i) {
    const before = await prisma.simScenario.findUnique({ where: { name: i.name }, select: { data: true } });
    if (!before) return { ok: false, error: `No saved scenario is called "${i.name}".` };
    const r = await deleteScenario(formOf({ name: i.name }));
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, message: `Deleted "${i.name}".`, undo: { tool: "restore_scenario", input: { name: i.name, data: JSON.stringify(before.data) } } };
  },
};

interface RestoreScenarioInput {
  name: string;
  /** The scenario's data as JSON text, or null for "there was none". */
  data: string | null;
}

/** The undo of a save or a delete — never offered to the model. */
export const restoreScenarioTool: WriteTool<RestoreScenarioInput> = {
  kind: "write",
  name: "restore_scenario",
  internal: true,
  title: "Put a saved scenario back",
  description: "Put a saved scenario back as it was before a change: its earlier data, or gone when there was none (the undo of a save or a delete).",
  area: "simulator",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: { name: { type: "string", minLength: 1, maxLength: 60 }, data: { type: ["string", "null"], maxLength: 2_000_000 } },
    required: ["name", "data"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, "simulator.edit")) return { error: NO_SAVE };
    const now = await prisma.simScenario.findUnique({ where: { name: i.name }, select: { data: true } });
    return {
      title: i.data === null ? `Remove scenario "${i.name}"` : `Put scenario "${i.name}" back`,
      summary: i.data === null ? `Remove the scenario "${i.name}" again — it was not there before.` : `Put the scenario "${i.name}" back as it was.`,
      changes: [{ label: i.name, before: now ? "saved" : "—", after: i.data === null ? "—" : "as it was" }],
      snapshot: { name: i.name, now: now?.data ?? null },
    };
  },
  async execute(i) {
    const r = i.data === null ? await deleteScenario(formOf({ name: i.name })) : await saveScenario(formOf({ name: i.name, data: i.data }));
    return r.ok ? { ok: true, message: i.data === null ? `"${i.name}" is removed.` : `"${i.name}" is back as it was.` } : { ok: false, error: r.error };
  },
};

// -------------------------------------------------------------- run order

async function liveRunOrder(): Promise<RunOrderLine[]> {
  const rows = await prisma.runOrderEntry.findMany({ orderBy: [{ rank: "asc" }, { id: "asc" }], select: { mo: true, item: true, batchQty: true, batchNo: true } });
  return rows;
}

const lineText = (l: RunOrderLine) => `${l.mo} ${l.item}${l.batchNo !== null ? ` batch ${l.batchNo}${l.batchQty !== null ? ` ×${l.batchQty}` : ""}` : ""}`;

/** What a run order changes, rank by rank — the first 40. */
function orderChanges(now: RunOrderLine[], next: RunOrderLine[]): AiChange[] {
  const n = Math.min(40, Math.max(now.length, next.length));
  return Array.from({ length: n }, (_, k) => ({ label: `#${k + 1}`, before: now[k] ? lineText(now[k]) : "—", after: next[k] ? lineText(next[k]) : "—" }));
}

/** The run order a scenario stands for: its open jobs in its queue order —
 *  what apply_run_order commits. */
function runOrderOf(inputs: WhatIfInputs, scenario: Scenario): RunOrderLine[] {
  return simulate(inputs, scenario).jobs
    .filter((j) => !j.done)
    .map((j) => ({ mo: j.mo, item: j.item, batchQty: j.batch !== null ? j.qty : null, batchNo: j.batch }));
}

export const applyRunOrderTool: WriteTool<KnobInput & { fromChat?: boolean }> = {
  kind: "write",
  name: "apply_run_order",
  title: "Make a scenario the run order",
  description:
    "Admin only. Make a scenario's queue THE run order: every department's worklist then shows its slice of it, in this order, until it is replaced or removed — it moves the real factory. Take this chat's working scenario exactly as kept (fromChat — its queue too, the way to apply one optimised, rushed or found by plan_for_deadlines), a saved scenario, or the knobs (not optimize). The card lists the new order against the one live now.",
  area: "simulator",
  risk: "high",
  tabs: TABS,
  schema: { type: "object", properties: { ...KNOB_PROPS, fromChat: FROM_CHAT }, additionalProperties: false },
  parse: (r) => fromChatOrSaved(r) ?? (r as KnobInput & { fromChat?: boolean }),
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: ADMIN_ONLY };
    const built = await changeScenario(i, ctx);
    if ("error" in built) return built;
    const next = runOrderOf(built.inputs, built.scenario);
    if (next.length === 0) return { error: "Nothing open to put in a run order." };
    if (next.length > MAX_RUN_ORDER) return { error: `${next.length} open jobs — the run order takes ${MAX_RUN_ORDER} at most.` };
    const now = await liveRunOrder();
    return {
      title: `Make this the run order — ${next.length} jobs`,
      summary: `Every department's worklist will show its slice of this order (${describeScenario(built.scenario, built.inputs)}), replacing ${now.length ? `the run order live now (${now.length} jobs)` : "the plain due-date order"}.`,
      changes: orderChanges(now, next),
      // the run order it replaces, and the scenario it comes from, must still
      // be so; the jobs themselves move all day (one finishing drops out of
      // the order, a new one joins its back), so they are read again at the
      // approval and the order applied is the scenario's as it stands then
      snapshot: { now, from: built.from },
    };
  },
  async execute(i, ctx) {
    const built = await changeScenario(i, ctx);
    if ("error" in built) return { ok: false, error: built.error };
    const next = runOrderOf(built.inputs, built.scenario);
    const before = await liveRunOrder();
    const r = await applyRunOrder(formOf({ entries: JSON.stringify(next) }));
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, message: `The run order is live on the worklists — ${next.length} jobs.`, undo: { tool: "restore_run_order", input: { entries: JSON.stringify(before) } } };
  },
};

export const clearRunOrderTool: WriteTool<Record<string, never>> = {
  kind: "write",
  name: "clear_run_order",
  title: "Remove the run order",
  description: "Admin only. Take the run order off the worklists — each goes back to its plain due-date order.",
  area: "simulator",
  risk: "destructive",
  tabs: TABS,
  schema: { type: "object", properties: {}, additionalProperties: false },
  async describe(_i, ctx) {
    if (!ctx.user.isAdmin) return { error: ADMIN_ONLY };
    const now = await liveRunOrder();
    if (now.length === 0) return { error: "No run order is live — the worklists follow the due dates already." };
    return {
      title: "Remove the run order",
      summary: `Take the run order (${now.length} jobs) off every worklist; they go back to the plain due-date order.`,
      changes: [{ label: "Run order", before: `${now.length} jobs, first ${lineText(now[0])}`, after: "none — due-date order" }],
      snapshot: now,
    };
  },
  async execute() {
    const before = await liveRunOrder();
    const r = await clearRunOrder();
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, message: "The run order is off the worklists.", undo: { tool: "restore_run_order", input: { entries: JSON.stringify(before) } } };
  },
};

/** The undo of setting or removing the run order — never offered to the model. */
export const restoreRunOrderTool: WriteTool<{ entries: string }> = {
  kind: "write",
  name: "restore_run_order",
  internal: true,
  title: "Put the run order back",
  description: "Put the run order back exactly as it was before a change (none, when there was none).",
  area: "simulator",
  risk: "high",
  tabs: TABS,
  schema: { type: "object", properties: { entries: { type: "string", maxLength: 200000 } }, required: ["entries"], additionalProperties: false },
  parse: (r) => {
    try {
      return Array.isArray(JSON.parse(String(r.entries))) ? { entries: String(r.entries) } : "The run order to put back is not a list.";
    } catch {
      return "The run order to put back cannot be read.";
    }
  },
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: ADMIN_ONLY };
    const back = JSON.parse(i.entries) as RunOrderLine[];
    const now = await liveRunOrder();
    return {
      title: "Put the run order back",
      summary: back.length ? `Put the earlier run order back (${back.length} jobs).` : "Take the run order off again — there was none before.",
      changes: orderChanges(now, back),
      snapshot: now,
    };
  },
  async execute(i) {
    const back = JSON.parse(i.entries) as RunOrderLine[];
    const r = back.length === 0 ? await clearRunOrder() : await applyRunOrder(formOf({ entries: i.entries }));
    return r.ok ? { ok: true, message: back.length ? "The earlier run order is back." : "The run order is off again." } : { ok: false, error: r.error };
  },
};

export const SIMULATOR_TOOLS = [
  listScenariosTool,
  simulateScenarioTool,
  keepScenarioTool,
  planForDeadlinesTool,
  saveScenarioTool,
  deleteScenarioTool,
  applyRunOrderTool,
  clearRunOrderTool,
  restoreScenarioTool,
  restoreRunOrderTool,
] as const;
