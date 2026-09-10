"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireDeptEdit } from "@/lib/server/auth";
import { getOptimizerInputs } from "@/lib/server/machineBoard";
import { optimizePlan } from "@/lib/domain/optimizePlan";
import { factoryDayISO } from "@/lib/domain/dates";
import { CENTER_LABEL, machineWord } from "@/lib/domain/shifts";

// The machine board's writes: put a worklist line on a machine (or take it
// off), move it up or down that machine's queue, empty a machine. The
// dept's worklist permission covers them — deciding what runs where is the
// same job as recording what ran.

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
  for (const p of ["/worklist/cut", "/worklist/welding", "/worklist/painting", "/simulate"]) revalidatePath(p);
}

function readLine(fd: FormData): { dept: BoardDept; bom: string; mo: string; item: string } | { error: string } {
  const dept = String(fd.get("dept") ?? "");
  if (!(BOARD_DEPTS as readonly string[]).includes(dept)) return { error: "This worklist has no machines." };
  const bom = String(fd.get("bom") ?? "").trim();
  const mo = String(fd.get("mo") ?? "").trim();
  const item = String(fd.get("item") ?? "").trim().toUpperCase();
  if (!bom || !item) return { error: "The line is incomplete — reload the page." };
  return { dept: dept as BoardDept, bom, mo, item };
}

/** Renumber a machine's queue 1..n in its current order — running lines
 *  first, then the waiting ones. */
async function renumber(dept: string, machineId: number) {
  const rows = await prisma.worklistMachine.findMany({ where: { dept, machineId }, orderBy: [{ running: "desc" }, { rank: "asc" }, { updatedAt: "asc" }] });
  await Promise.all(rows.map((r, i) => (r.rank === i + 1 ? null : prisma.worklistMachine.update({ where: { id: r.id }, data: { rank: i + 1 } }))));
}

/** The row of a line on one machine — the machine comes with the request
 *  now that a line can sit on several. */
function rowKey(line: { dept: BoardDept; bom: string; mo: string; item: string }, machineId: number) {
  return { dept_bom_mo_item_machineId: { dept: line.dept, bom: line.bom, mo: line.mo, item: line.item, machineId } };
}

function readQty(fd: FormData): number | null | { error: string } {
  const raw = String(fd.get("qty") ?? "").trim();
  if (!raw) return null;
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
  const guard = await requireDeptEdit(line.dept);
  if (guard.error) return { ok: false, error: guard.error };
  const raw = String(fd.get("machineId") ?? "").trim();
  const qty = readQty(fd);
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

  const here = existing.find((e) => e.machineId === machineId);
  // a line has ONE "rest" row (no quantity) at most: giving this machine the
  // rest takes it off the machine that had it, while the machines holding a
  // fixed share keep it — so a whole line moves with the picker, and the
  // leftover of a split line lands on the machine picked for it
  const displaced = qty === null ? existing.filter((e) => e.machineId !== machineId && e.qty === null) : [];
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
  await prisma.worklistMachine.create({ data: { ...key, machineId, rank, running, qty, setBy: by } });
  await dropDisplaced();
  revalidate();
  return { ok: true };
}

/** Resize a line's share on one machine ("keep 12 of the 20 here" — the rest
 *  waits unassigned for another machine); blank = the whole rest. */
export async function setLineQty(fd: FormData): Promise<MachineActionResult> {
  const line = readLine(fd);
  if ("error" in line) return { ok: false, error: line.error };
  const guard = await requireDeptEdit(line.dept);
  if (guard.error) return { ok: false, error: guard.error };
  const machineId = Number(fd.get("machineId"));
  if (!Number.isInteger(machineId)) return { ok: false, error: "Invalid machine." };
  const qty = readQty(fd);
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
  const guard = await requireDeptEdit(line.dept);
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
  const guard = await requireDeptEdit(line.dept);
  if (guard.error) return { ok: false, error: guard.error };
  const dir = String(fd.get("dir") ?? "");
  if (!["up", "down", "top"].includes(dir)) return { ok: false, error: "Invalid move." };
  const machineId = Number(fd.get("machineId"));
  if (!Number.isInteger(machineId)) return { ok: false, error: "Invalid machine." };

  const row = await prisma.worklistMachine.findUnique({ where: rowKey(line, machineId) });
  if (!row) return { ok: false, error: "That line is not on this machine any more — reload the page." };
  // moves happen within the line's own group: the running lines keep the
  // front, the waiting ones are reordered among themselves
  const queue = await prisma.worklistMachine.findMany({ where: { dept: line.dept, machineId: row.machineId, running: row.running }, orderBy: [{ rank: "asc" }, { updatedAt: "asc" }] });
  const i = queue.findIndex((q) => q.id === row.id);
  const order = queue.map((q) => q.id);
  if (dir === "top") {
    order.splice(i, 1);
    order.unshift(row.id);
  } else {
    const j = dir === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= order.length) return { ok: true };
    [order[i], order[j]] = [order[j], order[i]];
  }
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
  const guard = await requireDeptEdit(line.dept);
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

