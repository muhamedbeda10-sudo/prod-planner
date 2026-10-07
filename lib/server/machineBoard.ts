import "server-only";
import { prisma } from "@/lib/db";
import { itemHoursFor, tierForOrder } from "@/lib/domain/stdEngine";
import { buildMachineBoard, lineKey, type Assignment, type BoardLine, type LinePlacement, type MachineBoard } from "@/lib/domain/machineBoard";
import { centerShares, hoursOfShift, isShiftCode, round1, routeFor } from "@/lib/domain/shifts";
import { ITEM_NAME, applicableItems, ospOf } from "@/lib/domain/constants";
import { isOnHold } from "@/lib/domain/hold";
import { dateForOffsetISO, offsetForDateISO } from "@/lib/domain/whatif";
import type { OptLine, OptMachine, OptPin } from "@/lib/domain/optimizePlan";
import { getStdData } from "./standardTimes";
import { getAllMachines, type MachineDTO } from "./machines";
import { getMachineItemTimes } from "./machineTimes";
import { getCutSheet, getPaintingQueue, getWeldingQueue } from "./execution";
import { getWorklistExtras } from "./worklistExtras";
import { parseISODate, toISODate } from "@/lib/domain/dates";
import { loadHolidays, loadMasterOrdersOf } from "./loads";
import { getSettings, getShiftHours } from "./data";
import { withLine } from "./line";
import { getLvWorklist } from "./lvWorklist";
import { LV_ITEM } from "@/lib/domain/lv";
import { fullyCutPieces, sheetKeyOf, type LineMaterial } from "@/lib/domain/machineMaterial";
import { getLinesMaterial, type OrderRef } from "./machineMaterial";
import { getManualJobs, manualBoardLines } from "./manualJobs";
import { getNestRuns, runCover, runCut } from "./nestRuns";
import { RUN_BOM, RUN_ITEM, minutesLeft, runDescription, runIdOf, runMo, type NestRunView } from "@/lib/domain/nestRun";
import { MANUAL_BOM, MANUAL_ITEM, manualIdOf, manualMaterial, manualMo, type ManualJobView } from "@/lib/domain/manualJob";

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
  /** Items spread over machines by sheet whose every sheet is cut for some
   *  pieces — whole pieces, ready to be recorded as cut in one click. */
  readyCut: ReadyCut[];
  /** The cutting board's nest runs — open ones on the board, and the list. */
  nestRuns: NestRunView[];
  runOptions: RunSheetOption[];
  runCandidates: RunCandidate[];
}

/** A sheet the open lines are cut from, and the lines that still need it —
 *  what a nest run is put together from. */
export interface RunSheetOption {
  sheet: string;
  material: string;
  thicknessMm: number;
  sheetSize: string;
  lines: {
    key: string; bom: string; mo: string; item: string; description: string; free: number; perUnit: number;
    /** The plan's Required for the whole BOM. */
    required: number;
    /** The nesting's material name and code, and its sheets for the job. */
    material: string; materialCode: string; jobSheets: number | null;
  }[];
}

/** Any open line, for a run cut from a sheet the nesting does not list. */
export interface RunCandidate {
  key: string; bom: string; mo: string; item: string; description: string; remaining: number;
  /** The plan's Required for the whole BOM. */
  required: number;
  /** Pieces no machine or run holds yet (the most any of its sheets lacks). */
  free: number;
  /** The sheets its own nesting cuts it from. */
  sheets: string[];
}

export interface ReadyCut {
  key: string;
  bom: string;
  mo: string;
  item: string;
  description: string;
  /** Pieces cut on every sheet — what can be recorded. */
  qty: number;
  /** What each sheet has cut so far (pieces' worth). */
  sheets: { sheet: string; cut: number }[];
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

  const assignments: Assignment[] = rows.map((r) => ({ key: lineKey(r.bom, r.mo, r.item), machineId: r.machineId, rank: r.rank, running: r.running, qty: r.qty, sheet: r.sheet, sheetDone: r.sheetDone }));
  const downtimeH: Record<number, number> = {};
  for (const d of downtime) downtimeH[d.machineId] = (downtimeH[d.machineId] ?? 0) + d.hours;
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
  return { machines, assignments, price, perPiece, urgentByMo, downtimeH, crewH, crew, rates, orderOf: (mo: string) => orderByMo.get(mo), requiredByBom, orders };
}

