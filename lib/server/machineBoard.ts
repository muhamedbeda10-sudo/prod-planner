import "server-only";
import { prisma } from "@/lib/db";
import { itemHoursFor, stageShares, tierForOrder } from "@/lib/domain/stdEngine";
import { boardTakesLine, buildMachineBoard, lineKey, type Assignment, type BoardLine, type LinePlacement, type MachineBoard } from "@/lib/domain/machineBoard";
import { hoursOfShift, isShiftCode, round1, routeFor } from "@/lib/domain/shifts";
import { dateForOffsetISO, offsetForDateISO } from "@/lib/domain/whatif";
import { boardPins, type OptLine, type OptMachine, type OptPin } from "@/lib/domain/optimizePlan";
import { machineVerdict, type MachineRuleLike, type WorkFacts } from "@/lib/domain/machineRules";
import { getStdData } from "./standardTimes";
import { getAllMachines, type MachineDTO } from "./machines";
import { getMachineItemTimes } from "./machineTimes";
import { getPaintingQueue, getWeldingQueue } from "./execution";
import { getWorklistExtras } from "./worklistExtras";
import { parseISODate, toISODate } from "@/lib/domain/dates";
import { loadHolidays, loadMasterOrdersOf } from "./loads";
import { getSettings, getShiftHours } from "./data";
import { withLine } from "./line";
import { getLvWorklist } from "./lvWorklist";
import { LV_ITEM, lvStageAt } from "@/lib/domain/lv";
import { sheetKeyOf, type LineMaterial } from "@/lib/domain/machineMaterial";
import { getLinesMaterial, type OrderRef } from "./machineMaterial";
import { getJobCuts, getManualJobs, manualBoardLines, openJobBoms } from "./manualJobs";
import { getActiveMachineRules } from "./machineRules";
import { MANUAL_BOM, MANUAL_ITEM, manualIdOf, manualMaterial, manualMo, type ManualJobView, type SheetCutView } from "@/lib/domain/manualJob";

// The machine load board for one worklist: the page hands over the open
// lines it already computed (every section of the sheet), this prices them
// in standard hours for the stage, joins the planner's assignments, today's
// downtime and crew from the shift log, and lays the board out.

export type BoardDept = "Cut" | "Welding" | "Painting" | "ShotBlast";

export interface BoardLineInput {
  bom: string;
  mo: string;
  item: string;
  description: string;
  remaining: number;
  deliveryISO: string | null;
  /** When THIS stage has to be finished (the delivery less its lead) — what
   *  the optimizer plans against. Absent = the delivery date, or no date. */
  dueISO?: string | null;
}

export interface MachineBoardData extends MachineBoard {
  dept: BoardDept;
  /** The day the board is for — the date a Done recorded on a card carries. */
  dayISO: string;
  /** The plan a Done recorded on a card belongs to (0 = the queue bucket). */
  planNo: number;
  /** Welding mints a serial per tank: those are recorded on the queue table
   *  (they need the welder), never straight off a card. */
  tankSerials: boolean;
  /** The department's machines a line can be put on (active only). */
  machines: MachineDTO[];
  /** The working days ahead, as ISO dates — index 0 is today. The timeline's
   *  axis: Fridays and the calendar's days off are already left out. */
  days: string[];
  /** bom|mo|item → where the line sits, for the tables' pickers: its first
   *  machine (a running one first) and how many more it is split over. */
  assigned: Record<string, LinePlacement>;
  /** bom|mo|item → the sheets the line is cut from (thickness, material,
   *  size, sheets a piece), off the MATERIAL tab's nesting — what the
   *  technician needs to know before starting it. Absent = not nested. */
  material: Record<string, LineMaterial>;
  /** The department's jobs from outside the plan — open ones on the board
   *  like any line, and the list kept to come back to. */
  manualJobs: ManualJobView[];
  /** The plan's Required for each BOM on the board — every open order of it
   *  together; what the floor knows a job by (the printed sheet's column). */
  required: Record<string, number>;
  /** The open transformer projects (BOMs) — what a sheet job's parts are
   *  typed against on the fabrication board; empty on the other boards. */
  jobBoms: string[];
  /** Job id → every ✓ recorded on that open sheet job, newest first — its
   *  details' cut history. No key = nothing cut yet, or the job is finished. */
  jobCuts: Record<number, SheetCutView[]>;
}

