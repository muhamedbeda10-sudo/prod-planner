import "server-only";
import type { Machine } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { isMachinePlanningOn } from "@/lib/server/data";
import { getDeptBoardLines, getMachineBoard, type MachineBoardData } from "@/lib/server/machineBoard";
import { readQueueSnapshot, type QueueRowSnapshot } from "@/lib/server/machineQueues";
import { runCover } from "@/lib/server/nestRuns";
import { readManualJob, readNestRun, restoreManualJob, restoreNestRun, type ManualJobSnapshot, type NestRunSnapshot } from "@/lib/server/rowSnapshots";
import { createNestRun, deleteNestRun, recordNestRunSheets, updateNestRun } from "@/app/worklist/nestRunActions";
import { createManualJob, deleteManualJob, recordManualDone, reopenManualJob, updateManualJob } from "@/app/worklist/manualActions";
import { recordSheetDone } from "@/app/worklist/machineActions";
import { deptPermKey, machineLinePermKey } from "@/lib/domain/permissions";
import { expectedSheets, minutesText, partsDoneAt, RUN_BOM, RUN_ITEM, runMo } from "@/lib/domain/nestRun";
import { MANUAL_BOM, MANUAL_ITEM, editedJobQty, manualMo } from "@/lib/domain/manualJob";
import { sheetKeyLabel, sheetKeyOf } from "@/lib/domain/machineMaterial";
import { normalizeMaterialType, normalizeSheetSize } from "@/lib/domain/material";
import { lineKey } from "@/lib/domain/machineBoard";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import type { AiChange } from "@/lib/domain/aiActions";
import { formOf, type ReadTool, type ToolCtx, type WriteTool } from "./types";

// The cutting floor for the assistant, beside the machine board's queues:
// NEST RUNS (sheets of one thickness carrying several jobs' parts, cut
// together), the MANUAL JOBS typed in from outside the plan, and the ✓ of a
// sheet's pieces cut on a machine — through the machine screen's own actions,
// under the department's worklist key, as the person does them there. A run
// or a job is undone exactly (lib/server/rowSnapshots.ts); sheets recorded as
// cut stay recorded, as on the screen.

type BoardDept = "Cut" | "Welding" | "Painting" | "ShotBlast";
const BOARD_DEPTS = ["Cut", "Welding", "Painting", "ShotBlast"] as const;
const OFF = "Machine planning is switched off for the plant (Settings) — the machine board is not in use.";
const noKey = (dept: string) => `Working on ${dept}'s machine board needs its worklist key — the owner ticks it on Users & Permissions.`;
/** How far back a sheet may be recorded as cut — older is far likelier a misread. */
const DAYS_BACK = 62;

const name = (bom: string, mo: string, item: string) => `${mo || bom} ${item}`;

async function machineByCode(dept: string, code: string): Promise<Machine | null> {
  return prisma.machine.findFirst({ where: { dept, code: { equals: code.trim(), mode: "insensitive" } } });
}

/** A day a sheet or a job is recorded on: not one to come, not far back. */
function dayProblem(iso: string, todayISO: string): string | null {
  if (iso > todayISO) return `${iso} has not come yet.`;
  if (iso < addDaysISO(todayISO, -DAYS_BACK)) return `${iso} is more than ${DAYS_BACK} days back — check the date.`;
  return null;
}

