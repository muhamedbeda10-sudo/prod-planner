import "server-only";
import type { Machine } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { isMachinePlanningOn } from "@/lib/server/data";
import { getDeptBoardLines, getMachineBoard } from "@/lib/server/machineBoard";
import { partsWithPlanBoms } from "@/lib/server/manualJobs";
import { readManualJob, restoreManualJob, type ManualJobSnapshot } from "@/lib/server/rowSnapshots";
import { createManualJob, deleteManualJob, recordManualDone, reopenManualJob, updateManualJob } from "@/app/worklist/manualActions";
import { deptPermKey } from "@/lib/domain/permissions";
import {
  MANUAL_BOM, MANUAL_ITEM, MAX_JOB_PARTS, SHEET_COUNT_RULE, editedJobQty, isSheetCount, roundSheets, jobName, jobSheetLabel, jobsBySheet, manualIdOf, manualMo, partsText, readJobParts,
  type ManualJobPartView,
} from "@/lib/domain/manualJob";
import { ITEMS } from "@/lib/domain/constants";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { formOf, type ReadTool, type ToolCtx, type WriteTool } from "./types";

// The machine boards' JOBS for the assistant: on the fabrication board every
// job is a SHEET JOB — sheets of one thickness, material and size carrying
// the parts of several projects, queued, split over machines and closed in
// sheets; on the other boards a job from outside the plan, in pieces. All
// through the machine screen's own actions, under the department's worklist
// key, as the person does them there. A job is undone exactly
// (lib/server/rowSnapshots.ts).

type BoardDept = "Cut" | "Welding" | "Painting" | "ShotBlast";
const BOARD_DEPTS = ["Cut", "Welding", "Painting", "ShotBlast"] as const;
const OFF = "Machine planning is switched off for the plant (Settings) — the machine board is not in use.";
const noKey = (dept: string) => `Working on ${dept}'s machine board needs its worklist key — the owner ticks it on Users & Permissions.`;
const PIECES_JOB = "This fabrication job was typed in pieces, before the board counted sheets — it is kept as it was; make a new sheet job (create_manual_job) instead.";
/** How far back a job's sheets or pieces may be recorded — older is far likelier a misread. */
const DAYS_BACK = 62;

async function machineByCode(dept: string, code: string): Promise<Machine | null> {
  return prisma.machine.findFirst({ where: { dept, code: { equals: code.trim(), mode: "insensitive" } } });
}

/** A day a job is recorded on: not one to come, not far back. */
function dayProblem(iso: string, todayISO: string): string | null {
  if (iso > todayISO) return `${iso} has not come yet.`;
  if (iso < addDaysISO(todayISO, -DAYS_BACK)) return `${iso} is more than ${DAYS_BACK} days back — check the date.`;
  return null;
}

/** A snapshot kept as text: what an undo writes back, checked when read. */
function stateOf<T extends { id: number }>(text: string, id: number, ok: (v: Record<string, unknown>) => boolean): T | string {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return "The earlier record could not be read.";
  }
  if (!v || typeof v !== "object" || (v as { id?: unknown }).id !== id || !ok(v as Record<string, unknown>)) return "The earlier record is not whole.";
  return v as T;
}

async function jobMachine(dept: string, code: string): Promise<Machine | { error: string }> {
  const m = await machineByCode(dept, code);
  if (!m) return { error: `No machine ${code} in ${dept}.` };
  if (!m.active) return { error: `${m.code} is retired.` };
  return m;
}

const unitOf = (j: { bySheet: boolean }) => (j.bySheet ? "sheet(s)" : "piece(s)");
const progress = (j: { bySheet: boolean; doneQty: number; qty: number }) => `${roundSheets(j.doneQty)} of ${roundSheets(j.qty)} ${j.bySheet ? "sheets cut" : "done"}`;

/** What is wrong with a count of a job's sheets (Cut, to the hundredth: 2.5) or pieces (whole), or null. */
const countProblem = (bySheet: boolean, n: number, what: string): string | null =>
  bySheet ? (isSheetCount(n) ? null : `${what} must be ${SHEET_COUNT_RULE}.`) : Number.isInteger(n) && n > 0 ? null : `${what} must be whole pieces above 0.`;

