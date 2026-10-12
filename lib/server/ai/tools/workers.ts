import "server-only";
import type { Worker } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { createWorker, deleteWorker, setWorkerActive, setWorkerVacation, updateWorker } from "@/app/admin/workers/actions";
import { normalizeEmpId, WORKER_SECTIONS } from "@/lib/domain/tanks";
import { parseWorkerSections, serializeWorkerDepts } from "@/lib/domain/workers";
import { cell } from "@/lib/domain/aiActions";
import { answerOf, formOf, type WriteTool } from "./types";

// The production workers list for the assistant: a worker added, corrected,
// sent on vacation or brought back, retired or brought back into service, or
// deleted (only while nothing of theirs is on record — the list's own rule).
// Each runs the list's own action as the person (workers.manage); each is
// undone by putting the worker back as they were. A worker is named by the
// ID on their badge, or their exact name.

const TABS = ["workers"] as const;
const PERM = "workers.manage";
const NO_RIGHT = "Keeping the workers list needs the Workers permission — the owner ticks it on Users & Permissions.";
const SECTION_CODES = WORKER_SECTIONS.map((s) => s.code);
const WHO = { type: "string", minLength: 1, maxLength: 80, description: "The worker's badge ID, or exact name." } as const;
const DAY = { type: "string", format: "date" } as const;
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const sectionsText = (csv: string) => parseWorkerSections(csv).map((c) => WORKER_SECTIONS.find((s) => s.code === c)?.label ?? c).join(", ") || "—";

async function findWorker(who: string): Promise<Worker | null> {
  return (await prisma.worker.findUnique({ where: { empId: normalizeEmpId(who) } })) ?? prisma.worker.findFirst({ where: { name: { equals: who.trim(), mode: "insensitive" } } });
}

/** A worker as the list's form sends them — every field. */
interface WorkerFields {
  empId: string;
  name: string;
  jobTitle: string | null;
  stamp: string | null;
  sections: string[];
  vacationUntil: string | null;
}

const fieldsOf = (w: Worker): WorkerFields => ({
  empId: w.empId, name: w.name, jobTitle: w.jobTitle, stamp: w.stamp, sections: parseWorkerSections(w.depts), vacationUntil: day(w.vacationUntil),
});

function form(f: WorkerFields, id?: number): FormData {
  const fd = formOf({ ...(id ? { id } : {}), empId: f.empId, name: f.name, jobTitle: f.jobTitle ?? "", stamp: f.stamp ?? "", vacationUntil: f.vacationUntil ?? "" });
  for (const s of f.sections) fd.append("depts", s);
  return fd;
}

const SECTIONS = { type: "array", minItems: 1, maxItems: SECTION_CODES.length, items: { type: "string", enum: SECTION_CODES }, description: `The sections they work in: ${WORKER_SECTIONS.map((s) => `${s.code} (${s.label})`).join(", ")}.` } as const;

interface AddInput {
  empId: string;
  name: string;
  jobTitle?: string;
  stamp?: string;
  sections: string[];
  vacationUntil?: string;
}