async function cutBoard(ctx: ToolCtx): Promise<MachineBoardData> {
  return getMachineBoard("Cut", await getDeptBoardLines("Cut", ctx.todayISO), ctx.todayISO);
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

// ------------------------------------------------------------- reading

const runLine = (r: MachineBoardData["nestRuns"][number]) => ({
  id: r.id,
  sheet: sheetKeyLabel(sheetKeyOf(r)),
  material: r.material,
  thicknessMm: r.thicknessMm,
  sheetSize: r.sheetSize,
  sheets: r.sheets,
  sheetsDone: r.sheetsDone,
  ...(r.sheetMinutes.length ? { minutes: r.identical ? `${r.sheetMinutes[0]} a sheet` : r.sheetMinutes } : {}),
  parts: r.parts.map((p) => ({ line: name(p.bom, p.mo, p.item), bom: p.bom, mo: p.mo, item: p.item, pcs: p.pcs, cut: p.donePcs, ...(p.replaces ? { insteadOf: p.replaces } : {}) })),
  on: r.onMachines,
  boardLine: { bom: RUN_BOM, mo: runMo(r.id), item: RUN_ITEM },
  ...(r.note ? { note: r.note } : {}),
});

export const getNestRunsTool: ReadTool<Record<string, never>> = {
  kind: "read",
  name: "get_nest_runs",
  title: "Reading the nest runs",
  description:
    "The cutting floor's nest runs — sheets of one thickness, material and size carrying several jobs' parts, cut together: each open run (its sheets, how many are cut, its parts, the laser it sits on). And what a new run can be put together from: each sheet the open lines are cut from (thickness, material, size — pass them as they are to create_nest_run) with the lines that still need it, the pieces of each no machine or run holds yet (free) and the nesting's sheets per piece; then every open cutting line with the sheets its own nesting cuts it from (keys, for a run on another sheet). Also the manual jobs typed in from outside the plan. A run or a job sits in a machine's queue as a line (its boardLine) — move it up or down with move_line_in_queue, put a job on a machine or move it with assign_line_to_machine, take it off with unassign_line. Read it before create_nest_run.",
  schema: { type: "object", properties: {}, additionalProperties: false },
  status: () => "Reading the nest runs",
  async run(_i, ctx) {
    if (!(await isMachinePlanningOn())) return { ok: false, text: OFF };
    const board = await cutBoard(ctx);
    return {
      ok: true,
      text: JSON.stringify({
        openRuns: board.nestRuns.filter((r) => !r.doneAtISO).map(runLine),
        sheets: board.runOptions.slice(0, 40).map((o) => ({
          sheet: sheetKeyLabel(o.sheet), key: o.sheet, material: o.material, thicknessMm: o.thicknessMm, sheetSize: o.sheetSize,
          lines: o.lines.slice(0, 60).map((l) => ({ line: name(l.bom, l.mo, l.item), bom: l.bom, mo: l.mo, item: l.item, free: l.free, sheetsPerPiece: l.perUnit })),
        })),
        openLines: board.runCandidates.slice(0, 120).map((c) => ({
          line: name(c.bom, c.mo, c.item), bom: c.bom, mo: c.mo, item: c.item, remaining: c.remaining, free: c.free,
          ownSheets: c.sheets.map((k) => ({ key: k, sheet: sheetKeyLabel(k) })),
        })),
        manualJobs: board.manualJobs.filter((j) => !j.doneAtISO).map((j) => ({
          id: j.id, title: j.title, ...(j.bom ? { bom: j.bom } : {}), ...(j.item ? { item: j.item } : {}), qty: j.qty, done: j.doneQty, on: j.onMachines,
          boardLine: { bom: MANUAL_BOM, mo: manualMo(j.id), item: MANUAL_ITEM },
        })),
      }),
    };
  },
};

// ------------------------------------------------------------- nest runs

interface PartInput {
  bom: string;
  mo: string;
  item: string;
  pcs: number;
  replaces?: string;
}

interface RunSheet {
  material: string;
  thicknessMm: number;
  sheetSize: string;
}

const PART = {
  type: "object",
  properties: {
    bom: { type: "string", minLength: 1, maxLength: 80 },
    mo: { type: "string", maxLength: 80, description: "The line's MO (\"\" for a BOM-level line)." },
    item: { type: "string", minLength: 1, maxLength: 20, description: "CF, TC, TN, CB, AR, MB…" },
    pcs: { type: "integer", minimum: 1, maximum: 100000, description: "Pieces of it on the run's sheets." },
    replaces: { type: "string", maxLength: 120, description: "Only when the run's sheet is not one its nesting cuts it from and the nesting has several: the key of its own sheet this one stands in for (get_nest_runs → ownSheets)." },
  },
  required: ["bom", "mo", "item", "pcs"],
  additionalProperties: false,
} as const;

const SHEET_FIELDS = {
  material: { type: "string", minLength: 1, maxLength: 60, description: "The sheet's material, as get_nest_runs gives it." },
  thicknessMm: { type: "number", minimum: 0.1, maximum: 200 },
  sheetSize: { type: "string", maxLength: 40, description: "The sheet's size, as get_nest_runs gives it (\"\" when not known)." },
} as const;

const MINUTES = {
  minutesPerSheet: { type: "number", minimum: 0, maximum: 10000, description: "Cutting minutes of ONE sheet, the sheets being identical." },
  sheetMinutes: { type: "array", minItems: 1, maxItems: 500, items: { type: "number", minimum: 0, maximum: 10000 }, description: "When the sheets differ: each sheet's cutting minutes, in the order they are cut — one per sheet." },
} as const;

function parseParts(raw: unknown): PartInput[] | string {
  const parts = (raw as PartInput[]).map((p) => ({ bom: p.bom.trim(), mo: (p.mo ?? "").trim(), item: p.item.trim().toUpperCase(), pcs: p.pcs, ...(p.replaces?.trim() ? { replaces: p.replaces.trim() } : {}) }));
  const seen = new Set<string>();
  for (const p of parts) {
    const k = lineKey(p.bom, p.mo, p.item);
    if (seen.has(k)) return `${name(p.bom, p.mo, p.item)} is in the run twice — give its pieces on one row.`;
    seen.add(k);
  }
  return parts;
}

/** Minutes as the run keeps them: one figure for identical sheets, one per sheet otherwise. */
function minutesOf(i: { sheets: number; minutesPerSheet?: number; sheetMinutes?: number[] }): { identical: boolean; minutes: number[] } | string {
  if (i.minutesPerSheet !== undefined && i.sheetMinutes) return "Give the time as one sheet's minutes or as every sheet's, not both.";
  if (i.sheetMinutes) {
    if (i.sheetMinutes.length !== i.sheets) return `Give every one of the ${i.sheets} sheet(s) its minutes — ${i.sheetMinutes.length} given.`;
    return { identical: false, minutes: i.sheetMinutes };
  }
  return { identical: true, minutes: i.minutesPerSheet !== undefined ? [i.minutesPerSheet] : [] };
}

interface PlannedPart extends PartInput {
  key: string;
  replaces: string;
  remaining: number;
  held: number;
  perUnit: number | null;
  onMachine: string | null;
}

/** The run's parts checked against the cutting board, as the screen's picker
 *  offers them: each an open cutting line, its own sheet when the run's is
 *  not one its nesting uses, and no more pieces than are left of it once the
 *  other runs have theirs. Pieces queued on a machine are no bar: a run's
 *  pieces come off what the machine cuts of the line. */
function planParts(board: MachineBoardData, sheet: string, parts: readonly PartInput[], exceptRun?: number): PlannedPart[] | { error: string } {
  const held = runCover(board.nestRuns.filter((r) => !r.doneAtISO && r.id !== exceptRun));
  const codeOf = new Map(board.cards.map((c) => [c.machine.id, c.machine.code]));
  const out: PlannedPart[] = [];
  for (const p of parts) {
    const key = lineKey(p.bom, p.mo, p.item);
    const what = name(p.bom, p.mo, p.item);
    const c = board.runCandidates.find((x) => x.key === key);
    if (!c) return { error: `${what} is not an open cutting line — read get_nest_runs for the lines that still need cutting.` };
    let replaces = "";
    if (c.sheets.length > 0 && !c.sheets.includes(sheet)) {
      if (p.replaces) {
        if (!c.sheets.includes(p.replaces)) return { error: `${what}: its nesting cuts it from ${c.sheets.map(sheetKeyLabel).join(", ")} — "replaces" names one of them.` };
        replaces = p.replaces;
      } else if (c.sheets.length === 1) replaces = c.sheets[0];
      else return { error: `${what}: its nesting cuts it from ${c.sheets.map((k) => `${sheetKeyLabel(k)} (${k})`).join(", ")} — say which of them this sheet stands in for ("replaces").` };
    }
    const on = replaces || sheet;
    const heldNow = held.filter((h) => h.key === key && h.sheet === on).reduce((n, h) => n + h.pcs, 0);
    const left = Math.max(0, c.remaining - heldNow);
    if (p.pcs > left) return { error: `${what}: ${left} piece(s) of it are left for a run on ${sheetKeyLabel(on)} — it still owes ${c.remaining} and other runs hold ${heldNow}.` };
    const rate = replaces ? null : board.runOptions.find((o) => o.sheet === sheet)?.lines.find((l) => l.key === key)?.perUnit ?? null;
    const placed = board.assigned[key];
    out.push({ ...p, key, replaces, remaining: c.remaining, held: heldNow, perUnit: rate, onMachine: placed ? codeOf.get(placed.machineId) ?? null : null });
  }
  return out;
}

const partsSnapshot = (sheet: string, parts: readonly PlannedPart[]) =>
  parts.map((p) => ({ key: p.key, sheet: p.replaces || sheet, remaining: p.remaining, held: p.held })).sort((a, b) => a.key.localeCompare(b.key));

const partChange = (p: PlannedPart, sheet: string): AiChange => ({
  label: `${name(p.bom, p.mo, p.item)}${p.replaces ? ` (instead of ${sheetKeyLabel(p.replaces)})` : ""}`,
  before: `${p.remaining - p.held} left to place${p.onMachine ? ` · queued on ${p.onMachine}` : ""}`,
  after: `×${p.pcs} on the ${sheetKeyLabel(sheet)} sheets${p.onMachine ? ` (off what ${p.onMachine} cuts of it)` : ""}`,
});

async function cuttingMachine(code: string): Promise<Machine | { error: string }> {
  const m = await machineByCode("Cut", code);
  if (!m) return { error: `No cutting machine ${code}.` };
  if (!m.active) return { error: `${m.code} is retired.` };
  return m;
}

interface CreateRunInput extends RunSheet {
  sheets: number;
  minutesPerSheet?: number;
  sheetMinutes?: number[];
  note?: string;
  machine?: string;
  parts: PartInput[];
}

type Planned<T> = Promise<{ error: string } | T>;

/** Everything a new run needs, checked — what the card shows and the run is made from. */
async function planRun(i: CreateRunInput, ctx: ToolCtx): Planned<{ sheet: string; machine: Machine | null; parts: PlannedPart[]; time: { identical: boolean; minutes: number[] } }> {
  if (!(await isMachinePlanningOn())) return { error: OFF };
  if (!hasPerm(ctx.user, deptPermKey("Cut"))) return { error: noKey("Cut") };
  const time = minutesOf(i);
  if (typeof time === "string") return { error: time };
  const machine = i.machine ? await cuttingMachine(i.machine) : null;
  if (machine && "error" in machine) return machine;
  const sheet = sheetKeyOf(i);
  const board = await cutBoard(ctx);
  const parts = planParts(board, sheet, i.parts);
  if ("error" in parts) return parts;
  return { sheet, machine, parts, time };
}

export const createNestRunTool: WriteTool<CreateRunInput> = {
  kind: "write",
  name: "create_nest_run",
  title: "Put a nest run together",
  description:
    "Put a nest run together — sheets of one material, thickness and size on a laser, carrying several jobs' parts cut together (CF and TC of an order on the same sheets, …) — and queue it at the back of a cutting machine (an idle one starts on it), as the machine screen's 🧩 Nest run does. The parts' pieces come off what their machines cut of those lines. Read get_nest_runs first: the sheet's material, thickness and size as it gives them, and pieces no more than each line still needs. Undo deletes the run.",
  area: "machines",
  risk: "low",
  schema: {
    type: "object",
    properties: {
      ...SHEET_FIELDS,
      sheets: { type: "integer", minimum: 1, maximum: 500, description: "How many sheets." },
      ...MINUTES,
      note: { type: "string", maxLength: 500 },
      machine: { type: "string", maxLength: 40, description: "The cutting machine's code to queue it on; leave out to save it to the list only." },
      parts: { type: "array", minItems: 1, maxItems: 40, items: PART },
    },
    required: ["material", "thicknessMm", "sheets", "parts"],
    additionalProperties: false,
  },
  parse(r) {
    const parts = parseParts(r.parts);
    if (typeof parts === "string") return parts;
    const i = {
      material: normalizeMaterialType(r.material), thicknessMm: r.thicknessMm as number, sheetSize: normalizeSheetSize(r.sheetSize ?? ""), sheets: r.sheets as number,
      ...(r.minutesPerSheet !== undefined ? { minutesPerSheet: r.minutesPerSheet as number } : {}),
      ...(r.sheetMinutes ? { sheetMinutes: r.sheetMinutes as number[] } : {}),
      ...(typeof r.note === "string" && r.note.trim() ? { note: r.note.trim() } : {}),
      ...(typeof r.machine === "string" && r.machine.trim() ? { machine: r.machine.trim() } : {}),
      parts,
    };
    const time = minutesOf(i);
    return typeof time === "string" ? time : i;
  },
  async describe(i, ctx) {
    const plan = await planRun(i, ctx);
    if ("error" in plan) return plan;
    const { sheet, machine, parts, time } = plan;
    const est = expectedSheets(parts.map((p) => ({ pcs: p.pcs, perUnit: p.perUnit })));
    const minutes = time.minutes.length ? ` Cutting time ${minutesText(time.identical ? time.minutes[0] * i.sheets : time.minutes.reduce((s, m) => s + m, 0))}.` : "";
    return {
      title: `🧩 ${i.sheets} × ${sheetKeyLabel(sheet)}${machine ? ` on ${machine.code}` : ""}`,
      summary: `Put together a nest run of ${i.sheets} sheet(s) of ${sheetKeyLabel(sheet)} carrying ${parts.length} part(s)${machine ? `, queued at the back of ${machine.code} (an idle machine starts on it)` : " — saved to the list, on no machine yet"}.${est !== null ? ` The nesting's rates come to about ${est} sheet(s).` : ""}${minutes}`,
      changes: parts.map((p) => partChange(p, sheet)),
      snapshot: partsSnapshot(sheet, parts),
    };
  },
  async execute(i, ctx) {
    const plan = await planRun(i, ctx);
    if ("error" in plan) return { ok: false, error: plan.error };
    const { machine, parts, time } = plan;
    const r = await createNestRun(formOf({
      material: i.material, thicknessMm: i.thicknessMm, sheetSize: i.sheetSize, sheets: i.sheets, identical: time.identical, minutes: JSON.stringify(time.minutes), note: i.note ?? "",
      parts: JSON.stringify(parts.map((p) => ({ bom: p.bom, mo: p.mo, item: p.item, pcs: p.pcs, replaces: p.replaces }))),
      ...(machine ? { machineId: machine.id } : {}),
    }));
    if (!r.ok || !r.id) return { ok: false, error: r.error ?? "The run was not saved." };
    return { ok: true, message: `Nest run #${r.id} is put together${machine ? ` and queued on ${machine.code}` : ""}.`, undo: { tool: "delete_nest_run", input: { id: r.id } } };
  },
};

interface RunIdInput {
  id: number;
}

async function openRun(id: number, ctx: ToolCtx): Promise<NestRunSnapshot | { error: string }> {
  if (!(await isMachinePlanningOn())) return { error: OFF };
  const run = await readNestRun(id);
  if (!run) return { error: `No nest run #${id}.` };
  if (!hasPerm(ctx.user, deptPermKey(run.dept))) return { error: noKey(run.dept) };
  return run;
}

const runSheetLabel = (r: Pick<NestRunSnapshot, "thicknessMm" | "material" | "sheetSize">) => sheetKeyLabel(sheetKeyOf(r));

interface UpdateRunInput extends RunIdInput {
  sheets?: number;
  minutesPerSheet?: number;
  sheetMinutes?: number[];
  clearMinutes?: boolean;
  note?: string;
  machine?: string;
  material?: string;
  thicknessMm?: number;
  sheetSize?: string;
  parts?: PartInput[];
}

interface UpdatePlan {
  run: NestRunSnapshot;
  locked: boolean;
  sheets: number;
  material: string;
  thicknessMm: number;
  sheetSize: string;
  sheet: string;
  time: { identical: boolean; minutes: number[] };
  /** undefined: the machine stays; null: off every machine. */
  machine: Machine | null | undefined;
  parts: { bom: string; mo: string; item: string; pcs: number; replaces: string }[];
  planned: PlannedPart[] | null;
}

/** The run as the edit leaves it, checked: what the card shows and the form sends. */
async function planUpdate(i: UpdateRunInput, ctx: ToolCtx): Planned<UpdatePlan> {
  const run = await openRun(i.id, ctx);
  if ("error" in run) return run;
  if (run.doneAt) return { error: `Nest run #${i.id} is finished — every sheet of it is cut.` };
  const locked = run.sheetsDone > 0;
  const sheetChanges = i.material !== undefined || i.thicknessMm !== undefined || i.sheetSize !== undefined || i.parts !== undefined;
  if (locked && sheetChanges) return { error: `${run.sheetsDone} sheet(s) of run #${i.id} are cut — its sheet and its parts stay as they are; only the number of sheets, the time, the note and the machine change.` };
  const sheets = i.sheets ?? run.sheets;
  if (sheets < run.sheetsDone) return { error: `${run.sheetsDone} sheet(s) are already cut — the run cannot have fewer.` };
  const material = i.material ?? run.material;
  const thicknessMm = i.thicknessMm ?? run.thicknessMm;
  const sheetSize = i.sheetSize ?? run.sheetSize;
  const sheet = sheetKeyOf({ material, thicknessMm, sheetSize });
  // the time: as given, cleared, or as it was (one figure kept for identical sheets)
  const given = i.minutesPerSheet !== undefined || i.sheetMinutes !== undefined;
  const time = i.clearMinutes ? { identical: true, minutes: [] as number[] } : given ? minutesOf({ ...i, sheets }) : { identical: run.identical, minutes: run.identical ? run.sheetMinutes : run.sheetMinutes.slice(0, sheets) };
  if (typeof time === "string") return { error: time };
  if (!time.identical && time.minutes.length > 0 && time.minutes.length < sheets) return { error: `Give every one of the ${sheets} sheet(s) its minutes — the run has ${time.minutes.length}.` };
  let machine: Machine | null | undefined;
  if (i.machine !== undefined) {
    if (i.machine === "") machine = null;
    else {
      const m = await cuttingMachine(i.machine);
      if ("error" in m) return m;
      machine = m;
    }
  }
  let parts: { bom: string; mo: string; item: string; pcs: number; replaces: string }[] = run.parts.map((p) => ({ bom: p.bom, mo: p.mo, item: p.item, pcs: p.pcs, replaces: p.replaces }));
  let planned: PlannedPart[] | null = null;
  if (!locked && (i.parts !== undefined || i.material !== undefined || i.thicknessMm !== undefined || i.sheetSize !== undefined)) {
    const p = planParts(await cutBoard(ctx), sheet, i.parts ?? run.parts.map((x) => ({ bom: x.bom, mo: x.mo, item: x.item, pcs: x.pcs, ...(x.replaces ? { replaces: x.replaces } : {}) })), run.id);
    if ("error" in p) return p;
    planned = p;
    parts = p.map((x) => ({ bom: x.bom, mo: x.mo, item: x.item, pcs: x.pcs, replaces: x.replaces }));
  }
  return { run, locked, sheets, material, thicknessMm, sheetSize, sheet, time, machine, parts, planned };
}

export const updateNestRunTool: WriteTool<UpdateRunInput> = {
  kind: "write",
  name: "update_nest_run",
  title: "Change a nest run",
  description:
    "Change a nest run, as the machine screen's edit does. Until a sheet of it is cut anything changes — the sheet (material, thickness, size), the sheets, the time, the note, its parts (parts replaces the whole list); once sheets are cut only the number of sheets (never below those cut — cut down to them, the run is finished), the time and the note. machine moves it to the back of another cutting machine's queue (\"\" takes it off every machine). Undo puts it back as it was.",
  area: "machines",
  risk: "low",
  schema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      sheets: { type: "integer", minimum: 1, maximum: 500 },
      ...MINUTES,
      clearMinutes: { type: "boolean", description: "true: the run keeps no cutting time." },
      note: { type: "string", maxLength: 500, description: "\"\" clears it." },
      machine: { type: "string", maxLength: 40, description: "Move it to this cutting machine's queue; \"\" takes it off every machine." },
      ...SHEET_FIELDS,
      parts: { type: "array", minItems: 1, maxItems: 40, items: PART },
    },
    required: ["id"],
    additionalProperties: false,
  },
  parse(r) {
    const parts = r.parts === undefined ? undefined : parseParts(r.parts);
    if (typeof parts === "string") return parts;
    const i: UpdateRunInput = {
      id: r.id as number,
      ...(r.sheets !== undefined ? { sheets: r.sheets as number } : {}),
      ...(r.minutesPerSheet !== undefined ? { minutesPerSheet: r.minutesPerSheet as number } : {}),
      ...(r.sheetMinutes !== undefined ? { sheetMinutes: r.sheetMinutes as number[] } : {}),
      ...(r.clearMinutes ? { clearMinutes: true } : {}),
      ...(r.note !== undefined ? { note: String(r.note).trim() } : {}),
      ...(r.machine !== undefined ? { machine: String(r.machine).trim() } : {}),
      ...(r.material !== undefined ? { material: normalizeMaterialType(r.material) } : {}),
      ...(r.thicknessMm !== undefined ? { thicknessMm: r.thicknessMm as number } : {}),
      ...(r.sheetSize !== undefined ? { sheetSize: normalizeSheetSize(r.sheetSize) } : {}),
      ...(parts ? { parts } : {}),
    };
    if (i.clearMinutes && (i.minutesPerSheet !== undefined || i.sheetMinutes !== undefined)) return "Clear the time or give it, not both.";
    if (Object.keys(i).length === 1) return "Say what changes on the run.";
    return i;
  },
  async describe(i, ctx) {
    const u = await planUpdate(i, ctx);
    if ("error" in u) return u;
    const { run } = u;
    const changes: AiChange[] = [];
    const was = runSheetLabel(run);
    if (sheetKeyOf(run) !== u.sheet) changes.push({ label: "Sheet", before: was, after: sheetKeyLabel(u.sheet) });
    if (u.sheets !== run.sheets) changes.push({ label: "Sheets", before: `${run.sheets}${run.sheetsDone ? ` (${run.sheetsDone} cut)` : ""}`, after: `${u.sheets}${u.sheets === run.sheetsDone ? " — finished" : ""}` });
    const minutesLine = (identical: boolean, m: number[]) => (m.length === 0 ? "—" : identical ? `${m[0]} min a sheet` : `${m.join(", ")} min`);
    if (minutesLine(run.identical, run.sheetMinutes) !== minutesLine(u.time.identical, u.time.minutes)) changes.push({ label: "Time", before: minutesLine(run.identical, run.sheetMinutes), after: minutesLine(u.time.identical, u.time.minutes) });
    if (i.note !== undefined && (i.note || null) !== run.note) changes.push({ label: "Note", before: run.note ?? "—", after: i.note || "—" });
    if (u.machine !== undefined) {
      const now = run.queue.map((q) => q.machineId);
      changes.push({ label: "Machine", before: now.length ? (await prisma.machine.findMany({ where: { id: { in: now } }, select: { code: true } })).map((m) => m.code).join(", ") : "on no machine", after: u.machine ? `back of ${u.machine.code}'s queue` : "on no machine" });
    }
    if (u.planned) {
      const before = new Map(run.parts.map((p) => [lineKey(p.bom, p.mo, p.item), p.pcs]));
      for (const p of u.planned) changes.push({ label: name(p.bom, p.mo, p.item), before: before.has(p.key) ? `×${before.get(p.key)}` : "not on it", after: `×${p.pcs}` });
      for (const p of run.parts) if (!u.planned.some((x) => x.key === lineKey(p.bom, p.mo, p.item))) changes.push({ label: name(p.bom, p.mo, p.item), before: `×${p.pcs}`, after: "off the run" });
    }
    if (changes.length === 0) return { error: "That is how the run is already." };
    return {
      title: `Change nest run #${run.id}`,
      summary: `Change nest run #${run.id} (${run.sheets} × ${was}).${u.sheets === run.sheetsDone ? " Cut down to the sheets already cut, it is finished and leaves its machine." : ""}`,
      changes,
      snapshot: run,
    };
  },
  async execute(i, ctx) {
    const u = await planUpdate(i, ctx);
    if ("error" in u) return { ok: false, error: u.error };
    const before = u.run;
    const r = await updateNestRun(formOf({
      id: i.id, material: u.material, thicknessMm: u.thicknessMm, sheetSize: u.sheetSize, sheets: u.sheets, identical: u.time.identical, minutes: JSON.stringify(u.time.minutes),
      note: i.note !== undefined ? i.note : before.note ?? "", parts: JSON.stringify(u.parts),
      ...(u.machine !== undefined ? { machineId: u.machine ? u.machine.id : "" } : {}),
    }));
    if (!r.ok) return { ok: false, error: r.error ?? "The run was not changed." };
    return { ok: true, message: `Nest run #${i.id} is changed.`, undo: { tool: "restore_nest_run", input: { id: i.id, state: JSON.stringify(before) } } };
  },
};

