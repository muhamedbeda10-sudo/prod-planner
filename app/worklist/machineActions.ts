"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { bayAccess, requireBayAccess, requireMachineLineEdit } from "@/lib/server/auth";
import { mayScheduleLine, type BayAccess } from "@/lib/domain/permissions";
import { ledgerItemWhere } from "@/lib/server/line";
import { getOptimizerInputs } from "@/lib/server/machineBoard";
import { optimizePlan } from "@/lib/domain/optimizePlan";
import { factoryDayISO } from "@/lib/domain/dates";
import { CENTER_LABEL, machineWord } from "@/lib/domain/shifts";
import { MANUAL_BOM, MANUAL_ITEM, SHEET_COUNT_RULE, isSheetCount, isSheetJobLine, manualIdOf, typedCount } from "@/lib/domain/manualJob";
import { BOARD_LINE_REFUSED, boardTakesLine } from "@/lib/domain/machineBoard";
import type { QueueRowSnapshot } from "@/lib/server/machineQueues";

// The machine board's writes: put a worklist line on a machine (or take it
// off), move it up or down that machine's queue, empty a machine. Deciding
// what runs where is the same job as recording what ran, so the LINE's key
// covers them: the machines are shared, and a panel on a punch is the panel
// clerk's (the LV stage's key), a transformer part the bay's. A write over a
// whole machine or bay acts on the lines the account's keys cover and leaves
// the other line's work where it is.

export interface MachineActionResult {
  ok: boolean;
  error?: string;
  /** What the ⚡ optimizer did, in one line for the planner. */
  summary?: string;
  /** Lines it could not get in on time, worst first — a warning, not a failure. */
  lateNote?: string;
}

const BOARD_DEPTS = ["Cut", "Welding", "Painting", "ShotBlast"] as const;
type BoardDept = (typeof BOARD_DEPTS)[number];

function revalidate() {
  for (const p of ["/worklist/cut", "/worklist/welding", "/worklist/painting"]) revalidatePath(p);
}

/** A bay's machine rows the account may plan, and the other line's it may
 *  not, as `where` fragments — a row's line is its item, as in the ledger —
 *  with the words the summaries name them by. Holding both lines' keys,
 *  every row is its own and the summaries read as they always did. */
function rowsOf(access: BayAccess) {
  if (access.tr && access.lv) return { mine: {}, theirs: null, kind: "", other: "" };
  return access.lv
    ? { mine: ledgerItemWhere("LV"), theirs: ledgerItemWhere("TR"), kind: "panel", other: "transformer" }
    : { mine: ledgerItemWhere("TR"), theirs: ledgerItemWhere("LV"), kind: "transformer", other: "panel" };
}

/** "line", or "panel line" / "transformer line" when only one line is planned. */
const lineWord = (kind: string) => (kind ? `${kind} line` : "line");

function readLine(fd: FormData): { dept: BoardDept; bom: string; mo: string; item: string; sheet: string } | { error: string } {
  const dept = String(fd.get("dept") ?? "");
  if (!(BOARD_DEPTS as readonly string[]).includes(dept)) return { error: "This worklist has no machines." };
  const bom = String(fd.get("bom") ?? "").trim();
  const mo = String(fd.get("mo") ?? "").trim();
  const item = String(fd.get("item") ?? "").trim().toUpperCase();
  if (!bom || !item) return { error: "The line is incomplete — reload the page." };
  // the sheet of the item a machine cuts, when the item is spread by sheet
  const sheet = String(fd.get("sheet") ?? "").trim().slice(0, 120);
  return { dept: dept as BoardDept, bom, mo, item, sheet };
}

/** Renumber a machine's queue 1..n in its current order — running lines
 *  first, then the waiting ones. */
async function renumber(dept: string, machineId: number) {
  const rows = await prisma.worklistMachine.findMany({ where: { dept, machineId }, orderBy: [{ running: "desc" }, { rank: "asc" }, { updatedAt: "asc" }] });
  await Promise.all(rows.map((r, i) => (r.rank === i + 1 ? null : prisma.worklistMachine.update({ where: { id: r.id }, data: { rank: i + 1 } }))));
}

/** The row of a line on one machine — the machine comes with the request
 *  now that a line can sit on several. */
function rowKey(line: { dept: BoardDept; bom: string; mo: string; item: string; sheet: string }, machineId: number) {
  return { dept_bom_mo_item_machineId_sheet: { dept: line.dept, bom: line.bom, mo: line.mo, item: line.item, machineId, sheet: line.sheet } };
}