export const addWorkerTool: WriteTool<AddInput> = {
  kind: "write",
  name: "add_worker",
  title: "Add a worker",
  description: "Add a production worker to the list: the ID on their badge, their name, job title, welder's stamp, the sections they work in, and a vacation if they are away.",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      empId: { type: "string", minLength: 1, maxLength: 30 },
      name: { type: "string", minLength: 1, maxLength: 80 },
      jobTitle: { type: "string", maxLength: 80 },
      stamp: { type: "string", maxLength: 10, description: "The welder's stamp letter(s)." },
      sections: SECTIONS,
      vacationUntil: { ...DAY, description: "Away until this day (inclusive)." },
    },
    required: ["empId", "name", "sections"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const empId = normalizeEmpId(i.empId);
    if (await prisma.worker.findUnique({ where: { empId }, select: { id: true } })) return { error: `ID ${empId} is taken by another worker.` };
    if (await prisma.worker.findFirst({ where: { name: { equals: i.name.trim(), mode: "insensitive" } }, select: { id: true } })) return { error: `A worker called ${i.name.trim()} is on the list already.` };
    const sections = sectionsText(serializeWorkerDepts(i.sections));
    return {
      title: `New worker ${i.name.trim()}`,
      summary: `Add ${i.name.trim()} (ID ${empId}${i.jobTitle ? `, ${i.jobTitle}` : ""}) to the workers list — ${sections}.`,
      changes: [{ label: `${empId} ${i.name.trim()}`, before: "—", after: `${sections}${i.stamp ? ` · stamp ${i.stamp.toUpperCase()}` : ""}${i.vacationUntil ? ` · away until ${i.vacationUntil}` : ""}` }],
      snapshot: { empId },
    };
  },
  async execute(i) {
    const f: WorkerFields = { empId: i.empId, name: i.name, jobTitle: i.jobTitle ?? null, stamp: i.stamp ?? null, sections: i.sections, vacationUntil: i.vacationUntil ?? null };
    const r = await createWorker(form(f));
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, message: `${i.name.trim()} is on the workers list.`, undo: { tool: "delete_worker", input: { worker: normalizeEmpId(i.empId) } } };
  },
};

interface UpdateInput {
  worker: string;
  empId?: string;
  name?: string;
  jobTitle?: string | null;
  stamp?: string | null;
  sections?: string[];
  vacationUntil?: string | null;
}

export const updateWorkerTool: WriteTool<UpdateInput> = {
  kind: "write",
  name: "update_worker",
  title: "Correct a worker",
  description: "Correct a worker on the list: their badge ID, name, job title, stamp, sections, or vacation — only the fields given change (null clears a job title, stamp or vacation).",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      worker: WHO,
      empId: { type: "string", minLength: 1, maxLength: 30 },
      name: { type: "string", minLength: 1, maxLength: 80 },
      jobTitle: { type: ["string", "null"], maxLength: 80 },
      stamp: { type: ["string", "null"], maxLength: 10 },
      sections: SECTIONS,
      vacationUntil: { type: ["string", "null"], format: "date" },
    },
    required: ["worker"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const w = await findWorker(i.worker);
    if (!w) return { error: `No worker ${i.worker} on the list.` };
    const was = fieldsOf(w);
    const next = mergedWorker(was, i);
    const changes = [
      ["ID", was.empId, next.empId],
      ["Name", was.name, next.name],
      ["Job title", was.jobTitle, next.jobTitle],
      ["Stamp", was.stamp, next.stamp],
      ["Sections", sectionsText(serializeWorkerDepts(was.sections)), sectionsText(serializeWorkerDepts(next.sections))],
      ["Away until", was.vacationUntil, next.vacationUntil],
    ].filter(([, a, b]) => (a ?? null) !== (b ?? null)).map(([label, a, b]) => ({ label: `${w.name} · ${label}`, before: cell(a), after: cell(b) }));
    if (changes.length === 0) return { error: `${w.name} reads so already.` };
    return { title: `Correct ${w.name}`, summary: `Correct ${w.name} on the workers list: ${changes.map((c) => `${c.label.split(" · ")[1]} ${c.before} → ${c.after}`).join("; ")}.`, changes, snapshot: was };
  },
  async execute(i) {
    const w = await findWorker(i.worker);
    if (!w) return { ok: false, error: `No worker ${i.worker} on the list.` };
    const was = fieldsOf(w);
    const next = mergedWorker(was, i);
    const r = await updateWorker(form(next, w.id));
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, message: `${next.name} corrected.`, undo: { tool: "update_worker", input: { worker: normalizeEmpId(next.empId), ...was } } };
  },
};

function mergedWorker(was: WorkerFields, i: UpdateInput): WorkerFields {
  return {
    empId: i.empId === undefined ? was.empId : normalizeEmpId(i.empId),
    name: i.name?.trim() ?? was.name,
    jobTitle: i.jobTitle === undefined ? was.jobTitle : i.jobTitle?.trim() || null,
    stamp: i.stamp === undefined ? was.stamp : i.stamp?.trim().toUpperCase() || null,
    sections: i.sections === undefined ? was.sections : parseWorkerSections(serializeWorkerDepts(i.sections)),
    vacationUntil: i.vacationUntil === undefined ? was.vacationUntil : i.vacationUntil,
  };
}