export const deleteNestRunTool: WriteTool<RunIdInput> = {
  kind: "write",
  name: "delete_nest_run",
  title: "Delete a nest run",
  description: "Delete a nest run put together by mistake — only while none of its sheets is cut. Its parts go back to the lines not on a run. Undo puts it back.",
  area: "machines",
  risk: "destructive",
  schema: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false },
  async describe(i, ctx) {
    const run = await openRun(i.id, ctx);
    if ("error" in run) return run;
    if (run.sheetsDone > 0) return { error: `${run.sheetsDone} of its sheets are already cut — the run stays, with what was cut.` };
    return {
      title: `Delete nest run #${run.id}`,
      summary: `Delete nest run #${run.id}: ${run.sheets} × ${runSheetLabel(run)}${run.queue.length ? " — it comes off its machine" : ""}.`,
      changes: run.parts.map((p) => ({ label: name(p.bom, p.mo, p.item), before: `×${p.pcs} on the run`, after: "off it" })),
      snapshot: run,
    };
  },
  async execute(i) {
    const before = await readNestRun(i.id);
    if (!before) return { ok: false, error: `No nest run #${i.id}.` };
    const r = await deleteNestRun(formOf({ id: i.id }));
    if (!r.ok) return { ok: false, error: r.error ?? "The run was not deleted." };
    return { ok: true, message: `Nest run #${i.id} is deleted.`, undo: { tool: "restore_nest_run", input: { id: i.id, state: JSON.stringify(before) } } };
  },
};

