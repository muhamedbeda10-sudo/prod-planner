import "server-only";
import { hasPerm } from "@/lib/server/auth";
import { getShiftRoster, type ShiftLineDTO } from "@/lib/server/shifts";
import { clearShiftDay, saveShiftRoster } from "@/app/shifts/actions";
import { readShiftState, restoreShiftState, type ShiftState } from "@/lib/server/rowSnapshots";
import { ROSTER_DEPTS, SHIFT_CODES, dayTotals, hoursOfShift, isRosterDept, type RosterDept, type ShiftCode, type ShiftHours } from "@/lib/domain/shifts";
import { PERMISSIONS, shiftPermKey } from "@/lib/domain/permissions";
import { WORKER_DEPT_LABEL, normalizeEmpId } from "@/lib/domain/tanks";
import { formOf, type ReadTool, type WriteTool } from "./types";

// The SHIFT ROSTER for the assistant: who worked each day in each department,
// on which shift and with how much overtime — what the Shifts tab records,
// and the calibration and the capacity check sum. Through the tab's own
// actions, under the person's own shift-log permission for each department.
//
// A department's day is saved WHOLE, as the tab saves it: every worker of the
// department gets a row, the ones not mentioned as the tab shows them
// (recorded, or present on the usual shift — absent while on vacation), so
// the day's man-hours stay a plain sum. Undone by putting the day back
// exactly as it was, its man-hours figure included.

const TABS = ["shifts"] as const;
const DAY = { type: "string", format: "date" } as const;
const DEPT = { type: "string", enum: [...ROSTER_DEPTS], description: "Cut = Fabrication. LV panels: Punching, Bending, WeldingLV, PaintingLV." } as const;
const SHIFT = { type: "string", enum: [...SHIFT_CODES], description: "S9 = day shift 07:00–16:00, S11 = night shift 19:00–07:00. Both include a one-hour break." } as const;
const OVERTIME = { type: "number", minimum: 0, maximum: 12, description: "Day shift only: the fixed 16:00–19:00 overtime period. Use the configured overtime hours shown by get_shift_day." } as const;
const MAX_STATE = 200_000;

const label = (d: RosterDept) => WORKER_DEPT_LABEL[d];
const permLabel = (key: string) => PERMISSIONS.find((p) => p.key === key)?.label ?? key;
const noRight = (d: RosterDept) => `Recording ${label(d)} on the shift log needs the "${permLabel(shiftPermKey(d))}" permission — the owner ticks it on Users & Permissions.`;
const halfHour = (h: number) => Math.round(h * 2) / 2;
/** The roster action's own rule: a day whose midnight (UTC) has not come is refused. */
const notYet = (iso: string, now: Date) => new Date(`${iso}T00:00:00.000Z`).getTime() > now.getTime();

interface DayLine {
  present: boolean;
  shift: ShiftCode;
  overtimeH: number;
  note: string | null;
}

function lineText(l: DayLine, h: ShiftHours): string {
  const note = l.note ? ` · “${l.note}”` : "";
  if (!l.present) return `absent${note}`;
  return `${hoursOfShift(l.shift, h)} h${l.shift === "S9" && l.overtimeH > 0 ? ` + ${l.overtimeH} h OT` : ""}${note}`;
}

const sameLine = (a: DayLine, b: DayLine) => a.present === b.present && a.shift === b.shift && a.overtimeH === b.overtimeH && (a.note ?? null) === (b.note ?? null);
const asDayLine = (l: ShiftLineDTO): DayLine => ({ present: l.present, shift: l.shift, overtimeH: l.overtimeH, note: l.note.trim() || null });

/** The worker a reference names on a department's day: the badge number,
 *  or the exact name when no badge matches. */
function findLine(lines: readonly ShiftLineDTO[], ref: string): ShiftLineDTO | "none" | "many" {
  const badge = normalizeEmpId(ref);
  const byBadge = lines.filter((l) => normalizeEmpId(l.empId) === badge);
  if (byBadge.length === 1) return byBadge[0];
  const name = ref.trim().replace(/\s+/g, " ").toLowerCase();
  const byName = lines.filter((l) => l.name.trim().replace(/\s+/g, " ").toLowerCase() === name);
  if (byName.length === 1) return byName[0];
  return byName.length > 1 ? "many" : "none";
}

