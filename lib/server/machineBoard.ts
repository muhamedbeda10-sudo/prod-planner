import "server-only";
import { prisma } from "@/lib/db";
import { itemHoursFor, tierForOrder } from "@/lib/domain/stdEngine";
import { buildMachineBoard, lineKey, type Assignment, type BoardLine, type LinePlacement, type MachineBoard } from "@/lib/domain/machineBoard";
import { centerShares, hoursOfShift, isShiftCode, round1, routeFor } from "@/lib/domain/shifts";
import { dateForOffsetISO, offsetForDateISO } from "@/lib/domain/whatif";
import type { OptLine, OptMachine, OptPin } from "@/lib/domain/optimizePlan";
import { getStdData } from "./standardTimes";
import { getAllMachines, type MachineDTO } from "./machines";
import { getMachineItemTimes } from "./machineTimes";
import { getCutSheet, getPaintingQueue, getWeldingQueue } from "./execution";
import { getWorklistExtras } from "./worklistExtras";
import { parseISODate, toISODate } from "@/lib/domain/dates";
import { loadHolidays, loadMasterOrders } from "./loads";
import { getSettings, getShiftHours } from "./data";
import { getActiveLine } from "./line";
import { getLvWorklist } from "./lvWorklist";
import { LV_ITEM } from "@/lib/domain/lv";

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
    loadMasterOrders(),
    prisma.machineDowntime.findMany({ where: { date, machine: { dept } }, select: { machineId: true, hours: true } }),
    prisma.shiftEntry.findMany({ where: { date, dept, present: true, machineId: { not: null } }, select: { machineId: true, shift: true, overtimeH: true, worker: { select: { name: true } } } }),
    getMachineItemTimes(),
  ]);
  const machines = all.filter((m) => m.dept === dept);

  // the class an order belongs to, by MO; by BOM when the line has no MO and
  // every order of that BOM agrees
  const tierByMo = new Map(orders.map((o) => [o.mo, tierForOrder(std, o)]));
  const urgentByMo = new Map(orders.map((o) => [o.mo, o.urgent]));
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
  /** Standard hours ONE piece of this line costs the whole stage. */
  const perPiece = (l: { bom: string; mo: string; item: string }): number | null =>
    stageHours((l.mo ? tierByMo.get(l.mo) : tierByBom.get(l.bom)) ?? null, l.item);

  const price = (lines: readonly BoardLineInput[]): BoardLine[] =>
    lines.map((l) => {
      const per = perPiece(l);
      const hours = per === null ? null : Math.round(per * l.remaining * 10) / 10;
      // the stage's hours split over the centres the item routes through —
      // a tank is cut, bent and finned, and each centre carries its share
      const shares = centerShares(dept, l.item);
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

  const assignments: Assignment[] = rows.map((r) => ({ key: lineKey(r.bom, r.mo, r.item), machineId: r.machineId, rank: r.rank, running: r.running, qty: r.qty }));
  const downtimeH: Record<number, number> = {};
  for (const d of downtime) downtimeH[d.machineId] = (downtimeH[d.machineId] ?? 0) + d.hours;
  const crewH: Record<number, number> = {};
  const crew: Record<number, string[]> = {};
  for (const s of shifts) {
    if (s.machineId === null) continue;
    crewH[s.machineId] = (crewH[s.machineId] ?? 0) + hoursOfShift(isShiftCode(s.shift) ? s.shift : "S9", shiftHours) + Math.max(0, s.overtimeH);
    (crew[s.machineId] ??= []).push(s.worker.name);
  }
  return { machines, assignments, price, perPiece, urgentByMo, downtimeH, crewH, crew, rates };
}

export async function getMachineBoard(dept: BoardDept, lines: readonly BoardLineInput[], dayISO: string, planNo = 0): Promise<MachineBoardData> {
  const [ctx, settings, holidays] = await Promise.all([loadBoardContext(dept, dayISO), getSettings(), loadHolidays()]);
  const board = buildMachineBoard(ctx.machines, ctx.price(lines), ctx.assignments, { downtimeH: ctx.downtimeH, crewH: ctx.crewH, crew: ctx.crew }, ctx.rates);
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
  return { ...board, dept, dayISO, planNo, tankSerials: settings.tankTracking && dept === "Welding", machines: ctx.machines.filter((m) => m.active), days, assigned };
}

/** What the ⚡ optimizer plans from: the department's machines with the hours
 *  they really have today, every open line with its route and the day the plan
 *  promises it, and the work already running (which keeps its machine). */
export async function getOptimizerInputs(dept: BoardDept, dayISO: string): Promise<{ machines: OptMachine[]; lines: OptLine[]; pins: OptPin[] }> {
  const [ctx, inputs, holidays] = await Promise.all([loadBoardContext(dept, dayISO), getDeptBoardLines(dept, dayISO), loadHolidays()]);
  const board = buildMachineBoard(ctx.machines, ctx.price(inputs), ctx.assignments, { downtimeH: ctx.downtimeH, crewH: ctx.crewH, crew: ctx.crew }, ctx.rates);

  // what runs now holds its machine, and covers that many pieces of its step
  const pins: OptPin[] = [];
  const pinned = new Map<string, number>();
  for (const c of board.cards) {
    for (const q of c.running) {
      pins.push({ key: q.key, center: q.step, machineId: c.machine.id, pieces: q.remaining, hours: q.hours ?? 0 });
      pinned.set(`${q.key}#${q.step}`, (pinned.get(`${q.key}#${q.step}`) ?? 0) + q.remaining);
    }
  }

  // one row per line — the same line can arrive as several tranches
  const holidaySet = new Set(holidays.map((h) => toISODate(h.date)));
  const merged = new Map<string, { key: string; item: string; pieces: number; perPiece: number | null; dueISO: string | null; urgent: boolean }>();
  for (const l of inputs) {
    if (!(l.remaining > 0)) continue;
    const key = lineKey(l.bom, l.mo, l.item);
    const due = l.dueISO ?? l.deliveryISO ?? null;
    const prev = merged.get(key);
    if (!prev) merged.set(key, { key, item: l.item, pieces: l.remaining, perPiece: ctx.perPiece(l), dueISO: due, urgent: !!ctx.urgentByMo.get(l.mo) });
    else {
      prev.pieces += l.remaining;
      if (due && (!prev.dueISO || due < prev.dueISO)) prev.dueISO = due;
    }
  }

  const lines: OptLine[] = [...merged.values()].map((l) => {
    const shares = centerShares(dept, l.item);
    const route = routeFor(dept, l.item).map((center) => {
      const left = Math.max(0, l.pieces - (pinned.get(`${l.key}#${center}`) ?? 0));
      const perPc = l.perPiece === null ? 0 : l.perPiece * (shares[center] ?? 1);
      // the machines of this centre that carry the planner's own figure
      const perMachine: Record<number, number> = {};
      for (const m of ctx.machines) {
        const own = ctx.rates[m.id]?.[l.item];
        if (m.center === center && own !== undefined) perMachine[m.id] = own;
      }
      return { center, pieces: left, hoursPerPiece: perPc, ...(Object.keys(perMachine).length > 0 ? { perMachine } : {}) };
    });
    return { key: l.key, pieces: l.pieces, route, dueDay: l.dueISO ? offsetForDateISO(l.dueISO, dayISO, holidaySet, false) : null, urgent: l.urgent };
  });

  const machines: OptMachine[] = ctx.machines
    .filter((m) => m.active)
    .map((m) => ({ id: m.id, code: m.code, center: m.center, availableH: m.hoursPerDay === null ? 0 : Math.max(0, m.hoursPerDay - (ctx.downtimeH[m.id] ?? 0)) }));
  return { machines, lines, pins };
}

/** The open lines of a department's worklist, as the board wants them — the
 *  same rows the worklist page shows, gathered for a page that has not
 *  loaded them itself (the Floor canvas). Shot blast has no worklist. */
export async function getDeptBoardLines(dept: BoardDept, dayISO: string): Promise<BoardLineInput[]> {
  const day = parseISODate(dayISO) ?? new Date();
  // The panels: their punching runs on the fabrication bay's punches, their
  // welding and painting on those bays — each stage's worklist, as lines.
  // Bending is one centre and is not drawn on a machine.
  if ((await getActiveLine()) === "LV") {
    if (dept === "ShotBlast") return [];
    const stage = dept === "Cut" ? "Punching" : dept;
    const list = await getLvWorklist(stage);
    return list.rows.map((r) => ({ bom: r.bom, mo: r.mo, item: LV_ITEM, description: `${r.product ?? "LV panel"} · ${r.customer ?? ""}`.trim(), remaining: r.waiting, deliveryISO: null, dueISO: null }));
  }
  if (dept === "Cut") {
    const sheet = await getCutSheet();
    return [
      ...[...sheet.dueNow, ...sheet.overdue, ...sheet.postponed].map((r) => ({ bom: r.bom, mo: r.mo, item: r.item, description: r.description, remaining: r.remaining, deliveryISO: r.deliveryISO, dueISO: r.cutDueISO })),
      ...[...sheet.pushed, ...sheet.remarked, ...sheet.unscheduled].map((r) => ({ bom: r.bom, mo: r.mo, item: r.item, description: r.description, remaining: r.available, deliveryISO: r.deliveryISO, dueISO: null })),
    ];
  }
  if (dept === "ShotBlast") return [];
  const [queue, extras] = await Promise.all([dept === "Welding" ? getWeldingQueue(day) : getPaintingQueue(day), getWorklistExtras(dept)]);
  return [
    ...queue.map((r) => ({ bom: r.bom, mo: r.mo, item: r.item, description: r.description, remaining: r.available, deliveryISO: r.deliveryISO, dueISO: r.dueISO })),
    ...extras.pushed.map((p) => ({ bom: p.bom, mo: p.mo, item: p.item, description: p.description, remaining: p.qty, deliveryISO: null })),
  ];
}