/** The share a machine is given: whole pieces — or, of a sheet job, its
 *  sheets, part of a sheet too (2.5). Blank = the rest of the line. */
function readQty(fd: FormData, line: { dept: string; bom: string }): number | null | { error: string } {
  const raw = String(fd.get("qty") ?? "").trim();
  if (!raw) return null;
  if (isSheetJobLine(line.dept, line.bom)) {
    const n = typedCount(raw);
    return isSheetCount(n) ? n : { error: `Sheets must be ${SHEET_COUNT_RULE} — leave it blank for the whole job.` };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return { error: "Pieces must be a whole number above 0 — leave it blank for the whole line." };
  return n;
}

/** Put the line on a machine, at the back of its queue. With a quantity the
 *  line is SPLIT: those pieces go to this machine and the rest stays where it
 *  is (or waits unassigned); without one this machine takes the rest of the
 *  line — the whole of it when nothing is split off — and the machine that
 *  held the rest before loses it. An empty machine takes the line off the
 *  board, every share of it. */
export async function assignLineMachine(fd: FormData): Promise<MachineActionResult> {
  const line = readLine(fd);
  if ("error" in line) return { ok: false, error: line.error };
  const guard = await requireMachineLineEdit(line.dept, line.item);
  if (guard.error) return { ok: false, error: guard.error };
  const raw = String(fd.get("machineId") ?? "").trim();
  // the fabrication machines carry sheet jobs (and the panels' punching) —
  // a transformer plan line goes on them inside a job, never on its own
  if (raw && !boardTakesLine(line.dept, line.bom, line.item)) return { ok: false, error: BOARD_LINE_REFUSED };
  // a job goes on its own board's machines while it is open
  if (raw && line.bom === MANUAL_BOM) {
    const id = manualIdOf(line.mo);
    const job = id === null ? null : await prisma.manualJob.findUnique({ where: { id }, select: { dept: true, doneAt: true } });
    if (!job || job.dept !== line.dept) return { ok: false, error: "That job is gone — reload the page." };
    if (job.doneAt) return { ok: false, error: "That job is finished — open it again from the jobs list first." };
  }
  const qty = readQty(fd, line);
  if (qty !== null && typeof qty === "object") return { ok: false, error: qty.error };
  const key = { dept: line.dept, bom: line.bom, mo: line.mo, item: line.item };
  const existing = await prisma.worklistMachine.findMany({ where: key });

  if (!raw) {
    if (existing.length > 0) {
      await prisma.worklistMachine.deleteMany({ where: key });
      for (const m of new Set(existing.map((e) => e.machineId))) await renumber(line.dept, m);
    }
    revalidate();
    return { ok: true };
  }
  const machineId = Number(raw);
  if (!Number.isInteger(machineId)) return { ok: false, error: "Invalid machine." };
  const machine = await prisma.machine.findUnique({ where: { id: machineId } });
  if (!machine || machine.dept !== line.dept) return { ok: false, error: "That machine is not in this department." };
  if (!machine.active) return { ok: false, error: `${machine.code} is retired — bring it back in Tools → Machines first.` };

  // a sheet of the item is its own share: the same machine may hold the
  // whole item or one sheet of it, and other machines other sheets
  const here = existing.find((e) => e.machineId === machineId && e.sheet === line.sheet);
  // a line has ONE "rest" row (no quantity) at most: giving this machine the
  // rest takes it off the machine that had it, while the machines holding a
  // fixed share keep it — so a whole line moves with the picker, and the
  // leftover of a split line lands on the machine picked for it
  const displaced = qty === null ? existing.filter((e) => e.sheet === line.sheet && e.machineId !== machineId && e.qty === null) : [];
  const by = guard.user?.name ?? null;
  const dropDisplaced = async () => {
    if (displaced.length === 0) return;
    await prisma.worklistMachine.deleteMany({ where: { id: { in: displaced.map((e) => e.id) } } });
    for (const m of new Set(displaced.map((e) => e.machineId))) await renumber(line.dept, m);
  };

  if (here) {
    // already on this machine: a quantity resizes its share, none gives it the rest
    await prisma.worklistMachine.update({ where: { id: here.id }, data: { qty, setBy: by } });
    await dropDisplaced();
    revalidate();
    return { ok: true };
  }

  const [last, runningNow] = await Promise.all([
    prisma.worklistMachine.aggregate({ where: { dept: line.dept, machineId }, _max: { rank: true } }),
    prisma.worklistMachine.count({ where: { dept: line.dept, machineId, running: true } }),
  ]);
  const rank = (last._max.rank ?? 0) + 1;
  // an idle machine starts on the line it is given; a busy one queues it
  const running = runningNow === 0;
  await prisma.worklistMachine.create({ data: { ...key, sheet: line.sheet, machineId, rank, running, qty, setBy: by } });
  await dropDisplaced();
  revalidate();
  return { ok: true };
}

/** Resize a line's share on one machine ("keep 12 of the 20 here" — the rest
 *  waits unassigned for another machine); blank = the whole rest. */
export async function setLineQty(fd: FormData): Promise<MachineActionResult> {
  const line = readLine(fd);
  if ("error" in line) return { ok: false, error: line.error };
  const guard = await requireMachineLineEdit(line.dept, line.item);
  if (guard.error) return { ok: false, error: guard.error };
  const machineId = Number(fd.get("machineId"));
  if (!Number.isInteger(machineId)) return { ok: false, error: "Invalid machine." };
  const qty = readQty(fd, line);
  if (qty !== null && typeof qty === "object") return { ok: false, error: qty.error };
  const row = await prisma.worklistMachine.findUnique({ where: rowKey(line, machineId) });
  if (!row) return { ok: false, error: "That line is not on this machine any more — reload the page." };
  await prisma.worklistMachine.update({ where: { id: row.id }, data: { qty, setBy: guard.user?.name ?? null } });
  revalidate();
  return { ok: true };
}

/** Take one machine's share of a line off it (the other machines keep theirs). */
export async function unassignLineMachine(fd: FormData): Promise<MachineActionResult> {
  const line = readLine(fd);
  if ("error" in line) return { ok: false, error: line.error };
  const guard = await requireMachineLineEdit(line.dept, line.item);
  if (guard.error) return { ok: false, error: guard.error };
  const machineId = Number(fd.get("machineId"));
  if (!Number.isInteger(machineId)) return { ok: false, error: "Invalid machine." };
  const row = await prisma.worklistMachine.findUnique({ where: rowKey(line, machineId) });
  if (row) {
    await prisma.worklistMachine.delete({ where: { id: row.id } });
    await renumber(line.dept, machineId);
  }
  revalidate();
  return { ok: true };
}

/** Move the line one step up / down its machine's queue, or straight to the
 *  front ("run this next"). */
export async function moveLineRank(fd: FormData): Promise<MachineActionResult> {
  const line = readLine(fd);
  if ("error" in line) return { ok: false, error: line.error };
  const guard = await requireMachineLineEdit(line.dept, line.item);
  if (guard.error) return { ok: false, error: guard.error };
  const dir = String(fd.get("dir") ?? "");
  if (!["up", "down", "top"].includes(dir)) return { ok: false, error: "Invalid move." };
  const machineId = Number(fd.get("machineId"));
  if (!Number.isInteger(machineId)) return { ok: false, error: "Invalid machine." };

  const row = await prisma.worklistMachine.findUnique({ where: rowKey(line, machineId) });
  if (!row) return { ok: false, error: "That line is not on this machine any more — reload the page." };
  // moves happen within the line's own group: the running lines keep the
  // front, the waiting ones are reordered among themselves — on a shared
  // machine, among the rows this account may schedule: the other line's rows
  // keep their places, and the line moves through the slots that are its own
  const queue = await prisma.worklistMachine.findMany({ where: { dept: line.dept, machineId: row.machineId, running: row.running }, orderBy: [{ rank: "asc" }, { updatedAt: "asc" }] });
  const access = bayAccess(guard.user ?? null, line.dept);
  const slots = queue.flatMap((q, n) => (mayScheduleLine(access, q.item) ? [n] : []));
  const own = slots.map((n) => queue[n].id);
  const i = own.indexOf(row.id);
  if (dir === "top") {
    own.splice(i, 1);
    own.unshift(row.id);
  } else {
    const j = dir === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= own.length) return { ok: true };
    [own[i], own[j]] = [own[j], own[i]];
  }
  const order = queue.map((q) => q.id);
  slots.forEach((n, k) => { order[n] = own[k]; });
  const base = row.running ? 0 : await prisma.worklistMachine.count({ where: { dept: line.dept, machineId: row.machineId, running: true } });
  await prisma.$transaction(order.map((id, n) => prisma.worklistMachine.update({ where: { id }, data: { rank: base + n + 1 } })));
  revalidate();
  return { ok: true };
}

