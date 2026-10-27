import "server-only";
import { prisma } from "@/lib/db";
import { traceHref } from "@/lib/domain/links";
import { parseISODate, toISODate } from "@/lib/domain/dates";
import { downtimeByCause, downtimeLabel, stopsByMachine } from "@/lib/domain/downtime";
import { itemHoursFor, tierForOrder } from "@/lib/domain/stdEngine";
import { SHEET_ITEMS } from "@/lib/domain/constants";
import {
  CONTROL_STAGES, CR_ACTION, DISPATCH_RULES, LOAD_OVER, LOAD_TIGHT, RULE_TEXT, STAGE_NAME,
  compareByRule, dispatchList, dispatchRow, ioReport, loadPct, loadProfile, loadStatus, pastPlantWeeks, rankConstraint, releaseChecklist, simulateRush, stageHours, statusCounts, withCumulative,
  type ControlStage, type DispatchRule, type RushJob,
} from "@/lib/domain/planningControl";
import type { WhatIfInputs } from "@/lib/domain/whatif";
import { getStdData } from "@/lib/server/standardTimes";
import { withLine } from "@/lib/server/line";
import { getWhatIfInputs } from "@/lib/server/whatif";
import { getControlInputs, getReleaseFacts, getStationFlows, getStationStops, queueNow } from "@/lib/server/planningControl";
import type { ReadResult, ReadTool, ToolCtx } from "./types";

// The planner's production-activity-control tools: what each station should
// run next and why (critical ratio, slack and the other dispatch rules), the
// load against capacity week by week, input/output control, the constraint,
// the stops ranked by cause, whether an order can be released, and whether a
// new order can make its date. Every figure is computed in
// lib/domain/planningControl.ts and comes back with the inputs and the
// assumptions behind it, so the answer can show its working.

const STAGE = { type: "string", enum: [...CONTROL_STAGES], description: "cut = Fabrication (laser, punching, bending, fins), weld = Welding, finish = shot blast + painting (the core frame finishes at shot blast)." } as const;
const LINE = { type: "string", enum: ["TR"], description: "These tools model the transformers only. Give TR explicitly when asked from an LV screen about the transformers." } as const;
const r1 = (n: number) => Math.round(n * 10) / 10;
/** JSON for the model: a load against no hours at all would otherwise read as null — "no figure". */
const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (x === Infinity ? "beyond capacity (no working hours in the window)" : x));
const dashboardLink = { label: "Planning dashboard", href: "/" };
const orderLinks = (mos: readonly string[]) => [...new Set(mos)].slice(0, 15).map((mo) => ({ label: mo, href: traceHref({ mo, line: "TR" }) }));

const BASE_ASSUMPTIONS = [
  "Transformers only: the stations are Fabrication → Welding → Finishing (shot blast + paint); LV panels are not in this model.",
  "Work is priced in standard hours from Admin → Standard times (per KVA class and component); components without a standard time are left out and counted under coverage.",
  "Station pace = the standard hours it actually earned per working day over the last working days (rateWindowDays); Fridays and the factory calendar's holidays are days off.",
  "Due date = the latest weekly-plan (oven) date of the order.",
];

function lvRefusal(input: { line?: "TR" }, ctx: ToolCtx): ReadResult | null {
  if (ctx.line === "LV" && input.line !== "TR") return { ok: false, text: "These planning tools model the transformers (TR) only, not the LV panels. Say so; give line TR only if the person means the transformers." };
  return null;
}

function inputsUsed(inputs: WhatIfInputs) {
  return {
    todayISO: inputs.todayISO,
    stationPaceStdHPerDay: Object.fromEntries(CONTROL_STAGES.map((s) => [s, r1(inputs.rates[s])])),
    rateWindowDays: inputs.rateWindowDays,
    capacityManHoursPerDay: inputs.capacity,
    openJobs: inputs.jobs.length,
  };
}

function coverageOf(inputs: WhatIfInputs) {
  const c = inputs.coverage;
  return c ? { heldOrdersLeftOut: c.heldOrders, pendingQuantityOrders: c.pendingQuantityOrders, unpricedComponents: c.missingTimes.length, unpricedExamples: c.missingTimes.slice(0, 8).map((m) => `${m.mo}|${m.item}`) } : null;
}

// ---------------------------------------------------------------- dispatch list