export async function getMachineBoard(dept: BoardDept, planLines: readonly BoardLineInput[], dayISO: string, planNo = 0): Promise<MachineBoardData> {
  const [ctx, settings, holidays, manualJobs, nestRuns] = await Promise.all([
    loadBoardContext(dept, dayISO), getSettings(), loadHolidays(), getManualJobs(dept), dept === "Cut" ? getNestRuns(dept) : Promise.resolve([] as NestRunView[]),
  ]);
  // the jobs typed in from outside the plan queue beside the plan's lines
  const lines = [...planLines, ...manualBoardLines(manualJobs)];
  // the nest runs' hold on their parts' sheets, and what they have cut
  const cover = runCover(nestRuns);
  const cutByRuns = runCut(nestRuns);
  const coverKeys = new Set(cover.map((c) => c.key));
  // the sheets behind the lines (a plan line's off the MATERIAL tab's
  // nesting, a manual job's as it was typed) — every open line on the cutting
  // board, where a nest run is put together from them; the lines a machine
  // holds elsewhere. An item spread by sheet (over machines or runs) also
  // gets its list of sheets, so the board can say which still need a machine.
  const placedKeys = new Set(ctx.assignments.map((a) => a.key));
  // the cutting board's nest runs can carry any part the plan still owes
  const registry = dept === "Cut" ? await registryCutLines(ctx.orders) : [];
  const refs = new Map<string, { key: string; bom: string; mo: string; item: string }>();
  for (const l of [...lines, ...registry]) {
    const key = lineKey(l.bom, l.mo, l.item);
    if (manualIdOf(l.mo) !== null) continue;
    if (dept === "Cut" || placedKeys.has(key) || coverKeys.has(key)) refs.set(key, { key, bom: l.bom, mo: l.mo, item: l.item });
  }
  const material = await getLinesMaterial([...refs.values()], ctx.orderOf);
  for (const j of manualJobs) {
    const m = manualMaterial(j);
    if (m) material[lineKey(MANUAL_BOM, manualMo(j.id), MANUAL_ITEM)] = m;
  }
  const bySheet = new Set([...ctx.assignments.filter((a) => a.sheet).map((a) => a.key), ...coverKeys]);
  const sheetsOf = (key: string) => {
    const own = material[key]?.specs.map(sheetKeyOf) ?? [];
    // a run's sheet the nesting does not list still counts as one of the item's
    const extra = cover.filter((c) => c.key === key && !own.includes(c.sheet)).map((c) => c.sheet);
    return [...own, ...new Set(extra)];
  };
  // a run is a line of its own: its sheets are its pieces; its hours are its
  // parts' cutting hours for the sheets still to cut
  const runLines: BoardLine[] = nestRuns
    .filter((r) => !r.doneAtISO && r.sheets - r.sheetsDone > 0)
    .map((r) => {
      const left = r.sheets - r.sheetsDone;
      let hours: number | null = null;
      for (const p of r.parts) {
        const per = ctx.perPiece({ bom: p.bom, mo: p.mo, item: p.item });
        if (per === null) continue;
        hours = (hours ?? 0) + per * (centerShares(dept, p.item).Cutting ?? 1) * p.pcs;
      }
      // the run's own cutting time, where it was given, outranks the estimate
      const own = minutesLeft(r);
      const h = own !== null ? round1(own / 60) : hours === null ? null : round1((hours * left) / r.sheets);
      const key = lineKey(RUN_BOM, runMo(r.id), RUN_ITEM);
      material[key] = { partName: "", month: "nest run", specs: [{ material: r.material, materialCode: "", thicknessMm: r.thicknessMm, sheetSize: r.sheetSize, perUnit: 1, actual: true }] };
      return { key, bom: RUN_BOM, mo: runMo(r.id), item: RUN_ITEM, description: runDescription(r), remaining: left, hours: h, deliveryISO: null, dueISO: null, route: [{ center: "Cutting", hours: h }] };
    });
  const priced = [
    ...ctx.price(lines).map((l) => (bySheet.has(l.key) ? { ...l, sheets: sheetsOf(l.key) } : l)),
    ...runLines,
  ];
  const board = buildMachineBoard(ctx.machines, priced, ctx.assignments, { downtimeH: ctx.downtimeH, crewH: ctx.crewH, crew: ctx.crew }, ctx.rates, cover);
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
  // the items whose every sheet is cut for some pieces: those pieces are
  // whole, and wait for one click to be recorded as cut
  const remainingOf = new Map<string, { remaining: number; l: BoardLineInput }>();
  for (const l of lines) {
    const k = lineKey(l.bom, l.mo, l.item);
    const cur = remainingOf.get(k);
    remainingOf.set(k, { remaining: (cur?.remaining ?? 0) + l.remaining, l: cur?.l ?? l });
  }
  // a part the worklist does not show yet (its day has not come, or the line
  // is hidden) can still sit in a run — the registry says what is left of it
  const registryOf = new Map<string, BoardLineInput>();
  for (const r of registry) registryOf.set(lineKey(r.bom, r.mo, r.item), r);
  for (const [k, r] of registryOf) if (!remainingOf.has(k)) remainingOf.set(k, { remaining: r.remaining, l: r });
  const readyCut: ReadyCut[] = [];
  for (const key of bySheet) {
    const open = remainingOf.get(key);
    const specs = material[key]?.specs ?? [];
    if (!open || open.remaining <= 0 || specs.length === 0) continue;
    const rows = [
      ...ctx.assignments.filter((x) => x.key === key && x.sheet).map((x) => ({ sheet: x.sheet!, sheetDone: x.sheetDone ?? 0 })),
      ...cutByRuns.filter((x) => x.key === key),
    ];
    const keys = sheetsOf(key);
    const qty = fullyCutPieces(rows, keys, open.remaining);
    if (qty <= 0) continue;
    readyCut.push({
      key, bom: open.l.bom, mo: open.l.mo, item: open.l.item, description: open.l.description, qty,
      sheets: keys.map((sh) => ({ sheet: sh, cut: rows.filter((r) => r.sheet === sh).reduce((n, r) => n + r.sheetDone, 0) })),
    });
  }
  // what a nest run can be put together from: each sheet the open lines are
  // cut from, with the lines that still need it and how many of their pieces
  // no machine or run holds yet
  const runOptions: RunSheetOption[] = [];
  const runCandidates: RunCandidate[] = [];
  if (dept === "Cut") {
    // what the board already holds of a line on a sheet: placed on machines
    // (its worklist pieces less what still waits) or carried by a run
    const boardRemaining = new Map<string, number>();
    for (const l of priced) boardRemaining.set(l.key, (boardRemaining.get(l.key) ?? 0) + l.remaining);
    const coverOf = (key: string, sheet: string) => cover.filter((c) => c.key === key && (!sheet || c.sheet === sheet)).reduce((n, c) => n + c.pcs, 0);
    const placedOn = (key: string, sheet: string) => {
      const onBoard = boardRemaining.get(key);
      if (onBoard === undefined) return coverOf(key, sheet);
      const step1 = board.unassigned.filter((u) => u.key === key && u.stepNo === 1);
      const waiting = (sheet ? step1.find((u) => u.sheet === sheet) : undefined) ?? step1.find((u) => !u.sheet);
      // a line spread by sheet with nothing waiting on this one is fully placed on it
      const left = waiting?.remaining ?? (sheet && step1.some((u) => u.sheet) ? 0 : step1.reduce((n, u) => Math.max(n, u.remaining), 0));
      return Math.max(0, onBoard - left);
    };
    const bySheetOpt = new Map<string, RunSheetOption>();
    const seenLine = new Set<string>();
    for (const l of [...priced, ...registry.map((r) => ({ ...r, key: lineKey(r.bom, r.mo, r.item) }))]) {
      if (seenLine.has(l.key) || manualIdOf(l.mo) !== null || runIdOf(l.mo) !== null) continue;
      seenLine.add(l.key);
      // the plan's own figure where the registry has the line, else the board's
      const remaining = registryOf.get(l.key)?.remaining ?? remainingOf.get(l.key)?.remaining ?? 0;
      if (remaining <= 0) continue;
      const specs = material[l.key]?.specs ?? [];
      const freeOn = (sheet: string) => Math.max(0, remaining - placedOn(l.key, sheet));
      runCandidates.push({
        key: l.key, bom: l.bom, mo: l.mo, item: l.item, description: l.description, remaining, required: ctx.requiredByBom.get(l.bom) ?? 0,
        free: specs.length > 0 ? Math.max(...specs.map((sp) => freeOn(sheetKeyOf(sp)))) : freeOn(""),
        sheets: specs.map(sheetKeyOf),
      });
      for (const sp of specs) {
        const sheet = sheetKeyOf(sp);
        const free = freeOn(sheet);
        if (free <= 0) continue;
        const opt = bySheetOpt.get(sheet) ?? { sheet, material: sp.material, thicknessMm: sp.thicknessMm, sheetSize: sp.sheetSize, lines: [] };
        opt.lines.push({
          key: l.key, bom: l.bom, mo: l.mo, item: l.item, description: l.description, free, perUnit: sp.perUnit,
          required: ctx.requiredByBom.get(l.bom) ?? 0, material: sp.material, materialCode: sp.materialCode, jobSheets: sp.jobSheets ?? null,
        });
        bySheetOpt.set(sheet, opt);
      }
    }
    runOptions.push(...[...bySheetOpt.values()].sort((a, b) => b.lines.length - a.lines.length || a.thicknessMm - b.thicknessMm));
  }
  return {
    ...board, readyCut, dept, dayISO, planNo, tankSerials: settings.tankTracking && dept === "Welding", machines: ctx.machines.filter((m) => m.active), days, assigned, material, manualJobs,
    nestRuns, runOptions, runCandidates,
  };
}