/** Start a waiting line on its machine now (alongside whatever already runs
 *  there), or put a running line back to waiting. */
export async function setLineRunning(fd: FormData): Promise<MachineActionResult> {
  const line = readLine(fd);
  if ("error" in line) return { ok: false, error: line.error };
  const guard = await requireMachineLineEdit(line.dept, line.item);
  if (guard.error) return { ok: false, error: guard.error };
  const running = String(fd.get("running") ?? "") === "true";
  const machineId = Number(fd.get("machineId"));
  if (!Number.isInteger(machineId)) return { ok: false, error: "Invalid machine." };
  const row = await prisma.worklistMachine.findUnique({ where: rowKey(line, machineId) });
  if (!row) return { ok: false, error: "That line is not on this machine any more — reload the page." };
  if (row.running === running) return { ok: true };
  // a line put back to waiting goes to the front of the waiting ones; a line
  // started goes behind the lines already running
  await prisma.worklistMachine.update({ where: { id: row.id }, data: { running, rank: running ? 9999 : 0, setBy: guard.user?.name ?? null } });
  await renumber(line.dept, row.machineId);
  revalidate();
  return { ok: true };
}

/** Take every line off one machine — every line the account's keys cover:
 *  the other line's work on a shared machine stays. */
export async function clearMachineQueue(fd: FormData): Promise<MachineActionResult> {
  const dept = String(fd.get("dept") ?? "");
  if (!(BOARD_DEPTS as readonly string[]).includes(dept)) return { ok: false, error: "This worklist has no machines." };
  const guard = await requireBayAccess(dept);
  if (!guard.access) return { ok: false, error: guard.error };
  const machineId = Number(fd.get("machineId"));
  if (!Number.isInteger(machineId)) return { ok: false, error: "Invalid machine." };
  await prisma.worklistMachine.deleteMany({ where: { dept, machineId, ...rowsOf(guard.access).mine } });
  revalidate();
  return { ok: true };
}