interface DispatchInput { stage?: ControlStage; rule?: DispatchRule; mos?: string[]; arrivedOnly?: boolean; limit?: number; line?: "TR" }

export const getDispatchListTool: ReadTool<DispatchInput> = {
  kind: "read", name: "get_dispatch_list", title: "Building the dispatch list", tabs: ["dashboard"], cacheable: true,
  description:
    "The prioritized dispatch list of a TR station (what to run next) under a dispatch rule — CR (critical ratio, the default), EDD (earliest due date), SLACK, SPT (shortest at this station), LWR (least work remaining) or FOR (fewest operations remaining). " +
    "Per job (one component of one order, MO|ITEM): due date, working days to due, pieces left at the station and pieces already waiting at it, standard hours, the forecast finish (queue included), CR = working days to due ÷ forecast working days left, its status (late ≤0 / behind <1 / on schedule 1–1.1 / ahead) and action, slack = days to due − remaining work days (setup + run at the stations' real pace, no queue) and slack per operation, ⭐ priority, urgent, and running (on a machine now, as the Fabrication and Painting machine boards record it — do not break its setup; the other stations record no running job). " +
    "Jobs already at the station come first, then those still upstream. Give mos instead (or with a stage) to compute the priority of named orders — each job at its current station when no stage is given. Read this for \"what should welding run today?\", \"which orders to expedite?\", \"compute the critical ratio of …\". FCFS is not offered: arrival times are not recorded.",
  schema: { type: "object", additionalProperties: false, properties: {
    stage: STAGE,
    rule: { type: "string", enum: [...DISPATCH_RULES] },
    mos: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 60 }, description: "Only these orders' jobs." },
    arrivedOnly: { type: "boolean", description: "Only jobs with pieces already waiting at the station." },
    limit: { type: "integer", minimum: 1, maximum: 40 },
    line: LINE,
  } },
  parse: (raw) => (!raw.stage && !(raw.mos as string[] | undefined)?.length ? "Give a stage, or the orders (mos) to prioritize." : (raw as DispatchInput)),
  status: (i) => (i.stage ? `Building ${STAGE_NAME[i.stage]}'s dispatch list` : "Computing the orders' priority"),
  async run(i, ctx) {
    const refusal = lvRefusal(i, ctx); if (refusal) return refusal;
    const { inputs, priorityMos, urgentMos, running } = await getControlInputs();
    const rule = i.rule ?? "CR";
    const holidays = new Set(inputs.holidayISOs);
    // order numbers as typed, matched whatever their case
    const wanted = i.mos?.length ? new Set(i.mos.map((m) => m.trim().toUpperCase())) : null;
    const jobs = wanted ? inputs.jobs.filter((j) => wanted.has(j.mo.toUpperCase())) : inputs.jobs;
    const base = { todayISO: inputs.todayISO, holidays, rates: inputs.rates, priorityMos, urgentMos };
    let rows;
    if (i.stage) rows = dispatchList(jobs, i.stage, rule, { ...base, runningIds: running[i.stage] });
    else {
      rows = jobs.flatMap((j) => {
        const at = CONTROL_STAGES.find((s) => j.left[s] > 0);
        return at ? [{ ...dispatchRow(j, at, { ...base, runningIds: running[at] }), station: at }] : [];
      });
      const cmp = compareByRule(rule);
      rows.sort((a, b) => Number(b.running) - Number(a.running) || cmp(a, b));
    }
    if (i.arrivedOnly) rows = rows.filter((r) => r.pcsArrived > 0);
    const limit = i.limit ?? 15;
    const missing = wanted ? [...wanted].filter((mo) => !inputs.jobs.some((j) => j.mo.toUpperCase() === mo)) : [];
    return {
      ok: true,
      text: toJson({
        scope: { line: "TR", station: i.stage ? STAGE_NAME[i.stage] : "each job at its current station", rule, ruleText: RULE_TEXT[rule], orders: wanted ? [...wanted] : "all open" },
        inputs_used: inputsUsed(inputs),
        formulas: { criticalRatio: "CR = working days to due ÷ forecast working days left (the forecast includes the queue at each station)", slack: "slack = working days to due − remaining work days (each station's std hours ÷ its pace, no queue); per operation = slack ÷ stations left", statusBands: { late: "CR ≤ 0", behind: "CR < 1", on_schedule: "1 ≤ CR ≤ 1.1", ahead: "CR > 1.1" }, actions: CR_ACTION },
        counts: statusCounts(rows),
        totalJobs: rows.length,
        rows: rows.slice(0, limit),
        truncated: rows.length > limit,
        notInModel: missing.length ? { mos: missing, why: "Closed, on hold, finished, or no standard time for its components — check get_orders." } : undefined,
        coverage: coverageOf(inputs),
        assumptions: [...BASE_ASSUMPTIONS, "Re-run the list each day or shift: time moves and the queues change.", "A job running on a machine is kept on top — interrupting it costs a new setup."],
      }),
      links: [dashboardLink, ...orderLinks(rows.slice(0, limit).map((r) => r.mo))],
    };
  },
};