// ------------------------------------------------------------------ read

interface DayInput {
  date: string;
  depts?: RosterDept[];
}

export const getShiftDayTool: ReadTool<DayInput> = {
  kind: "read",
  name: "get_shift_day",
  title: "Reading the shift roster",
  description:
    "One day of the shift roster, as the Shifts tab shows it: per department, every worker on its list (badge, name, sections) present or absent, the shift (S9 / S11), overtime and note — whether the department's day was saved, and its man-hours. A worker with no record reads as the tab shows him: present on the usual shift, or absent while on vacation. Read it before you prepare record_shift_day.",
  schema: {
    type: "object",
    properties: { date: DAY, depts: { type: "array", minItems: 1, maxItems: ROSTER_DEPTS.length, items: DEPT, description: "The departments to read — all of them when left out." } },
    required: ["date"],
    additionalProperties: false,
  },
  tabs: TABS,
  status: (i) => `Reading the shift roster of ${i.date}`,
  async run(i) {
    const r = await getShiftRoster(i.date);
    const depts = i.depts ?? ROSTER_DEPTS.filter((d) => r.lines.some((l) => l.dept === d));
    return {
      ok: true,
      text: JSON.stringify({
        date: r.dateISO,
        shiftHours: { S9: r.shiftHours.short, S11: r.shiftHours.long, usualOvertime: r.shiftHours.overtime },
        departments: depts.map((d) => {
          const lines = r.lines.filter((l) => l.dept === d);
          const t = dayTotals(lines, r.shiftHours);
          return {
            dept: d,
            name: label(d),
            saved: r.savedDepts.includes(d),
            workers: t.workers,
            present: t.present,
            manHours: t.hours,
            overtimeH: t.overtimeH,
            capacityMhPerDay: r.capacityMh[d] ?? null,
            columns: ["badge", "name", "sections", "present", "shift", "overtimeH", "note", "recorded", "onVacation"],
            rows: lines.map((l) => [l.empId, l.name, l.sectionLabels.join(", "), l.present, l.shift, l.overtimeH, l.note || null, l.recorded, l.onVacation]),
          };
        }),
        recordedBy: r.recordedBy,
      }),
    };
  },
};

// ------------------------------------------------------------------ record

interface WorkerChange {
  worker: string;
  present?: boolean;
  shift?: ShiftCode;
  overtimeH?: number;
  note?: string | null;
}

interface RecordInput {
  date: string;
  dept: RosterDept;
  everyone?: { shift?: ShiftCode; overtimeH?: number };
  workers?: WorkerChange[];
}

interface PlannedLine {
  line: ShiftLineDTO;
  before: DayLine;
  after: DayLine;
}

/** The department's day as it will be saved: every worker on it, the changes
 *  asked for applied — the whole department's first, each worker's on top. A
 *  shift or overtime for "everyone" goes to the ones present. */
export function planShiftDay(lines: readonly ShiftLineDTO[], i: Pick<RecordInput, "everyone" | "workers">): PlannedLine[] | { error: string } {
  const asked = new Map<number, WorkerChange>();
  for (const w of i.workers ?? []) {
    const hit = findLine(lines, w.worker);
    if (hit === "none") return { error: `${w.worker} is not on this department's roster for the day — check the badge with get_shift_day.` };
    if (hit === "many") return { error: `More than one worker is called ${w.worker} — use the badge number.` };
    if (asked.has(hit.workerId)) return { error: `${hit.empId} ${hit.name} is named twice.` };
    asked.set(hit.workerId, w);
  }
  const invalidOvertime = [i.everyone, ...(i.workers ?? [])].find((change) => change?.shift === "S11" && (change.overtimeH ?? 0) > 0);
  if (invalidOvertime) return { error: "Overtime is available to the day shift only (16:00–19:00)." };
  return lines.map((line) => {
    const before = asDayLine(line);
    const w = asked.get(line.workerId);
    const present = w?.present ?? before.present;
    const all = present ? i.everyone : undefined;
    const shift = w?.shift ?? all?.shift ?? before.shift;
    const requestedOvertime = halfHour(w?.overtimeH ?? all?.overtimeH ?? before.overtimeH);
    const after: DayLine = {
      present,
      shift,
      overtimeH: present && shift === "S9" ? requestedOvertime : 0,
      note: w && w.note !== undefined ? w.note?.trim() || null : before.note,
    };
    return { line, before, after };
  });
}