/** ⚡ Plan every machine of the department from the weekly plan: what runs
 *  first, then next, on each one. Lines go in the order they are DUE, each to
 *  the machine that finishes it soonest, split over machines of the same
 *  centre when parallel work clears the batch sooner, and along the routing
 *  (cut, then bend, then fins). What is RUNNING now is never moved — the plan
 *  is built around it. */
export async function optimizeMachines(fd: FormData): Promise<MachineActionResult> {
  const dept = String(fd.get("dept") ?? "");
  if (!(BOARD_DEPTS as readonly string[]).includes(dept)) return { ok: false, error: "This worklist has no machines." };
  const guard = await requireBayAccess(dept);
  if (!guard.access) return { ok: false, error: guard.error };
  const access = guard.access;
  const rows = rowsOf(access);
  const word = machineWord(dept);
  const dayISO = factoryDayISO(new Date());
  const { machines, lines, pins } = await getOptimizerInputs(dept as BoardDept, dayISO, (item) => mayScheduleLine(access, item));
  if (machines.every((m) => m.availableH <= 0)) {
    return { ok: false, error: `No ${word} has its hours a day set — put them in Tools → Machines first, then plan.` };
  }
  const plan = optimizePlan(machines, lines, pins);
  if (plan.placements.length === 0) {
    return { ok: true, summary: `Nothing to plan — every open ${lineWord(rows.kind)} is already running on a ${word}.` };
  }

  // how many pieces of a step the plan gives out, so a share that covers the
  // whole step is stored as "the rest" and follows the line as output lands
  const perStep = new Map<string, number>();
  for (const p of plan.placements) perStep.set(`${p.key}#${p.center}`, (perStep.get(`${p.key}#${p.center}`) ?? 0) + 1);
  const stepPieces = new Map<string, number>();
  for (const l of lines) for (const r of l.route) stepPieces.set(`${l.key}#${r.center}`, r.pieces ?? l.pieces);
  const pinnedStep = new Set(pins.map((p) => `${p.key}#${p.center}`));
  const by = guard.user?.name ?? null;

  const keptTheirs = await prisma.$transaction(async (tx) => {
    // the running work stays exactly where it is; everything else is re-planned
    // a job typed in from outside the plan stays on the machine it was put on
    // and so does a sheet of an item the planner put on a machine by hand —
    // and so does the other line's waiting work, which only its own keys plan
    await tx.worklistMachine.deleteMany({ where: { dept, running: false, sheet: "", NOT: [{ bom: MANUAL_BOM, item: MANUAL_ITEM }], ...rows.mine } });
    const running = await tx.worklistMachine.findMany({ where: { dept, running: true } });
    // only a whole-item row takes extra pieces — a sheet's row is that sheet alone
    const held = new Map(running.filter((r) => r.sheet === "").map((r) => [`${r.bom}|${r.mo}|${r.item}#${r.machineId}`, r]));
    const base = new Map<number, number>();
    for (const r of running) base.set(r.machineId, (base.get(r.machineId) ?? 0) + 1);
    // the plan queues behind the other line's waiting work, as behind what runs
    const theirs = rows.theirs ? await tx.worklistMachine.findMany({ where: { dept, running: false, ...rows.theirs }, select: { machineId: true, rank: true } }) : [];
    for (const r of theirs) base.set(r.machineId, Math.max(base.get(r.machineId) ?? 0, r.rank));

    for (const p of plan.placements) {
      const [bom, mo, item] = p.key.split("|");
      const stepKey = `${p.key}#${p.center}`;
      const whole = perStep.get(stepKey) === 1 && !pinnedStep.has(stepKey) && p.pieces >= (stepPieces.get(stepKey) ?? p.pieces);
      const already = held.get(`${p.key}#${p.machineId}`);
      if (already) {
        // the plan puts more of the same line on the machine that runs it —
        // its running row takes the extra pieces rather than a second row
        if (already.qty !== null) await tx.worklistMachine.update({ where: { id: already.id }, data: { qty: already.qty + p.pieces } });
        continue;
      }
      await tx.worklistMachine.create({
        data: { dept, bom, mo, item, machineId: p.machineId, rank: (base.get(p.machineId) ?? 0) + p.rank, running: false, qty: whole ? null : p.pieces, setBy: by },
      });
    }
    return theirs.length > 0;
  });
  revalidate();

  const bits = [`${plan.linesPlaced} ${lineWord(rows.kind)}(s) over ${plan.machinesUsed} ${machineWord(dept, plan.machinesUsed !== 1)}`];
  if (plan.spanDays > 0) bits.push(`clears in ${plan.spanDays} day(s)`);
  if (plan.unpriced > 0) bits.push(`${plan.unpriced} with no standard time, queued last`);
  const centresShort = [...new Set(plan.skipped.filter((x) => x.reason === "no machine").map((x) => x.center))];
  if (centresShort.length > 0) bits.push(`no ${word} for ${centresShort.map((c) => CENTER_LABEL[c] ?? c).join(", ")}`);
  const ruledOut = new Set(plan.skipped.filter((x) => x.reason === "not allowed").map((x) => x.key));
  if (ruledOut.size > 0) bits.push(`${ruledOut.size} line(s) no ${word}'s rules allow — left to place by hand`);
  const late = plan.late.length > 0
    ? `${plan.late.length} line(s) cannot make their date — worst by ${plan.late[0].byDays} day(s). Add hours, or move the date.`
    : undefined;
  const kept = keptTheirs ? ` The ${rows.other} lines kept their places — these queue behind them.` : "";
  return { ok: true, summary: `Planned: ${bits.join(" · ")}.${kept}`, lateNote: late };
}

