import "server-only";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { getWhatIfInputs } from "@/lib/server/whatif";
import { applyRunOrder, clearRunOrder, deleteScenario, saveScenario, type RunOrderLine } from "@/app/simulate/actions";
import { defaultScenario, optimizeQueueWithin, simulate, type Scenario, type WhatIfInputs, type WhatIfResult } from "@/lib/domain/whatif";
import { describeScenario, knobsOfScenario, kpisOf, loadScenario, scenarioCost, scenarioName, withKnobs, type ScenarioKnobs } from "@/lib/domain/whatifScenario";
import type { AiChange } from "@/lib/domain/aiActions";
import type { ArraySchema, ObjectSchema } from "@/lib/domain/aiInput";
import { formOf, type ReadTool, type ToolCtx, type WriteTool } from "./types";

// The What-if Simulator for the assistant: run a scenario — workers added or
// taken away, Fridays, stoppages, material holds, split batches, jobs rushed
// to the front, the queue optimised — against today's open jobs with the
// screen's own arithmetic; put one on the person's own Simulator, as they
// would turn its knobs themselves (nothing in the plant moves, so no card);
// keep one under a name for everyone (Simulator — save and delete
// scenarios); and, for an admin, make one THE run order every worklist
// follows. Saving and the run order go through the screen's own actions as
// the person; each is undone by putting back what was there.

const TABS = ["simulate"] as const;
const NO_SAVE = "Saving and deleting scenarios needs the Simulator — save and delete scenarios permission (Users & Permissions).";
const ADMIN_ONLY = "Only an admin sets the run order the worklists follow.";
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

const OPTIMIZE = { type: "boolean", description: "Reorder the queue for the fewest late jobs, then the least lateness (the screen's ⚡ optimiser). Not with first." } as const;

export const FROM = {
  type: "string",
  enum: ["screen", "plant"],
  description:
    "What it starts from: screen (the default) = the scenario on the person's Simulator — while it is not open, the one last offered them in this answer, else the plant; plant = the plant as it stands, nothing turned. Not with saved.",
} as const;

interface KnobInput extends ScenarioKnobs {
  saved?: string;
}

/** A scenario that may start from the person's Simulator. */
export interface ScreenInput extends KnobInput {
  from?: "screen" | "plant";
  optimize?: boolean;
}

/** The input's knobs, apart from the starting scenario's name. */
function knobsOf(i: KnobInput): ScenarioKnobs {
  return {
    workersDelta: i.workersDelta, shiftHours: i.shiftHours, workFridays: i.workFridays,
    downtimes: i.downtimes, holds: i.holds, splits: i.splits, first: i.first,
  };
}

export function parseScreenInput(r: Record<string, unknown>): ScreenInput | string {
  if (r.optimize === true && Array.isArray(r.first) && r.first.length > 0) return "Either rush jobs with first, or let optimize order the queue — not both.";
  if (r.saved !== undefined && r.from !== undefined) return "Start from a saved scenario (saved), or from the screen or the plant (from) — not both.";
  return r as unknown as ScreenInput;
}

/** The scenario on the person's Simulator a call starts from — null when it
 *  starts from a saved one or the plant, or there is none (an automation, a
 *  Simulator that is not open). */
export function screenStart(i: ScreenInput, ctx: ToolCtx): unknown {
  return i.saved || i.from === "plant" ? null : (ctx.screen?.simulator.scenario ?? null);
}

interface Built {
  inputs: WhatIfInputs;
  scenario: Scenario;
  /** The saved scenario it started from, as stored — null from the plant as it stands or the screen. */
  from: unknown;
  /** What it started from, in words. */
  start: string;
}

/** The scenario the input names: its starting point (a saved scenario, the
 *  one on the person's Simulator, or the plant as it stands) with the knobs
 *  turned. The screen's is read against today's jobs as a saved one is. */