const dayOf = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** How far ahead the board's timeline is drawn — four working weeks is more
 *  than any queue a planner works with, and the picture zooms into it. */
const TIMELINE_DAYS = 20;

/** Everything a board needs from the database, loaded once: the department's
 *  machines, the planner's assignments, today's downtime and crew, and a
 *  pricing function that turns a worklist line into its route — the centres it
 *  passes and the standard hours each one owes. */
async function loadBoardContext(dept: BoardDept, dayISO: string) {
  const date = dayOf(dayISO);
  const [shiftHours, all, rows, std, orders, downtime, shifts, rates] = await Promise.all([
    getShiftHours(),
    getAllMachines(),
    prisma.worklistMachine.findMany({ where: { dept }, orderBy: [{ machineId: "asc" }, { rank: "asc" }] }),
    getStdData(),
    Promise.all([loadMasterOrdersOf("TR"), loadMasterOrdersOf("LV")]).then(([a, b]) => [...a, ...b]),
    prisma.machineDowntime.findMany({ where: { date, machine: { dept } }, select: { machineId: true, hours: true } }),
    prisma.shiftEntry.findMany({ where: { date, dept, present: true, machineId: { not: null } }, select: { machineId: true, shift: true, overtimeH: true, worker: { select: { name: true } } } }),
    getMachineItemTimes(),
  ]);
  const machines = all.filter((m) => m.dept === dept);

  // the class an order belongs to, by MO; by BOM when the line has no MO and
  // every order of that BOM agrees
  const tierByMo = new Map(orders.map((o) => [o.mo, tierForOrder(std, o)]));
  // "flagged": the monthly plan's URGENT column, or the planner's ⭐ priority
  // on the tracker — either puts the order first among those due the same day
  const urgentByMo = new Map(orders.map((o) => [o.mo, o.urgent || o.priority]));
  const tierByBom = new Map<string, number | null>();
  for (const o of orders) {
    const t = tierByMo.get(o.mo) ?? null;
    if (!tierByBom.has(o.bom)) tierByBom.set(o.bom, t);
    else if (tierByBom.get(o.bom) !== t) tierByBom.set(o.bom, null);
  }
  const stageHours = (tier: number | null, item: string): number | null => {
    if (tier === null) return null;
    const per = itemHoursFor(std, tier)[item];
    if (!per) return null; // AR / MB carry no standard times
    return dept === "Cut" ? per.cut : dept === "Welding" ? per.weld : dept === "ShotBlast" ? per.shb : per.paint;
  };
  const tierOfLine = (l: { bom: string; mo: string }) => (l.mo ? tierByMo.get(l.mo) : tierByBom.get(l.bom)) ?? null;
  /** Standard hours ONE piece of this line costs the whole stage. */
  const perPiece = (l: { bom: string; mo: string; item: string }): number | null => stageHours(tierOfLine(l), l.item);
  /** How that stage's hours divide over the centres of the item's route —
   *  the planner's typed hours a piece per centre, else the crews' split. */
  const sharesOf = (l: { bom: string; mo: string; item: string }) => stageShares(std, tierOfLine(l), dept, l.item);

  const price = (lines: readonly BoardLineInput[]): BoardLine[] =>
    lines.map((l) => {
      const per = perPiece(l);
      const hours = per === null ? null : Math.round(per * l.remaining * 10) / 10;
      // the stage's hours split over the centres the item routes through —
      // a tank is cut, bent and finned, and each centre carries its share
      const shares = sharesOf(l);
      const route = routeFor(dept, l.item).map((center) => ({ center, hours: hours === null ? null : round1(hours * (shares[center] ?? 1)) }));
      return {
        key: lineKey(l.bom, l.mo, l.item),
        bom: l.bom, mo: l.mo, item: l.item, description: l.description,
        remaining: l.remaining,
        hours,
        deliveryISO: l.deliveryISO,
        dueISO: l.dueISO ?? l.deliveryISO,
        route,
      };
    });

  const assignments: Assignment[] = rows.map((r) => ({ key: lineKey(r.bom, r.mo, r.item), machineId: r.machineId, rank: r.rank, running: r.running, qty: r.qty, sheet: r.sheet, sheetDone: r.sheetDone }));
  const downtimeH: Record<number, number> = {};
  for (const d of downtime) if (d.machineId !== null) downtimeH[d.machineId] = (downtimeH[d.machineId] ?? 0) + d.hours;
  const crewH: Record<number, number> = {};
  const crew: Record<number, string[]> = {};
  for (const s of shifts) {
    if (s.machineId === null) continue;
    crewH[s.machineId] = (crewH[s.machineId] ?? 0) + hoursOfShift(isShiftCode(s.shift) ? s.shift : "S9", shiftHours) + Math.max(0, s.overtimeH);
    (crew[s.machineId] ??= []).push(s.worker.name);
  }
  const orderByMo = new Map<string, OrderRef>(orders.map((o) => [o.mo, { soi: o.soi, months: (o.months || o.source || "").split(",").map((x) => x.trim()).filter(Boolean) }]));
  // the plan's Required for each BOM — every open order of it together; what
  // the floor knows a job by
  const requiredByBom = new Map<string, number>();
  for (const o of orders) if (o.status === "open") requiredByBom.set(o.bom, (requiredByBom.get(o.bom) ?? 0) + o.planQty);
  /** The kVA class a line's order belongs to — what a machine's kVA rule reads. */
  const tierOf = (l: { bom: string; mo: string }): number | null => (l.mo ? tierByMo.get(l.mo) : tierByBom.get(l.bom)) ?? null;
  return { machines, assignments, price, perPiece, sharesOf, tierOf, urgentByMo, downtimeH, crewH, crew, rates, orderOf: (mo: string) => orderByMo.get(mo), requiredByBom, orders };
}