interface VacationInput {
  entries: { worker: string; until: string | null }[];
}

export const setWorkerVacationTool: WriteTool<VacationInput> = {
  kind: "write",
  name: "set_worker_vacation",
  title: "Send workers on vacation, or bring them back",
  description: "Mark workers away until a day (inclusive — absent on the shift log and out of the pickers until then), or back at work (until null).",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: { type: "object", properties: { worker: WHO, until: { type: ["string", "null"], format: "date" } }, required: ["worker", "until"], additionalProperties: false },
      },
    },
    required: ["entries"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const rows: { w: Worker; until: string | null }[] = [];
    for (const e of i.entries) {
      const w = await findWorker(e.worker);
      if (!w) return { error: `No worker ${e.worker} on the list.` };
      if (day(w.vacationUntil) !== e.until) rows.push({ w, until: e.until });
    }
    if (rows.length === 0) return { error: "Every one of them reads so already." };
    return {
      title: `Vacation for ${rows.length} worker(s)`,
      summary: `Set the vacation of ${rows.length} worker(s).`,
      changes: rows.map(({ w, until }) => ({ label: `${w.empId} ${w.name}`, before: w.vacationUntil ? `away until ${day(w.vacationUntil)}` : "at work", after: until ? `away until ${until}` : "at work" })),
      snapshot: rows.map(({ w }) => ({ id: w.id, until: day(w.vacationUntil) })),
    };
  },
  async execute(i) {
    const back: VacationInput["entries"] = [];
    for (const e of i.entries) {
      const w = await findWorker(e.worker);
      if (!w) return back.length ? { ok: true, message: `Stopped at ${e.worker}: not on the list.`, undo: { tool: "set_worker_vacation", input: { entries: back } } } : { ok: false, error: `No worker ${e.worker} on the list.` };
      if (day(w.vacationUntil) === e.until) continue;
      const r = await answerOf(() => setWorkerVacation(formOf({ id: w.id, until: e.until ?? "" })));
      if (!r.ok) return back.length ? { ok: true, message: `Stopped at ${w.name}: ${r.error ?? "refused"}.`, undo: { tool: "set_worker_vacation", input: { entries: back } } } : { ok: false, error: r.error };
      back.push({ worker: w.empId, until: day(w.vacationUntil) });
    }
    return { ok: true, message: `${back.length} worker(s) updated.`, undo: { tool: "set_worker_vacation", input: { entries: back } } };
  },
};

export const setWorkersActiveTool: WriteTool<{ workers: string[]; active: boolean }> = {
  kind: "write",
  name: "set_workers_active",
  title: "Retire workers, or bring them back",
  description: "Retire workers (they leave every picker but stay on the records they made) or bring retired ones back into service.",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: { workers: { type: "array", minItems: 1, maxItems: 100, items: WHO }, active: { type: "boolean", description: "false = retire, true = back in service." } },
    required: ["workers", "active"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const ws: Worker[] = [];
    for (const who of i.workers) {
      const w = await findWorker(who);
      if (!w) return { error: `No worker ${who} on the list.` };
      if (w.active !== i.active) ws.push(w);
    }
    if (ws.length === 0) return { error: `Every one of them is ${i.active ? "in service" : "retired"} already.` };
    return {
      title: `${i.active ? "Bring back" : "Retire"} ${ws.length} worker(s)`,
      summary: `${i.active ? "Bring back into service" : "Retire"} ${ws.map((w) => w.name).join(", ")}.`,
      changes: ws.map((w) => ({ label: `${w.empId} ${w.name}`, before: w.active ? "in service" : "retired", after: i.active ? "in service" : "retired" })),
      snapshot: ws.map((w) => ({ id: w.id, active: w.active })),
    };
  },
  async execute(i) {
    const changed: string[] = [];
    for (const who of i.workers) {
      const w = await findWorker(who);
      if (!w || w.active === i.active) continue;
      const r = await answerOf(() => setWorkerActive(formOf({ id: w.id, active: i.active })));
      if (!r.ok) {
        if (changed.length === 0) return { ok: false, error: r.error };
        return { ok: true, message: `Stopped at ${w.name}: ${r.error ?? "refused"}.`, undo: { tool: "set_workers_active", input: { workers: changed, active: !i.active } } };
      }
      changed.push(w.empId);
    }
    return { ok: true, message: `${changed.length} worker(s) ${i.active ? "back in service" : "retired"}.`, undo: { tool: "set_workers_active", input: { workers: changed, active: !i.active } } };
  },
};

