import "server-only";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { addDowntime, deleteDowntime } from "@/app/shifts/downtimeActions";
import { DOWNTIME_REASONS, MAX_STOP_HOURS, downtimeLabel, isDowntimeCode, stopHours, stopTiming, type DowntimeCode } from "@/lib/domain/downtime";
import { shiftPermKey } from "@/lib/domain/permissions";
import { ROSTER_DEPTS, WORK_CENTRES, workerCentres, isRosterDept } from "@/lib/domain/shifts";
import { clockMinutes } from "@/lib/domain/downtime";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { elapsedStopHours, stopPeriodBounds } from "@/lib/domain/downtimePeriods";
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
  hours?: number;
  startTime?: string;
  endTime?: string;
  endsNextDay?: boolean;
  isOpen?: boolean;
  endDate?: string;
  unlisted?: boolean;
  department?: string;
  centre?: string;
  reason: DowntimeCode;
  note?: string;
}

export const recordMachineStopTool: WriteTool<StopInput> = {
  kind: "write",
  name: "record_machine_stop",
  title: "Record a machine stop",
  description:
    "Record that a machine stood still on a day: which machine (its code or exact name), from startTime to endTime (minute precision, endsNextDay for overnight), or legacy hours, and why — one of the plant's reason codes. What the Shifts tab's Machine stops records, where the lost hours are counted by cause. Ask for the reason when the person did not give one — never guess it. Leave endTime absent and set isOpen=true for an unresolved problem; never invent a resolution. Supply the actual endDate for multi-day closed repairs. No future days. For equipment outside the machine list, use unlisted=true and its name in machine, with its explicit department (and work centre for Cut). Never guess the department or silently treat an unmatched machine as unlisted.",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      date: DAY,
      machine: { type: "string", minLength: 1, maxLength: 120, description: "The machine's code (e.g. LSR-1) or exact name." },
      hours: { type: "number", minimum: 0, description: "Duration; prefer clock times. Legacy hours-only calls round to a quarter hour." },
      startTime: { type: "string", format: "time" },
      endTime: { type: "string", format: "time" },
      endsNextDay: { type: "boolean" },
      isOpen: { type: "boolean" },
      endDate: { type: "string", format: "date" },
      unlisted: { type: "boolean", description: "Only when the user explicitly records equipment outside the registry." },
      department: { type: "string", enum: ROSTER_DEPTS },
      centre: { type: "string", enum: WORK_CENTRES },
      reason: REASON,
      note: { type: "string", maxLength: 200, description: "The supervisor's own words, if any." },
    },
    required: ["date", "machine", "reason"],
    additionalProperties: false,
  },
  parse: (r) => {
    if (!isDowntimeCode(String(r.reason))) return "Give one of the plant's reason codes.";
    if (r.unlisted && (!isRosterDept(String(r.department)) || (workerCentres(String(r.department)) && !workerCentres(String(r.department))!.some((c) => c === r.centre)))) return "Give the unlisted equipment's department and work centre.";
    if (r.isOpen === true) {
      if (clockMinutes(String(r.startTime ?? "")) === null || r.endTime || r.endDate) return "An open stop needs a start time and no end.";
      return { ...(r as unknown as StopInput), hours: 0 };
    }
    if (r.startTime && r.endTime) {
      // a timed stop always carries its end date, as the Shifts tab writes
      // it, so its hours fall on the factory days it really spanned and an
      // end still to come is refused
      const date = String(r.date);
      let endDate = r.endDate ? String(r.endDate) : null;
      if (!endDate) {
        const timing = stopTiming(String(r.startTime), String(r.endTime), r.endsNextDay as boolean | undefined);
        if (!timing) return "Give valid start/end times within 24 hours.";
        endDate = addDaysISO(date, timing.endsNextDay ? 1 : 0);
      }
      const bounds = stopPeriodBounds({ date, hours: 0, startTime: String(r.startTime), endTime: String(r.endTime), endDate });
      return bounds ? { ...(r as unknown as StopInput), endDate, endsNextDay: endDate > date, hours: (bounds.end - bounds.start) / 3600000 } : "Give an actual closing date/time after the start.";
    }
    if (r.startTime || r.endTime) return "Give both the start and the end time, or mark the stop as still open.";
    const hours = stopHours(Number(r.hours));
    return Number.isFinite(hours) && hours > 0 && hours <= MAX_STOP_HOURS ? { ...(r as unknown as StopInput), hours } : "Give start/end times or legacy stopped hours.";
  },
  async describe(i, ctx) {
    if (notYet(i.date, ctx.todayISO)) return { error: `${i.date} has not come yet.` };
    const m = i.unlisted ? null : await machineOf(i.machine);
    if (!i.unlisted && !m) return { error: `There is no machine "${i.machine}" — check the code, or explicitly give unlisted equipment and its department.` };
    const dept = m?.dept ?? i.department ?? "", label = m?.code ?? i.machine.trim();
    if (!isRosterDept(dept) || !hasPerm(ctx.user, shiftPermKey(dept))) return { error: `Recording ${label}'s stops needs its department's shift-log permission.` };
    if (m && !m.active) return { error: `${label} is retired.` };
    const scope = m ? { machineId: m.id } : { machineId: null, customDept: dept, customName: { equals: label, mode: "insensitive" as const } };
    const before = await prisma.machineDowntime.findMany({ where: { date: new Date(`${i.date}T00:00:00.000Z`), ...scope }, select: { id: true, hours: true, startTime: true, endTime: true, endsNextDay: true, isOpen: true, endDate: true } });
    const had = before.reduce((s, r) => s + r.hours, 0);
    return {
      title: `Machine stop: ${label} ${i.date}`,
      summary: `Record ${label} stopped on ${i.date}${i.startTime ? ` from ${i.startTime}${i.endTime ? ` to ${i.endDate ?? ""} ${i.endTime}${i.endsNextDay ? " (+1 day)" : ""}` : ""}` : ""}${i.isOpen ? ", still open — end unknown" : `, ${i.hours} h`} — ${downtimeLabel(i.reason)}${i.note ? ` (${i.note})` : ""}.`,
      changes: [{ label: `${label} stops ${i.date}`, before: had > 0 ? `${had} h` : "none", after: i.isOpen ? "Open — elapsed duration is calculated live" : `${had + (i.hours ?? 0)} h` }],
      snapshot: { ...scope, stops: before },
    };
  },
  async execute(i) {
    const m = i.unlisted ? null : await machineOf(i.machine);
    if (!i.unlisted && !m) return { ok: false, error: `There is no machine "${i.machine}".` };
    const r = await addDowntime(formOf({ date: i.date, ...(m ? { machineId: m.id } : { machineId: "custom", customName: i.machine, customDept: i.department ?? "", customCentre: i.centre ?? "" }), ...(i.startTime ? { startTime: i.startTime, endTime: i.endTime, endsNextDay: i.endsNextDay ?? false, ...(i.isOpen ? { isOpen: true } : {}), ...(i.endDate ? { endDate: i.endDate } : {}) } : { hours: i.hours }), reasonCode: i.reason, reason: i.note ?? null }));
    if (!r.ok || !r.id) return { ok: false, error: r.error ?? "The stop was not recorded." };
    return { ok: true, message: `${m?.code ?? i.machine}'s ${r.isOpen ? "open stop" : `stop of ${r.hours ?? i.hours} h`} on ${i.date} is recorded — ${downtimeLabel(i.reason)}.`, undo: { tool: "delete_machine_stop", input: { id: r.id } } };
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
    const dept = row.machine?.dept ?? row.customDept ?? "";
    if (!isRosterDept(dept) || !hasPerm(ctx.user, shiftPermKey(dept))) return { error: "Deleting this stop needs the shift-log permission of its department." };
    const day = row.date.toISOString().slice(0, 10);
    return {
      title: `Delete a stop of ${(row.machine?.code ?? row.customName ?? "Unlisted equipment")}`,
      summary: `Delete ${(row.machine?.code ?? row.customName ?? "Unlisted equipment")}'s stop ${row.isOpen ? `still open (${elapsedStopHours(row, ctx.now)} h elapsed)` : `of ${row.hours} h`} on ${day} — ${downtimeLabel(row.reasonCode, row.reason)}.`,
      changes: [{ label: `${(row.machine?.code ?? row.customName ?? "Unlisted equipment")} ${day}`, before: `${row.hours} h · ${downtimeLabel(row.reasonCode, row.reason)}`, after: "deleted" }],
      snapshot: { id: row.id, hours: row.hours, isOpen: row.isOpen, endDate: row.endDate, reasonCode: row.reasonCode, reason: row.reason, startTime: row.startTime, endTime: row.endTime, endsNextDay: row.endsNextDay, machineId: row.machineId, customName: row.customName, customDept: row.customDept, customCentre: row.customCentre },
    };
  },
  async execute(i) {
    const row = await prisma.machineDowntime.findUnique({ where: { id: i.id }, include: { machine: true } });
    if (!row) return { ok: false, error: `There is no machine stop ${i.id}.` };
    const r = await deleteDowntime(formOf({ id: i.id }));
    if (!r.ok) return { ok: false, error: r.error };
    const day = row.date.toISOString().slice(0, 10);
    const reason = row.reasonCode && isDowntimeCode(row.reasonCode) ? row.reasonCode : "OTHER";
    const undo = { tool: "record_machine_stop", input: { date: day, machine: (row.machine?.code ?? row.customName ?? "Unlisted equipment"), ...(row.isOpen ? { isOpen: true, startTime: row.startTime } : row.startTime && row.endTime ? { startTime: row.startTime, endTime: row.endTime, endsNextDay: row.endsNextDay, ...(row.endDate ? { endDate: row.endDate.toISOString().slice(0, 10) } : {}) } : { hours: row.hours }), ...(row.machineId === null ? { unlisted: true, department: row.customDept, ...(row.customCentre ? { centre: row.customCentre } : {}) } : {}), reason, ...(row.reason ? { note: row.reason.slice(0, 200) } : {}) } };
    return { ok: true, message: `${(row.machine?.code ?? row.customName ?? "Unlisted equipment")}'s stop on ${day} is deleted.`, undo };
  },
};

export const DOWNTIME_TOOLS = [recordMachineStopTool, deleteMachineStopTool] as const;
