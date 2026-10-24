import { ETA_STAGES, type EtaStage } from "./eta";
import { defaultScenario, simulate, WI_STAGES, type Scenario, type WhatIfInputs, type WhatIfResult, type WiStage } from "./whatif";
import { scenarioCost, withKnobs, type ScenarioKnobs } from "./whatifScenario";

export interface ForecastCoverage {
  openOrders: number;
  heldOrders: number;
  pendingQuantityOrders: number;
  missingTimes: { mo: string; bom: string; item: string }[];
  unpricedPlanPieces: number;
  totalPlanPieces: number;
}
export interface ReadinessIssue { code: string; severity: "blocking" | "warning"; message: string; count?: number; records?: string[] }
export const SIMULATION_ASSUMPTIONS = [
  "TR fabrication model: Cut → Welding → combined Shot Blast/Painting; no LV punching/bending forecast.",
  "Rates are trailing standard-hours per working day; worker changes scale them proportionally to registered department capacity. Shift hours price added/removed workers, not overtime for the existing crew.",
  "Stoppages stop an entire model station, not one named machine. Individual machine queues, skills, breakdown probability and stock reservations are not modeled.",
  "Material readiness is not verified against physical stock or nesting; entered material holds are assumptions. Check Material and stock before committing to dates.",
  "Due dates come from the latest scheduled delivery per MO, not independently verified customer commitments. Fridays and recorded holidays follow the scenario calendar.",
  "Man-hours are resource effort, not monetary cost. Dates are deterministic estimates, not guarantees or statistical confidence limits.",
] as const;
const active = (j: WhatIfInputs["jobs"][number]) => ETA_STAGES.some((s) => j.left[s] > 0);
const finitePositive = (n: number | undefined) => n !== undefined && Number.isFinite(n) && n > 0;

export function simulationReadiness(inputs: WhatIfInputs, scenario = defaultScenario(inputs)) {
  const issues: ReadinessIssue[] = [];
  const jobs = inputs.jobs.filter(active);
  const add = (code: string, severity: ReadinessIssue["severity"], message: string, records?: string[], count = records?.length) => issues.push({ code, severity, message, ...(count === undefined ? {} : { count }), ...(records ? { records: records.slice(0, 12) } : {}) });
  if (!jobs.length) add("empty-queue", "warning", "No active priced jobs are available; an empty forecast does not establish that every order is complete.");
  if (!inputs.coverage) add("unknown-coverage", "warning", "Coverage of open orders omitted from the forecast is unavailable.");
  else {
    const c = inputs.coverage;
    if (c.missingTimes.length) add("missing-standard-times", "blocking", "Required components have no usable standard times and are omitted from the forecast.", c.missingTimes.map((j) => `${j.mo}|${j.item}`));
    if (c.heldOrders) add("held-orders", "warning", "Orders on hold are outside the simulation queue; their release is not forecast.", undefined, c.heldOrders);
    if (c.pendingQuantityOrders) add("pending-quantities", "warning", "Open orders have pending plan-quantity decisions; forecasts use the registered quantity.", undefined, c.pendingQuantityOrders);
    if (c.unpricedPlanPieces > 0) add("unpriced-plan", "blocking", "Weekly-plan pieces could not be priced in standard hours; department loads are incomplete.", undefined, c.unpricedPlanPieces);
  }
  const noDue = [...new Set(jobs.filter((j) => !j.dueISO).map((j) => j.mo))];
  if (noDue.length) add("missing-due-dates", "warning", "Orders without a scheduled due date are not counted as on time or late.", noDue);
  for (const stage of ETA_STAGES) {
    const needed = jobs.filter((j) => j.left[stage] > 0);
    const missingTimes = needed.filter((j) => !finitePositive(j.perPc[stage]));
    if (missingTimes.length) add(`invalid-times-${stage}`, "blocking", `Required ${stage} work has zero or invalid standard time.`, missingTimes.map((j) => j.id));
    if (needed.length && !finitePositive(inputs.rates[stage])) add(`missing-rate-${stage}`, "blocking", `No positive recorded production rate for ${stage}; the forecast cannot pass this station.`);
    if (needed.length && inputs.rates[stage] > 0 && inputs.rateSigma[stage] / inputs.rates[stage] > 0.5) add(`volatile-rate-${stage}`, "warning", `The ${stage} rate varies substantially across the history window; compare disruption scenarios before relying on the estimate.`);
  }
  if (jobs.length && inputs.rateWindowDays <= 0) add("missing-history", "blocking", "The production-rate history window is unavailable.");
  const demanded = new Set<WiStage>();
  for (const j of jobs) {
    if (j.left.cut > 0) demanded.add("Cut");
    if (j.left.weld > 0) demanded.add("Welding");
    if (j.left.finish > 0) { demanded.add("ShotBlast"); if (j.item !== "CF") demanded.add("Painting"); }
  }
  for (const stage of WI_STAGES) if (demanded.has(stage) || scenario.workersDelta[stage] !== 0) {
    if (!finitePositive(inputs.capacity[stage])) add(`capacity-${stage}`, "warning", `No positive base capacity for ${stage}; crew-based rate scaling or load comparisons may be unsupported.`);
    if ((inputs.capacity[stage] ?? 0) + scenario.workersDelta[stage] * scenario.shiftHours < 0) add(`crew-floor-${stage}`, "warning", `The ${stage} resource reduction exceeds registered capacity and is clamped to zero.`);
  }
  if (!inputs.plan) add("no-weekly-plan", "warning", "No weekly plan window is available for department load comparisons.");
  return { status: issues.some((i) => i.severity === "blocking") ? "blocked" as const : issues.length ? "review" as const : "usable-with-assumptions" as const,
    activeJobs: jobs.length, activeOrders: new Set(jobs.map((j) => j.mo)).size, issues, assumptions: SIMULATION_ASSUMPTIONS };
}