export async function buildScenario(i: KnobInput, screen: unknown = null, snapshot?: WhatIfInputs): Promise<Built | { error: string }> {
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
  } else if (screen !== null) {
    const own = withKnobs(inputs, loadScenario(inputs, screen), {});
    if (!own.ok) return { error: `The scenario on the person's Simulator cannot be read (${own.error}) — start from the plant (from: plant) or a saved scenario.` };
    start = own.scenario;
    named = "the scenario on the person's Simulator";
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
 *  of simulate_scenario and show_on_simulator. */
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
  description: "The what-if scenarios saved on the Simulator (name, who saved it and when, what it changes), and the run order the worklists follow now, if one is set.",
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

interface SimulateInput extends ScreenInput {
  show?: JobsShown;
}

export const simulateScenarioTool: ReadTool<SimulateInput> = {
  kind: "read",
  name: "simulate_scenario",
  title: "Running a what-if scenario",
  description:
    "Run a what-if on the Simulator's own arithmetic — it changes nothing, not even the person's screen (show_on_simulator puts one there). Start from what the person's Simulator shows (the default; the plant as it stands when there is none), the plant (from: plant) or a saved scenario, and turn the knobs: workers per department, hours a worker adds, Fridays, stoppages, material holds, split batches, jobs rushed to the front, or the optimised queue. Returns the scenario and its knobs against today's reality: orders late and when the last clears, the weekly plan's load per department, and the jobs that are late or move (each with its due day, today's forecast and the scenario's). A job is one component of one order, \"MO|ITEM\".",
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
  parse: (r) => parseScreenInput(r) as SimulateInput | string,
  status: (i) => (i.optimize ? "Optimising the queue" : "Running the scenario"),
  async run(i, ctx) {
    const built = await buildScenario(i, screenStart(i, ctx));
    if ("error" in built) return { ok: false, text: built.error };
    const { scenario, optimized } = optimised(built, i.optimize);
    return { ok: true, text: JSON.stringify(scenarioReport(built, scenario, ctx, { show: i.show, optimized })) };
  },
};

export const showOnSimulatorTool: ReadTool<ScreenInput> = {
  kind: "read",
  name: "show_on_simulator",
  title: "Putting it on the Simulator",
  description:
    "Put a what-if scenario on the person's What-if Simulator, at once and with no card — nothing in the plant changes: it is their own screen, and the scenario it replaces stays one click away there. While the Simulator is open beside the chat, what they see changes; while it is not, the chat shows them a button that opens it with this scenario. Built like simulate_scenario: from what the Simulator shows (the default), the plant as it stands (from: plant — the screen's changes dropped) or a saved scenario (saved — how one is opened on it), with the knobs turned. A knob given replaces that knob of the start — stoppages, holds and splits as whole lists, so send back the result's knobs with the one change; a knob left out keeps it. Returns what it does against today's reality.",
  schema: { type: "object", properties: { ...KNOB_PROPS, from: FROM, optimize: OPTIMIZE }, additionalProperties: false },
  tabs: TABS,
  // the person's screen — never in an automation, where nobody has one
  liveOnly: true,
  parse: parseScreenInput,
  status: (i) => (i.optimize ? "Optimising the queue" : "Putting it on the Simulator"),
  async run(i, ctx) {
    if (!ctx.screen) return { ok: false, text: "The Simulator can be changed only in a chat the person is in." };
    const built = await buildScenario(i, screenStart(i, ctx));
    if ("error" in built) return { ok: false, text: built.error };
    const { scenario, optimized } = optimised(built, i.optimize);
    const { open } = ctx.screen.simulator;
    // what the Simulator shows now — or would open with — for the calls after
    ctx.screen.simulator = { open, scenario };
    const named = describeScenario(scenario, built.inputs);
    return {
      ok: true,
      text: JSON.stringify({
        screen: open
          ? "On the person's Simulator now; the scenario it replaced is one click away there."
          : "The Simulator is not open on the person's screen: the chat shows them a button that opens it with this scenario.",
        ...scenarioReport(built, scenario, ctx, { optimized }),
      }),
      simulator: { scenario, label: optimized ? named.replace("queue edited", "queue optimised") : named },
    };
  },
};

// ------------------------------------------------------- saved scenarios

interface SaveInput extends KnobInput {
  name: string;
  optimize?: boolean;
}

const SAVE_SCHEMA: ObjectSchema = {
  type: "object",
  properties: { name: { type: "string", minLength: 1, maxLength: 60, description: "The name to save it under — an existing name is overwritten." }, ...KNOB_PROPS, optimize: OPTIMIZE },
  required: ["name"],
  additionalProperties: false,
};

const savedLine = (inputs: WhatIfInputs, row: { data: unknown; savedBy: string | null } | null) =>
  row ? `${describeScenario(loadScenario(inputs, row.data), inputs)}${row.savedBy ? ` (saved by ${row.savedBy})` : ""}` : "—";

export const saveScenarioTool: WriteTool<SaveInput> = {
  kind: "write",
  name: "save_scenario",
  title: "Save a what-if scenario",
  description:
    "Save a what-if scenario on the Simulator under a name, for everyone to load — built from the plant as it stands or a saved one, with the knobs turned (optionally the optimised queue). It does not read the person's screen: to keep what their Simulator shows, send the knobs simulate_scenario or show_on_simulator report — a queue reordered by hand (queueEdited) cannot be sent, so then the person saves it with the Simulator's own Save. A scenario of that name is overwritten. Show it to the person first (show_on_simulator, or simulate_scenario).",
  area: "simulator",
  risk: "low",
  tabs: TABS,
  schema: SAVE_SCHEMA,
  parse: (r) => (r.optimize === true && Array.isArray(r.first) && r.first.length > 0 ? "Either rush jobs with first, or let optimize order the queue — not both." : { ...(r as unknown as SaveInput), name: scenarioName(r.name) }),
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, "simulator.edit")) return { error: NO_SAVE };
    const built = await buildScenario(i);
    if ("error" in built) return built;
    const existing = await prisma.simScenario.findUnique({ where: { name: i.name }, select: { data: true, savedBy: true } });
    const what = `${describeScenario(built.scenario, built.inputs)}${i.optimize ? " · queue optimised" : ""}`;
    return {
      title: `Save scenario "${i.name}"`,
      summary: `Save the scenario "${i.name}" (${what}) on the Simulator${existing ? `, replacing the one saved${existing.savedBy ? ` by ${existing.savedBy}` : ""}` : ""}.`,
      changes: [{ label: i.name, before: savedLine(built.inputs, existing), after: what }],
      // what it overwrites, and what it is built from, must still be so
      snapshot: { name: i.name, existing: existing?.data ?? null, from: built.from },
    };
  },
  async execute(i) {
    const built = await buildScenario(i);
    if ("error" in built) return { ok: false, error: built.error };
    let scenario = built.scenario;
    if (i.optimize) scenario = { ...scenario, queue: optimizeQueueWithin(built.inputs, scenario, OPTIMIZE_MS).queue };
    const before = await prisma.simScenario.findUnique({ where: { name: i.name }, select: { data: true } });
    const r = await saveScenario(formOf({ name: i.name, data: JSON.stringify(scenario) }));
    if (!r.ok) return { ok: false, error: r.error };
    return {
      ok: true,
      message: `Saved "${i.name}" — it is on the Simulator's list of saved scenarios.`,
      undo: { tool: "restore_scenario", input: { name: i.name, data: before ? JSON.stringify(before.data) : null } },
    };
  },
};