/** A sheet job's parts, checked, each BOM the plan carries in the plan's own
 *  spelling (any other kept as typed — a job may be for any project), and
 *  which BOMs the plan does not carry; or what is wrong. */
async function checkedParts(raw: unknown): Promise<{ parts: Omit<ManualJobPartView, "id">[]; notInPlan: string[] } | { error: string }> {
  const read = readJobParts(raw);
  if (!read.ok) return { error: read.error };
  return partsWithPlanBoms(read.parts);
}

// ------------------------------------------------------------- reading

const DEPT = { type: "string", enum: [...BOARD_DEPTS], description: "The machine board: Cut (Fabrication — sheet jobs), Welding, Painting, ShotBlast." } as const;

export const getJobsTool: ReadTool<{ dept?: BoardDept }> = {
  kind: "read",
  name: "get_jobs",
  title: "Reading the jobs on the machines",
  description:
    "The jobs of a machine board (default Cut, the fabrication board) and how they are spread. On Cut every job is a SHEET JOB: sheets of one thickness, material and size, carrying the parts of several projects (BOM, component, part such as Bottom / Side wall / Skirt base, pieces) — the fabrication machines carry nothing else, and a job is counted, split and closed in SHEETS. Returns each machine with the sheets (or pieces) queued on it and its jobs in order; every open job (its sheet, sheets wanted and cut, parts, the machines it sits on, its boardLine); and, on Cut, the open projects (BOMs) of the plan — a job's part may also name any other project. To distribute: put a job on a machine with assign_line_to_machine / assign_lines_to_machines using its boardLine (bom MANUAL, mo MANUAL-<id>, item JOB) — a qty there puts only that many SHEETS of it on that machine, the rest on another; move it with move_line_in_queue, take it off with unassign_line.",
  schema: { type: "object", properties: { dept: DEPT }, additionalProperties: false },
  status: (i) => `Reading the jobs on ${i.dept ?? "Cut"}`,
  async run(i, ctx) {
    if (!(await isMachinePlanningOn())) return { ok: false, text: OFF };
    const dept = i.dept ?? "Cut";
    const board = await getMachineBoard(dept, await getDeptBoardLines(dept, ctx.todayISO), ctx.todayISO);
    const jobs = new Map(board.manualJobs.map((j) => [j.id, j]));
    return {
      ok: true,
      text: JSON.stringify({
        dept,
        countedIn: jobsBySheet(dept) ? "sheets" : "pieces",
        machines: board.cards.map((c) => {
          const queue = c.queue.filter((q) => manualIdOf(q.mo) !== null);
          return {
            code: c.machine.code, name: c.machine.name, center: c.machine.center, active: c.machine.active,
            jobsQueued: queue.reduce((n, q) => n + q.remaining, 0),
            otherLines: c.queue.length - queue.length,
            jobs: queue.map((q) => ({ rank: q.rank, running: q.running, id: manualIdOf(q.mo), here: q.remaining, ...(q.split ? { ofLeft: q.lineRemaining } : {}) })),
          };
        }),
        openJobs: board.manualJobs.filter((j) => !j.doneAtISO).map((j) => ({
          id: j.id,
          name: jobName(j),
          ...(j.bySheet
            ? {
              sheet: jobSheetLabel(j), thicknessMm: j.thicknessMm, material: j.material, sheetSize: j.sheetSize, sheets: j.qty, sheetsCut: j.doneQty, parts: j.parts.map((p) => ({ bom: p.bom, item: p.item, part: p.part, pcs: p.pcs })),
              // every ✓ on it, newest first: when, which machine, how many, by whom
              ...(board.jobCuts?.[j.id]?.length ? { cuts: board.jobCuts[j.id].slice(0, 20).map((c) => ({ at: c.atISO, machine: c.machine, sheets: c.qty, by: c.by })) } : {}),
            }
            : { pieces: j.qty, done: j.doneQty, ...(j.bom ? { bom: j.bom } : {}), ...(j.item ? { item: j.item } : {}) }),
          on: j.onMachines,
          ...(j.note ? { note: j.note } : {}),
          boardLine: { bom: MANUAL_BOM, mo: manualMo(j.id), item: MANUAL_ITEM },
        })),
        finishedLately: board.manualJobs.filter((j) => j.doneAtISO).slice(0, 15).map((j) => ({ id: j.id, name: jobName(j), [j.bySheet ? "sheets" : "pieces"]: j.qty, lastOn: j.lastMachine, done: j.doneAtISO!.slice(0, 10) })),
        ...(jobsBySheet(dept) ? { openProjects: board.jobBoms.slice(0, 300) } : {}),
        notes: [...jobs.values()].some((j) => !j.bySheet && jobsBySheet(dept)) ? ["Jobs with pieces on Cut were typed before the board counted sheets — kept as they were."] : [],
      }),
    };
  },
};