// ---------------------------------------------------------------- load profile

interface LoadInput { weeks?: number; stage?: ControlStage; line?: "TR" }

export const getLoadProfileTool: ReadTool<LoadInput> = {
  kind: "read", name: "get_load_profile", title: "Setting the load against capacity", tabs: ["dashboard"], cacheable: true,
  description:
    "The TR load profile: for each station (or one) and each plant week (Saturday–Friday, the current week from today), the standard hours the open work owes by its due dates (infinite loading — what is past due lands in the current week) against the station's capacity: available = Admin capacity in man-hours a day × working days, and demonstrated = its real pace × working days. " +
    `Load % = load ÷ available × 100 — ok under ${LOAD_TIGHT}%, tight to ${LOAD_OVER}%, overloaded past it — plus the load against the demonstrated pace, the running shortfall from this week, the biggest jobs of each week, and the work with no date or due later. ` +
    "Read it for \"is this month's plan feasible?\", overloaded weeks, and before suggesting overtime or moving orders. Finite loading at the real pace is the forecast: simulate_scenario / plan_for_deadlines.",
  schema: { type: "object", additionalProperties: false, properties: { weeks: { type: "integer", minimum: 1, maximum: 8, description: "Weeks ahead, the current one included; default 4." }, stage: STAGE, line: LINE } },
  async run(i, ctx) {
    const refusal = lvRefusal(i, ctx); if (refusal) return refusal;
    const inputs = await withLine("TR", () => getWhatIfInputs());
    const profile = loadProfile(inputs, i.weeks ?? 4).filter((s) => !i.stage || s.stage === i.stage);
    const overloaded = profile.flatMap((s) => s.weeks.filter((w) => w.status === "overloaded").map((w) => ({ station: s.name, week: `${w.fromISO} – ${w.toISO}`, loadH: w.loadH, availableH: w.availableH, loadPct: w.loadPct })));
    return {
      ok: true,
      text: toJson({
        scope: { line: "TR", weeks: i.weeks ?? 4, station: i.stage ? STAGE_NAME[i.stage] : "all" },
        inputs_used: inputsUsed(inputs),
        formulas: { load: "load (std h) = Σ pieces left at the station × std hours a piece, by the order's due week", available: "available = man-hours a day (Admin capacity) × working days in the week", demonstrated: "demonstrated = the station's real pace (std h a day) × working days", loadPct: "load % = load ÷ available × 100", bands: { ok: `< ${LOAD_TIGHT}%`, tight: `${LOAD_TIGHT}–${LOAD_OVER}%`, overloaded: `> ${LOAD_OVER}%` } },
        stations: profile,
        overloaded,
        coverage: coverageOf(inputs),
        assumptions: [...BASE_ASSUMPTIONS, "Infinite loading: a week's load is what is due in it, whether or not the station can do it — the shortfall shows where it cannot.", "Available man-hours and earned standard hours are compared directly, as the Planning dashboard's capacity check does: 100% load needs the crew to work at the standard pace."],
      }),
      links: [dashboardLink],
    };
  },
};

// ---------------------------------------------------------------- input / output

interface IoInput { stage: ControlStage; weeks?: number; line?: "TR" }