export async function getMachineBoard(dept: BoardDept, planLines: readonly BoardLineInput[], dayISO: string, planNo = 0): Promise<MachineBoardData> {
  const [ctx, settings, holidays, [manualJobs, jobCuts], jobBoms] = await Promise.all([
    loadBoardContext(dept, dayISO), getSettings(), loadHolidays(),
    // the sheet jobs' cut history follows the jobs, alongside the rest
    getManualJobs(dept).then(async (jobs) => [jobs, await getJobCuts(dept, jobs)] as const),
    dept === "Cut" ? openJobBoms() : Promise.resolve([] as string[]),
  ]);
  // the jobs typed in from outside the plan queue beside the plan's lines —
  // on the fabrication machines, beside the panels' punching only: a
  // transformer plan line goes on them inside a sheet job
  const lines = [...planLines.filter((l) => boardTakesLine(dept, l.bom, l.item)), ...manualBoardLines(manualJobs)];
  // the sheets behind the lines a machine holds (a plan line's off the
  // MATERIAL tab's nesting, a manual job's as it was typed) — what the
  // technician needs before starting it. An item spread by sheet also gets
  // its list of sheets, so the board can say which still need a machine.
  const placedKeys = new Set(ctx.assignments.map((a) => a.key));
  const refs = new Map<string, { key: string; bom: string; mo: string; item: string }>();
  for (const l of lines) {
    const key = lineKey(l.bom, l.mo, l.item);
    if (manualIdOf(l.mo) !== null || !placedKeys.has(key)) continue;
    refs.set(key, { key, bom: l.bom, mo: l.mo, item: l.item });
  }
  const material = await getLinesMaterial([...refs.values()], ctx.orderOf);
  for (const j of manualJobs) {
    const m = manualMaterial(j);
    if (m) material[lineKey(MANUAL_BOM, manualMo(j.id), MANUAL_ITEM)] = m;
  }
  const bySheet = new Set(ctx.assignments.filter((a) => a.sheet).map((a) => a.key));
  const sheetsOf = (key: string) => material[key]?.specs.map(sheetKeyOf) ?? [];
  const priced = ctx.price(lines).map((l) => (bySheet.has(l.key) ? { ...l, sheets: sheetsOf(l.key) } : l));
  const board = buildMachineBoard(ctx.machines, priced, ctx.assignments, { downtimeH: ctx.downtimeH, crewH: ctx.crewH, crew: ctx.crew }, ctx.rates);
  // the day each machine's queue is finished — Fridays and the calendar's days
  // off skipped, so "clears 18/09" is a date the floor can hold you to
  const holidaySet = new Set(holidays.map((h) => toISODate(h.date)));
  for (const c of board.cards) c.clearsISO = c.days !== null && c.days > 0 ? dateForOffsetISO(c.days, dayISO, holidaySet, false) : null;
  // the axis the timeline draws on: the next working days, today first
  const days: string[] = [];
  for (let i = 1; i <= TIMELINE_DAYS; i += 1) days.push(dateForOffsetISO(i, dayISO, holidaySet, false));

  // where each line sits for the tables' pickers: the first step of its route,
  // the machines sharing that step, and the centres further along
  const code = new Map(ctx.machines.map((m) => [m.id, m.code]));
  const steps = new Map<string, { step: string; stepNo: number; machineId: number; rank: number; running: boolean; qty: number; split: boolean }[]>();
  for (const c of board.cards) {
    for (const q of c.queue) {
      const list = steps.get(q.key) ?? [];
      list.push({ step: q.step, stepNo: q.stepNo, machineId: c.machine.id, rank: q.rank, running: q.running, qty: q.remaining, split: q.split });
      steps.set(q.key, list);
    }
  }
  const routeOf = new Map<string, readonly string[]>();
  for (const l of lines) routeOf.set(lineKey(l.bom, l.mo, l.item), routeFor(dept, l.item));
  const assigned: Record<string, LinePlacement> = {};
  for (const [key, list] of steps) {
    list.sort((a, b) => a.stepNo - b.stepNo || Number(b.running) - Number(a.running) || a.rank - b.rank);
    const first = list[0];
    const here = list.filter((x) => x.step === first.step);
    const lead = here.find((x) => x.running) ?? here[0];
    const later = list.filter((x) => x.step !== first.step);
    const seenStep = new Set<string>();
    const next: NonNullable<LinePlacement["next"]> = [];
    for (const x of later) {
      if (seenStep.has(x.step)) continue;
      seenStep.add(x.step);
      next.push({ center: x.step, machineId: x.machineId, code: code.get(x.machineId) ?? "", rank: x.rank, running: x.running });
    }
    const done = new Set(list.map((x) => x.step));
    const missing = (routeOf.get(key) ?? []).filter((c) => !done.has(c));
    assigned[key] = {
      machineId: lead.machineId, rank: lead.rank, running: lead.running, qty: lead.qty, split: lead.split,
      others: here.length - 1,
      ...(next.length > 0 ? { next } : {}),
      ...(missing.length > 0 ? { missing } : {}),
    };
  }
  return {
    ...board, dept, dayISO, planNo, tankSerials: settings.tankTracking && dept === "Welding", machines: ctx.machines.filter((m) => m.active), days, assigned, material, manualJobs, jobBoms, jobCuts,
    required: Object.fromEntries([...new Set(lines.map((l) => l.bom))].map((b) => [b, ctx.requiredByBom.get(b) ?? 0])),
  };
}