/** ⟲ Reset: take every line off every machine of the department — the board
 *  goes back to empty and nothing is running. The work itself is untouched;
 *  only the plan of what runs where is cleared, ready to be planned again.
 *  Every line the account's keys cover, that is: the other line's stay. */
export async function resetMachinePlan(fd: FormData): Promise<MachineActionResult> {
  const dept = String(fd.get("dept") ?? "");
  if (!(BOARD_DEPTS as readonly string[]).includes(dept)) return { ok: false, error: "This worklist has no machines." };
  const guard = await requireBayAccess(dept);
  if (!guard.access) return { ok: false, error: guard.error };
  const rows = rowsOf(guard.access);
  const { count } = await prisma.worklistMachine.deleteMany({ where: { dept, ...rows.mine } });
  const kept = rows.theirs ? await prisma.worklistMachine.count({ where: { dept, ...rows.theirs } }) : 0;
  revalidate();
  const cleared = count > 0
    ? `Cleared — ${count} ${lineWord(rows.kind)}(s) taken off the ${machineWord(dept, true)}.`
    : rows.kind ? `No ${rows.kind} line was on a ${machineWord(dept)}.` : `Nothing was on a ${machineWord(dept)}.`;
  return { ok: true, summary: kept > 0 ? `${cleared} The ${rows.other} lines stay where they are.` : cleared };
}