interface RecordRunInput extends RunIdInput {
  sheets: number;
  machine?: string;
  date?: string;
}

async function planRecordRun(i: RecordRunInput, ctx: ToolCtx): Planned<{ run: NestRunSnapshot; date: string; machine: Machine | null }> {
  const run = await openRun(i.id, ctx);
  if ("error" in run) return run;
  if (run.doneAt) return { error: `Nest run #${i.id} is finished — every sheet of it is cut.` };
  const left = run.sheets - run.sheetsDone;
  if (i.sheets > left) return { error: `Only ${left} sheet(s) left on run #${i.id}.` };
  const date = i.date ?? ctx.todayISO;
  const bad = dayProblem(date, ctx.todayISO);
  if (bad) return { error: bad };
  // the laser that cut them: as named, else the one it sits on
  let machine: Machine | null = null;
  if (i.machine) {
    const m = await cuttingMachine(i.machine);
    if ("error" in m) return m;
    machine = m;
  } else if (run.queue.length === 1) machine = await prisma.machine.findUnique({ where: { id: run.queue[0].machineId } });
  else if (run.queue.length > 1) return { error: `Run #${i.id} sits on more than one machine — say which cut these sheets.` };
  return { run, date, machine };
}

export const recordNestRunSheetsTool: WriteTool<RecordRunInput> = {
  kind: "write",
  name: "record_nest_run_sheets",
  title: "Record sheets of a nest run as cut",
  description:
    "✓ on a nest run: these sheets are cut. Every part's pieces follow (its share of the sheets cut, the last sheet bringing each to its full count) and go on the cut log with the machine; once every sheet is cut the run leaves its machine, finished. As on the machine screen it is not undone from the chat — get the count right.",
  area: "machines",
  risk: "high",
  schema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      sheets: { type: "integer", minimum: 1, maximum: 500, description: "Sheets finished now." },
      machine: { type: "string", maxLength: 40, description: "The machine that cut them — leave out for the one the run sits on." },
      date: { type: "string", format: "date", description: "The day they were cut (default today)." },
    },
    required: ["id", "sheets"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    const p = await planRecordRun(i, ctx);
    if ("error" in p) return p;
    const { run, date, machine } = p;
    const after = run.sheetsDone + i.sheets;
    const done = partsDoneAt(run.parts, run.sheets, after);
    return {
      title: `✓ ${i.sheets} sheet(s) of nest run #${run.id}`,
      summary: `Record ${i.sheets} sheet(s) of nest run #${run.id} (${run.sheets} × ${runSheetLabel(run)}) as cut on ${date}${machine ? ` on ${machine.code}` : ""}${after >= run.sheets ? " — its last; the run is finished and leaves its machine" : ""}. Not undone from the chat.`,
      changes: [
        { label: "Sheets cut", before: `${run.sheetsDone} of ${run.sheets}`, after: `${after} of ${run.sheets}` },
        ...run.parts.map((pt) => ({ label: name(pt.bom, pt.mo, pt.item), before: `${pt.donePcs} of ${pt.pcs} cut`, after: `${done.get(pt.id) ?? pt.donePcs} of ${pt.pcs} cut` })),
      ],
      snapshot: { sheetsDone: run.sheetsDone, sheets: run.sheets, parts: run.parts.map((pt) => [pt.id, pt.pcs, pt.donePcs]) },
    };
  },
  async execute(i, ctx) {
    const p = await planRecordRun(i, ctx);
    if ("error" in p) return { ok: false, error: p.error };
    const r = await recordNestRunSheets(formOf({ id: i.id, qty: i.sheets, date: p.date, ...(p.machine ? { machineId: p.machine.id } : {}) }));
    return r.ok ? { ok: true, message: `${i.sheets} sheet(s) of nest run #${i.id} are recorded as cut.` } : { ok: false, error: r.error ?? "The sheets were not recorded." };
  },
};