export const deleteScenarioTool: WriteTool<{ name: string }> = {
  kind: "write",
  name: "delete_scenario",
  title: "Delete a saved scenario",
  description: "Delete a saved what-if scenario from the Simulator, by its exact name.",
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
      summary: `Delete the saved scenario "${i.name}"${row.savedBy ? ` (saved by ${row.savedBy})` : ""} from the Simulator.`,
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
 *  what the screen's "Apply as the run order" commits. */
function runOrderOf(inputs: WhatIfInputs, scenario: Scenario): RunOrderLine[] {
  return simulate(inputs, scenario).jobs
    .filter((j) => !j.done)
    .map((j) => ({ mo: j.mo, item: j.item, batchQty: j.batch !== null ? j.qty : null, batchNo: j.batch }));
}

export const applyRunOrderTool: WriteTool<KnobInput> = {
  kind: "write",
  name: "apply_run_order",
  title: "Make a scenario the run order",
  description:
    "Admin only. Make a scenario's queue THE run order: every department's worklist then shows its slice of it, in this order, until it is replaced or removed — it moves the real factory. Name a saved scenario (save an optimised one first with save_scenario), or the knobs (not optimize). The card lists the new order against the one live now.",
  area: "simulator",
  risk: "high",
  tabs: TABS,
  schema: { type: "object", properties: { ...KNOB_PROPS }, additionalProperties: false },
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: ADMIN_ONLY };
    const built = await buildScenario(i);
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
  async execute(i) {
    const built = await buildScenario(i);
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
  showOnSimulatorTool,
  saveScenarioTool,
  deleteScenarioTool,
  applyRunOrderTool,
  clearRunOrderTool,
  restoreScenarioTool,
  restoreRunOrderTool,
] as const;
