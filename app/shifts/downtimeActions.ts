"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { shiftPermKey } from "@/lib/domain/permissions";
import { parseISODate } from "@/lib/domain/dates";
import { isRosterDept } from "@/lib/domain/shifts";
import { MAX_STOP_HOURS, downtimeLabel, isDowntimeCode, stopHours } from "@/lib/domain/downtime";
import { factoryDayISO } from "@/lib/domain/dates";
import { Prisma } from "@prisma/client";
import { emitEvent } from "@/lib/server/events";

// A machine's stop, recorded on the shift log by the department's supervisor:
// the machine, the hours it stood and why. Recording needs the department's
// own shift-log permission, as the day's attendance does.

export interface DowntimeActionResult {
  ok: boolean;
  error?: string;
  id?: number;
  /** The hours as kept — to the quarter hour. */
  hours?: number;
}

// every page that reads a machine's stops: the board's hours left, the
// cockpit's losses, the simulator's capacity
const PATHS = ["/shifts", "/", "/worklist/cut", "/worklist/welding", "/worklist/painting", "/worklist/machines", "/simulate"];
const revalidate = () => { for (const p of PATHS) revalidatePath(p); };


async function machineGuard(machineId: number) {
  const machine = await prisma.machine.findUnique({ where: { id: machineId } });
  if (!machine) return { error: "That machine is not on the list — reload the page." } as const;
  if (!isRosterDept(machine.dept)) return { error: `${machine.code} belongs to no department the shift log records.` } as const;
  const guard = await requirePerm(shiftPermKey(machine.dept));
  if (guard.error) return { error: guard.error } as const;
  return { machine, by: guard.user?.name ?? null } as const;
}

export async function addDowntime(fd: FormData): Promise<DowntimeActionResult> {
  const dateISO = String(fd.get("date") ?? "");
  const date = parseISODate(dateISO);
  if (!date) return { ok: false, error: "Pick a day." };
  // the factory's own day (Cairo), not the server's clock
  if (dateISO > factoryDayISO(new Date())) return { ok: false, error: "That day has not come yet." };
  const machineId = Number(fd.get("machineId"));
  if (!Number.isInteger(machineId)) return { ok: false, error: "Pick the machine that stopped." };
  const hours = stopHours(Number(String(fd.get("hours") ?? "").trim()));
  if (!Number.isFinite(hours) || hours <= 0) return { ok: false, error: "Give the hours it stood — a quarter of an hour at least." };
  if (hours > MAX_STOP_HOURS) return { ok: false, error: `A machine cannot stand more than ${MAX_STOP_HOURS} hours in a day.` };
  const reasonCode = String(fd.get("reasonCode") ?? "");
  if (!isDowntimeCode(reasonCode)) return { ok: false, error: "Pick why it stopped." };
  const reason = String(fd.get("reason") ?? "").trim().slice(0, 200) || null;

  const g = await machineGuard(machineId);
  if ("error" in g) return { ok: false, error: g.error };
  if (!g.machine.active) return { ok: false, error: `${g.machine.code} is retired — bring it back under Machines & lines first.` };

  // the day's total and the new stop in one serializable step, so two
  // supervisors adding at once cannot pass the day between them
  let r: { error: string } | { row: { id: number } };
  try {
    r = await prisma.$transaction(async (tx) => {
      const before = await tx.machineDowntime.aggregate({ where: { date, machineId }, _sum: { hours: true } });
      const total = (before._sum.hours ?? 0) + hours;
      if (total > MAX_STOP_HOURS) return { error: `${g.machine.code} already has ${before._sum.hours} h of stops that day — ${total} h would be more than the day.` };
      return { row: await tx.machineDowntime.create({ data: { date, machineId, hours, reasonCode, reason, recordedBy: g.by } }) };
    }, { isolationLevel: "Serializable" });
  } catch (e) {
    // another stop on the same machine was saved at the same moment
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034") return { ok: false, error: "Someone recorded a stop on this machine at the same moment — try again." };
    throw e;
  }
  if ("error" in r) return { ok: false, error: r.error };
  await emitEvent({
    type: "machine.stopped",
    subject: g.machine.code,
    summary: `${g.machine.code} (${g.machine.name}) stood ${hours} h on ${dateISO} — ${downtimeLabel(reasonCode)}${reason ? `: ${reason}` : ""}`,
    data: { machine: g.machine.code, dept: g.machine.dept, hours, reasonCode, date: dateISO },
  });
  revalidate();
  return { ok: true, id: r.row.id, hours };
}

export async function deleteDowntime(fd: FormData): Promise<DowntimeActionResult> {
  const id = Number(fd.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Pick the stop to delete." };
  const row = await prisma.machineDowntime.findUnique({ where: { id } });
  if (!row) return { ok: false, error: "That stop is already gone — reload the page." };
  const g = await machineGuard(row.machineId);
  if ("error" in g) return { ok: false, error: g.error };
  // a double click, or two people at once: the second finds it gone
  const { count } = await prisma.machineDowntime.deleteMany({ where: { id } });
  if (count === 0) return { ok: false, error: "That stop is already gone — reload the page." };
  revalidate();
  return { ok: true, id };
}

/** Correct a past stop in place; its machine and factory day stay attached to the original record. */
export async function updateDowntime(fd: FormData): Promise<DowntimeActionResult> {
  const id = Number(fd.get("id"));
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "Pick the stop to edit." };
  const row = await prisma.machineDowntime.findUnique({ where: { id } });
  if (!row) return { ok: false, error: "That stop is already gone — reload the page." };
  const g = await machineGuard(row.machineId);
  if ("error" in g) return { ok: false, error: g.error };
  if (row.date.toISOString().slice(0, 10) > factoryDayISO(new Date())) return { ok: false, error: "That day has not come yet." };
  let before: { hours?: unknown; reasonCode?: unknown; reason?: unknown };
  try { before = JSON.parse(String(fd.get("before") ?? "")); } catch { return { ok: false, error: "Reload this stop before editing it." }; }
  if (!before || before.hours !== row.hours || before.reasonCode !== row.reasonCode || before.reason !== row.reason) return { ok: false, error: "This stop changed since you opened it. Reload before saving." };
  const hours = stopHours(Number(String(fd.get("hours") ?? "").trim()));
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_STOP_HOURS) return { ok: false, error: `Give stopped hours between ${0.25} and ${MAX_STOP_HOURS}.` };
  const reasonCode = String(fd.get("reasonCode") ?? "");
  if (!isDowntimeCode(reasonCode)) return { ok: false, error: "Pick why it stopped." };
  const reason = String(fd.get("reason") ?? "").trim().slice(0, 200) || null;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const other = await tx.machineDowntime.aggregate({ where: { date: row.date, machineId: row.machineId, id: { not: id } }, _sum: { hours: true } });
      if ((other._sum.hours ?? 0) + hours > MAX_STOP_HOURS) return { ok: false, error: "The machine's total stopped hours would exceed the day." };
      const saved = await tx.machineDowntime.updateMany({ where: { id, date: row.date, machineId: row.machineId, hours: row.hours, reasonCode: row.reasonCode, reason: row.reason }, data: { hours, reasonCode, reason, recordedBy: g.by } });
      return saved.count ? { ok: true, id, hours } : { ok: false, error: "This stop changed or was deleted. Reload before saving." };
    }, { isolationLevel: "Serializable" });
    if (result.ok) revalidate();
    return result;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return { ok: false, error: "The machine's stops changed at the same time. Reload and try again." };
    throw error;
  }
}