export const getIoReportTool: ReadTool<IoInput> = {
  kind: "read", name: "get_io_report", title: "Reading the input/output report", tabs: ["dashboard"], cacheable: true,
  description:
    "Input/output control for one TR station over the past plant weeks (Saturday–Friday, the current week to yesterday), in standard hours: planned and actual input (what the station before passed on, priced at this station — not recorded for Fabrication), planned and actual output (what the station earned), cumulative variances, and the backlog (queue in front of it) at each week's start and end — walked back from the queue standing there now (backlog end = start + input − output). " +
    "The diagnosis says where to look: input below plan = upstream (the station before, material, releases); input on plan but output short = inside the station; plus whether the queue is growing. Read it for \"why is welding behind?\", \"is the problem upstream?\".",
  schema: { type: "object", additionalProperties: false, properties: { stage: STAGE, weeks: { type: "integer", minimum: 2, maximum: 8, description: "Past weeks; default 4." }, line: LINE }, required: ["stage"] },
  async run(i, ctx) {
    const refusal = lvRefusal(i, ctx); if (refusal) return refusal;
    const inputs = await withLine("TR", () => getWhatIfInputs());
    const weeks = pastPlantWeeks(inputs.todayISO, i.weeks ?? 4, new Set(inputs.holidayISOs));
    const flow = await getStationFlows(weeks);
    const queue = queueNow(inputs)[i.stage];
    const report = ioReport(flow.flows[i.stage].map((w) => ({ ...w, plannedInput: w.plannedInput === null ? null : r1(w.plannedInput), actualInput: w.actualInput === null ? null : r1(w.actualInput), plannedOutput: w.plannedOutput === null ? null : r1(w.plannedOutput), actualOutput: r1(w.actualOutput) })), i.stage === "cut" ? null : r1(queue));
    return {
      ok: true,
      text: toJson({
        scope: { line: "TR", station: STAGE_NAME[i.stage], weeks: weeks.map((w) => `${w.fromISO} – ${w.toISO}`) },
        inputs_used: { todayISO: inputs.todayISO, queueNowStdH: r1(queue), unpricedPiecesInTheLog: flow.unpricedPcs },
        formulas: { backlog: "backlog end = backlog start + actual input − actual output", cumInputVariance: "Σ actual input − Σ planned input", cumOutputVariance: "Σ actual output − Σ planned output", tolerance: "a variance within 10% of plan is on plan" },
        ...report,
        note: i.stage === "cut" ? "Fabrication's input (orders released, material issued) is not recorded, so only its output against plan and its open work (queueNowStdH = every piece not cut yet) can be read." : undefined,
        assumptions: [...BASE_ASSUMPTIONS, "Planned figures come from the newest weekly plan dating each day; a plan dates the oven, and the stations before it are read against the same week — the plant keeps no offset between them.", "The leak test between welding and painting is not a station here."],
      }),
      links: [dashboardLink],
    };
  },
};

// ---------------------------------------------------------------- the constraint

interface BottleneckInput { weeks?: number; line?: "TR" }

export const identifyBottleneckTool: ReadTool<BottleneckInput> = {
  kind: "read", name: "identify_bottleneck", title: "Finding the constraint", tabs: ["dashboard"], cacheable: true,
  description:
    "Which TR station is the constraint (bottleneck), with the evidence: per station the open work in standard hours ÷ its real pace = working days of work it holds (the ranking), the queue already waiting in front of it (hours and days), its load % over the coming weeks, the machine-hours lost to unplanned stops in the last 14 days, and how its queue moved over the last 4 weeks. " +
    "Also how hard the other stations are loaded against the drum (subordinate: their days of work as a share of the constraint's). Read it for \"what is our bottleneck?\", before deciding where overtime or people go (an hour lost at the constraint is an hour lost to the plant).",
  schema: { type: "object", additionalProperties: false, properties: { weeks: { type: "integer", minimum: 1, maximum: 8, description: "Weeks ahead for the load %; default 4." }, line: LINE } },
  async run(i, ctx) {
    const refusal = lvRefusal(i, ctx); if (refusal) return refusal;
    const inputs = await withLine("TR", () => getWhatIfInputs());
    const holidays = new Set(inputs.holidayISOs);
    const past = pastPlantWeeks(inputs.todayISO, 4, holidays);
    const lostFrom = toISODate(new Date(Date.parse(`${inputs.todayISO}T00:00:00Z`) - 14 * 86400000));
    const [stops, { flows }] = await Promise.all([getStationStops(lostFrom, inputs.todayISO), getStationFlows(past)]);
    const queue = queueNow(inputs);
    const profile = loadProfile(inputs, i.weeks ?? 4);
    const evidence = CONTROL_STAGES.map((stage) => {
      const openH = inputs.jobs.reduce((a, j) => a + stageHours(j, stage), 0);
      const rate = inputs.rates[stage];
      const p = profile.find((x) => x.stage === stage)!;
      const load = p.weeks.reduce((a, w) => a + w.loadH, 0);
      const avail = p.capacityPerDay === null ? null : p.weeks.reduce((a, w) => a + (w.availableH ?? 0), 0);
      const io = stage === "cut" ? null : ioReport(flows[stage], queue[stage]);
      const first = io?.weeks[0]?.backlogStart ?? null, last = io?.weeks[io.weeks.length - 1]?.backlogEnd ?? null;
      return {
        stage, name: STAGE_NAME[stage], openH: r1(openH), ratePerDay: r1(rate),
        daysOfWork: rate > 0 ? r1(openH / rate) : null,
        queueH: r1(queue[stage]), queueDays: rate > 0 ? r1(queue[stage] / rate) : null,
        nearLoadPct: loadPct(load, avail),
        lostH: r1(stops.filter((s) => s.stage === stage && s.reasonCode !== "PM").reduce((a, s) => a + s.hours, 0)),
        backlogTrendH: first === null || last === null ? null : r1(last - first),
      };
    });
    const ranked = rankConstraint(evidence);
    return {
      ok: true,
      text: toJson({
        scope: { line: "TR", loadWeeks: i.weeks ?? 4, stopsFrom: lostFrom, trendWeeks: past.map((w) => `${w.fromISO} – ${w.toISO}`) },
        inputs_used: inputsUsed(inputs),
        formulas: { daysOfWork: "days of work = open std h at the station ÷ its pace (std h a day)", queueDays: "queue days = std h already waiting ÷ pace", loadPct: "std h due in the weeks ÷ available man-hours" },
        ...ranked,
        coverage: coverageOf(inputs),
        assumptions: [...BASE_ASSUMPTIONS, "Stops are machine-hours on the station's machines, planned maintenance left out; the panels' stops are not counted.", "A station with no recorded pace cannot be ranked; it is named in the evidence."],
      }),
      links: [dashboardLink],
    };
  },
};