interface RestoreInput {
  id: number;
  state: string;
}

const RESTORE_SCHEMA = {
  type: "object",
  properties: { id: { type: "integer", minimum: 1 }, state: { type: "string", minLength: 2, maxLength: 200_000 } },
  required: ["id", "state"],
  additionalProperties: false,
} as const;

const runState = (i: RestoreInput) =>
  stateOf<NestRunSnapshot>(i.state, i.id, (v) => typeof v.dept === "string" && Array.isArray(v.parts) && Array.isArray(v.queue) && Number.isInteger(v.sheets) && Array.isArray(v.sheetMinutes));

/** The undo of a run's change or deletion — never offered to the model. */
export const restoreNestRunTool: WriteTool<RestoreInput> = {
  kind: "write",
  name: "restore_nest_run",
  internal: true,
  title: "Put a nest run back",
  description: "Put a nest run back exactly as it was (the undo of a change to it or its deletion).",
  area: "machines",
  risk: "low",
  schema: RESTORE_SCHEMA,
  parse(r) {
    const i = { id: r.id as number, state: r.state as string };
    const s = runState(i);
    return typeof s === "string" ? s : i;
  },
  async describe(i, ctx) {
    const then = runState(i);
    if (typeof then === "string") return { error: then };
    if (!hasPerm(ctx.user, deptPermKey(then.dept))) return { error: noKey(then.dept) };
    const now = await readNestRun(i.id);
    return {
      title: `Put nest run #${i.id} back`,
      summary: `Put nest run #${i.id} (${then.sheets} × ${runSheetLabel(then)}) back as it was${now ? "" : " — it was deleted"}.`,
      changes: [{ label: `Nest run #${i.id}`, before: now ? `${now.sheets} × ${runSheetLabel(now)}, ${now.parts.length} part(s)` : "deleted", after: `${then.sheets} × ${runSheetLabel(then)}, ${then.parts.length} part(s)` }],
      snapshot: now,
    };
  },
  async execute(i) {
    const then = runState(i);
    if (typeof then === "string") return { ok: false, error: then };
    const r = await restoreNestRun(then);
    return r.ok ? { ok: true, message: `Nest run #${i.id} is back as it was.` } : { ok: false, error: r.error };
  },
};

