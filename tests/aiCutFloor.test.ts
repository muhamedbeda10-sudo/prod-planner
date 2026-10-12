import { beforeEach, describe, expect, it, vi } from "vitest";

// The assistant's cutting-floor tools (lib/server/ai/tools/cutFloor.ts): nest
// runs, manual jobs and a sheet's pieces cut — what each card says, which of
// the machine screen's own actions it runs with what, and how it is undone —
// against a stubbed database, board and actions.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: { machine: { findFirst: fn(), findUnique: fn(), findMany: fn() } },
    perms: new Set<string>(),
    planningOn: true,
    board: null as unknown,
    readQueueSnapshot: fn(),
    snaps: { readNestRun: fn(), readManualJob: fn(), restoreNestRun: fn(), restoreManualJob: fn() },
    runs: { createNestRun: fn(), updateNestRun: fn(), deleteNestRun: fn(), recordNestRunSheets: fn() },
    jobs: { createManualJob: fn(), recordManualDone: fn(), reopenManualJob: fn(), deleteManualJob: fn() },
    recordSheetDone: fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ hasPerm: (_u: unknown, k: string) => h.perms.has(k) }));
vi.mock("@/lib/server/data", () => ({ isMachinePlanningOn: async () => h.planningOn }));
vi.mock("@/lib/server/machineBoard", () => ({ getDeptBoardLines: async () => [], getMachineBoard: async () => h.board }));
vi.mock("@/lib/server/machineQueues", () => ({ readQueueSnapshot: h.readQueueSnapshot }));
vi.mock("@/lib/server/rowSnapshots", () => h.snaps);
vi.mock("@/app/worklist/nestRunActions", () => h.runs);
vi.mock("@/app/worklist/manualActions", () => h.jobs);
vi.mock("@/app/worklist/machineActions", () => ({ recordSheetDone: h.recordSheetDone }));

import type { User } from "@prisma/client";
import type { ToolCtx } from "@/lib/server/ai/tools/types";
import type { NestRunSnapshot, ManualJobSnapshot } from "@/lib/server/rowSnapshots";
import {
  createManualJobTool, createNestRunTool, deleteManualJobTool, deleteNestRunTool, getNestRunsTool, recordManualJobDoneTool, recordNestRunSheetsTool, recordSheetDoneTool,
  reopenManualJobTool, restoreNestRunTool, updateNestRunTool,
} from "@/lib/server/ai/tools/cutFloor";
import { checkToolInput, toolsFor } from "@/lib/server/ai/tools";

const ctx: ToolCtx = { user: { id: 1, name: "Sara" } as User, hidden: new Set(), now: new Date("2026-10-12T08:00:00Z"), todayISO: "2026-10-12", conversationId: 1, automationId: null };
const L1 = { id: 1, code: "B4-10", name: "Laser", dept: "Cut", center: "Cutting", active: true };
const L2 = { id: 2, code: "B4-09", name: "Laser 2", dept: "Cut", center: "Cutting", active: true };
// the MATERIAL tab keeps a material by its one name — "mild steel" is Steel
const S3 = "3|Steel|1250*2500";
const S4 = "4|Steel|1250*2500";
const S5 = "5|Steel|1250*2500";

const parsed = <I>(tool: Parameters<typeof checkToolInput<I>>[0], raw: unknown): I => {
  const c = checkToolInput<I>(tool, raw);
  if (!c.ok) throw new Error(c.error);
  return c.input;
};
const fd = (m: ReturnType<typeof vi.fn>, call = 0) => Object.fromEntries((m.mock.calls[call][0] as FormData).entries());