/** What the machine plan (the assistant's optimizer) plans from: the department's machines with the hours
 *  they really have today, every open line with its route and the day the plan
 *  promises it, the work already running (which keeps its machine), and the
 *  machines' rules with what each line is as they read it. */
export interface OptimizerInputs {
  machines: OptMachine[];
  lines: OptLine[];
  pins: OptPin[];
  /** What each line is, as the machines' rules read it. */
  facts: Record<string, WorkFacts>;
  /** The department's active machine rules. */
  rules: MachineRuleLike[];
}

/** The optimizer's inputs for a department. `mayPlan` narrows them to the
 *  lines the planner's keys cover on the shared floor; the other line's
 *  waiting work then keeps its machine and its place too, like running work. */
export async function getOptimizerInputs(dept: BoardDept, dayISO: string, mayPlan: (item: string) => boolean = () => true): Promise<OptimizerInputs> {
  const [ctx, inputs, holidays, rules] = await Promise.all([
    loadBoardContext(dept, dayISO), getDeptBoardLines(dept, dayISO), loadHolidays(), getActiveMachineRules(dept),
  ]);
  // the board of BOTH lines, whoever plans: the work the plan keeps has to
  // be on it to be kept
  const board = buildMachineBoard(ctx.machines, ctx.price(inputs), ctx.assignments, { downtimeH: ctx.downtimeH, crewH: ctx.crewH, crew: ctx.crew }, ctx.rates);

  // what runs now holds its machine, and covers that many pieces of its step
  // — and so does the other line's waiting work, when only one line is planned
  const pins = boardPins(board.cards, mayPlan);
  const pinned = new Map<string, number>();
  for (const p of pins) pinned.set(`${p.key}#${p.center}`, (pinned.get(`${p.key}#${p.center}`) ?? 0) + p.pieces);

  // one row per line — the same line can arrive as several tranches
  const holidaySet = new Set(holidays.map((h) => toISODate(h.date)));
  const merged = new Map<string, { key: string; item: string; pieces: number; perPiece: number | null; shares: Record<string, number>; dueISO: string | null; urgent: boolean }>();
  for (const l of inputs) {
    if (!(l.remaining > 0) || !mayPlan(l.item)) continue;
    const key = lineKey(l.bom, l.mo, l.item);
    const due = l.dueISO ?? l.deliveryISO ?? null;
    const prev = merged.get(key);
    if (!prev) merged.set(key, { key, item: l.item, pieces: l.remaining, perPiece: ctx.perPiece(l), shares: ctx.sharesOf(l), dueISO: due, urgent: !!ctx.urgentByMo.get(l.mo) });
    else {
      prev.pieces += l.remaining;
      if (due && (!prev.dueISO || due < prev.dueISO)) prev.dueISO = due;
    }
  }

  // what each line is, for the machines' rules: its item and product line,
  // its order's kVA class, and the sheets its nesting cuts it from
  const facts: Record<string, WorkFacts> = {};
  if (rules.length > 0) {
    const refs = [...merged.values()].map((l) => {
      const [bom, mo, item] = l.key.split("|");
      return { key: l.key, bom, mo, item };
    });
    const material = await getLinesMaterial(refs, ctx.orderOf);
    for (const r of refs) {
      const specs = material[r.key]?.specs ?? [];
      facts[r.key] = {
        item: r.item,
        line: r.item === LV_ITEM ? "LV" : "TR",
        kva: ctx.tierOf(r),
        thicknessesMm: [...new Set(specs.map((x) => x.thicknessMm))],
        materials: [...new Set(specs.map((x) => x.material))],
      };
    }
  }
  const rulesOf = new Map<number, MachineRuleLike[]>();
  for (const r of rules) (rulesOf.get(r.machineId) ?? rulesOf.set(r.machineId, []).get(r.machineId)!).push(r);

  const lines: OptLine[] = [...merged.values()].map((l) => {
    const shares = l.shares;
    const route = routeFor(dept, l.item).map((center) => {
      const left = Math.max(0, l.pieces - (pinned.get(`${l.key}#${center}`) ?? 0));
      const perPc = l.perPiece === null ? 0 : l.perPiece * (shares[center] ?? 1);
      // the machines of this centre that carry the planner's own figure
      const perMachine: Record<number, number> = {};
      for (const m of ctx.machines) {
        const own = ctx.rates[m.id]?.[l.item];
        if (m.center === center && own !== undefined) perMachine[m.id] = own;
      }
      // the machines of this centre the rules let it go on, and prefer for it
      const atCenter = ctx.machines.filter((m) => m.active && m.center === center);
      const ruled = atCenter.some((m) => rulesOf.has(m.id));
      const verdicts = ruled ? atCenter.map((m) => ({ id: m.id, v: machineVerdict(rulesOf.get(m.id) ?? [], facts[l.key]) })) : [];
      const preferred = verdicts.filter((x) => x.v.allowed && x.v.preferred).map((x) => x.id);
      return {
        center,
        pieces: left,
        hoursPerPiece: perPc,
        ...(Object.keys(perMachine).length > 0 ? { perMachine } : {}),
        ...(ruled ? { allowed: verdicts.filter((x) => x.v.allowed).map((x) => x.id) } : {}),
        ...(preferred.length > 0 ? { preferred } : {}),
      };
    });
    return { key: l.key, pieces: l.pieces, route, dueDay: l.dueISO ? offsetForDateISO(l.dueISO, dayISO, holidaySet, false) : null, urgent: l.urgent };
  });

  const machines: OptMachine[] = ctx.machines
    .filter((m) => m.active)
    .map((m) => ({ id: m.id, code: m.code, center: m.center, availableH: m.hoursPerDay === null ? 0 : Math.max(0, m.hoursPerDay - (ctx.downtimeH[m.id] ?? 0)) }));
  return { machines, lines, pins, facts, rules };
}