// ------------------------------------------------------------ manual jobs

const DEPT = { type: "string", enum: [...BOARD_DEPTS], description: "The machine board it goes on: Cut (Fabrication), Welding, Painting, ShotBlast." } as const;

interface CreateJobInput {
  dept: BoardDept;
  title: string;
  qty: number;
  machine?: string;
  bom?: string;
  item?: string;
  material?: string;
  thicknessMm?: number;
  sheetSize?: string;
  sheets?: number;
  note?: string;
}

async function jobMachine(dept: string, code: string): Promise<Machine | { error: string }> {
  const m = await machineByCode(dept, code);
  if (!m) return { error: `No machine ${code} in ${dept}.` };
  if (!m.active) return { error: `${m.code} is retired.` };
  return m;
}

export const createManualJobTool: WriteTool<CreateJobInput> = {
  kind: "write",
  name: "create_manual_job",
  title: "Add a manual job",
  description:
    "Type in a job from outside the plan (a bracket, a repair, a sample …) as the machine screen's ✋ Manual job does, and put it at the back of a machine's queue (an idle machine starts on it) — or only save it to the list when no machine is given. Its pieces are counted on the job itself, never in the plan's ledger. Undo deletes it.",
  area: "machines",
  risk: "low",
  schema: {
    type: "object",
    properties: {
      dept: DEPT,
      title: { type: "string", minLength: 1, maxLength: 120, description: "What the job is, in the person's words." },
      qty: { type: "integer", minimum: 1, maximum: 100000, description: "Pieces." },
      machine: { type: "string", maxLength: 40, description: "The machine's code to queue it on; leave out to save it to the list only." },
      bom: { type: "string", maxLength: 60, description: "A BOM it belongs to, when there is one." },
      item: { type: "string", maxLength: 60, description: "The part, when there is one." },
      material: { type: "string", maxLength: 60 },
      thicknessMm: { type: "number", minimum: 0, maximum: 200 },
      sheetSize: { type: "string", maxLength: 40 },
      sheets: { type: "number", minimum: 0, maximum: 10000, description: "Sheets it takes, when known." },
      note: { type: "string", maxLength: 500 },
    },
    required: ["dept", "title", "qty"],
    additionalProperties: false,
  },
  parse(r) {
    const title = String(r.title).trim();
    if (!title) return "Say what the job is.";
    const { machine, ...rest } = r as unknown as CreateJobInput;
    return { ...rest, title, ...(typeof machine === "string" && machine.trim() ? { machine: machine.trim() } : {}) };
  },
  async describe(i, ctx) {
    if (!(await isMachinePlanningOn())) return { error: OFF };
    if (!hasPerm(ctx.user, deptPermKey(i.dept))) return { error: noKey(i.dept) };
    const machine = i.machine ? await jobMachine(i.dept, i.machine) : null;
    if (machine && "error" in machine) return machine;
    const sheet = i.thicknessMm ? ` · ${i.thicknessMm} mm ${i.material ?? ""}${i.sheets ? ` (${i.sheets} sheet(s))` : ""}` : "";
    return {
      title: `✋ ${i.title} ×${i.qty}${machine ? ` on ${machine.code}` : ""}`,
      summary: `Add the manual job "${i.title}" — ${i.qty} piece(s) on ${i.dept}'s board${machine ? `, at the back of ${machine.code}'s queue (an idle machine starts on it)` : ", saved to the list on no machine"}.`,
      changes: [{ label: i.title, before: "—", after: `×${i.qty}${i.bom ? ` · BOM ${i.bom}` : ""}${i.item ? ` · ${i.item}` : ""}${sheet}${machine ? ` · ${machine.code}` : ""}` }],
      snapshot: machine ? { machine: machine.id, active: machine.active } : null,
    };
  },
  async execute(i) {
    const machine = i.machine ? await jobMachine(i.dept, i.machine) : null;
    if (machine && "error" in machine) return { ok: false, error: machine.error };
    const r = await createManualJob(formOf({
      dept: i.dept, title: i.title, qty: i.qty, bom: i.bom, item: i.item, material: i.material, thicknessMm: i.thicknessMm, sheetSize: i.sheetSize, sheets: i.sheets, note: i.note,
      ...(machine ? { machineId: machine.id } : {}),
    }));
    if (!r.ok || !r.id) return { ok: false, error: r.error ?? "The job was not saved." };
    return { ok: true, message: `Manual job #${r.id} "${i.title}" is added${machine ? ` on ${machine.code}` : ""}.`, undo: { tool: "delete_manual_job", input: { id: r.id } } };
  },
};

async function theJob(id: number, ctx: ToolCtx): Promise<ManualJobSnapshot | { error: string }> {
  if (!(await isMachinePlanningOn())) return { error: OFF };
  const job = await readManualJob(id);
  if (!job) return { error: `No manual job #${id}.` };
  if (!hasPerm(ctx.user, deptPermKey(job.dept))) return { error: noKey(job.dept) };
  return job;
}

const jobUndo = (before: ManualJobSnapshot) => ({ tool: "restore_manual_job", input: { id: before.id, state: JSON.stringify(before) } });

interface JobDoneInput {
  id: number;
  qty: number;
  machine?: string;
}

export const recordManualJobDoneTool: WriteTool<JobDoneInput> = {
  kind: "write",
  name: "record_manual_job_done",
  title: "Record pieces of a manual job as done",
  description: "✓ on a manual job: pieces finished. They go on the job, never in the plan's ledger; when it is all done it leaves every machine and stays in the list as finished. Undo puts it back as it was.",
  area: "machines",
  risk: "low",
  schema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      qty: { type: "integer", minimum: 1, maximum: 100000 },
      machine: { type: "string", maxLength: 40, description: "The machine that made them — a fixed share on it shrinks by them." },
    },
    required: ["id", "qty"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    const job = await theJob(i.id, ctx);
    if ("error" in job) return job;
    const left = job.qty - job.doneQty;
    if (job.doneAt || left <= 0) return { error: `Manual job #${i.id} is finished.` };
    if (i.qty > left) return { error: `Only ${left} left on job #${i.id}.` };
    if (i.machine) {
      const m = await jobMachine(job.dept, i.machine);
      if ("error" in m) return m;
    }
    return {
      title: `✓ ${i.qty} of "${job.title}"`,
      summary: `Record ${i.qty} piece(s) of manual job #${job.id} "${job.title}" as done${job.doneQty + i.qty >= job.qty ? " — its last; it leaves every machine, finished" : ""}.`,
      changes: [{ label: job.title, before: `${job.doneQty} of ${job.qty} done`, after: `${job.doneQty + i.qty} of ${job.qty} done` }],
      snapshot: job,
    };
  },
  async execute(i) {
    const before = await readManualJob(i.id);
    if (!before) return { ok: false, error: `No manual job #${i.id}.` };
    const m = i.machine ? await jobMachine(before.dept, i.machine) : null;
    if (m && "error" in m) return { ok: false, error: m.error };
    const r = await recordManualDone(formOf({ id: i.id, qty: i.qty, ...(m ? { machineId: m.id } : {}) }));
    return r.ok ? { ok: true, message: `${i.qty} piece(s) of job #${i.id} are recorded as done.`, undo: jobUndo(before) } : { ok: false, error: r.error ?? "Not recorded." };
  },
};