async function deptDay(dateISO: string, dept: RosterDept) {
  const roster = await getShiftRoster(dateISO);
  return { roster, lines: roster.lines.filter((l) => l.dept === dept) };
}

const SHIFT_STATE = (s: ShiftState) => JSON.stringify(s);

export const recordShiftDayTool: WriteTool<RecordInput> = {
  kind: "write",
  name: "record_shift_day",
  title: "Record a day on the shift roster",
  description:
    "Record one department's day on the shift roster, as the Shifts tab does: who was absent, who worked the night shift, day-shift overtime and notes. `everyone` applies a shift or overtime to every worker present in the department; `workers` sets single workers (badge number or exact name) on top of that. The department's day is saved whole — workers not mentioned are recorded as the tab shows them (read it first with get_shift_day). No future days.",
  area: "data",
  // a few workers marked is small; the whole department, or many, is not
  risk: (i) => (!i.everyone && (i.workers?.length ?? 0) <= 3 ? "low" : "high"),
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      date: DAY,
      dept: DEPT,
      everyone: {
        type: "object",
        properties: { shift: SHIFT, overtimeH: OVERTIME },
        additionalProperties: false,
        description: "For every worker present in the department — e.g. the whole department on the long shift, or 3 hours' overtime each.",
      },
      workers: {
        type: "array",
        minItems: 1,
        maxItems: 300,
        items: {
          type: "object",
          properties: {
            worker: { type: "string", minLength: 1, maxLength: 80, description: "The worker's badge number, or exact name." },
            present: { type: "boolean" },
            shift: SHIFT,
            overtimeH: OVERTIME,
            note: { type: ["string", "null"], maxLength: 200, description: "The day's note for this worker (null clears it)." },
          },
          required: ["worker"],
          additionalProperties: false,
        },
      },
    },
    required: ["date", "dept"],
    additionalProperties: false,
  },
  parse(r) {
    const i = r as unknown as RecordInput;
    const everyone = i.everyone && (i.everyone.shift !== undefined || i.everyone.overtimeH !== undefined) ? i.everyone : undefined;
    const bare = (i.workers ?? []).find((w) => w.present === undefined && w.shift === undefined && w.overtimeH === undefined && w.note === undefined);
    if (bare) return `Say what changes for ${bare.worker}: present, shift, overtime or note.`;
    if (!everyone && !i.workers?.length) return "Say what to record: a shift or overtime for everyone, or single workers.";
    return { date: i.date, dept: i.dept, ...(everyone ? { everyone } : {}), ...(i.workers?.length ? { workers: i.workers } : {}) };
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, shiftPermKey(i.dept))) return { error: noRight(i.dept) };
    if (notYet(i.date, ctx.now)) return { error: `${i.date} has not come yet — the roster records days that have begun.` };
    const { roster, lines } = await deptDay(i.date, i.dept);
    if (lines.length === 0) return { error: `Nobody is on ${label(i.dept)}'s list of workers — add workers first.` };
    const plan = planShiftDay(lines, i);
    if ("error" in plan) return plan;
    const h = roster.shiftHours;
    const moved = plan.filter((p) => !sameLine(p.before, p.after));
    const unrecorded = plan.filter((p) => !p.line.recorded);
    if (moved.length === 0 && unrecorded.length === 0) return { error: `${label(i.dept)}'s day ${i.date} reads so already.` };
    // the ones saved for the first time as the tab shows them, unchanged
    const asShown = unrecorded.filter((p) => sameLine(p.before, p.after)).length;
    const before = dayTotals(plan.map((p) => p.before), h);
    const after = dayTotals(plan.map((p) => p.after), h);
    const state = await readShiftState(i.date, [i.dept]);
    return {
      title: `Shift roster: ${label(i.dept)} ${i.date}`,
      summary:
        `Save ${label(i.dept)}'s day ${i.date} on the shift roster: ${moved.length} worker(s) change` +
        (asShown > 0 ? `, and ${asShown} more with no record yet are recorded as the tab shows them` : "") +
        ` — ${after.present}/${after.workers} present, ${after.hours} man-hours.`,
      changes: [
        ...moved.map((p) => ({ label: `${p.line.empId} ${p.line.name}`, before: lineText(p.before, h), after: lineText(p.after, h) })),
        { label: `${label(i.dept)} man-hours`, before: `${before.hours} (${before.present}/${before.workers} present)`, after: `${after.hours} (${after.present}/${after.workers} present)` },
      ],
      snapshot: { state, roster: lines.map((l) => l.workerId) },
    };
  },
  async execute(i) {
    const { lines } = await deptDay(i.date, i.dept);
    const plan = planShiftDay(lines, i);
    if ("error" in plan) return { ok: false, error: plan.error };
    const before = await readShiftState(i.date, [i.dept]);
    const saved = plan.map((p) => ({ dept: i.dept, workerId: p.line.workerId, present: p.after.present, shift: p.after.shift, overtimeH: p.after.overtimeH, note: p.after.note ?? "" }));
    const r = await saveShiftRoster(formOf({ date: i.date, lines: JSON.stringify(saved) }));
    if (!r.ok) return { ok: false, error: r.error };
    const t = dayTotals(plan.map((p) => p.after));
    return {
      ok: true,
      message: `${label(i.dept)}'s day ${i.date} is saved — ${t.present}/${t.workers} present.`,
      undo: { tool: "restore_shift_day", input: { date: i.date, depts: [i.dept], state: SHIFT_STATE(before) } },
    };
  },
};