const run = (o: Partial<NestRunSnapshot> = {}): NestRunSnapshot => ({
  id: 7, dept: "Cut", material: "Steel", thicknessMm: 3, sheetSize: "1250*2500", sheets: 5, sheetsDone: 0, identical: true, sheetMinutes: [], note: null,
  createdBy: "Sara", createdAt: "2026-10-11T07:00:00.000Z", doneAt: null,
  parts: [{ id: 70, bom: "B1", mo: "M1", item: "CF", pcs: 10, donePcs: 0, consumedPcs: 0, replaces: "" }],
  queue: [{ id: 900, machineId: 1, rank: 2, running: false, qty: null, sheet: "", sheetDone: 0, setBy: "Sara" }],
  ...o,
});
const job = (o: Partial<ManualJobSnapshot> = {}): ManualJobSnapshot => ({
  id: 12, dept: "Cut", title: "Brackets", bom: "", item: "", qty: 20, doneQty: 5, material: "", thicknessMm: null, sheetSize: "", sheets: null, note: null,
  machineId: 1, createdBy: "Sara", createdAt: "2026-10-11T07:00:00.000Z", doneAt: null, queue: [], ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.perms.clear();
  h.perms.add("cut.edit");
  h.planningOn = true;
  h.prisma.machine.findFirst.mockImplementation(async ({ where }: { where: { dept: string; code: { equals: string } } }) =>
    [L1, L2].find((m) => m.dept === where.dept && m.code.toLowerCase() === where.code.equals.toLowerCase()) ?? null);
  h.prisma.machine.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) => [L1, L2].find((m) => m.id === where.id) ?? null);
  h.prisma.machine.findMany.mockResolvedValue([{ code: "B4-10" }]);
  h.board = {
    cards: [{ machine: L1 }, { machine: L2 }],
    assigned: { "B1|M1|CF": { machineId: 1 } },
    nestRuns: [
      // another open run already holds 4 of M2 TC on the 3 mm
      { id: 3, material: "Steel", thicknessMm: 3, sheetSize: "1250*2500", sheets: 2, sheetsDone: 0, identical: true, sheetMinutes: [], note: null, doneAtISO: null, onMachines: ["B4-09"], machineIds: [2],
        parts: [{ id: 30, bom: "B2", mo: "M2", item: "TC", pcs: 4, donePcs: 0, consumedPcs: 0, replaces: "" }], createdBy: null, createdAtISO: "" },
    ],
    runOptions: [{ sheet: S3, material: "Steel", thicknessMm: 3, sheetSize: "1250*2500", lines: [{ key: "B1|M1|CF", bom: "B1", mo: "M1", item: "CF", free: 0, perUnit: 0.25 }, { key: "B2|M2|TC", bom: "B2", mo: "M2", item: "TC", free: 6, perUnit: 0.1 }] }],
    runCandidates: [
      { key: "B1|M1|CF", bom: "B1", mo: "M1", item: "CF", remaining: 12, free: 0, sheets: [S3] },
      { key: "B2|M2|TC", bom: "B2", mo: "M2", item: "TC", remaining: 10, free: 6, sheets: [S3] },
      { key: "B3|M3|CB", bom: "B3", mo: "M3", item: "CB", remaining: 8, free: 8, sheets: [S4, S5] },
    ],
    manualJobs: [{ id: 12, title: "Brackets", bom: "", item: "", qty: 20, doneQty: 5, onMachines: ["B4-10"], doneAtISO: null }],
  };
  for (const f of [...Object.values(h.runs), ...Object.values(h.jobs), h.recordSheetDone]) f.mockResolvedValue({ ok: true });
  h.runs.createNestRun.mockResolvedValue({ ok: true, id: 8 });
  h.jobs.createManualJob.mockResolvedValue({ ok: true, id: 13 });
  h.snaps.readNestRun.mockResolvedValue(run());
  h.snaps.readManualJob.mockResolvedValue(job());
  h.snaps.restoreNestRun.mockResolvedValue({ ok: true });
});

describe("get_nest_runs", () => {
  it("gives the open runs, each sheet the open lines need with what is free on it, every open line's own sheets, and the manual jobs", async () => {
    const r = await getNestRunsTool.run({}, ctx);
    expect(r.ok).toBe(true);
    const out = JSON.parse(r.text);
    expect(out.openRuns[0]).toMatchObject({ id: 3, sheets: 2, on: ["B4-09"], parts: [{ line: "M2 TC", pcs: 4, cut: 0 }], boardLine: { bom: "RUN", mo: "RUN-3", item: "SHEET" } });
    expect(out.sheets[0]).toMatchObject({ key: S3, material: "Steel", thicknessMm: 3, sheetSize: "1250*2500", lines: [{ line: "M1 CF", free: 0, sheetsPerPiece: 0.25 }, { line: "M2 TC", free: 6 }] });
    expect(out.openLines[2]).toMatchObject({ line: "M3 CB", ownSheets: [{ key: S4 }, { key: S5 }] });
    // a job sits in a queue as a line — moved, reordered or taken off by the board's own tools
    expect(out.manualJobs).toEqual([{ id: 12, title: "Brackets", qty: 20, done: 5, on: ["B4-10"], boardLine: { bom: "MANUAL", mo: "MANUAL-12", item: "JOB" } }]);
    h.planningOn = false;
    expect((await getNestRunsTool.run({}, ctx)).ok).toBe(false);
  });
});