export const reopenManualJobTool: WriteTool<{ id: number; more: number }> = {
  kind: "write",
  name: "reopen_manual_job",
  title: "Open a manual job again",
  description: "Open a finished manual job again — more pieces are wanted (more), or it was ticked by mistake (more 0); it is back in the list as open, on no machine until it is put on one. On a job still open, more adds pieces to it where it is. Undo puts it back as it was.",
  area: "machines",
  risk: "low",
  schema: {
    type: "object",
    properties: { id: { type: "integer", minimum: 1 }, more: { type: "integer", minimum: 0, maximum: 100000, description: "Extra pieces wanted (0 = none)." } },
    required: ["id", "more"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    const job = await theJob(i.id, ctx);
    if ("error" in job) return job;
    if (!job.doneAt) {
      // still open: more pieces of it, where it is
      if (i.more === 0) return { error: `Manual job #${i.id} is open already — say how many more pieces are wanted.` };
      return {
        title: `${i.more} more of "${job.title}"`,
        summary: `Add ${i.more} piece(s) to manual job #${job.id} "${job.title}" — it stays where it is.`,
        changes: [{ label: job.title, before: `${job.doneQty} of ${job.qty} done`, after: `${job.doneQty} of ${job.qty + i.more} done` }],
        snapshot: job,
      };
    }
    if (job.qty + i.more - job.doneQty <= 0) return { error: "Nothing would be left to make — add the extra pieces wanted." };
    return {
      title: `Open "${job.title}" again`,
      summary: `Open manual job #${job.id} "${job.title}" again${i.more ? ` with ${i.more} more piece(s)` : ""} — in the list as open, on no machine until it is put on one.`,
      changes: [{ label: job.title, before: `${job.doneQty} of ${job.qty} done, finished`, after: `${job.doneQty} of ${job.qty + i.more} done, open` }],
      snapshot: job,
    };
  },
  async execute(i) {
    const before = await readManualJob(i.id);
    if (!before) return { ok: false, error: `No manual job #${i.id}.` };
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
  note?: string;
}

const JOB_FIELDS = ["title", "qty", "bom", "item", "material", "thicknessMm", "sheetSize", "sheets", "note"] as const;
const JOB_FIELD_LABEL: Record<(typeof JOB_FIELDS)[number], string> = {
  title: "What it is", qty: "Pieces", bom: "BOM", item: "Part", material: "Material", thicknessMm: "Thickness (mm)", sheetSize: "Sheet size", sheets: "Sheets", note: "Note",
};
const shown = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? "—" : String(v));

/** The job as it will read after the change: what was said, the rest as it is. */
function jobAfter(job: ManualJobSnapshot, i: UpdateJobInput) {
  return {
    title: i.title ?? job.title, qty: i.qty ?? job.qty, bom: i.bom ?? job.bom, item: i.item ?? job.item, material: i.material ?? job.material,
    thicknessMm: i.thicknessMm ?? job.thicknessMm, sheetSize: i.sheetSize ?? job.sheetSize, sheets: i.sheets ?? job.sheets, note: i.note ?? job.note,
  };
}

export const updateManualJobTool: WriteTool<UpdateJobInput> = {
  kind: "write",
  name: "update_manual_job",
  title: "Change a manual job",
  description:
    "Change a manual job as it was typed, as ✎ Edit in the Manual jobs list does: what it is, the pieces wanted, its BOM and part, the sheet (material, thickness, size, sheets) and the note — only the fields given change. Where it is queued stays as it is. Pieces never below what is done; exactly what is done finishes it; more opens a finished one again, on no machine. To copy a job, use create_manual_job with its details. Undo puts it back as it was.",
  area: "machines",
  risk: "low",
  schema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      title: { type: "string", minLength: 1, maxLength: 120 },
      qty: { type: "integer", minimum: 1, maximum: 100000, description: "Pieces wanted in all (not the extra)." },
      bom: { type: "string", maxLength: 60 },
      item: { type: "string", maxLength: 60 },
      material: { type: "string", maxLength: 60 },
      thicknessMm: { type: "number", minimum: 0, maximum: 200 },
      sheetSize: { type: "string", maxLength: 40 },
      sheets: { type: "number", minimum: 0, maximum: 10000 },
      note: { type: "string", maxLength: 500 },
    },
    required: ["id"],
    additionalProperties: false,
  },
  parse(r) {
    const i = r as unknown as UpdateJobInput;
    if (typeof i.title === "string" && !i.title.trim()) return "Say what the job is.";
    if (!JOB_FIELDS.some((k) => i[k] !== undefined)) return "Say what to change on the job.";
    return { ...i, ...(typeof i.title === "string" ? { title: i.title.trim() } : {}) };
  },
  async describe(i, ctx) {
    const job = await theJob(i.id, ctx);
    if ("error" in job) return job;
    const after = jobAfter(job, i);
    const qty = editedJobQty(job.doneQty, after.qty);
    if (!qty.ok) return { error: qty.error };
    const changes = JOB_FIELDS
      .filter((k) => i[k] !== undefined && shown(job[k]) !== shown(after[k]))
      .map((k) => ({ label: JOB_FIELD_LABEL[k], before: shown(job[k]), after: shown(after[k]) }));
    if (changes.length === 0) return { error: `Manual job #${i.id} reads like that already.` };
    const state = qty.finished && !job.doneAt ? " — that is all it has done, so it is finished and leaves every machine"
      : !qty.finished && job.doneAt ? " — it opens again, on no machine until it is put on one" : "";
    return {
      title: `✎ "${job.title}"`,
      summary: `Change manual job #${job.id} "${job.title}"${state}.`,
      changes,
      snapshot: job,
    };
  },
  async execute(i) {
    const before = await readManualJob(i.id);
    if (!before) return { ok: false, error: `No manual job #${i.id}.` };
    const r = await updateManualJob(formOf({ id: i.id, ...jobAfter(before, i) }));
    return r.ok ? { ok: true, message: `Job #${i.id} is changed.`, undo: jobUndo(before) } : { ok: false, error: r.error ?? "Not changed." };
  },
};