/** Take every line off one machine. */
export async function clearMachineQueue(fd: FormData): Promise<MachineActionResult> {
  const dept = String(fd.get("dept") ?? "");
  if (!(BOARD_DEPTS as readonly string[]).includes(dept)) return { ok: false, error: "This worklist has no machines." };
  const guard = await requireDeptEdit(dept);
  if (guard.error) return { ok: false, error: guard.error };
  const machineId = Number(fd.get("machineId"));
  if (!Number.isInteger(machineId)) return { ok: false, error: "Invalid machine." };
  await prisma.worklistMachine.deleteMany({ where: { dept, machineId } });
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
  const guard = await requireDeptEdit(dept);
  if (guard.error) return { ok: false, error: guard.error };
  const word = machineWord(dept);
  const dayISO = factoryDayISO(new Date());
  const { machines, lines, pins } = await getOptimizerInputs(dept as BoardDept, dayISO);
  if (machines.every((m) => m.availableH <= 0)) {
    return { ok: false, error: `No ${word} has its hours a day set — put them in Tools → Machines first, then plan.` };
  }
  const plan = optimizePlan(machines, lines, pins);
  if (plan.placements.length === 0) {
    return { ok: true, summary: `Nothing to plan — every open line is already running on a ${word}.` };
  }

  // how many pieces of a step the plan gives out, so a share that covers the
  // whole step is stored as "the rest" and follows the line as output lands
  const perStep = new Map<string, number>();
  for (const p of plan.placements) perStep.set(`${p.key}#${p.center}`, (perStep.get(`${p.key}#${p.center}`) ?? 0) + 1);
  const stepPieces = new Map<string, number>();
  for (const l of lines) for (const r of l.route) stepPieces.set(`${l.key}#${r.center}`, r.pieces ?? l.pieces);
  const pinnedStep = new Set(pins.map((p) => `${p.key}#${p.center}`));
  const by = guard.user?.name ?? null;

  await prisma.$transaction(async (tx) => {
    // the running work stays exactly where it is; everything else is re-planned
    await tx.worklistMachine.deleteMany({ where: { dept, running: false } });
    const running = await tx.worklistMachine.findMany({ where: { dept, running: true } });
    const held = new Map(running.map((r) => [`${r.bom}|${r.mo}|${r.item}#${r.machineId}`, r]));
    const base = new Map<number, number>();
    for (const r of running) base.set(r.machineId, (base.get(r.machineId) ?? 0) + 1);

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
  });
  revalidate();

  const bits = [`${plan.linesPlaced} line(s) over ${plan.machinesUsed} ${machineWord(dept, plan.machinesUsed !== 1)}`];
  if (plan.spanDays > 0) bits.push(`clears in ${plan.spanDays} day(s)`);
  if (plan.unpriced > 0) bits.push(`${plan.unpriced} with no standard time, queued last`);
  const centresShort = [...new Set(plan.skipped.map((x) => x.center))];
  if (centresShort.length > 0) bits.push(`no ${word} for ${centresShort.map((c) => CENTER_LABEL[c] ?? c).join(", ")}`);
  const late = plan.late.length > 0
    ? `${plan.late.length} line(s) cannot make their date — worst by ${plan.late[0].byDays} day(s). Add hours, or move the date.`
    : undefined;
  return { ok: true, summary: `Planned: ${bits.join(" · ")}.`, lateNote: late };
}

/** ⟲ Reset: take every line off every machine of the department — the board
 *  goes back to empty and nothing is running. The work itself is untouched;
 *  only the plan of what runs where is cleared, ready to be planned again. */
export async function resetMachinePlan(fd: FormData): Promise<MachineActionResult> {
  const dept = String(fd.get("dept") ?? "");
  if (!(BOARD_DEPTS as readonly string[]).includes(dept)) return { ok: false, error: "This worklist has no machines." };
  const guard = await requireDeptEdit(dept);
  if (guard.error) return { ok: false, error: guard.error };
  const { count } = await prisma.worklistMachine.deleteMany({ where: { dept } });
  revalidate();
  return { ok: true, summary: count === 0 ? `Nothing was on a ${machineWord(dept)}.` : `Cleared — ${count} line(s) taken off the ${machineWord(dept, true)}.` };
}
