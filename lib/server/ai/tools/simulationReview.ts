import "server-only";
import { traceHref } from "@/lib/domain/links";
import { getWhatIfInputs } from "@/lib/server/whatif";
import { withLine } from "@/lib/server/line";
import { compareSimulations, simulationReadiness, stressSimulations, type NamedSimulation, type StressCase } from "@/lib/domain/simulationReview";
import { optimizeQueueWithin, type WhatIfInputs } from "@/lib/domain/whatif";
import { describeScenario, knobsOfScenario, withKnobs, type ScenarioKnobs } from "@/lib/domain/whatifScenario";
import type { ObjectSchema } from "@/lib/domain/aiInput";
import { buildScenario, FROM, KNOB_PROPS, parseScreenInput, screenStart, type ScreenInput } from "./simulator";
import type { ReadTool, ToolCtx } from "./types";

interface Variant extends ScenarioKnobs { label: string; optimize?: boolean }
interface Start { from?: ScreenInput["from"]; saved?: string; line?: "TR" }
interface CompareInput extends Start { variants: Variant[]; detailLimit?: number }
interface StressInput extends Start { variants?: Variant[]; stresses: StressCase[] }
const { saved: savedSchema, ...knobs } = KNOB_PROPS;
const label = { type: "string", minLength: 1, maxLength: 80 } as const;
const VARIANT: ObjectSchema = { type: "object", properties: { label, ...knobs, optimize: { type: "boolean", description: "Optimise this alternative's queue within a bounded search; not with first." } }, required: ["label"], additionalProperties: false };
const START = { from: FROM, saved: savedSchema, line: { type: "string", enum: ["TR"], description: "This simulator models transformers only. Specify TR explicitly when intentionally reviewing transformers from an LV screen." } } satisfies ObjectSchema["properties"];
function validate(raw: Record<string, unknown>) {
  const start = parseScreenInput(raw);
  if (typeof start === "string") return start;
  const variants = (raw.variants ?? []) as Variant[];
  const stresses = (raw.stresses ?? []) as StressCase[];
  for (const list of [variants, stresses]) {
    const names = list.map((r) => r.label.toLowerCase());
    if (new Set(names).size !== names.length || names.includes("plant baseline")) return "Use distinct labels, different from Plant baseline.";
  }
  for (const variant of variants) {
    if (variant.optimize && variant.first?.length) return "Either optimise an alternative or give its first jobs, not both.";
  }
  for (const stress of stresses) if (!stress.downtimes?.length && !stress.holds?.length && !Object.values(stress.workersDelta ?? {}).some((v) => v < 0)) return "Each stress must specify an actual station stoppage, material hold or worker reduction.";
  return raw;
}
function denied(i: Start, ctx: ToolCtx) {
  if (ctx.hidden.has("simulate")) return "The Simulator is not opened for this person.";
  if (ctx.line === "LV" && i.line !== "TR") return "The current simulation model is for TR transformers, not LV panels. Specify line TR only if that is the intended scope; do not apply these dates to LV.";
  return null;
}
async function prepare(i: Start, ctx: ToolCtx) {
  const inputs = await withLine("TR", () => getWhatIfInputs());
  const built = await buildScenario(i, screenStart(i, ctx), inputs);
  return { inputs, built };
}
function alternatives(inputs: WhatIfInputs, base: NamedSimulation["scenario"], variants: Variant[]): { error: string } | { result: NamedSimulation[]; optimization: { label: string; complete: boolean }[] } {
  const result: NamedSimulation[] = [];
  const optimization: { label: string; complete: boolean }[] = [];
  for (const variant of variants) {
    const built = withKnobs(inputs, base, variant);
    if (!built.ok) return { error: `${variant.label}: ${built.error}` };
    if (variant.optimize) {
      const optimized = optimizeQueueWithin(inputs, built.scenario, 1500);
      built.scenario.queue = optimized.queue;
      optimization.push({ label: variant.label, complete: optimized.complete });
    }
    result.push({ label: variant.label, scenario: built.scenario });
  }
  return { result, optimization };
}
const scope = (inputs: WhatIfInputs, start: string) => ({ line: "TR", snapshotAt: new Date().toISOString(), todayISO: inputs.todayISO, startedFrom: start, weeklyPlan: inputs.plan ? { planNo: inputs.plan.planNo, fromISO: inputs.plan.minISO, toISO: inputs.plan.maxISO } : null });
const links = [{ label: "What-if Simulator", href: "/simulate" }];
const recordLinks = (mos: string[]) => [...links, ...[...new Set(mos)].slice(0, 20).map((mo) => ({ label: mo, href: traceHref({ mo, line: "TR" }) }))];
export const compareScenariosTool: ReadTool<CompareInput> = {
  kind: "read", name: "compare_scenarios", title: "Comparing planning alternatives on one snapshot", tabs: ["simulate"],
  description: "Compare up to four TR planning alternatives side by side on ONE captured set of live inputs, against a freshly recomputed plant baseline. Defaults to the person's current Simulator scenario as the common starting point. Variants change workers, hours per added worker, Fridays, station stoppages, material holds, splits or job order. Reports MO-level late/on-time/blocked/undated counts, calendar-day delay, extra man-hours/day, department loads, changed records and readiness warnings. No write, no screen change, no monetary cost or delivery guarantee. Use instead of separate simulate_scenario calls when weighing alternatives. A shiftHours change alone does NOT add overtime for existing workers.",
  schema: { type: "object", properties: { ...START, variants: { type: "array", minItems: 1, maxItems: 4, items: VARIANT }, detailLimit: { type: "integer", minimum: 1, maximum: 30 } }, required: ["variants"], additionalProperties: false },
  parse: (r) => validate(r) as CompareInput | string,
  async run(i, ctx) {
    const refusal = denied(i, ctx); if (refusal) return { ok: false, text: refusal };
    const { inputs, built } = await prepare(i, ctx);
    if ("error" in built) return { ok: false, text: built.error };
    const variants = alternatives(inputs, built.scenario, i.variants);
    if ("error" in variants) return { ok: false, text: variants.error };
    const review = compareSimulations(inputs, variants.result, i.detailLimit);
    return { ok: true, text: JSON.stringify({ scope: scope(inputs, built.start), optimization: variants.optimization, alternatives: variants.result.map((v) => ({ label: v.label, description: describeScenario(v.scenario, inputs), knobs: knobsOfScenario(v.scenario, inputs), queueFront: v.scenario.queue.slice(0, 15) })), ...review }), links: recordLinks(review.variants.flatMap((v) => v.changedOrders.map((r) => r.mo))) };
  },
};
export const stressTestPlanTool: ReadTool<StressInput> = {
  kind: "read", name: "stress_test_plan", title: "Testing the plan against disruptions", tabs: ["simulate"],
  description: "Stress-test the TR plant baseline plus up to four alternatives against up to three EXPLICIT independent disruptions on ONE live snapshot. A stress subtracts workers for the full simulated horizon relative to each candidate, adds entire-station downtime (not one machine), or delays named jobs' material. Existing constraints remain in force; a new material hold never advances an existing hold. Returns MO-level effects, affected orders, worst-case metrics and a transparent provisional resilience ranking. Cases run independently, not all at once; there are no probabilities. Missing due dates or blocking readiness/invalid cases suppress ranking. Read-only: never changes schedules, screen or messages. Establish disruption dates, stations, worker reductions and exact jobs with the person; do not invent machine-level capacity effects.",
  schema: { type: "object", properties: { ...START, variants: { type: "array", maxItems: 4, items: VARIANT }, stresses: { type: "array", minItems: 1, maxItems: 3, items: { type: "object", properties: { label, workersDelta: { type: "object", properties: Object.fromEntries(["Cut", "Welding", "ShotBlast", "Painting"].map((s) => [s, { type: "integer" as const, minimum: -500, maximum: 0 }])), additionalProperties: false }, downtimes: knobs.downtimes, holds: knobs.holds }, required: ["label"], additionalProperties: false } } }, required: ["stresses"], additionalProperties: false },
  parse: (r) => validate(r) as StressInput | string,
  async run(i, ctx) {
    const refusal = denied(i, ctx); if (refusal) return { ok: false, text: refusal };
    const { inputs, built } = await prepare(i, ctx);
    if ("error" in built) return { ok: false, text: built.error };
    // Include the selected/saved starting scenario even when no variants are requested.
    const requested = i.variants?.length ? i.variants : [{ label: "Selected scenario" }];
    const variants = alternatives(inputs, built.scenario, requested);
    if ("error" in variants) return { ok: false, text: variants.error };
    const review = stressSimulations(inputs, variants.result, i.stresses);
    return { ok: true, text: JSON.stringify({ scope: scope(inputs, built.start), stresses: i.stresses, optimization: variants.optimization, readiness: simulationReadiness(inputs, built.scenario), ...review }), links: recordLinks(review.rows.flatMap((r) => r.trials.flatMap((t) => t.delayedOrders.map((j) => j.mo)))) };
  },
};
export const simulationReadinessTool: ReadTool<Start> = {
  kind: "read", name: "get_simulation_readiness", title: "Checking forecast coverage and assumptions", tabs: ["simulate"],
  description: "Audit the TR simulator's readiness before trusting dates: omitted open components without standard times, held orders, unresolved plan quantities, missing due dates, zero production rates, capacity gaps, volatile rate history and unpriced weekly-plan pieces. Explains coverage and model assumptions. Physical stock/nesting, individual machine constraints and customer commitments are NOT verified; report them as checks still needed, never assume ready. Same live inputs as compare_scenarios/stress_test_plan. Read-only; no invented confidence percentage.",
  schema: { type: "object", properties: START, additionalProperties: false }, parse: (r) => validate(r) as Start | string,
  async run(i, ctx) {
    const refusal = denied(i, ctx); if (refusal) return { ok: false, text: refusal };
    const { inputs, built } = await prepare(i, ctx);
    if ("error" in built) return { ok: false, text: built.error };
    return { ok: true, text: JSON.stringify({ scope: scope(inputs, built.start), coverage: inputs.coverage ? { ...inputs.coverage, missingTimes: inputs.coverage.missingTimes.slice(0, 30), missingTimesCount: inputs.coverage.missingTimes.length } : null, ...simulationReadiness(inputs, built.scenario) }), links: recordLinks(inputs.coverage?.missingTimes.map((r) => r.mo) ?? []) };
  },
};
export const SIMULATION_REVIEW_TOOLS = [compareScenariosTool, stressTestPlanTool, simulationReadinessTool] as const;