export const deleteManualJobTool: WriteTool<{ id: number }> = {
  kind: "write",
  name: "delete_manual_job",
  title: "Delete a manual job",
  description: "Delete a manual job typed by mistake — off every machine and out of the list. Undo puts it back.",
  area: "machines",
  risk: "destructive",
  schema: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false },
  async describe(i, ctx) {
    const job = await theJob(i.id, ctx);
    if ("error" in job) return job;
    return {
      title: `Delete "${job.title}"`,
      summary: `Delete manual job #${job.id} "${job.title}" (${job.doneQty} of ${job.qty} done)${job.queue.length ? " — it comes off its machine(s)" : ""}.`,
      changes: [{ label: job.title, before: `${job.doneQty} of ${job.qty} done`, after: "deleted" }],
      snapshot: job,
    };
  },
  async execute(i) {
    const before = await readManualJob(i.id);
    if (!before) return { ok: false, error: `No manual job #${i.id}.` };
    const r = await deleteManualJob(formOf({ id: i.id }));
    return r.ok ? { ok: true, message: `Job #${i.id} is deleted.`, undo: jobUndo(before) } : { ok: false, error: r.error ?? "Not deleted." };
  },
};

const jobState = (i: RestoreInput) =>
  stateOf<ManualJobSnapshot>(i.state, i.id, (v) => typeof v.dept === "string" && typeof v.title === "string" && Number.isInteger(v.qty) && Number.isInteger(v.doneQty) && Array.isArray(v.queue));

/** The undo of a manual job's change or deletion — never offered to the model. */
export const restoreManualJobTool: WriteTool<RestoreInput> = {
  kind: "write",
  name: "restore_manual_job",
  internal: true,
  title: "Put a manual job back",
  description: "Put a manual job back exactly as it was (the undo of a change to it or its deletion).",
  area: "machines",
  risk: "low",
  schema: RESTORE_SCHEMA,
  parse(r) {
    const i = { id: r.id as number, state: r.state as string };
    const s = jobState(i);
    return typeof s === "string" ? s : i;
  },
  async describe(i, ctx) {
    const then = jobState(i);
    if (typeof then === "string") return { error: then };
    if (!hasPerm(ctx.user, deptPermKey(then.dept))) return { error: noKey(then.dept) };
    const now = await readManualJob(i.id);
    return {
      title: `Put "${then.title}" back`,
      summary: `Put manual job #${i.id} "${then.title}" back as it was${now ? "" : " — it was deleted"}.`,
      changes: [{ label: then.title, before: now ? `${now.doneQty} of ${now.qty} done` : "deleted", after: `${then.doneQty} of ${then.qty} done` }],
      snapshot: now,
    };
  },
  async execute(i) {
    const then = jobState(i);
    if (typeof then === "string") return { ok: false, error: then };
    const r = await restoreManualJob(then);
    return r.ok ? { ok: true, message: `Job #${i.id} is back as it was.` } : { ok: false, error: r.error };
  },
};

// ------------------------------------------------------- a sheet's pieces

interface SheetDoneInput {
  dept: BoardDept;
  bom: string;
  mo: string;
  item: string;
  sheet: string;
  machine: string;
  qty: number;
  date?: string;
}

async function planSheetDone(i: SheetDoneInput, ctx: ToolCtx): Planned<{ machine: Machine; row: QueueRowSnapshot; date: string }> {
  if (!(await isMachinePlanningOn())) return { error: OFF };
  const key = machineLinePermKey(i.dept, i.item);
  if (key === null || !hasPerm(ctx.user, key)) return { error: "Recording this line's sheets needs its own key — the department's worklist key for a transformer part, the LV stage's for a panel." };
  const m = await machineByCode(i.dept, i.machine);
  if (!m) return { error: `No machine ${i.machine} in ${i.dept}.` };
  const row = (await readQueueSnapshot(i.dept)).find((r) => r.bom === i.bom && r.mo === i.mo && r.item === i.item && r.machineId === m.id && r.sheet === i.sheet);
  if (!row) return { error: `${name(i.bom, i.mo, i.item)}'s ${sheetKeyLabel(i.sheet)} is not on ${m.code} — only a line spread over machines by sheet is recorded sheet by sheet.` };
  const date = i.date ?? ctx.todayISO;
  const bad = dayProblem(date, ctx.todayISO);
  if (bad) return { error: bad };
  return { machine: m, row, date };
}

export const recordSheetDoneTool: WriteTool<SheetDoneInput> = {
  kind: "write",
  name: "record_sheet_done",
  title: "Record a sheet's pieces as cut",
  description:
    "✓ on a machine card's sheet: pieces' worth of one sheet of a line spread over the machines by sheet are cut on that machine (its 3 mm on one laser, its 5 mm on another). It goes on the cut log; once every sheet of an item is cut for some pieces, those pieces are whole and can be recorded as cut (record_output). As on the machine screen it is not undone from the chat.",
  area: "machines",
  risk: "high",
  schema: {
    type: "object",
    properties: {
      dept: DEPT,
      bom: { type: "string", minLength: 1, maxLength: 80 },
      mo: { type: "string", maxLength: 80 },
      item: { type: "string", minLength: 1, maxLength: 20 },
      sheet: { type: "string", minLength: 1, maxLength: 120, description: "\"<thickness>|<material>|<size>\" as the board shows the line's sheet." },
      machine: { type: "string", minLength: 1, maxLength: 40 },
      qty: { type: "integer", minimum: 1, maximum: 100000, description: "Pieces' worth of the sheet cut." },
      date: { type: "string", format: "date", description: "The day (default today)." },
    },
    required: ["dept", "bom", "mo", "item", "sheet", "machine", "qty"],
    additionalProperties: false,
  },
  parse: (r) => ({ ...(r as unknown as SheetDoneInput), bom: String(r.bom).trim(), mo: String(r.mo ?? "").trim(), item: String(r.item).trim().toUpperCase(), sheet: String(r.sheet).trim(), machine: String(r.machine).trim() }),
  async describe(i, ctx) {
    const p = await planSheetDone(i, ctx);
    if ("error" in p) return p;
    return {
      title: `✓ ${i.qty} × ${sheetKeyLabel(i.sheet)} — ${name(i.bom, i.mo, i.item)} on ${p.machine.code}`,
      summary: `Record ${i.qty} piece(s)' worth of ${name(i.bom, i.mo, i.item)}'s ${sheetKeyLabel(i.sheet)} as cut on ${p.machine.code} on ${p.date}. Not undone from the chat.`,
      changes: [{ label: `${name(i.bom, i.mo, i.item)} ${sheetKeyLabel(i.sheet)} on ${p.machine.code}`, before: `${p.row.sheetDone} cut`, after: `${p.row.sheetDone + i.qty} cut` }],
      snapshot: { sheetDone: p.row.sheetDone },
    };
  },
  async execute(i, ctx) {
    const p = await planSheetDone(i, ctx);
    if ("error" in p) return { ok: false, error: p.error };
    const r = await recordSheetDone(formOf({ dept: i.dept, bom: i.bom, mo: i.mo, item: i.item, sheet: i.sheet, machineId: p.machine.id, qty: i.qty, date: p.date }));
    return r.ok ? { ok: true, message: `${i.qty} piece(s)' worth of ${sheetKeyLabel(i.sheet)} recorded as cut on ${p.machine.code}.` } : { ok: false, error: r.error ?? "Not recorded." };
  },
};

export const CUT_FLOOR_TOOLS = [
  getNestRunsTool,
  createNestRunTool,
  updateNestRunTool,
  deleteNestRunTool,
  recordNestRunSheetsTool,
  restoreNestRunTool,
  createManualJobTool,
  updateManualJobTool,
  recordManualJobDoneTool,
  reopenManualJobTool,
  deleteManualJobTool,
  restoreManualJobTool,
  recordSheetDoneTool,
] as const;