// ------------------------------------------------------------ the jobs

const PART_SCHEMA = {
  type: "object",
  properties: {
    bom: { type: "string", maxLength: 60, description: "The project (BOM) the part belongs to, as the person gives it — any project, in the plan or not (one the plan carries is saved in the plan's spelling); \"\" for none." },
    item: { type: "string", enum: ["", ...ITEMS], description: "Its component (CF, TC, TN, CB, AR, MB) or \"\"." },
    part: { type: "string", minLength: 1, maxLength: 60, description: "The part in the planner's words — Bottom, Side wall, Skirt base …" },
    pcs: { type: "integer", minimum: 1, maximum: 100000, description: "Pieces of it the job's sheets carry — leave out when the person did not say." },
  },
  required: ["bom", "item", "part"],
  additionalProperties: false,
} as const;

interface PartInput {
  bom: string;
  item: string;
  part: string;
  pcs?: number | null;
}

interface CreateJobInput {
  dept: BoardDept;
  title?: string;
  qty: number;
  machine?: string;
  bom?: string;
  item?: string;
  material?: string;
  thicknessMm?: number;
  sheetSize?: string;
  sheets?: number;
  parts?: PartInput[];
  note?: string;
}

export const createManualJobTool: WriteTool<CreateJobInput> = {
  kind: "write",
  name: "create_manual_job",
  title: "Add a job",
  description:
    `Type in a job as the machine screen's ✋ Add job does, and put it at the back of a machine's queue (an idle machine starts on it) — or only save it to the list when no machine is given. On Cut (Fabrication) it is a SHEET JOB: qty is the SHEETS — part of a sheet too, to the hundredth (2.5) — thicknessMm and material are required (sheetSize when known), and parts lists every project's part the sheets carry (at most ${MAX_JOB_PARTS}; a part's pieces only when the person gives them — never guess a count); title is optional. One thickness, material and size per job — another sheet is another job. Its sheets are counted on the job itself, never in the plan's ledger (the cut pieces are recorded on the weekly plan with record_output). On the other boards it is a job from outside the plan (a bracket, a repair …) in pieces, with a title. Undo deletes it.`,
  area: "machines",
  risk: "low",
  schema: {
    type: "object",
    properties: {
      dept: DEPT,
      title: { type: "string", maxLength: 120, description: "What the job is, in the person's words — required off Cut; on Cut an optional name." },
      qty: { type: "number", minimum: 0.01, maximum: 100000, description: "On Cut the sheets (2.5 = two and a half); elsewhere the pieces, whole." },
      machine: { type: "string", maxLength: 40, description: "The machine's code to queue it on; leave out to save it to the list only." },
      material: { type: "string", maxLength: 60, description: "The sheet's material (Steel, Stainless steel, Galvanized steel …) — required on Cut." },
      thicknessMm: { type: "number", minimum: 0, maximum: 200, description: "The sheet's thickness — required on Cut." },
      sheetSize: { type: "string", maxLength: 40, description: "The sheet's size, e.g. 1250*2500." },
      parts: { type: "array", maxItems: MAX_JOB_PARTS, items: PART_SCHEMA, description: "Cut only: every project's part on the sheets." },
      bom: { type: "string", maxLength: 60, description: "Off Cut only: a BOM it belongs to, when there is one." },
      item: { type: "string", maxLength: 60, description: "Off Cut only: the part, when there is one." },
      sheets: { type: "number", minimum: 0, maximum: 10000, description: "Off Cut only: sheets it takes, when known." },
      note: { type: "string", maxLength: 500 },
    },
    required: ["dept", "qty"],
    additionalProperties: false,
  },
  parse(r) {
    const { machine, ...rest } = r as unknown as CreateJobInput;
    const title = String(rest.title ?? "").trim();
    const base = { ...rest, title, ...(typeof machine === "string" && machine.trim() ? { machine: machine.trim() } : {}) };
    const bad = countProblem(jobsBySheet(rest.dept), rest.qty, jobsBySheet(rest.dept) ? "Sheets" : "Pieces");
    if (bad) return bad;
    if (!jobsBySheet(rest.dept)) return title ? base : "Say what the job is.";
    if (!(Number(rest.thicknessMm) > 0)) return "A fabrication job needs its sheet's thickness.";
    if (!String(rest.material ?? "").trim()) return "A fabrication job needs its sheet's material.";
    const read = readJobParts(rest.parts ?? []);
    return read.ok ? base : read.error;
  },
  async describe(i, ctx) {
    if (!(await isMachinePlanningOn())) return { error: OFF };
    if (!hasPerm(ctx.user, deptPermKey(i.dept))) return { error: noKey(i.dept) };
    const machine = i.machine ? await jobMachine(i.dept, i.machine) : null;
    if (machine && "error" in machine) return machine;
    const where = machine ? `, at the back of ${machine.code}'s queue (an idle machine starts on it)` : ", saved to the list on no machine";
    if (jobsBySheet(i.dept)) {
      const checked = await checkedParts(i.parts ?? []);
      if ("error" in checked) return checked;
      const { parts, notInPlan } = checked;
      const sheet = jobSheetLabel({ thicknessMm: i.thicknessMm ?? 0, material: i.material ?? "", sheetSize: i.sheetSize ?? "" });
      const outside = notInPlan.length ? ` ${notInPlan.join(", ")} ${notInPlan.length === 1 ? "is" : "are"} not in the plan — kept as typed.` : "";
      return {
        title: `🧾 ${i.qty} × ${sheet}${machine ? ` on ${machine.code}` : ""}`,
        summary: `Add a sheet job of ${i.qty} sheet(s) of ${sheet}${i.title ? ` "${i.title}"` : ""} carrying ${parts.length} part(s)${where}.${outside}`,
        changes: [{ label: i.title || sheet, before: "—", after: `${i.qty} sheet(s) — ${partsText(parts)}${machine ? ` · ${machine.code}` : ""}` }],
        snapshot: machine ? { machine: machine.id, active: machine.active } : null,
      };
    }
    const sheet = i.thicknessMm ? ` · ${i.thicknessMm} mm ${i.material ?? ""}${i.sheets ? ` (${i.sheets} sheet(s))` : ""}` : "";
    return {
      title: `✋ ${i.title} ×${i.qty}${machine ? ` on ${machine.code}` : ""}`,
      summary: `Add the manual job "${i.title}" — ${i.qty} piece(s) on ${i.dept}'s board${where}.`,
      changes: [{ label: i.title ?? "", before: "—", after: `×${i.qty}${i.bom ? ` · BOM ${i.bom}` : ""}${i.item ? ` · ${i.item}` : ""}${sheet}${machine ? ` · ${machine.code}` : ""}` }],
      snapshot: machine ? { machine: machine.id, active: machine.active } : null,
    };
  },
  async execute(i) {
    const machine = i.machine ? await jobMachine(i.dept, i.machine) : null;
    if (machine && "error" in machine) return { ok: false, error: machine.error };
    const common = { dept: i.dept, title: i.title, qty: i.qty, material: i.material, thicknessMm: i.thicknessMm, sheetSize: i.sheetSize, note: i.note, ...(machine ? { machineId: machine.id } : {}) };
    const r = await createManualJob(formOf(jobsBySheet(i.dept)
      ? { ...common, parts: JSON.stringify(i.parts ?? []) }
      : { ...common, bom: i.bom, item: i.item, sheets: i.sheets }));
    if (!r.ok || !r.id) return { ok: false, error: r.error ?? "The job was not saved." };
    return { ok: true, message: `Job #${r.id} is added${machine ? ` on ${machine.code}` : ""}.`, undo: { tool: "delete_manual_job", input: { id: r.id } } };
  },
};

