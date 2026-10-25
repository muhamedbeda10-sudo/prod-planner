import "server-only";
import type { Machine } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { createMachine, deleteMachine, setMachineActive, updateMachine } from "@/app/admin/machines/actions";
import { CENTERS, CENTER_LABEL, SHIFT_DEPTS, isShiftDept } from "@/lib/domain/shifts";
import { deptLabel } from "@/lib/domain/constants";
import { cell } from "@/lib/domain/aiActions";
import { answerOf, formOf, type WriteTool } from "./types";

// The machines list for the assistant (Tools → Machines & lines): a machine
// added, corrected (code, name, work centre, hours a day), retired or brought
// back, or deleted (only while no day and no plan names it). Each runs the
// list's own action as the person (machines.manage); each is undone by
// putting the machine back as it was. A machine is named by its code.

const TABS = ["machines"] as const;
const PERM = "machines.manage";
const NO_RIGHT = "Keeping the machines list needs the Machines — manage permission (Users & Permissions).";
const CODE = { type: "string", minLength: 1, maxLength: 40, description: "The machine's code, e.g. B4-10." } as const;
const ALL_CENTERS = [...new Set(Object.values(CENTERS).flat())];
const centerText = (c: string) => (c ? CENTER_LABEL[c] ?? c : "—");
const hoursText = (h: number | null) => (h === null ? "not set" : `${h} h/day`);

async function byCode(code: string): Promise<Machine | null> {
  return prisma.machine.findFirst({ where: { code: { equals: code.trim(), mode: "insensitive" } } });
}

interface MachineFields {
  code: string;
  name: string;
  dept: string;
  center: string;
  hoursPerDay: number | null;
  sortOrder: number;
}

const fieldsOf = (m: Machine): MachineFields => ({ code: m.code, name: m.name, dept: m.dept, center: m.center, hoursPerDay: m.hoursPerDay, sortOrder: m.sortOrder });
const form = (f: MachineFields, id?: number) => formOf({ ...(id ? { id } : {}), code: f.code, name: f.name, dept: f.dept, center: f.center, hoursPerDay: f.hoursPerDay ?? "", sortOrder: f.sortOrder });

/** The centre named, checked against the department's. */
function centerProblem(dept: string, center: string): string | null {
  if (!isShiftDept(dept)) return `Unknown department ${dept}.`;
  if (center && !CENTERS[dept].includes(center)) return `${centerText(center)} is not a work centre of ${deptLabel(dept)} — it has ${CENTERS[dept].map(centerText).join(", ")}.`;
  return null;
}

interface AddInput {
  code: string;
  name: string;
  dept: string;
  center?: string;
  hoursPerDay?: number | null;
}

export const addMachineTool: WriteTool<AddInput> = {
  kind: "write",
  name: "add_machine",
  title: "Add a machine",
  description: `Add a machine or line to the list: its code, name, department, work centre and the hours it works a day (what the machine plan and the board count). Work centres: ${SHIFT_DEPTS.map((d) => `${d}: ${CENTERS[d].join(", ")}`).join("; ")}.`,
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      code: CODE,
      name: { type: "string", minLength: 1, maxLength: 80 },
      dept: { type: "string", enum: SHIFT_DEPTS },
      center: { type: "string", enum: ALL_CENTERS },
      hoursPerDay: { type: ["number", "null"], minimum: 0, maximum: 24 },
    },
    required: ["code", "name", "dept"],
    additionalProperties: false,
  },
  parse(r) {
    const i = { ...(r as unknown as AddInput), code: String(r.code).trim().toUpperCase(), name: String(r.name).trim() };
    const center = i.center ?? (isShiftDept(i.dept) ? CENTERS[i.dept][0] ?? "" : "");
    return centerProblem(i.dept, center) ?? { ...i, center };
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const clash = await byCode(i.code);
    if (clash) return { error: `Code ${i.code} is taken (${clash.name}).` };
    return {
      title: `New machine ${i.code}`,
      summary: `Add ${i.code} ${i.name} to ${deptLabel(i.dept)} — ${centerText(i.center ?? "")}, ${hoursText(i.hoursPerDay ?? null)}.`,
      changes: [{ label: `${i.code} ${i.name}`, before: "—", after: `${deptLabel(i.dept)} · ${centerText(i.center ?? "")} · ${hoursText(i.hoursPerDay ?? null)}` }],
      snapshot: { code: i.code },
    };
  },
  async execute(i) {
    const r = await createMachine(form({ code: i.code, name: i.name, dept: i.dept, center: i.center ?? "", hoursPerDay: i.hoursPerDay ?? null, sortOrder: 0 }));
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, message: `${i.code} is on the machines list.`, undo: { tool: "delete_machine", input: { machine: i.code } } };
  },
};

