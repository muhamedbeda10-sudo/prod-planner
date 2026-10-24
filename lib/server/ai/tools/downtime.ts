import "server-only";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { addDowntime, deleteDowntime } from "@/app/shifts/downtimeActions";
import { DOWNTIME_REASONS, MAX_STOP_HOURS, STOP_STEP, downtimeLabel, isDowntimeCode, stopHours, type DowntimeCode } from "@/lib/domain/downtime";
import { shiftPermKey } from "@/lib/domain/permissions";
import { isRosterDept } from "@/lib/domain/shifts";
import { formOf, type WriteTool } from "./types";

// MACHINE STOPS for the assistant: a machine that stood, how long and why —
// what the Shifts tab's "Machine stops" records, through the same actions and
// under the department's own shift-log permission. A stop recorded can be
// deleted, and each is the other's undo.

const TABS = ["shifts"] as const;
const DAY = { type: "string", format: "date" } as const;
const REASON = {
  type: "string",
  enum: DOWNTIME_REASONS.map((r) => r.code),
  description: DOWNTIME_REASONS.map((r) => `${r.code} = ${r.label}`).join("; "),
} as const;

/** A day after the factory's own today (Cairo). */
const notYet = (iso: string, todayISO: string) => iso > todayISO;

/** The one machine a reference names: its code, else its exact name — never
 *  a guess between two, and no pattern characters. */
async function machineOf(ref: string) {
  const text = ref.trim();
  if (!text || /[%_]/.test(text)) return null;
  const byCode = await prisma.machine.findMany({ where: { code: { equals: text, mode: "insensitive" } }, take: 2 });
  if (byCode.length === 1) return byCode[0];
  if (byCode.length > 1) return null;
  const byName = await prisma.machine.findMany({ where: { name: { equals: text, mode: "insensitive" } }, take: 2 });
  return byName.length === 1 ? byName[0] : null;
}

interface StopInput {
  date: string;
  machine: string;
  hours: number;
  reason: DowntimeCode;
  note?: string;
}

export const recordMachineStopTool: WriteTool<StopInput> = {
  kind: "write",
  name: "record_machine_stop",
  title: "Record a machine stop",
  description:
    "Record that a machine stood still on a day: which machine (its code or exact name), for how many hours (quarter hours), and why — one of the plant's reason codes. What the Shifts tab's Machine stops records, where the lost hours are counted by cause. Ask for the reason when the person did not give one — never guess it. No future days.",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      date: DAY,
      machine: { type: "string", minLength: 1, maxLength: 60, description: "The machine's code (e.g. LSR-1) or exact name." },
      hours: { type: "number", minimum: STOP_STEP, maximum: MAX_STOP_HOURS, description: "Hours it stood — kept to the quarter hour." },
      reason: REASON,
      note: { type: "string", maxLength: 200, description: "The supervisor's own words, if any." },
    },
    required: ["date", "machine", "hours", "reason"],
    additionalProperties: false,
  },
  parse: (r) => {
    if (!isDowntimeCode(String(r.reason))) return "Give one of the plant's reason codes.";
    const hours = stopHours(Number(r.hours));
    return hours > 0 ? { ...(r as unknown as StopInput), hours } : "Give the hours it stood — a quarter of an hour at least.";
  },
  async describe(i, ctx) {
    if (notYet(i.date, ctx.todayISO)) return { error: `${i.date} has not come yet.` };
    const m = await machineOf(i.machine);
    if (!m) return { error: `There is no machine "${i.machine}" — check the code with the machine list.` };
    if (!isRosterDept(m.dept) || !hasPerm(ctx.user, shiftPermKey(m.dept))) return { error: `Recording ${m.code}'s stops needs the shift-log permission of its department.` };
    if (!m.active) return { error: `${m.code} is retired.` };
    const before = await prisma.machineDowntime.findMany({ where: { date: new Date(`${i.date}T00:00:00.000Z`), machineId: m.id }, select: { id: true, hours: true } });
    const had = before.reduce((s, r) => s + r.hours, 0);
    return {
      title: `Machine stop: ${m.code} ${i.date}`,
      summary: `Record that ${m.code} (${m.name}) stood ${i.hours} h on ${i.date} — ${downtimeLabel(i.reason)}${i.note ? ` (“${i.note}”)` : ""}.`,
      changes: [{ label: `${m.code} stops ${i.date}`, before: had > 0 ? `${had} h` : "none", after: `${had + i.hours} h` }],
      snapshot: { machineId: m.id, stops: before },
    };
  },
  async execute(i) {
    const m = await machineOf(i.machine);
    if (!m) return { ok: false, error: `There is no machine "${i.machine}".` };
    const r = await addDowntime(formOf({ date: i.date, machineId: m.id, hours: i.hours, reasonCode: i.reason, reason: i.note ?? null }));
    if (!r.ok || !r.id) return { ok: false, error: r.error ?? "The stop was not recorded." };
    return { ok: true, message: `${m.code}'s stop of ${r.hours ?? i.hours} h on ${i.date} is recorded — ${downtimeLabel(i.reason)}.`, undo: { tool: "delete_machine_stop", input: { id: r.id } } };
  },
};

interface DeleteInput {
  id: number;
}

export const deleteMachineStopTool: WriteTool<DeleteInput> = {
  kind: "write",
  name: "delete_machine_stop",
  title: "Delete a machine stop",
  description: "Delete one recorded machine stop by its id (read the stops with query_database on MachineDowntime). Its hours come back to the machine's day. Undo records it again (a stop from before the reason codes comes back as Other, with its words as the note).",
  area: "data",
  risk: "destructive",
  tabs: TABS,
  schema: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false },
  async describe(i, ctx) {
    const row = await prisma.machineDowntime.findUnique({ where: { id: i.id }, include: { machine: true } });
    if (!row) return { error: `There is no machine stop ${i.id}.` };
    if (!isRosterDept(row.machine.dept) || !hasPerm(ctx.user, shiftPermKey(row.machine.dept))) return { error: `Deleting ${row.machine.code}'s stops needs the shift-log permission of its department.` };
    const day = row.date.toISOString().slice(0, 10);
    return {
      title: `Delete a stop of ${row.machine.code}`,
      summary: `Delete ${row.machine.code}'s stop of ${row.hours} h on ${day} — ${downtimeLabel(row.reasonCode, row.reason)}.`,
      changes: [{ label: `${row.machine.code} ${day}`, before: `${row.hours} h · ${downtimeLabel(row.reasonCode, row.reason)}`, after: "deleted" }],
      snapshot: { id: row.id, hours: row.hours, reasonCode: row.reasonCode, reason: row.reason },
    };
  },
  async execute(i) {
    const row = await prisma.machineDowntime.findUnique({ where: { id: i.id }, include: { machine: true } });
    if (!row) return { ok: false, error: `There is no machine stop ${i.id}.` };
    const r = await deleteDowntime(formOf({ id: i.id }));
    if (!r.ok) return { ok: false, error: r.error };
    const day = row.date.toISOString().slice(0, 10);
    const reason = row.reasonCode && isDowntimeCode(row.reasonCode) ? row.reasonCode : "OTHER";
    const undo = { tool: "record_machine_stop", input: { date: day, machine: row.machine.code, hours: row.hours, reason, ...(row.reason ? { note: row.reason.slice(0, 200) } : {}) } };
    return { ok: true, message: `${row.machine.code}'s stop on ${day} is deleted.`, undo };
  },
};

export const DOWNTIME_TOOLS = [recordMachineStopTool, deleteMachineStopTool] as const;