describe("create_nest_run", () => {
  const raw = { material: "mild steel", thicknessMm: 3, sheetSize: "1250 x 2500", sheets: 3, machine: "b4-10", parts: [{ bom: "B1", mo: "M1", item: "cf", pcs: 8 }, { bom: "B2", mo: "M2", item: "TC", pcs: 6 }] };

  it("reads the sheet as the screen keeps it, and refuses a line twice or a time given both ways", () => {
    const i = parsed<Parameters<typeof createNestRunTool.describe>[0]>(createNestRunTool, raw);
    expect(i).toMatchObject({ material: "Steel", sheetSize: "1250*2500", machine: "b4-10", parts: [{ item: "CF" }, { item: "TC" }] });
    expect(checkToolInput(createNestRunTool, { ...raw, parts: [raw.parts[0], { ...raw.parts[0], pcs: 1 }] })).toMatchObject({ ok: false, error: expect.stringContaining("in the run twice") });
    expect(checkToolInput(createNestRunTool, { ...raw, minutesPerSheet: 9, sheetMinutes: [9, 9, 9] })).toMatchObject({ ok: false, error: expect.stringContaining("not both") });
    expect(checkToolInput(createNestRunTool, { ...raw, sheetMinutes: [9, 9] })).toMatchObject({ ok: false, error: expect.stringContaining("every one of the 3") });
  });

  it("needs the cutting worklist's key and the board in use", async () => {
    const i = parsed<Parameters<typeof createNestRunTool.describe>[0]>(createNestRunTool, raw);
    h.perms.clear();
    expect(await createNestRunTool.describe(i, ctx)).toEqual({ error: expect.stringContaining("needs its worklist key") });
    h.perms.add("cut.edit");
    h.planningOn = false;
    expect(await createNestRunTool.describe(i, ctx)).toEqual({ error: expect.stringContaining("switched off") });
  });

  it("takes only open lines, no more pieces than other runs leave, and asks which own sheet a part stands in for", async () => {
    const bad = (parts: unknown[]) => createNestRunTool.describe(parsed(createNestRunTool, { ...raw, parts }), ctx);
    expect(await bad([{ bom: "B9", mo: "M9", item: "CF", pcs: 1 }])).toEqual({ error: expect.stringContaining("M9 CF is not an open cutting line") });
    // M2 TC still owes 10, another run holds 4 of it on the 3 mm
    expect(await bad([{ bom: "B2", mo: "M2", item: "TC", pcs: 7 }])).toEqual({ error: "M2 TC: 6 piece(s) of it are left for a run on 3 mm MS 1250×2500 — it still owes 10 and other runs hold 4." });
    expect(await bad([{ bom: "B3", mo: "M3", item: "CB", pcs: 2 }])).toEqual({ error: expect.stringContaining("say which of them this sheet stands in for") });
    expect(await bad([{ bom: "B3", mo: "M3", item: "CB", pcs: 2, replaces: S3 }])).toEqual({ error: expect.stringContaining('"replaces" names one of them') });
  });

  it("shows each part and where it is queued now, the nesting's own sheets, and relies on what is left of its lines", async () => {
    const p = await createNestRunTool.describe(parsed(createNestRunTool, { ...raw, minutesPerSheet: 12 }), ctx);
    expect(p).toMatchObject({
      title: "🧩 3 × 3 mm MS 1250×2500 on B4-10",
      summary: expect.stringContaining("about 2.6 sheet(s)"),
      changes: [
        { label: "M1 CF", before: "12 left to place · queued on B4-10", after: "×8 on the 3 mm MS 1250×2500 sheets (off what B4-10 cuts of it)" },
        { label: "M2 TC", before: "6 left to place", after: "×6 on the 3 mm MS 1250×2500 sheets" },
      ],
      snapshot: [{ key: "B1|M1|CF", sheet: S3, remaining: 12, held: 0 }, { key: "B2|M2|TC", sheet: S3, remaining: 10, held: 4 }],
    });
    expect("summary" in p && p.summary).toContain("Cutting time 36 min");
  });

  it("a part on another thickness stands in for its own sheet", async () => {
    const p = await createNestRunTool.describe(parsed(createNestRunTool, { ...raw, thicknessMm: 4, parts: [{ bom: "B1", mo: "M1", item: "CF", pcs: 2 }, { bom: "B3", mo: "M3", item: "CB", pcs: 2 }] }), ctx);
    expect(p).toMatchObject({ changes: [{ label: "M1 CF (instead of 3 mm MS 1250×2500)" }, { label: "M3 CB" }] });
  });

  it("runs the screen's own action and is undone by deleting the run", async () => {
    const out = await createNestRunTool.execute(parsed(createNestRunTool, { ...raw, thicknessMm: 4, sheetMinutes: [10, 11, 12], parts: [{ bom: "B1", mo: "M1", item: "CF", pcs: 2 }] }), ctx);
    expect(fd(h.runs.createNestRun)).toEqual({
      material: "Steel", thicknessMm: "4", sheetSize: "1250*2500", sheets: "3", identical: "false", minutes: "[10,11,12]", note: "",
      parts: JSON.stringify([{ bom: "B1", mo: "M1", item: "CF", pcs: 2, replaces: S3 }]), machineId: "1",
    });
    expect(out).toEqual({ ok: true, message: "Nest run #8 is put together and queued on B4-10.", undo: { tool: "delete_nest_run", input: { id: 8 } } });
  });
});