/** The open lines of a department's worklist, as the board wants them — the
 *  same rows the worklist page shows, gathered for a page that has not
 *  loaded them itself (the Floor canvas). Shot blast has no worklist. */
export async function getDeptBoardLines(dept: BoardDept, dayISO: string): Promise<BoardLineInput[]> {
  // One physical floor: the punches carry panels beside transformer parts,
  // so the board draws BOTH lines' work whatever the toggle says. The
  // transformers' lines come off their worklists under a forced line; the
  // panels' off their stage worklists, which read the panels regardless.
  const [tr, lv] = await Promise.all([withLine("TR", () => transformerBoardLines(dept, dayISO)), lvBoardLines(dept)]);
  return [...tr, ...lv];
}

async function transformerBoardLines(dept: BoardDept, dayISO: string): Promise<BoardLineInput[]> {
  const day = parseISODate(dayISO) ?? new Date();
  // the fabrication machines carry sheet jobs — no transformer line of its own
  if (dept === "Cut") return [];
  if (dept === "ShotBlast") return [];
  const [queue, extras] = await Promise.all([dept === "Welding" ? getWeldingQueue(day) : getPaintingQueue(day), getWorklistExtras(dept)]);
  return [
    ...queue.map((r) => ({ bom: r.bom, mo: r.mo, item: r.item, description: r.description, remaining: r.available, deliveryISO: r.deliveryISO, dueISO: r.dueISO })),
    ...extras.pushed.map((p) => ({ bom: p.bom, mo: p.mo, item: p.item, description: p.description, remaining: p.qty, deliveryISO: null })),
  ];
}

/** The panels on a bay: punching on the fabrication bay's punches, welding
 *  and painting on those bays. Bending is one centre and is not drawn. */
async function lvBoardLines(dept: BoardDept): Promise<BoardLineInput[]> {
  const stage = lvStageAt(dept);
  if (!stage) return [];
  const list = await getLvWorklist(stage);
  return list.rows.map((r) => ({ bom: r.bom, mo: r.mo, item: LV_ITEM, description: `LV ${r.product ?? "panel"} · ${r.customer ?? ""}`.trim(), remaining: r.waiting, deliveryISO: null, dueISO: null }));
}