interface UpdateInput {
  machine: string;
  code?: string;
  name?: string;
  center?: string;
  hoursPerDay?: number | null;
}

export const updateMachineTool: WriteTool<UpdateInput> = {
  kind: "write",
  name: "update_machine",
  title: "Correct a machine",
  description: "Correct a machine on the list: its code, name, work centre, or the hours it works a day (null = not set) — only the fields given change.",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      machine: CODE,
      code: CODE,
      name: { type: "string", minLength: 1, maxLength: 80 },
      center: { type: "string", enum: ALL_CENTERS },
      hoursPerDay: { type: ["number", "null"], minimum: 0, maximum: 24 },
    },
    required: ["machine"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const m = await byCode(i.machine);
    if (!m) return { error: `No machine ${i.machine} on the list.` };
    const was = fieldsOf(m);
    const next = mergedMachine(was, i);
    const bad = centerProblem(next.dept, next.center);
    if (bad) return { error: bad };
    if (next.code !== was.code && (await byCode(next.code))) return { error: `Code ${next.code} is taken.` };
    const changes = [
      ["Code", was.code, next.code],
      ["Name", was.name, next.name],
      ["Work centre", centerText(was.center), centerText(next.center)],
      ["Hours a day", hoursText(was.hoursPerDay), hoursText(next.hoursPerDay)],
    ].filter(([, a, b]) => a !== b).map(([label, a, b]) => ({ label: `${was.code} · ${label}`, before: cell(a), after: cell(b) }));
    if (changes.length === 0) return { error: `${was.code} reads so already.` };
    return { title: `Correct ${was.code}`, summary: `Correct ${was.code}: ${changes.map((c) => `${c.label.split(" · ")[1]} ${c.before} → ${c.after}`).join("; ")}.`, changes, snapshot: was };
  },
  async execute(i) {
    const m = await byCode(i.machine);
    if (!m) return { ok: false, error: `No machine ${i.machine} on the list.` };
    const was = fieldsOf(m);
    const next = mergedMachine(was, i);
    const r = await updateMachine(form(next, m.id));
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, message: `${next.code} corrected.`, undo: { tool: "update_machine", input: { machine: next.code, code: was.code, name: was.name, center: was.center, hoursPerDay: was.hoursPerDay } } };
  },
};

function mergedMachine(was: MachineFields, i: UpdateInput): MachineFields {
  return {
    ...was,
    code: i.code?.trim().toUpperCase() ?? was.code,
    name: i.name?.trim() ?? was.name,
    center: i.center ?? was.center,
    hoursPerDay: i.hoursPerDay === undefined ? was.hoursPerDay : i.hoursPerDay,
  };
}

export const setMachinesActiveTool: WriteTool<{ machines: string[]; active: boolean }> = {
  kind: "write",
  name: "set_machines_active",
  title: "Retire machines, or bring them back",
  description: "Retire machines (they leave the pickers and the machine plan, but stay on the days they were used) or bring retired ones back into service.",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: { type: "object", properties: { machines: { type: "array", minItems: 1, maxItems: 50, items: CODE }, active: { type: "boolean", description: "false = retire, true = back in service." } }, required: ["machines", "active"], additionalProperties: false },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const ms: Machine[] = [];
    for (const code of i.machines) {
      const m = await byCode(code);
      if (!m) return { error: `No machine ${code} on the list.` };
      if (m.active !== i.active) ms.push(m);
    }
    if (ms.length === 0) return { error: `Every one of them is ${i.active ? "in service" : "retired"} already.` };
    return {
      title: `${i.active ? "Bring back" : "Retire"} ${ms.length} machine(s)`,
      summary: `${i.active ? "Bring back into service" : "Retire"} ${ms.map((m) => m.code).join(", ")}.`,
      changes: ms.map((m) => ({ label: `${m.code} ${m.name}`, before: m.active ? "in service" : "retired", after: i.active ? "in service" : "retired" })),
      snapshot: ms.map((m) => ({ id: m.id, active: m.active })),
    };
  },
  async execute(i) {
    const changed: string[] = [];
    for (const code of i.machines) {
      const m = await byCode(code);
      if (!m || m.active === i.active) continue;
      const r = await answerOf(() => setMachineActive(formOf({ id: m.id, active: i.active })));
      if (!r.ok) {
        if (changed.length === 0) return { ok: false, error: r.error };
        return { ok: true, message: `Stopped at ${m.code}: ${r.error ?? "refused"}.`, undo: { tool: "set_machines_active", input: { machines: changed, active: !i.active } } };
      }
      changed.push(m.code);
    }
    return { ok: true, message: `${changed.length} machine(s) ${i.active ? "back in service" : "retired"}.`, undo: { tool: "set_machines_active", input: { machines: changed, active: !i.active } } };
  },
};