// ---------------------------------------------------------------- delay Pareto

interface ParetoInput { from?: string; to?: string; dept?: "Cut" | "Welding" | "ShotBlast" | "Painting" | "all" }

export const getDelayParetoTool: ReadTool<ParetoInput> = {
  kind: "read", name: "get_delay_pareto", title: "Ranking the causes of lost time", tabs: ["shifts"], cacheable: true,
  description:
    "The Pareto of lost time over a period (default the last 30 days; at most a year): machine stops by reason code with hours, stops, share and cumulative share — the vital few to 80% flagged — planned maintenance kept apart and outside the shares, the machines that lost most, and the orders on hold now with their reason (the order-level delays the app records). " +
    "Give dept for one department (Cut, Welding, ShotBlast, Painting). Read it for the monthly review of delay causes and where to start an improvement.",
  schema: { type: "object", additionalProperties: false, properties: {
    from: { type: "string", format: "date" }, to: { type: "string", format: "date" },
    dept: { type: "string", enum: ["Cut", "Welding", "ShotBlast", "Painting", "all"] },
  } },
  async run(i, ctx) {
    const toISO = i.to ?? ctx.todayISO;
    const fromISO = i.from ?? toISODate(new Date(parseISODate(toISO)!.getTime() - 29 * 86400000));
    if (fromISO > toISO) return { ok: false, text: "from must not be after to (to is today when left out)." };
    if ((Date.parse(toISO) - Date.parse(fromISO)) / 86400000 > 366) return { ok: false, text: "At most a year at a time." };
    const dept = i.dept && i.dept !== "all" ? i.dept : null;
    const [stops, holds] = await Promise.all([
      getStationStops(fromISO, toISO, ctx.now),
      prisma.masterOrder.findMany({ where: { status: "open", holdAt: { not: null }, line: "TR" }, select: { mo: true, holdNote: true, holdAt: true }, orderBy: { holdAt: "asc" }, take: 30 }),
    ]);
    const rows = stops.filter((s) => !dept || s.dept === dept);
    const { causes, unplannedH, plannedH } = downtimeByCause(rows);
    const unplanned = withCumulative(causes.filter((c) => !c.planned).map(({ code, label, hours, stops: n }) => ({ code, label, hours, stops: n })));
    return {
      ok: true,
      text: toJson({
        scope: { fromISO, toISO, dept: dept ?? "all", line: "machine stops of every department; holds of TR orders" },
        inputs_used: { stopsRead: rows.length },
        formulas: { share: "cause hours ÷ all unplanned hours", cumShare: "running total of the shares, most hours first", vital: "the causes reaching 80% of the hours" },
        unplannedH, plannedMaintenanceH: plannedH,
        pareto: unplanned,
        planned: causes.filter((c) => c.planned).map((c) => ({ code: c.code, label: c.label, hours: c.hours, stops: c.stops })),
        topMachines: stopsByMachine(rows.map((r) => ({ machine: r.machine, dept: r.dept, hours: r.hours, reasonCode: r.reasonCode }))),
        uncodedExamples: rows.filter((r) => !r.reasonCode).slice(0, 5).map((r) => ({ machine: r.machine, reason: downtimeLabel(r.reasonCode, r.reason), hours: r1(r.hours) })),
        ordersOnHold: holds.map((h) => ({ mo: h.mo, since: h.holdAt ? toISODate(h.holdAt) : null, reason: h.holdNote })),
        assumptions: ["Hours are the stops' machine-hours inside the window (an open stop counts until now).", "Order delays other than holds have no reason code in the app yet — only machine stops and holds can be ranked."],
      }),
      links: [{ label: "Shifts — machine stops", href: "/shifts" }, ...orderLinks(holds.map((h) => h.mo))],
    };
  },
};