export const deleteWorkerTool: WriteTool<{ worker: string }> = {
  kind: "write",
  name: "delete_worker",
  title: "Delete a worker",
  description: "Delete a worker from the list outright — refused while anything of theirs is on record (a tank, a hand-out, a day on the shift log): retire them instead.",
  area: "data",
  risk: "destructive",
  tabs: TABS,
  schema: { type: "object", properties: { worker: WHO }, required: ["worker"], additionalProperties: false },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const w = await findWorker(i.worker);
    if (!w) return { error: `No worker ${i.worker} on the list.` };
    const shifts = await prisma.shiftEntry.count({ where: { workerId: w.id } });
    if (shifts > 0) return { error: `${w.name} is on ${shifts} day(s) of the shift log — retire them instead (set_workers_active), so those days keep their record.` };
    return {
      title: `Delete worker ${w.name}`,
      summary: `Delete ${w.name} (ID ${w.empId}) from the workers list.`,
      changes: [{ label: `${w.empId} ${w.name}`, before: `${sectionsText(w.depts)}${w.active ? "" : " · retired"}`, after: "deleted" }],
      snapshot: { ...fieldsOf(w), active: w.active },
    };
  },
  async execute(i) {
    const w = await findWorker(i.worker);
    if (!w) return { ok: false, error: `No worker ${i.worker} on the list.` };
    const r = await deleteWorker(formOf({ id: w.id }));
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, message: `${w.name} is off the list.`, undo: { tool: "restore_worker", input: { ...fieldsOf(w), active: w.active } } };
  },
};

interface RestoreInput extends WorkerFields {
  active: boolean;
}

/** The undo of a deletion — never offered to the model. */
export const restoreWorkerTool: WriteTool<RestoreInput> = {
  kind: "write",
  name: "restore_worker",
  internal: true,
  title: "Put a worker back",
  description: "Put a deleted worker back on the list as they were (the undo of a deletion).",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      empId: { type: "string", minLength: 1, maxLength: 30 },
      name: { type: "string", minLength: 1, maxLength: 80 },
      jobTitle: { type: ["string", "null"], maxLength: 80 },
      stamp: { type: ["string", "null"], maxLength: 10 },
      sections: { type: "array", maxItems: SECTION_CODES.length, items: { type: "string", enum: SECTION_CODES } },
      vacationUntil: { type: ["string", "null"], format: "date" },
      active: { type: "boolean" },
    },
    required: ["empId", "name", "jobTitle", "stamp", "sections", "vacationUntil", "active"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const now = await prisma.worker.findUnique({ where: { empId: i.empId }, select: { id: true, name: true } });
    return {
      title: `Put ${i.name} back`,
      summary: `Put ${i.name} (ID ${i.empId}) back on the workers list as they were.`,
      changes: [{ label: `${i.empId} ${i.name}`, before: now ? "on the list" : "—", after: "back on the list" }],
      snapshot: now,
    };
  },
  async execute(i) {
    const r = await createWorker(form(i));
    if (!r.ok) return { ok: false, error: r.error };
    if (!i.active) {
      const w = await prisma.worker.findUnique({ where: { empId: i.empId }, select: { id: true } });
      if (w) await setWorkerActive(formOf({ id: w.id, active: false }));
    }
    return { ok: true, message: `${i.name} is back on the list.` };
  },
};

export const WORKER_TOOLS = [addWorkerTool, updateWorkerTool, setWorkerVacationTool, setWorkersActiveTool, deleteWorkerTool, restoreWorkerTool] as const;
