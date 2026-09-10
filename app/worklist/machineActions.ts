"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireDeptEdit } from "@/lib/server/auth";

// The machine board's writes: put a worklist line on a machine (or take it
// off), move it up or down that machine's queue, empty a machine. The
// dept's worklist permission covers them — deciding what runs where is the
// same job as recording what ran.

export interface MachineActionResult {
  ok: boolean;
  error?: string;
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

/** Put the line on a machine (at the back of its queue) — or, with an empty
 *  machine, take it off the board. Moving between machines keeps nothing of
 *  the old place. */
export async function assignLineMachine(fd: FormData): Promise<MachineActionResult> {
  const line = readLine(fd);
  if ("error" in line) return { ok: false, error: line.error };
  const guard = await requireDeptEdit(line.dept);
  if (guard.error) return { ok: false, error: guard.error };
  const raw = String(fd.get("machineId") ?? "").trim();
  const key = { dept: line.dept, bom: line.bom, mo: line.mo, item: line.item };
  const prev = await prisma.worklistMachine.findUnique({ where: { dept_bom_mo_item: key } });

  if (!raw) {
    if (prev) {
      await prisma.worklistMachine.delete({ where: { id: prev.id } });
      await renumber(line.dept, prev.machineId);
    }
    revalidate();
    return { ok: true };
  }
  const machineId = Number(raw);
  if (!Number.isInteger(machineId)) return { ok: false, error: "Invalid machine." };
  const machine = await prisma.machine.findUnique({ where: { id: machineId } });
  if (!machine || machine.dept !== line.dept) return { ok: false, error: "That machine is not in this department." };
  if (!machine.active) return { ok: false, error: `${machine.code} is retired — bring it back in Tools → Machines first.` };
  if (prev?.machineId === machineId) return { ok: true };

  const [last, runningNow] = await Promise.all([
    prisma.worklistMachine.aggregate({ where: { dept: line.dept, machineId }, _max: { rank: true } }),
    prisma.worklistMachine.count({ where: { dept: line.dept, machineId, running: true } }),
  ]);
  const rank = (last._max.rank ?? 0) + 1;
  const by = guard.user?.name ?? null;
  // an idle machine starts on the line it is given; a busy one queues it
  const running = runningNow === 0;
  await prisma.worklistMachine.upsert({
    where: { dept_bom_mo_item: key },
    create: { ...key, machineId, rank, running, setBy: by },
    update: { machineId, rank, running, setBy: by },
  });
  if (prev) await renumber(line.dept, prev.machineId);
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

  const row = await prisma.worklistMachine.findUnique({ where: { dept_bom_mo_item: { dept: line.dept, bom: line.bom, mo: line.mo, item: line.item } } });
  if (!row) return { ok: false, error: "That line is not on a machine any more — reload the page." };
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
  const row = await prisma.worklistMachine.findUnique({ where: { dept_bom_mo_item: { dept: line.dept, bom: line.bom, mo: line.mo, item: line.item } } });
  if (!row) return { ok: false, error: "That line is not on a machine any more — reload the page." };
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