// ---------------------------------------------------------------- release readiness

interface ReleaseInput { mo: string; line?: "TR" }

export const checkReleaseReadinessTool: ReadTool<ReleaseInput> = {
  kind: "read", name: "check_release_readiness", title: "Checking the order can be released", tabs: ["tracker"], cacheable: true,
  description:
    "The release checklist of one TR order before it goes to the floor: open and not on hold, no plan quantity waiting for a decision, every component priced (standard times), a due date, the nesting / drawings on the MATERIAL tab (lines and how many are nested), the raw-material stock (not read from Odoo yet — reported as a check still to do), Fabrication's load over this week and next, and whether Fabrication has already started it. " +
    "Answers ready / ready_with_checks / not_ready with each blocking item. Read it before push_to_worklist or when asked \"can we release MO …?\".",
  schema: { type: "object", additionalProperties: false, properties: { mo: { type: "string", minLength: 1, maxLength: 60 }, line: LINE }, required: ["mo"] },
  async run(i, ctx) {
    const refusal = lvRefusal(i, ctx); if (refusal) return refusal;
    const mo = i.mo.trim();
    const [facts, inputs] = await Promise.all([getReleaseFacts(mo), withLine("TR", () => getWhatIfInputs())]);
    if (!facts) return { ok: true, text: toJson({ mo, ...releaseChecklist({ found: false }) }) };
    const jobs = inputs.jobs.filter((j) => j.mo === mo);
    let dueISO = jobs.find((j) => j.dueISO)?.dueISO ?? null;
    if (!dueISO) {
      const s = await prisma.planSchedule.aggregate({ where: { mo }, _max: { ovenDate: true } });
      dueISO = s._max.ovenDate ? toISODate(s._max.ovenDate) : null;
    }
    const cut = loadProfile(inputs, 2).find((s) => s.stage === "cut")!;
    const load = cut.weeks.reduce((a, w) => a + w.loadH, 0);
    const avail = cut.capacityPerDay === null ? null : cut.weeks.reduce((a, w) => a + (w.availableH ?? 0), 0);
    const pct = loadPct(load, avail);
    const result = releaseChecklist({
      found: true,
      status: facts.order.status,
      onHold: facts.order.holdAt ? { note: facts.order.holdNote } : null,
      pendingQty: facts.order.pendingPlanQty,
      missingTimes: (inputs.coverage?.missingTimes ?? []).filter((m) => m.mo === mo).map((m) => m.item),
      dueISO,
      nesting: facts.nesting,
      stock: null,
      firstStationLoad: { pct, status: loadStatus(pct), weeks: `this week and next (${cut.weeks[0].fromISO} – ${cut.weeks[cut.weeks.length - 1].toISO})` },
      alreadyStarted: facts.alreadyStarted,
    });
    return {
      ok: true,
      text: toJson({
        mo, bom: facts.order.bom, kva: facts.order.kva, required: facts.order.planQty,
        ...result,
        inputs_used: { todayISO: inputs.todayISO, fabricationLoadStdH: r1(load), fabricationAvailableH: avail === null ? null : r1(avail) },
        assumptions: ["Material stock is not verified by the app yet — the Odoo stock feed is still to come; a planner must check it.", "Drawings are read through the nesting lines of the MATERIAL tab; other documents are not tracked."],
      }),
      links: orderLinks([mo]),
    };
  },
};