async function theJob(id: number, ctx: ToolCtx): Promise<ManualJobSnapshot | { error: string }> {
  if (!(await isMachinePlanningOn())) return { error: OFF };
  const job = await readManualJob(id);
  if (!job) return { error: `No job #${id}.` };
  if (!hasPerm(ctx.user, deptPermKey(job.dept))) return { error: noKey(job.dept) };
  return job;
}

/** A job that may be worked on: not a fabrication job left from the pieces days. */
async function workableJob(id: number, ctx: ToolCtx): Promise<ManualJobSnapshot | { error: string }> {
  const job = await theJob(id, ctx);
  if ("error" in job) return job;
  if (jobsBySheet(job.dept) && !job.bySheet) return { error: PIECES_JOB };
  return job;
}

/** The undo: the job put back as it was — a ✓'s own row off the sheet cut
 *  log too (`cutLogId`). */
const jobUndo = (before: ManualJobSnapshot, cutLogId?: number) =>
  ({ tool: "restore_manual_job", input: { id: before.id, state: JSON.stringify(before), ...(cutLogId !== undefined ? { cutLogId } : {}) } });

interface JobDoneInput {
  id: number;
  qty: number;
  machine?: string;
  date?: string;
}

export const recordManualJobDoneTool: WriteTool<JobDoneInput> = {
  kind: "write",
  name: "record_manual_job_done",
  title: "Record a job's sheets cut (or pieces done)",
  description: "✓ on a job's line on a machine: on Cut the SHEETS of the sheet job cut on that machine (they go on the sheet cut log with the machine and the day); elsewhere the pieces finished. They go on the job, never in the plan's ledger — the parts' cut pieces are recorded on the weekly plan with record_output. Give the machine that cut them: a share of the job fixed on it shrinks by them. When every sheet is cut the job leaves every machine and stays in the list as finished. Undo puts the job back as it was and takes the ✓ off the sheet cut log.",
  area: "machines",
  risk: "low",
  schema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      qty: { type: "number", minimum: 0.01, maximum: 100000, description: "Sheets cut (Cut — part of a sheet too, 2.5) or whole pieces done (elsewhere)." },
      machine: { type: "string", maxLength: 40, description: "The machine that cut them." },
      date: { type: "string", format: "date", description: "The day they were cut (default today)." },
    },
    required: ["id", "qty"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    const job = await workableJob(i.id, ctx);
    if ("error" in job) return job;
    const left = roundSheets(job.qty - job.doneQty);
    if (job.doneAt || left <= 0) return { error: `Job #${i.id} is finished.` };
    const badQty = countProblem(job.bySheet, i.qty, job.bySheet ? "Sheets cut" : "Pieces done");
    if (badQty) return { error: badQty };
    if (i.qty > left) return { error: `Only ${left} ${unitOf(job)} left on job #${i.id}.` };
    if (i.machine) {
      const m = await jobMachine(job.dept, i.machine);
      if ("error" in m) return m;
    }
    const date = i.date ?? ctx.todayISO;
    const bad = dayProblem(date, ctx.todayISO);
    if (bad) return { error: bad };
    const name = jobName(job);
    return {
      title: `✓ ${i.qty} ${unitOf(job)} of "${name}"`,
      summary: `Record ${i.qty} ${unitOf(job)} of job #${job.id} "${name}" as ${job.bySheet ? "cut" : "done"}${i.machine ? ` on ${i.machine}` : ""} on ${date}${roundSheets(job.doneQty + i.qty) >= roundSheets(job.qty) ? " — its last; it leaves every machine, finished" : ""}.`,
      changes: [{ label: name, before: progress(job), after: progress({ ...job, doneQty: roundSheets(job.doneQty + i.qty) }) }],
      snapshot: job,
    };
  },
  async execute(i, ctx) {
    const before = await readManualJob(i.id);
    if (!before) return { ok: false, error: `No job #${i.id}.` };
    const m = i.machine ? await jobMachine(before.dept, i.machine) : null;
    if (m && "error" in m) return { ok: false, error: m.error };
    const r = await recordManualDone(formOf({ id: i.id, qty: i.qty, date: i.date ?? ctx.todayISO, ...(m ? { machineId: m.id } : {}) }));
    return r.ok ? { ok: true, message: `${i.qty} ${unitOf(before)} of job #${i.id} are recorded.`, undo: jobUndo(before, r.cutLogId) } : { ok: false, error: r.error ?? "Not recorded." };
  },
};