/** Fold components and split batches to MOs before comparing delivery performance. */
export function simulationOrders(result: WhatIfResult) {
  const byMo = new Map<string, { mo: string; bom: string; etaISO: string | null; dueISO: string | null; blocked: boolean }>();
  for (const j of result.jobs) {
    if (j.done) continue;
    const row = byMo.get(j.mo) ?? { mo: j.mo, bom: j.bom, etaISO: null, dueISO: null, blocked: false };
    row.blocked ||= !!j.blockedBy || !j.etaISO;
    if (j.etaISO && (!row.etaISO || j.etaISO > row.etaISO)) row.etaISO = j.etaISO;
    if (j.dueISO && (!row.dueISO || j.dueISO > row.dueISO)) row.dueISO = j.dueISO;
    byMo.set(j.mo, row);
  }
  return [...byMo.values()].map((r) => ({ ...r, etaISO: r.blocked ? null : r.etaISO }));
}
const days = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
export function simulationMetrics(result: WhatIfResult, scenario: Scenario) {
  const orders = simulationOrders(result);
  const forecastable = orders.filter((r) => !r.blocked);
  const dated = forecastable.filter((r) => r.dueISO);
  const late = dated.filter((r) => r.etaISO! > r.dueISO!);
  return {
    orders: orders.length, forecastableOrders: forecastable.length, blockedOrders: orders.length - forecastable.length,
    undatedOrders: orders.filter((r) => !r.dueISO).length,
    lateOrders: late.length, onTimeOrders: dated.length - late.length,
    totalLateCalendarDays: late.reduce((sum, r) => sum + days(r.etaISO!, r.dueISO!), 0),
    allClearISO: orders.length && forecastable.length === orders.length ? forecastable.reduce((last, r) => r.etaISO! > last ? r.etaISO! : last, "") : null,
    addedManHoursPerWorkingDay: scenarioCost(scenario),
    departments: result.stages.map((s) => ({ dept: s.dept, requiredHours: s.required, availableHours: s.available, loadPct: s.load === null ? null : s.load * 100 })),
  };
}
export interface NamedSimulation { label: string; scenario: Scenario }
export interface StressCase { label: string; workersDelta?: Partial<Record<WiStage, number>>; downtimes?: ScenarioKnobs["downtimes"]; holds?: ScenarioKnobs["holds"] }
export function compareSimulations(inputs: WhatIfInputs, alternatives: readonly NamedSimulation[], detailLimit = 12) {
  const baseScenario = defaultScenario(inputs);
  const baseResult = simulate(inputs, baseScenario);
  const base = simulationMetrics(baseResult, baseScenario);
  const baseOrders = new Map(simulationOrders(baseResult).map((r) => [r.mo, r]));
  const variants = alternatives.map(({ label, scenario }) => {
    const result = simulate(inputs, scenario);
    const metrics = simulationMetrics(result, scenario);
    const changes = simulationOrders(result).flatMap((r) => {
      const before = baseOrders.get(r.mo);
      const delta = before?.etaISO && r.etaISO ? days(r.etaISO, before.etaISO) : null;
      return !before || before.blocked !== r.blocked || (delta !== null && delta !== 0) ? [{ mo: r.mo, bom: r.bom, beforeISO: before?.etaISO ?? null, afterISO: r.etaISO, deltaCalendarDays: delta, blocked: r.blocked, dueISO: r.dueISO }] : [];
    }).sort((a, b) => Number(b.blocked) - Number(a.blocked) || (b.deltaCalendarDays ?? 0) - (a.deltaCalendarDays ?? 0) || a.mo.localeCompare(b.mo));
    return { label, metrics, delta: { lateOrders: metrics.lateOrders - base.lateOrders, blockedOrders: metrics.blockedOrders - base.blockedOrders, totalLateCalendarDays: metrics.totalLateCalendarDays - base.totalLateCalendarDays, allClearCalendarDays: metrics.allClearISO && base.allClearISO ? days(metrics.allClearISO, base.allClearISO) : null }, readiness: simulationReadiness(inputs, scenario), changedOrders: changes.slice(0, detailLimit), changedOrdersCount: changes.length };
  });
  return { baseline: base, variants, readiness: simulationReadiness(inputs), note: "One input snapshot; deltas compare against the recomputed plant baseline. Orders are MOs, not components or split batches. Undated and blocked orders are separate from on-time orders. Counts and clearance dates cover the priced queue only; see readiness for omitted/held orders. No financial cost or delivery guarantee is inferred." };
}