describe("update_nest_run", () => {
  it("once sheets are cut, keeps the sheet and the parts and never goes below what is cut", async () => {
    h.snaps.readNestRun.mockResolvedValue(run({ sheetsDone: 2 }));
    expect(await updateNestRunTool.describe(parsed(updateNestRunTool, { id: 7, thicknessMm: 4 }), ctx)).toEqual({ error: expect.stringContaining("its sheet and its parts stay") });
    expect(await updateNestRunTool.describe(parsed(updateNestRunTool, { id: 7, sheets: 1 }), ctx)).toEqual({ error: expect.stringContaining("cannot have fewer") });
    const p = await updateNestRunTool.describe(parsed(updateNestRunTool, { id: 7, sheets: 2 }), ctx);
    expect(p).toMatchObject({ changes: [{ label: "Sheets", before: "5 (2 cut)", after: "2 — finished" }], summary: expect.stringContaining("it is finished") });
  });

  it("moves it to another laser or off every machine, and says so when nothing changes", async () => {
    expect(await updateNestRunTool.describe(parsed(updateNestRunTool, { id: 7, note: "" }), ctx)).toEqual({ error: "That is how the run is already." });
    expect(await updateNestRunTool.describe(parsed(updateNestRunTool, { id: 7, machine: "B4-09" }), ctx)).toMatchObject({ changes: [{ label: "Machine", before: "B4-10", after: "back of B4-09's queue" }] });
    expect(checkToolInput(updateNestRunTool, { id: 7 })).toMatchObject({ ok: false, error: "Say what changes on the run." });
  });

  it("sends the whole run as the edit form does, and is undone by putting it back as it was", async () => {
    const before = run();
    const out = await updateNestRunTool.execute(parsed(updateNestRunTool, { id: 7, sheets: 6, minutesPerSheet: 8, machine: "" }), ctx);
    expect(fd(h.runs.updateNestRun)).toEqual({
      id: "7", material: "Steel", thicknessMm: "3", sheetSize: "1250*2500", sheets: "6", identical: "true", minutes: "[8]", note: "",
      parts: JSON.stringify([{ bom: "B1", mo: "M1", item: "CF", pcs: 10, replaces: "" }]), machineId: "",
    });
    expect(out).toEqual({ ok: true, message: "Nest run #7 is changed.", undo: { tool: "restore_nest_run", input: { id: 7, state: JSON.stringify(before) } } });
  });
});