export const deleteMachineTool: WriteTool<{ machine: string }> = {
  kind: "write",
  name: "delete_machine",
  title: "Delete a machine",
  description: "Delete a machine from the list outright — refused while a day of the shift log, a downtime, a rule or a queue line names it: retire it instead.",
  area: "data",
  risk: "destructive",
  tabs: TABS,
  schema: { type: "object", properties: { machine: CODE }, required: ["machine"], additionalProperties: false },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const m = await byCode(i.machine);
    if (!m) return { error: `No machine ${i.machine} on the list.` };
    const [rules, queue, times, jobs, cuts] = await Promise.all([
      prisma.machineRule.count({ where: { machineId: m.id } }),
      prisma.worklistMachine.count({ where: { machineId: m.id } }),
      prisma.machineItemTime.count({ where: { machineId: m.id } }),
      prisma.manualJob.count({ where: { machineId: m.id } }),
      prisma.sheetCutLog.count({ where: { machineId: m.id } }),
    ]);
    if (rules > 0 || queue > 0) return { error: `${m.code} has ${rules} rule(s) and ${queue} queue line(s) — they would go with it. Retire it instead (set_machines_active), or take those off first.` };
    // its typed hours per piece would be dropped silently, and the undo cannot bring them back
    if (times > 0 || jobs > 0 || cuts > 0) return { error: `${m.code} has ${times} typed time(s) per piece, ${jobs} job(s) and ${cuts} sheet-cut record(s) — they would go or lose their machine. Retire it instead (set_machines_active).` };
    return {
      title: `Delete machine ${m.code}`,
      summary: `Delete ${m.code} ${m.name} from the machines list.`,
      changes: [{ label: `${m.code} ${m.name}`, before: `${deptLabel(m.dept)} · ${centerText(m.center)}${m.active ? "" : " · retired"}`, after: "deleted" }],
      snapshot: { ...fieldsOf(m), active: m.active },
    };
  },
  async execute(i) {
    const m = await byCode(i.machine);
    if (!m) return { ok: false, error: `No machine ${i.machine} on the list.` };
    const r = await deleteMachine(formOf({ id: m.id }));
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, message: `${m.code} is off the list.`, undo: { tool: "restore_machine", input: { ...fieldsOf(m), active: m.active } } };
  },
};

interface RestoreInput extends MachineFields {
  active: boolean;
}

/** The undo of a deletion — never offered to the model. */
export const restoreMachineTool: WriteTool<RestoreInput> = {
  kind: "write",
  name: "restore_machine",
  internal: true,
  title: "Put a machine back",
  description: "Put a deleted machine back on the list as it was (the undo of a deletion).",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      code: CODE,
      name: { type: "string", minLength: 1, maxLength: 80 },
      dept: { type: "string", enum: SHIFT_DEPTS },
      center: { type: "string", maxLength: 40 },
      hoursPerDay: { type: ["number", "null"], minimum: 0, maximum: 24 },
      sortOrder: { type: "integer", minimum: -100000, maximum: 100000 },
      active: { type: "boolean" },
    },
    required: ["code", "name", "dept", "center", "hoursPerDay", "sortOrder", "active"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const now = await byCode(i.code);
    return {
      title: `Put ${i.code} back`,
      summary: `Put ${i.code} ${i.name} back on the machines list as it was.`,
      changes: [{ label: `${i.code} ${i.name}`, before: now ? "on the list" : "—", after: "back on the list" }],
      snapshot: now ? { id: now.id } : null,
    };
  },
  async execute(i) {
    const r = await createMachine(form(i));
    if (!r.ok) return { ok: false, error: r.error };
    if (!i.active) {
      const m = await byCode(i.code);
      if (m) await setMachineActive(formOf({ id: m.id, active: false }));
    }
    return { ok: true, message: `${i.code} is back on the list.` };
  },
};

export const MACHINE_LIST_TOOLS = [addMachineTool, updateMachineTool, setMachinesActiveTool, deleteMachineTool, restoreMachineTool] as const;