/** Every transformer part the plan still owes cutting on, straight off the
 *  registry — open orders not on hold, each applicable component, its order
 *  qty less the OSP share less what is already cut. Wider than the cutting
 *  worklist, which shows a line only once its day comes (or it is pushed,
 *  remarked or date-less) and leaves the hidden ones out: a nest run can
 *  carry any of them now. */
async function registryCutLines(orders: readonly { mo: string; bom: string; line: string; status: string; holdAt: Date | null; planQty: number; ospCF: number; ospTC: number; ospTN: number; ospCB: number }[] & Parameters<typeof applicableItems>[0][]): Promise<BoardLineInput[]> {
  const done = await prisma.handoverEntry.groupBy({ by: ["mo", "item"], where: { dept: "Cut", mo: { not: null } }, _sum: { qty: true } });
  const doneOf = new Map(done.map((d) => [`${d.mo}|${d.item}`, d._sum.qty ?? 0]));
  const out: BoardLineInput[] = [];
  for (const o of orders) {
    if (o.line !== "TR" || o.status !== "open" || isOnHold(o)) continue;
    for (const item of applicableItems(o)) {
      const left = Math.max(0, o.planQty - ospOf(o, item) - (doneOf.get(`${o.mo}|${item}`) ?? 0));
      if (left > 0) out.push({ bom: o.bom, mo: o.mo, item, description: ITEM_NAME[item], remaining: left, deliveryISO: null });
    }
  }
  return out;
}