describe("delete_nest_run and its undo", () => {
  it("is a deletion, refused once a sheet is cut, and comes back exactly", async () => {
    expect(deleteNestRunTool.risk).toBe("destructive");
    h.snaps.readNestRun.mockResolvedValueOnce(run({ sheetsDone: 1 }));
    expect(await deleteNestRunTool.describe({ id: 7 }, ctx)).toEqual({ error: expect.stringContaining("already cut") });
    const out = await deleteNestRunTool.execute({ id: 7 }, ctx);
    expect(out).toMatchObject({ ok: true, undo: { tool: "restore_nest_run", input: { id: 7 } } });
    // the undo's stored input passes the restore's own check, and puts that very state back
    const undoInput = parsed<{ id: number; state: string }>(restoreNestRunTool, (out as { undo: { input: unknown } }).undo.input);
    await restoreNestRunTool.execute(undoInput, ctx);
    expect(h.snaps.restoreNestRun).toHaveBeenCalledWith(run());
    expect(checkToolInput(restoreNestRunTool, { id: 7, state: JSON.stringify({ id: 8 }) })).toMatchObject({ ok: false });
  });
});

describe("record_nest_run_sheets", () => {
  it("counts the parts' pieces the sheets carry, on the laser it sits on, and is never undone from the chat", async () => {
    expect(await recordNestRunSheetsTool.describe({ id: 7, sheets: 6 }, ctx)).toEqual({ error: "Only 5 sheet(s) left on run #7." });
    expect(await recordNestRunSheetsTool.describe({ id: 7, sheets: 1, date: "2026-10-13" }, ctx)).toEqual({ error: expect.stringContaining("has not come yet") });
    const p = await recordNestRunSheetsTool.describe({ id: 7, sheets: 2 }, ctx);
    expect(p).toMatchObject({ summary: expect.stringContaining("on B4-10"), changes: [{ label: "Sheets cut", after: "2 of 5" }, { label: "M1 CF", before: "0 of 10 cut", after: "4 of 10 cut" }] });
    const out = await recordNestRunSheetsTool.execute({ id: 7, sheets: 2 }, ctx);
    expect(fd(h.runs.recordNestRunSheets)).toEqual({ id: "7", qty: "2", date: "2026-10-12", machineId: "1" });
    expect(out).toEqual({ ok: true, message: "2 sheet(s) of nest run #7 are recorded as cut." });
    h.snaps.readNestRun.mockResolvedValue(run({ queue: [run().queue[0], { ...run().queue[0], id: 901, machineId: 2 }] }));
    expect(await recordNestRunSheetsTool.describe({ id: 7, sheets: 1 }, ctx)).toEqual({ error: expect.stringContaining("say which cut these sheets") });
  });
});