/** Stress resource changes are increments to each alternative; holds/stoppages add to its constraints. */
export function applySimulationStress(inputs: WhatIfInputs, start: Scenario, stress: StressCase) {
  const workersDelta = { ...start.workersDelta };
  for (const stage of WI_STAGES) workersDelta[stage] += stress.workersDelta?.[stage] ?? 0;
  const holds = new Map(Object.entries(start.holds));
  for (const h of stress.holds ?? []) holds.set(h.job, holds.has(h.job) && holds.get(h.job)! > h.untilISO ? holds.get(h.job)! : h.untilISO);
  return withKnobs(inputs, start, { workersDelta, downtimes: [...start.downtimes, ...(stress.downtimes ?? [])], holds: [...holds].map(([job, untilISO]) => ({ job, untilISO })) });
}
export function stressSimulations(inputs: WhatIfInputs, alternatives: readonly NamedSimulation[], stresses: readonly StressCase[]) {
  const candidates = [{ label: "Plant baseline", scenario: defaultScenario(inputs) }, ...alternatives];
  const rows = candidates.map(({ label, scenario }) => {
    const normalResult = simulate(inputs, scenario);
    const normal = simulationMetrics(normalResult, scenario);
    const before = new Map(simulationOrders(normalResult).map((r) => [r.mo, r]));
    const trials = stresses.map((stress) => {
      const applied = applySimulationStress(inputs, scenario, stress);
      if (!applied.ok) return { label: stress.label, error: applied.error, metrics: null, delayedOrders: [], delayedOrdersCount: 0 };
      const result = simulate(inputs, applied.scenario);
      const metrics = simulationMetrics(result, applied.scenario);
      const delayed = simulationOrders(result).flatMap((r) => {
        const b = before.get(r.mo);
        const delta = b?.etaISO && r.etaISO ? days(r.etaISO, b.etaISO) : null;
        return (r.blocked && !b?.blocked) || (delta !== null && delta > 0) ? [{ mo: r.mo, deltaCalendarDays: delta, blocked: r.blocked }] : [];
      }).sort((a, b) => Number(b.blocked) - Number(a.blocked) || (b.deltaCalendarDays ?? 0) - (a.deltaCalendarDays ?? 0) || a.mo.localeCompare(b.mo));
      return { label: stress.label, error: null, metrics, deltaLateOrders: metrics.lateOrders - normal.lateOrders, deltaBlockedOrders: metrics.blockedOrders - normal.blockedOrders, delayedOrders: delayed.slice(0, 12), delayedOrdersCount: delayed.length };
    });
    const valid = trials.filter((t) => t.metrics !== null);
    return { label, normal, trials, worst: valid.length === trials.length && valid.length ? { blockedOrders: Math.max(...valid.map((t) => t.metrics!.blockedOrders)), lateOrders: Math.max(...valid.map((t) => t.metrics!.lateOrders)), totalLateCalendarDays: Math.max(...valid.map((t) => t.metrics!.totalLateCalendarDays)) } : null };
  });
  const readiness = simulationReadiness(inputs);
  const canRank = readiness.issues.every((issue) => issue.severity !== "blocking" && issue.code !== "unknown-coverage" && !issue.code.startsWith("capacity-")) && rows.every((r) => r.worst && r.normal.undatedOrders === 0 && r.normal.orders > 0);
  const ranking = canRank ? [...rows].sort((a, b) => a.worst!.blockedOrders - b.worst!.blockedOrders || a.worst!.lateOrders - b.worst!.lateOrders || a.worst!.totalLateCalendarDays - b.worst!.totalLateCalendarDays || a.normal.addedManHoursPerWorkingDay - b.normal.addedManHoursPerWorkingDay).map((r) => r.label) : [];
  return { rows, ranking, rankingRule: "Minimise worst blocked orders, then worst late orders, then worst total late calendar days, then normal extra man-hours/day. Worst values may come from different independent stress cases; ties retain input order. No probability or combined-stress claim.", note: "Each stress is run independently on the same snapshot. Unknown coverage, missing capacity/due dates, blocking readiness issues or invalid trials suppress the ranking; review the metrics and assumptions." };
}
export const stressStage = (stage: EtaStage, fromISO: string, toISO: string): StressCase => ({ label: `${stage} station unavailable ${fromISO}–${toISO}`, downtimes: [{ stage, fromISO, toISO }] });