// ---------------------------------------------------------------- rush order

interface RushInput { kva: string; qty: number; by: string; items?: string[]; fgCode?: string; line?: "TR" }

export const simulateRushOrderTool: ReadTool<RushInput> = {
  kind: "read", name: "simulate_rush_order", title: "Testing a rush order against the plan", tabs: ["simulate"],
  description:
    "Can the plant take a NEW transformer order (a KVA class, a quantity, the components — CF, TC, TN, CB by default) and deliver it by a date? The order is priced with the standard times of its class and put on the forecast twice: queued by its due date with today's orders (how the floor works now) and expedited to the front. " +
    "For each: the projected finish, whether it makes the date, and the orders it delays (before → after, and the ones it makes late). Changes nothing. Read it for \"can we accept 20 × 1000 kVA by the 15th?\"; to rescue the orders it would push out, follow with plan_for_deadlines.",
  schema: { type: "object", additionalProperties: false, required: ["kva", "qty", "by"], properties: {
    kva: { type: "string", minLength: 1, maxLength: 20, description: "The transformer's rating in kVA, e.g. 1000." },
    qty: { type: "integer", minimum: 1, maximum: 1000 },
    by: { type: "string", format: "date", description: "The date asked for, YYYY-MM-DD." },
    items: { type: "array", minItems: 1, maxItems: 4, items: { type: "string", enum: [...SHEET_ITEMS] } },
    fgCode: { type: "string", maxLength: 60, description: "The FG code when known — it picks the class more exactly than the kVA." },
    line: LINE,
  } },
  async run(i, ctx) {
    const refusal = lvRefusal(i, ctx); if (refusal) return refusal;
    if (i.by < ctx.todayISO) return { ok: false, text: "The date asked for has already passed." };
    const [inputs, std] = await Promise.all([withLine("TR", () => getWhatIfInputs()), getStdData()]);
    const tier = tierForOrder(std, { kva: i.kva, fgCode: i.fgCode ?? null });
    if (tier === null) return { ok: true, text: toJson({ insufficientData: true, missing: ["standard times for this kVA class"], note: "No standard-time class matches this rating; add it on Admin → Standard times before the order can be priced." }) };
    const per = itemHoursFor(std, tier);
    const items = i.items?.length ? [...new Set(i.items)] : [...SHEET_ITEMS];
    const rush: RushJob[] = items.flatMap((item) => {
      const p = per[item];
      return p ? [{ id: `NEW|${item}`, item, qty: i.qty, perPc: { cut: p.cut, weld: p.weld, finish: p.shb + p.paint } }] : [];
    });
    if (!rush.length) return { ok: true, text: toJson({ insufficientData: true, missing: ["standard times for the components asked"] }) };
    const outcome = simulateRush(inputs, rush, i.by);
    const hours = Object.fromEntries(CONTROL_STAGES.map((s) => [s, r1(rush.reduce((a, j) => a + j.qty * j.perPc[s], 0))]));
    const cap = (o: typeof outcome.atDuePosition) => ({ ...o, pushedCount: o.pushed.length, madeLate: o.pushed.filter((p) => p.nowLate).length, pushed: o.pushed.slice(0, 15) });
    return {
      ok: true,
      text: toJson({
        scope: { line: "TR", order: { kvaClass: tier, qty: i.qty, items, requestedISO: i.by } },
        inputs_used: { ...inputsUsed(inputs), newOrderStdH: hours },
        atDuePosition: cap(outcome.atDuePosition),
        expedited: cap(outcome.expedited),
        blockedBy: outcome.blockedBy,
        coverage: coverageOf(inputs),
        assumptions: [...BASE_ASSUMPTIONS, "Material for the new order is assumed available on day one — check it.", "A what-if only: nothing is booked. Accepting it, or moving a customer date, is a decision for planning and sales management."],
      }),
      links: [dashboardLink, ...orderLinks(outcome.expedited.pushed.map((p) => p.mo))],
    };
  },
};

export const PLANNING_CONTROL_TOOLS = [getDispatchListTool, getLoadProfileTool, getIoReportTool, identifyBottleneckTool, getDelayParetoTool, checkReleaseReadinessTool, simulateRushOrderTool] as const;