describe("manual jobs", () => {
  it("are added on a machine of their own department, and undone by deleting them", async () => {
    const raw = { dept: "Welding", title: "  Lifting lugs ", qty: 4, machine: "B4-10" };
    expect(checkToolInput(createManualJobTool, { ...raw, title: "   " })).toMatchObject({ ok: false, error: expect.stringContaining("must not be empty") });
    expect(await createManualJobTool.describe(parsed(createManualJobTool, raw), ctx)).toEqual({ error: expect.stringContaining("Welding's machine board needs its worklist key") });
    h.perms.add("welding.edit");
    expect(await createManualJobTool.describe(parsed(createManualJobTool, raw), ctx)).toEqual({ error: "No machine B4-10 in Welding." });
    const out = await createManualJobTool.execute(parsed(createManualJobTool, { ...raw, dept: "Cut" }), ctx);
    expect(fd(h.jobs.createManualJob)).toEqual({ dept: "Cut", title: "Lifting lugs", qty: "4", machineId: "1" });
    expect(out).toEqual({ ok: true, message: 'Manual job #13 "Lifting lugs" is added on B4-10.', undo: { tool: "delete_manual_job", input: { id: 13 } } });
  });

  it("record pieces done no more than are left, reopen with pieces to make, and delete as a deletion — each undone exactly", async () => {
    // more pieces of a job still open, where it is
    expect(await reopenManualJobTool.describe({ id: 12, more: 0 }, ctx)).toEqual({ error: expect.stringContaining("is open already") });
    expect(await reopenManualJobTool.describe({ id: 12, more: 4 }, ctx)).toMatchObject({ summary: expect.stringContaining("it stays where it is"), changes: [{ before: "5 of 20 done", after: "5 of 24 done" }] });
    expect(await recordManualJobDoneTool.describe({ id: 12, qty: 16 }, ctx)).toEqual({ error: "Only 15 left on job #12." });
    expect(await recordManualJobDoneTool.describe({ id: 12, qty: 15 }, ctx)).toMatchObject({ summary: expect.stringContaining("its last") });
    expect(await recordManualJobDoneTool.execute({ id: 12, qty: 3, machine: "B4-10" }, ctx)).toEqual({ ok: true, message: expect.any(String), undo: { tool: "restore_manual_job", input: { id: 12, state: JSON.stringify(job()) } } });
    expect(fd(h.jobs.recordManualDone)).toEqual({ id: "12", qty: "3", machineId: "1" });
    h.snaps.readManualJob.mockResolvedValue(job({ doneQty: 20, doneAt: "2026-10-11T12:00:00.000Z" }));
    expect(await reopenManualJobTool.describe({ id: 12, more: 0 }, ctx)).toEqual({ error: expect.stringContaining("Nothing would be left") });
    expect(await reopenManualJobTool.describe({ id: 12, more: 5 }, ctx)).toMatchObject({ changes: [{ before: "20 of 20 done, finished", after: "20 of 25 done, open" }] });
    expect(deleteManualJobTool.risk).toBe("destructive");
    expect(await deleteManualJobTool.execute({ id: 12 }, ctx)).toMatchObject({ ok: true, undo: { tool: "restore_manual_job" } });
  });
});

describe("record_sheet_done", () => {
  it("records a sheet on the machine that holds it, with the line's own key", async () => {
    const raw = { dept: "Cut", bom: "B1", mo: "M1", item: "cf", sheet: S3, machine: "B4-10", qty: 4 };
    h.readQueueSnapshot.mockResolvedValue([{ bom: "B1", mo: "M1", item: "CF", machineId: 1, rank: 1, running: true, qty: null, sheet: S5, sheetDone: 0 }]);
    expect(await recordSheetDoneTool.describe(parsed(recordSheetDoneTool, raw), ctx)).toEqual({ error: expect.stringContaining("is not on B4-10") });
    h.readQueueSnapshot.mockResolvedValue([{ bom: "B1", mo: "M1", item: "CF", machineId: 1, rank: 1, running: true, qty: null, sheet: S3, sheetDone: 2 }]);
    expect(await recordSheetDoneTool.describe(parsed(recordSheetDoneTool, raw), ctx)).toMatchObject({ changes: [{ before: "2 cut", after: "6 cut" }], snapshot: { sheetDone: 2 } });
    expect(await recordSheetDoneTool.execute(parsed(recordSheetDoneTool, raw), ctx)).toMatchObject({ ok: true });
    expect(fd(h.recordSheetDone)).toEqual({ dept: "Cut", bom: "B1", mo: "M1", item: "CF", sheet: S3, machineId: "1", qty: "4", date: "2026-10-12" });
    h.perms.clear();
    expect(await recordSheetDoneTool.describe(parsed(recordSheetDoneTool, raw), ctx)).toEqual({ error: expect.stringContaining("needs its own key") });
  });
});

describe("what the assistant is offered", () => {
  it("never the restores; the deletions only with the deletions key", () => {
    const names = (perms: string[]) => {
      h.perms.clear();
      for (const k of perms) h.perms.add(k);
      return toolsFor({ id: 1, isAdmin: false, isOwner: false } as User, { hidden: new Set(), actionsPaused: false }).map((t) => t.name);
    };
    const without = names(["ai.act.machines"]);
    expect(without).toEqual(expect.arrayContaining(["get_nest_runs", "create_nest_run", "update_nest_run", "record_nest_run_sheets", "create_manual_job", "record_sheet_done"]));
    expect(without).not.toEqual(expect.arrayContaining(["delete_nest_run"]));
    expect(without).not.toContain("restore_nest_run");
    expect(names(["ai.act.machines", "ai.act.delete"])).toEqual(expect.arrayContaining(["delete_nest_run", "delete_manual_job"]));
  });
});