const MAX_RESTORE_ROWS = 3000;

/** The snapshot's rows, checked one by one, or what is wrong with them. */
function readSnapshotRows(raw: unknown, dept: string, machineIds: ReadonlySet<number>): QueueRowSnapshot[] | { error: string } {
  if (!Array.isArray(raw)) return { error: "The snapshot is not a list of rows." };
  if (raw.length > MAX_RESTORE_ROWS) return { error: `A snapshot holds at most ${MAX_RESTORE_ROWS} rows.` };
  const out: QueueRowSnapshot[] = [];
  const seen = new Set<string>();
  for (const r of raw as Record<string, unknown>[]) {
    const s = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : null);
    const bom = s(r?.bom, 80);
    const mo = s(r?.mo, 80);
    const item = s(r?.item, 20);
    const sheet = s(r?.sheet, 120);
    const machineId = Number(r?.machineId);
    const rank = Number(r?.rank);
    const sheetDone = Number(r?.sheetDone);
    const qty = r?.qty === null ? null : Number(r?.qty);
    if (bom === null || mo === null || item === null || sheet === null || !bom || !item) return { error: "A row of the snapshot is incomplete." };
    if (!machineIds.has(machineId)) return { error: "A row of the snapshot is on a machine of another department, or one that is gone." };
    if (!Number.isInteger(rank) || rank < 0 || !Number.isInteger(sheetDone) || sheetDone < 0) return { error: "A row of the snapshot has a bad rank or count." };
    // whole pieces — a sheet job's share may be part of a sheet (2.5)
    if (qty !== null && !(isSheetJobLine(dept, bom) ? isSheetCount(qty) : Number.isInteger(qty) && qty > 0)) return { error: "A row of the snapshot has a bad quantity." };
    if (typeof r?.running !== "boolean") return { error: "A row of the snapshot has no running state." };
    const k = `${bom}|${mo}|${item}|${machineId}|${sheet}`;
    if (seen.has(k)) return { error: "The snapshot holds the same row twice." };
    seen.add(k);
    out.push({ bom, mo, item, machineId, rank, running: r.running, qty, sheet, sheetDone });
  }
  return out;
}

/** Put a department's machine queues back exactly as a snapshot of them —
 *  how a board-wide change made through the assistant (⚡ Plan, ⟲ Reset,
 *  Empty, a move) is undone. Like every write over the bay, it acts on the
 *  lines the account may schedule there and leaves the other line's work
 *  where it is. */
export async function restoreMachineQueues(fd: FormData): Promise<MachineActionResult> {
  const dept = String(fd.get("dept") ?? "");
  if (!(BOARD_DEPTS as readonly string[]).includes(dept)) return { ok: false, error: "This worklist has no machines." };
  const guard = await requireBayAccess(dept);
  if (!guard.access) return { ok: false, error: guard.error };
  const access = guard.access;
  let raw: unknown;
  try {
    raw = JSON.parse(String(fd.get("rows") ?? ""));
  } catch {
    return { ok: false, error: "The snapshot cannot be read." };
  }
  const machines = await prisma.machine.findMany({ where: { dept }, select: { id: true } });
  const rows = readSnapshotRows(raw, dept, new Set(machines.map((m) => m.id)));
  if ("error" in rows) return { ok: false, error: rows.error };
  // a row the board no longer takes (a transformer plan line on the
  // fabrication machines, from before they carried sheet jobs) stays off
  const back = rows.filter((r) => mayScheduleLine(access, r.item) && boardTakesLine(dept, r.bom, r.item));
  const by = guard.user?.name ?? null;
  await prisma.$transaction([
    prisma.worklistMachine.deleteMany({ where: { dept, ...rowsOf(access).mine } }),
    prisma.worklistMachine.createMany({ data: back.map((r) => ({ dept, ...r, setBy: by })) }),
  ]);
  revalidate();
  return { ok: true, summary: `The ${machineWord(dept, true)}' queues are back as they were (${back.length} line${back.length === 1 ? "" : "s"}).` };
}