// ------------------------------------------------------------------ clear

interface ClearInput {
  date: string;
  depts: RosterDept[];
}

function stateLine(s: ShiftState, d: RosterDept): string {
  const rows = s.rows.filter((r) => r.dept === d);
  const h = s.dayHours.find((x) => x.dept === d);
  if (rows.length === 0 && !h) return "not recorded";
  return `${rows.length} worker(s) recorded${h ? ` · ${h.hours} man-hours` : ""}`;
}

export const clearShiftDayTool: WriteTool<ClearInput> = {
  kind: "write",
  name: "clear_shift_day",
  title: "Clear a day on the shift roster",
  description: "Forget what the shift roster recorded for some departments on one day — their workers' rows and the day's man-hours, as the tab's Clear does. Undo puts the day back as it was.",
  area: "data",
  risk: "destructive",
  tabs: TABS,
  schema: {
    type: "object",
    properties: { date: DAY, depts: { type: "array", minItems: 1, maxItems: ROSTER_DEPTS.length, items: DEPT } },
    required: ["date", "depts"],
    additionalProperties: false,
  },
  parse: (r) => ({ date: r.date as string, depts: [...new Set(r.depts as RosterDept[])] }),
  async describe(i, ctx) {
    const denied = i.depts.find((d) => !hasPerm(ctx.user, shiftPermKey(d)));
    if (denied) return { error: noRight(denied) };
    const state = await readShiftState(i.date, i.depts);
    const recorded = i.depts.filter((d) => stateLine(state, d) !== "not recorded");
    if (recorded.length === 0) return { error: `Nothing is recorded for ${i.depts.map(label).join(", ")} on ${i.date}.` };
    return {
      title: `Clear the roster of ${i.date}`,
      summary: `Forget ${recorded.map(label).join(", ")}'s day ${i.date} on the shift roster — the workers' rows and the man-hours the calibration reads.`,
      changes: recorded.map((d) => ({ label: `${label(d)} ${i.date}`, before: stateLine(state, d), after: "not recorded" })),
      snapshot: state,
    };
  },
  async execute(i) {
    const before = await readShiftState(i.date, i.depts);
    const r = await clearShiftDay(formOf({ date: i.date, depts: i.depts.join(",") }));
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, message: `The roster of ${i.date} is cleared for ${i.depts.map(label).join(", ")}.`, undo: { tool: "restore_shift_day", input: { date: i.date, depts: i.depts, state: SHIFT_STATE(before) } } };
  },
};

