import { beforeEach, describe, expect, it, vi } from "vitest";

// The assistant's job tools (lib/server/ai/tools/cutFloor.ts): the
// fabrication board's SHEET JOBS (sheets of one thickness carrying several
// projects' parts, closed in sheets) and the other boards' jobs in pieces —
// what each card says, which of the machine screen's own actions it runs with
// what, and how it is undone — against a stubbed database, board and actions.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: { machine: { findFirst: fn(), findUnique: fn(), findMany: fn() }, masterOrder: { findMany: fn() } },
    perms: new Set<string>(),
    planningOn: true,
    board: null as unknown,
    snaps: { readManualJob: fn(), restoreManualJob: fn() },
    jobs: { createManualJob: fn(), updateManualJob: fn(), recordManualDone: fn(), reopenManualJob: fn(), deleteManualJob: fn() },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ hasPerm: (_u: unknown, k: string) => h.perms.has(k) }));
vi.mock("@/lib/server/data", () => ({ isMachinePlanningOn: async () => h.planningOn }));
vi.mock("@/lib/server/machineBoard", () => ({ getDeptBoardLines: async () => [], getMachineBoard: async () => h.board }));
vi.mock("@/lib/server/rowSnapshots", () => h.snaps);
vi.mock("@/app/worklist/manualActions", () => h.jobs);

import type { User } from "@prisma/client";
import type { ToolCtx } from "@/lib/server/ai/tools/types";
import type { ManualJobSnapshot } from "@/lib/server/rowSnapshots";
import {
  createManualJobTool, deleteManualJobTool, getJobsTool, recordManualJobDoneTool, reopenManualJobTool, updateManualJobTool,
} from "@/lib/server/ai/tools/cutFloor";
import { checkToolInput, toolsFor } from "@/lib/server/ai/tools";

const ctx: ToolCtx = { user: { id: 1, name: "Sara" } as User, hidden: new Set(), now: new Date("2026-10-12T08:00:00Z"), todayISO: "2026-10-12", conversationId: 1, automationId: null };
const L1 = { id: 1, code: "B4-10", name: "Laser", dept: "Cut", center: "Cutting", active: true };
const L2 = { id: 2, code: "B4-09", name: "Laser 2", dept: "Cut", center: "Cutting", active: true };
const W1 = { id: 5, code: "Z1", name: "Zone 1", dept: "Welding", center: "Zone", active: true };

const parsed = <I>(tool: Parameters<typeof checkToolInput<I>>[0], raw: unknown): I => {
  const c = checkToolInput<I>(tool, raw);
  if (!c.ok) throw new Error(c.error);
  return c.input;
};
const fd = (m: ReturnType<typeof vi.fn>, call = 0) => Object.fromEntries((m.mock.calls[call][0] as FormData).entries());

const PARTS = [
  { id: 1, bom: "B1", item: "TN", part: "Bottom", pcs: 4 },
  { id: 2, bom: "B2", item: "TN", part: "Side wall", pcs: 8 },
];
/** A sheet job: 10 sheets of 3 mm steel, 4 of them cut. */
const sheetJob = (o: Partial<ManualJobSnapshot> = {}): ManualJobSnapshot => ({
  id: 12, dept: "Cut", title: "", bom: "", item: "", qty: 10, doneQty: 4, bySheet: true, parts: PARTS,
  material: "Steel", thicknessMm: 3, sheetSize: "1250*2500", sheets: null, note: null,
  machineId: 1, createdBy: "Sara", createdAt: "2026-10-11T07:00:00.000Z", doneAt: null, queue: [], ...o,
});
/** A welding job from outside the plan, in pieces. */
const pieceJob = (o: Partial<ManualJobSnapshot> = {}): ManualJobSnapshot => ({
  id: 20, dept: "Welding", title: "Brackets", bom: "", item: "", qty: 20, doneQty: 5, bySheet: false, parts: [],
  material: "", thicknessMm: null, sheetSize: "", sheets: null, note: null,
  machineId: 5, createdBy: "Sara", createdAt: "2026-10-11T07:00:00.000Z", doneAt: null, queue: [], ...o,
});