export const reopenManualJobTool: WriteTool<{ id: number; more: number }> = {
  kind: "write",
  name: "reopen_manual_job",
  title: "Open a job again",
  description: "Open a finished job again — more wanted (more: sheets on Cut, pieces elsewhere), or it was ticked by mistake (more 0); it is back in the list as open, on no machine until it is put on one. On a job still open, more adds to it where it is. Undo puts it back as it was.",
  area: "machines",
  risk: "low",
  schema: {
    type: "object",
    properties: { id: { type: "integer", minimum: 1 }, more: { type: "number", minimum: 0, maximum: 100000, description: "Extra sheets (Cut — part of a sheet too, 2.5) or whole pieces wanted (0 = none)." } },
    required: ["id", "more"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    const job = await workableJob(i.id, ctx);
    if ("error" in job) return job;
    const name = jobName(job);
    const bad = i.more === 0 ? null : countProblem(job.bySheet, i.more, job.bySheet ? "Extra sheets" : "Extra pieces");
    if (bad) return { error: bad };
    if (!job.doneAt) {
      // still open: more of it, where it is
      if (i.more === 0) return { error: `Job #${i.id} is open already — say how many more ${unitOf(job)} are wanted.` };
      return {
        title: `${i.more} more ${unitOf(job)} of "${name}"`,
        summary: `Add ${i.more} ${unitOf(job)} to job #${job.id} "${name}" — it stays where it is.`,
        changes: [{ label: name, before: progress(job), after: progress({ ...job, qty: roundSheets(job.qty + i.more) }) }],
        snapshot: job,
      };
    }
    if (roundSheets(job.qty + i.more - job.doneQty) <= 0) return { error: `Nothing would be left to make — add the extra ${unitOf(job)} wanted.` };
    return {
      title: `Open "${name}" again`,
      summary: `Open job #${job.id} "${name}" again${i.more ? ` with ${i.more} more ${unitOf(job)}` : ""} — in the list as open, on no machine until it is put on one.`,
      changes: [{ label: name, before: `${progress(job)}, finished`, after: `${progress({ ...job, qty: roundSheets(job.qty + i.more) })}, open` }],
      snapshot: job,
    };
  },
  async execute(i) {
    const before = await readManualJob(i.id);
    if (!before) return { ok: false, error: `No job #${i.id}.` };
    const r = await reopenManualJob(formOf({ id: i.id, more: i.more }));
    return r.ok ? { ok: true, message: `Job #${i.id} is open again.`, undo: jobUndo(before) } : { ok: false, error: r.error ?? "Not reopened." };
  },
};

interface UpdateJobInput {
  id: number;
  title?: string;
  qty?: number;
  bom?: string;
  item?: string;
  material?: string;
  thicknessMm?: number;
  sheetSize?: string;
  sheets?: number;
  parts?: PartInput[];
  note?: string;
}

const JOB_FIELDS = ["title", "qty", "bom", "item", "material", "thicknessMm", "sheetSize", "sheets", "parts", "note"] as const;
type JobField = (typeof JOB_FIELDS)[number];
/** The fields a sheet job carries — its BOM, part and sheets-for-pieces are its parts and count. */
const SHEET_JOB_FIELDS: readonly JobField[] = ["title", "qty", "material", "thicknessMm", "sheetSize", "parts", "note"];
const PIECE_JOB_FIELDS: readonly JobField[] = ["title", "qty", "bom", "item", "material", "thicknessMm", "sheetSize", "sheets", "note"];
const JOB_FIELD_LABEL = (bySheet: boolean): Record<JobField, string> => ({
  title: bySheet ? "Name" : "What it is", qty: bySheet ? "Sheets" : "Pieces", bom: "BOM", item: "Part", material: "Material",
  thicknessMm: "Thickness (mm)", sheetSize: "Sheet size", sheets: "Sheets", parts: "Parts on the sheets", note: "Note",
});
const shown = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? "—" : String(v));