/** What the ⚡ optimizer plans from: the department's machines with the hours
 *  they really have today, every open line with its route and the day the plan
 *  promises it, and the work already running (which keeps its machine). */
export async function getOptimizerInputs(dept: BoardDept, dayISO: string): Promise<{ machines: OptMachine[]; lines: OptLine[]; pins: OptPin[] }> {
  const [ctx, allInputs, holidays, runs] = await Promise.all([
    loadBoardContext(dept, dayISO), getDeptBoardLines(dept, dayISO), loadHolidays(), dept === "Cut" ? getNestRuns(dept) : Promise.resolve([] as NestRunView[]),
  ]);
  // a line a nest run carries is the planner's own arrangement — the plan
  // leaves it to him rather than put the item on a machine a second time
  const inRun = new Set(runCover(runs).map((c) => c.key));
  const inputs = allInputs.filter((l) => !inRun.has(lineKey(l.bom, l.mo, l.item)));
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
  // One physical floor: the punches carry panels beside transformer parts,
  // so the board draws BOTH lines' work whatever the toggle says. The
  // transformers' lines come off their worklists under a forced line; the
  // panels' off their stage worklists, which read the panels regardless.
  const [tr, lv] = await Promise.all([withLine("TR", () => transformerBoardLines(dept, dayISO)), lvBoardLines(dept)]);
  return [...tr, ...lv];
}

async function transformerBoardLines(dept: BoardDept, dayISO: string): Promise<BoardLineInput[]> {
  const day = parseISODate(dayISO) ?? new Date();
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

/** The panels on a bay: punching on the fabrication bay's punches, welding
 *  and painting on those bays. Bending is one centre and is not drawn. */
async function lvBoardLines(dept: BoardDept): Promise<BoardLineInput[]> {
  if (dept === "ShotBlast") return [];
  const list = await getLvWorklist(dept === "Cut" ? "Punching" : dept);
  return list.rows.map((r) => ({ bom: r.bom, mo: r.mo, item: LV_ITEM, description: `LV ${r.product ?? "panel"} · ${r.customer ?? ""}`.trim(), remaining: r.waiting, deliveryISO: null, dueISO: null }));
}