const CUT_RAW = {
  dept: "Cut", qty: 10, machine: "b4-10", thicknessMm: 3, material: "Steel", sheetSize: "1250*2500",
  parts: [{ bom: "b1", item: "TN", part: "Bottom", pcs: 4 }, { bom: "B2", item: "TN", part: "Side wall", pcs: 8 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.perms.clear();
  h.perms.add("cut.edit");
  h.planningOn = true;
  h.prisma.machine.findFirst.mockImplementation(async ({ where }: { where: { dept: string; code: { equals: string } } }) =>
    [L1, L2, W1].find((m) => m.dept === where.dept && m.code.toLowerCase() === where.code.equals.toLowerCase()) ?? null);
  // the plan knows B1 and B2 — as the plan spells them
  h.prisma.masterOrder.findMany.mockImplementation(async ({ where }: { where: { OR: { bom: { equals: string } }[] } }) =>
    ["B1", "B2"].filter((b) => where.OR.some((o) => o.bom.equals.toUpperCase() === b)).map((bom) => ({ bom })));
  h.board = {
    cards: [
      { machine: L1, queue: [{ bom: "MANUAL", mo: "MANUAL-12", item: "JOB", rank: 1, running: true, remaining: 6, split: false, lineRemaining: 6 }] },
      { machine: L2, queue: [] },
    ],
    manualJobs: [
      { id: 12, dept: "Cut", title: "", bom: "", item: "", qty: 10, doneQty: 4, bySheet: true, parts: PARTS, material: "Steel", thicknessMm: 3, sheetSize: "1250*2500", sheets: null, note: null, onMachines: ["B4-10"], lastMachine: "B4-10", createdBy: "Sara", createdAtISO: "", doneAtISO: null },
    ],
    jobBoms: ["B1", "B2"],
  };
  for (const f of Object.values(h.jobs)) f.mockResolvedValue({ ok: true });
  h.jobs.createManualJob.mockResolvedValue({ ok: true, id: 13 });
  h.snaps.readManualJob.mockResolvedValue(sheetJob());
});

describe("get_jobs", () => {
  it("gives each machine's sheets queued, every open sheet job with its sheet and parts, and the open projects", async () => {
    const r = await getJobsTool.run({}, ctx);
    expect(r.ok).toBe(true);
    const out = JSON.parse(r.text);
    expect(out.countedIn).toBe("sheets");
    expect(out.machines).toEqual([
      { code: "B4-10", name: "Laser", center: "Cutting", active: true, jobsQueued: 6, otherLines: 0, jobs: [{ rank: 1, running: true, id: 12, here: 6 }] },
      { code: "B4-09", name: "Laser 2", center: "Cutting", active: true, jobsQueued: 0, otherLines: 0, jobs: [] },
    ]);
    expect(out.openJobs).toEqual([expect.objectContaining({
      id: 12, name: "3 mm MS 1250×2500", sheets: 10, sheetsCut: 4, on: ["B4-10"],
      parts: [{ bom: "B1", item: "TN", part: "Bottom", pcs: 4 }, { bom: "B2", item: "TN", part: "Side wall", pcs: 8 }],
      boardLine: { bom: "MANUAL", mo: "MANUAL-12", item: "JOB" },
    })]);
    expect(out.openProjects).toEqual(["B1", "B2"]);
  });

  it("says so while machine planning is off", async () => {
    h.planningOn = false;
    expect(await getJobsTool.run({}, ctx)).toEqual({ ok: false, text: expect.stringContaining("switched off") });
  });
});

describe("create_manual_job — a sheet job on Cut", () => {
  it("takes a part without its count — the count is the person's to give", async () => {
    const i = parsed(createManualJobTool, { ...CUT_RAW, parts: [{ bom: "B1", item: "TN", part: "Bottom" }] });
    expect(await createManualJobTool.describe(i, ctx)).toMatchObject({ changes: [{ after: "10 sheet(s) — B1 TN Bottom · B4-10" }] });
  });

  it("needs the sheet's thickness and material and at least one part", () => {
    expect(checkToolInput(createManualJobTool, { ...CUT_RAW, thicknessMm: undefined })).toMatchObject({ ok: false, error: expect.stringContaining("thickness") });
    expect(checkToolInput(createManualJobTool, { ...CUT_RAW, material: " " })).toMatchObject({ ok: false, error: expect.stringContaining("material") });
    expect(checkToolInput(createManualJobTool, { ...CUT_RAW, parts: [] })).toMatchObject({ ok: false, error: expect.stringContaining("at least one") });
  });

  it("refuses a BOM the plan does not carry, and the board's key", async () => {
    const bad = parsed(createManualJobTool, { ...CUT_RAW, parts: [{ bom: "ZZ9", item: "TN", part: "Bottom", pcs: 1 }] });
    expect(await createManualJobTool.describe(bad, ctx)).toEqual({ error: expect.stringContaining("ZZ9 is no project in the plan") });
    h.perms.clear();
    expect(await createManualJobTool.describe(parsed(createManualJobTool, CUT_RAW), ctx)).toEqual({ error: expect.stringContaining("Cut's machine board needs its worklist key") });
  });

  it("shows the sheets and every part, runs the screen's own action with the parts, and is undone by deleting it", async () => {
    const i = parsed(createManualJobTool, CUT_RAW);
    expect(await createManualJobTool.describe(i, ctx)).toMatchObject({
      title: "🧾 10 × 3 mm MS 1250×2500 on B4-10",
      summary: expect.stringContaining("10 sheet(s) of 3 mm MS 1250×2500 carrying 2 part(s), at the back of B4-10's queue"),
      changes: [{ label: "3 mm MS 1250×2500", before: "—", after: "10 sheet(s) — B1 TN Bottom ×4 · B2 TN Side wall ×8 · B4-10" }],
    });
    const out = await createManualJobTool.execute(i, ctx);
    expect(fd(h.jobs.createManualJob)).toEqual({
      dept: "Cut", title: "", qty: "10", material: "Steel", thicknessMm: "3", sheetSize: "1250*2500", machineId: "1",
      parts: JSON.stringify(CUT_RAW.parts),
    });
    expect(out).toEqual({ ok: true, message: "Job #13 is added on B4-10.", undo: { tool: "delete_manual_job", input: { id: 13 } } });
  });

  it("off Cut it is a job from outside the plan in pieces, with a title", async () => {
    h.perms.add("welding.edit");
    expect(checkToolInput(createManualJobTool, { dept: "Welding", qty: 4, title: "  " })).toMatchObject({ ok: false, error: "Say what the job is." });
    const i = parsed(createManualJobTool, { dept: "Welding", title: " Lifting lugs ", qty: 4, machine: "Z1" });
    expect(await createManualJobTool.describe(i, ctx)).toMatchObject({ summary: expect.stringContaining('"Lifting lugs" — 4 piece(s)') });
    await createManualJobTool.execute(i, ctx);
    expect(fd(h.jobs.createManualJob)).toEqual({ dept: "Welding", title: "Lifting lugs", qty: "4", machineId: "5" });
  });
});

describe("record_manual_job_done — sheets cut", () => {
  it("counts sheets, no more than are left, on a day that has come, and is undone exactly", async () => {
    expect(await recordManualJobDoneTool.describe({ id: 12, qty: 7 }, ctx)).toEqual({ error: "Only 6 sheet(s) left on job #12." });
    expect(await recordManualJobDoneTool.describe({ id: 12, qty: 2, date: "2026-10-13" }, ctx)).toEqual({ error: expect.stringContaining("has not come yet") });
    expect(await recordManualJobDoneTool.describe({ id: 12, qty: 6, machine: "B4-10" }, ctx)).toMatchObject({
      summary: expect.stringContaining("6 sheet(s) of job #12"),
      changes: [{ before: "4 of 10 sheets cut", after: "10 of 10 sheets cut" }],
    });
    const out = await recordManualJobDoneTool.execute({ id: 12, qty: 2, machine: "B4-10" }, ctx);
    expect(fd(h.jobs.recordManualDone)).toEqual({ id: "12", qty: "2", date: "2026-10-12", machineId: "1" });
    expect(out).toEqual({ ok: true, message: "2 sheet(s) of job #12 are recorded.", undo: { tool: "restore_manual_job", input: { id: 12, state: JSON.stringify(sheetJob()) } } });
  });

  it("a fabrication job left from the pieces days is kept as it was", async () => {
    h.snaps.readManualJob.mockResolvedValue(sheetJob({ bySheet: false, parts: [], title: "Old" }));
    expect(await recordManualJobDoneTool.describe({ id: 12, qty: 1 }, ctx)).toEqual({ error: expect.stringContaining("typed in pieces") });
    expect(await reopenManualJobTool.describe({ id: 12, more: 1 }, ctx)).toEqual({ error: expect.stringContaining("typed in pieces") });
  });
});

describe("update_manual_job", () => {
  it("changes a sheet job's sheets and parts, refuses fields a sheet job has not, and is undone exactly", async () => {
    expect(checkToolInput(updateManualJobTool, { id: 12 })).toMatchObject({ ok: false, error: expect.stringContaining("Say what to change") });
    expect(await updateManualJobTool.describe(parsed(updateManualJobTool, { id: 12, bom: "B1" }), ctx)).toEqual({ error: expect.stringContaining("has no bom to change") });
    expect(await updateManualJobTool.describe(parsed(updateManualJobTool, { id: 12, qty: 3 }), ctx)).toEqual({ error: expect.stringContaining("4 sheet(s) are cut already") });
    const input = parsed(updateManualJobTool, { id: 12, qty: 12, parts: [{ bom: "B1", item: "TN", part: "Bottom", pcs: 6 }] });
    expect(await updateManualJobTool.describe(input, ctx)).toMatchObject({
      summary: 'Change job #12 "3 mm MS 1250×2500".',
      changes: [{ label: "Sheets", before: "10", after: "12" }, { label: "Parts on the sheets", before: "B1 TN Bottom ×4 · B2 TN Side wall ×8", after: "B1 TN Bottom ×6" }],
    });
    const out = await updateManualJobTool.execute(input, ctx);
    expect(fd(h.jobs.updateManualJob)).toEqual({
      id: "12", title: "", qty: "12", bom: "", item: "", material: "Steel", thicknessMm: "3", sheetSize: "1250*2500",
      parts: JSON.stringify([{ bom: "B1", item: "TN", part: "Bottom", pcs: 6 }]),
    });
    expect(out).toEqual({ ok: true, message: "Job #12 is changed.", undo: { tool: "restore_manual_job", input: { id: 12, state: JSON.stringify(sheetJob()) } } });
  });

  it("a job in pieces keeps its own fields and words", async () => {
    h.perms.add("welding.edit");
    h.snaps.readManualJob.mockResolvedValue(pieceJob());
    expect(await updateManualJobTool.describe(parsed(updateManualJobTool, { id: 20, title: "Brackets" }), ctx)).toEqual({ error: expect.stringContaining("reads like that already") });
    expect(await updateManualJobTool.describe({ id: 20, qty: 4 }, ctx)).toEqual({ error: expect.stringContaining("5 piece(s) are done already") });
    expect(await updateManualJobTool.describe(parsed(updateManualJobTool, { id: 20, qty: 30, note: "for maintenance" }), ctx)).toMatchObject({
      changes: [{ label: "Pieces", before: "20", after: "30" }, { label: "Note", before: "—", after: "for maintenance" }],
    });
    h.snaps.readManualJob.mockResolvedValue(pieceJob({ doneQty: 20, doneAt: "2026-10-11T12:00:00.000Z" }));
    expect(await reopenManualJobTool.describe({ id: 20, more: 5 }, ctx)).toMatchObject({ changes: [{ before: "20 of 20 done, finished", after: "20 of 25 done, open" }] });
    expect(await updateManualJobTool.describe({ id: 20, qty: 25 }, ctx)).toMatchObject({ summary: expect.stringContaining("it opens again, on no machine") });
  });
});

describe("delete_manual_job", () => {
  it("is a deletion, undone by putting the job back", async () => {
    expect(deleteManualJobTool.risk).toBe("destructive");
    expect(await deleteManualJobTool.describe({ id: 12 }, ctx)).toMatchObject({ summary: expect.stringContaining("(4 of 10 sheets cut)") });
    expect(await deleteManualJobTool.execute({ id: 12 }, ctx)).toMatchObject({ ok: true, undo: { tool: "restore_manual_job" } });
  });
});

describe("what the assistant is offered", () => {
  it("the jobs and their distribution, never the restores; the deletions only with the deletions key; no nest runs", () => {
    const names = (perms: string[]) => {
      h.perms.clear();
      for (const k of perms) h.perms.add(k);
      return toolsFor({ id: 1, isAdmin: false, isOwner: false } as User, { hidden: new Set(), actionsPaused: false }).map((t) => t.name);
    };
    const without = names(["ai.act.machines"]);
    expect(without).toEqual(expect.arrayContaining(["get_jobs", "create_manual_job", "update_manual_job", "record_manual_job_done", "assign_lines_to_machines", "plan_machines"]));
    expect(without).not.toContain("delete_manual_job");
    expect(without).not.toContain("restore_manual_job");
    for (const gone of ["get_nest_runs", "create_nest_run", "record_nest_run_sheets", "record_sheet_done"]) expect(without).not.toContain(gone);
    expect(names(["ai.act.machines", "ai.act.delete"])).toContain("delete_manual_job");
  });
});