/** The job as it will read after the change: what was said, the rest as it is. */
function jobAfter(job: ManualJobSnapshot, i: UpdateJobInput) {
  return {
    title: i.title ?? job.title, qty: i.qty ?? job.qty, bom: i.bom ?? job.bom, item: i.item ?? job.item, material: i.material ?? job.material,
    thicknessMm: i.thicknessMm ?? job.thicknessMm, sheetSize: i.sheetSize ?? job.sheetSize, sheets: i.sheets ?? job.sheets, note: i.note ?? job.note,
    parts: (i.parts ?? job.parts).map((p) => ({ bom: p.bom, item: p.item, part: p.part, pcs: p.pcs ?? null })),
  };
}

export const updateManualJobTool: WriteTool<UpdateJobInput> = {
  kind: "write",
  name: "update_manual_job",
  title: "Change a job",
  description:
    "Change a job as it was typed, as ✎ Edit in the jobs list does — only the fields given change; where it is queued stays as it is. A sheet job (Cut): its sheets (qty), the sheet (material, thickness, size), its parts (parts replaces the whole list), its name and note. Another board's job: what it is, the pieces, its BOM and part, the sheet and the note. Never fewer than are already cut or done; exactly that finishes it; more opens a finished one again, on no machine. To copy a job, use create_manual_job with its details. Undo puts it back as it was.",
  area: "machines",
  risk: "low",
  schema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      title: { type: "string", maxLength: 120 },
      qty: { type: "number", minimum: 0.01, maximum: 100000, description: "Sheets (Cut — part of a sheet too, 2.5) or whole pieces wanted in all — not the extra." },
      material: { type: "string", maxLength: 60 },
      thicknessMm: { type: "number", minimum: 0, maximum: 200 },
      sheetSize: { type: "string", maxLength: 40 },
      parts: { type: "array", maxItems: MAX_JOB_PARTS, items: PART_SCHEMA, description: "A sheet job's whole new list of parts." },
      bom: { type: "string", maxLength: 60, description: "Off Cut only." },
      item: { type: "string", maxLength: 60, description: "Off Cut only." },
      sheets: { type: "number", minimum: 0, maximum: 10000, description: "Off Cut only: sheets it takes." },
      note: { type: "string", maxLength: 500 },
    },
    required: ["id"],
    additionalProperties: false,
  },
  parse(r) {
    const i = r as unknown as UpdateJobInput;
    if (!JOB_FIELDS.some((k) => i[k] !== undefined)) return "Say what to change on the job.";
    if (i.parts !== undefined) {
      const read = readJobParts(i.parts);
      if (!read.ok) return read.error;
    }
    return { ...i, ...(typeof i.title === "string" ? { title: i.title.trim() } : {}) };
  },
  async describe(i, ctx) {
    const job = await workableJob(i.id, ctx);
    if ("error" in job) return job;
    const allowed = job.bySheet ? SHEET_JOB_FIELDS : PIECE_JOB_FIELDS;
    const stray = JOB_FIELDS.filter((k) => i[k] !== undefined && !allowed.includes(k));
    if (stray.length > 0) return { error: `${job.bySheet ? "A sheet job" : "This job"} has no ${stray.join(", ")} to change.` };
    const after = jobAfter(job, i);
    if (!job.bySheet && !after.title.trim()) return { error: "Say what the job is." };
    if (job.bySheet && !(Number(after.thicknessMm) > 0)) return { error: "A sheet job needs its thickness." };
    if (job.bySheet && !after.material.trim()) return { error: "A sheet job needs its material." };
    if (job.bySheet && i.parts !== undefined) {
      const parts = await checkedParts(i.parts);
      if ("error" in parts) return parts;
    }
    const qty = editedJobQty(job.doneQty, after.qty, job.bySheet);
    if (!qty.ok) return { error: qty.error };
    const label = JOB_FIELD_LABEL(job.bySheet);
    const valueOf = (o: ReturnType<typeof jobAfter> | ManualJobSnapshot, k: JobField) => (k === "parts" ? partsText(o.parts) : shown(o[k]));
    const changes = allowed
      .filter((k) => i[k] !== undefined && valueOf(job, k) !== valueOf(after, k))
      .map((k) => ({ label: label[k], before: valueOf(job, k) || "—", after: valueOf(after, k) || "—" }));
    if (changes.length === 0) return { error: `Job #${i.id} reads like that already.` };
    const state = qty.finished && !job.doneAt ? " — that is all it has done, so it is finished and leaves every machine"
      : !qty.finished && job.doneAt ? " — it opens again, on no machine until it is put on one" : "";
    return {
      title: `✎ "${jobName(job)}"`,
      summary: `Change job #${job.id} "${jobName(job)}"${state}.`,
      changes,
      snapshot: job,
    };
  },
  async execute(i) {
    const before = await readManualJob(i.id);
    if (!before) return { ok: false, error: `No job #${i.id}.` };
    const { parts, ...after } = jobAfter(before, i);
    const r = await updateManualJob(formOf({ id: i.id, ...after, ...(before.bySheet ? { parts: JSON.stringify(parts) } : {}) }));
    return r.ok ? { ok: true, message: `Job #${i.id} is changed.`, undo: jobUndo(before) } : { ok: false, error: r.error ?? "Not changed." };
  },
};