// ------------------------------------------------------------------ undo

interface RestoreInput {
  date: string;
  depts: RosterDept[];
  /** The day as it was (ShiftState), as JSON text — kept as text so the
   *  checked input still reads as the schema when the undo is approved. */
  state: string;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStrOrNull = (v: unknown) => v === null || typeof v === "string";

/** The state an undo carries, checked whole — the app wrote it, but it is
 *  read back from the change's record. */
export function readShiftStateText(text: string, depts: readonly string[]): ShiftState | string {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return "The day's earlier record could not be read.";
  }
  const s = v as Partial<ShiftState> | null;
  if (!s || !Array.isArray(s.rows) || !Array.isArray(s.dayHours)) return "The day's earlier record is not whole.";
  const rowOk = (r: Record<string, unknown>) =>
    typeof r.dept === "string" && depts.includes(r.dept) && Number.isInteger(r.workerId) && typeof r.present === "boolean" && typeof r.shift === "string" &&
    isNum(r.overtimeH) && (r.machineId === null || Number.isInteger(r.machineId)) && isStrOrNull(r.note) && isStrOrNull(r.recordedBy);
  const hoursOk = (h: Record<string, unknown>) =>
    typeof h.dept === "string" && depts.includes(h.dept) && isNum(h.hours) && (h.people === null || Number.isInteger(h.people)) && (h.hoursEach === null || isNum(h.hoursEach)) &&
    typeof h.source === "string" && isStrOrNull(h.recordedBy);
  if (!s.rows.every((r) => r && typeof r === "object" && rowOk(r as unknown as Record<string, unknown>))) return "A worker's row in the earlier record is not whole.";
  if (!s.dayHours.every((h) => h && typeof h === "object" && hoursOk(h as unknown as Record<string, unknown>))) return "The man-hours in the earlier record are not whole.";
  return { rows: s.rows, dayHours: s.dayHours };
}

/** The undo of either change above — never offered to the model. */
export const restoreShiftDayTool: WriteTool<RestoreInput> = {
  kind: "write",
  name: "restore_shift_day",
  internal: true,
  title: "Put the shift roster back",
  description: "Put departments' day on the shift roster back exactly as it was (the undo of a roster change).",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: { date: DAY, depts: { type: "array", minItems: 1, maxItems: ROSTER_DEPTS.length, items: DEPT }, state: { type: "string", minLength: 2, maxLength: MAX_STATE } },
    required: ["date", "depts", "state"],
    additionalProperties: false,
  },
  parse(r) {
    const depts = [...new Set(r.depts as string[])].filter(isRosterDept);
    const state = readShiftStateText(r.state as string, depts);
    return typeof state === "string" ? state : { date: r.date as string, depts, state: r.state as string };
  },
  async describe(i, ctx) {
    const denied = i.depts.find((d) => !hasPerm(ctx.user, shiftPermKey(d)));
    if (denied) return { error: noRight(denied) };
    const then = readShiftStateText(i.state, i.depts);
    if (typeof then === "string") return { error: then };
    const now = await readShiftState(i.date, i.depts);
    return {
      title: `Put the roster of ${i.date} back`,
      summary: `Put ${i.depts.map(label).join(", ")}'s day ${i.date} on the shift roster back as it was.`,
      changes: i.depts.map((d) => ({ label: `${label(d)} ${i.date}`, before: stateLine(now, d), after: stateLine(then, d) })),
      snapshot: now,
    };
  },
  async execute(i) {
    const then = readShiftStateText(i.state, i.depts);
    if (typeof then === "string") return { ok: false, error: then };
    const r = await restoreShiftState(i.date, i.depts, then);
    return r.ok ? { ok: true, message: `The roster of ${i.date} is back as it was.` } : { ok: false, error: r.error };
  },
};

export const SHIFT_TOOLS = [getShiftDayTool, recordShiftDayTool, clearShiftDayTool, restoreShiftDayTool] as const;