export const deleteManualJobTool: WriteTool<{ id: number }> = {
  kind: "write",
  name: "delete_manual_job",
  title: "Delete a job",
  description: "Delete a job typed by mistake — off every machine and out of the list. Undo puts it back.",
  area: "machines",
  risk: "destructive",
  schema: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false },
  async describe(i, ctx) {
    const job = await theJob(i.id, ctx);
    if ("error" in job) return job;
    const name = jobName(job);
    return {
      title: `Delete "${name}"`,
      summary: `Delete job #${job.id} "${name}" (${progress(job)})${job.queue.length ? " — it comes off its machine(s)" : ""}.`,
      changes: [{ label: name, before: progress(job), after: "deleted" }],
      snapshot: job,
    };
  },
  async execute(i) {
    const before = await readManualJob(i.id);
    if (!before) return { ok: false, error: `No job #${i.id}.` };
    const r = await deleteManualJob(formOf({ id: i.id }));
    return r.ok ? { ok: true, message: `Job #${i.id} is deleted.`, undo: jobUndo(before) } : { ok: false, error: r.error ?? "Not deleted." };
  },
};

interface RestoreInput {
  id: number;
  state: string;
  /** The sheet cut log row the undone ✓ wrote. */
  cutLogId?: number;
}

const RESTORE_SCHEMA = {
  type: "object",
  properties: { id: { type: "integer", minimum: 1 }, state: { type: "string", minLength: 2, maxLength: 200_000 }, cutLogId: { type: "integer", minimum: 1 } },
  required: ["id", "state"],
  additionalProperties: false,
} as const;

const jobState = (i: RestoreInput) =>
  stateOf<ManualJobSnapshot>(i.state, i.id, (v) =>
    typeof v.dept === "string" && typeof v.title === "string" && Number.isFinite(v.qty) && Number.isFinite(v.doneQty) && typeof v.bySheet === "boolean" && Array.isArray(v.parts) && Array.isArray(v.queue));

/** The undo of a job's change, ✓ or deletion — never offered to the model. */
export const restoreManualJobTool: WriteTool<RestoreInput> = {
  kind: "write",
  name: "restore_manual_job",
  internal: true,
  title: "Put a job back",
  description: "Put a job back exactly as it was (the undo of a change to it, a ✓ on it — its row on the sheet cut log taken off too — or its deletion).",
  area: "machines",
  risk: "low",
  schema: RESTORE_SCHEMA,
  parse(r) {
    const i: RestoreInput = { id: r.id as number, state: r.state as string, ...(r.cutLogId !== undefined ? { cutLogId: r.cutLogId as number } : {}) };
    const s = jobState(i);
    return typeof s === "string" ? s : i;
  },
  async describe(i, ctx) {
    const then = jobState(i);
    if (typeof then === "string") return { error: then };
    if (!hasPerm(ctx.user, deptPermKey(then.dept))) return { error: noKey(then.dept) };
    const now = await readManualJob(i.id);
    const name = jobName(then);
    return {
      title: `Put "${name}" back`,
      summary: `Put job #${i.id} "${name}" back as it was${now ? "" : " — it was deleted"}${i.cutLogId !== undefined ? " — the ✓ comes off the sheet cut log too" : ""}.`,
      changes: [{ label: name, before: now ? progress(now) : "deleted", after: progress(then) }],
      snapshot: now,
    };
  },
  async execute(i) {
    const then = jobState(i);
    if (typeof then === "string") return { ok: false, error: then };
    const r = await restoreManualJob(then, { cutLogId: i.cutLogId });
    return r.ok ? { ok: true, message: `Job #${i.id} is back as it was.` } : { ok: false, error: r.error };
  },
};

export const CUT_FLOOR_TOOLS = [
  getJobsTool,
  createManualJobTool,
  updateManualJobTool,
  recordManualJobDoneTool,
  reopenManualJobTool,
  deleteManualJobTool,
  restoreManualJobTool,
] as const;
