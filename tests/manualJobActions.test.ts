import { beforeEach, describe, expect, it, vi } from "vitest";

// The jobs on the machine boards (app/worklist/manualActions.ts). Off the
// fabrication board a job from outside the plan, in pieces: ✎ Edit changes its
// own fields, never where it is queued; the pieces never drop below what is
// done; exactly what is done finishes it (off every machine). On the
// fabrication board a SHEET JOB: the sheets and every project's part on them,
// each BOM matched to the plan; closed in sheets, each ✓ on the sheet cut
// log. Against a stubbed database and guard.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  const tx = {
    manualJob: { create: fn(), update: fn(), updateMany: fn() },
    manualJobPart: { deleteMany: fn(), createMany: fn() },
    sheetCutLog: { create: fn() },
    worklistMachine: { deleteMany: fn(), updateMany: fn(), findFirst: fn(), update: fn(), delete: fn(), create: fn(), aggregate: fn(), count: fn() },
  };
  return {
    tx,
    prisma: {
      manualJob: { findUnique: fn() },
      machine: { findUnique: fn() },
      masterOrder: { findMany: fn() },
      $transaction: vi.fn(async (f: (t: typeof tx) => Promise<unknown>) => f(tx)),
    },
    guard: fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ requireDeptEdit: h.guard }));

import { createManualJob, recordManualDone, reopenManualJob, updateManualJob } from "@/app/worklist/manualActions";

const JOB = {
  id: 12, dept: "Welding", title: "Brackets", bom: "", item: "", qty: 20, doneQty: 5, bySheet: false, material: "", thicknessMm: null, sheetSize: "", sheets: null, note: null,
  machineId: 1, createdBy: "Sara", createdAt: new Date("2026-10-11T07:00:00Z"), doneAt: null as Date | null, updatedAt: new Date(),
};
const KEY = { dept: "Welding", bom: "MANUAL", mo: "MANUAL-12", item: "JOB" };
/** A sheet job on the fabrication board: 10 sheets of 3 mm steel, 4 cut. */
const SHEET_JOB = { ...JOB, id: 30, dept: "Cut", title: "", qty: 10, doneQty: 4, bySheet: true, material: "Steel", thicknessMm: 3, sheetSize: "1250*2500" };
const SHEET_KEY = { dept: "Cut", bom: "MANUAL", mo: "MANUAL-30", item: "JOB" };
const PARTS = [{ bom: "b1", item: "TN", part: "Bottom", pcs: 4 }, { bom: "B2", item: "tn", part: " Side   wall ", pcs: 8 }];

function form(fields: Record<string, string>, base: Record<string, string> = { id: "12", title: "Brackets", qty: "20" }): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...base, ...fields })) fd.set(k, v);
  return fd;
}
const sheetForm = (fields: Record<string, string> = {}) =>
  form(fields, { id: "30", qty: "10", thicknessMm: "3", material: "mild steel", sheetSize: "1250x2500", parts: JSON.stringify(PARTS) });

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.manualJob.findUnique.mockResolvedValue({ ...JOB });
  h.guard.mockResolvedValue({ user: { name: "Sara" } });
  // the plan carries B1 and B2, as it spells them
  h.prisma.masterOrder.findMany.mockImplementation(async ({ where }: { where: { OR: { bom: { equals: string } }[] } }) =>
    ["B1", "B2"].filter((b) => where.OR.some((o) => o.bom.equals.toUpperCase() === b)).map((bom) => ({ bom })));
  h.prisma.machine.findUnique.mockResolvedValue({ id: 1, dept: "Cut", active: true, code: "L1" });
  h.tx.manualJob.create.mockResolvedValue({ id: 31 });
  h.tx.manualJob.updateMany.mockResolvedValue({ count: 1 });
  h.tx.worklistMachine.aggregate.mockResolvedValue({ _max: { rank: 2 } });
  h.tx.worklistMachine.count.mockResolvedValue(1);
});

describe("updateManualJob — a job in pieces", () => {
  it("writes the job's fields as typed and keeps it where it is queued", async () => {
    const r = await updateManualJob(form({ title: "  Lifting lugs ", qty: "30", bom: "B-1", item: "Lug", material: "mild steel", thicknessMm: "4", sheetSize: "1250x2500", sheets: "1.5", note: "for maintenance" }));
    expect(r).toEqual({ ok: true });
    expect(h.tx.manualJob.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: expect.objectContaining({ title: "Lifting lugs", qty: 30, bom: "B-1", item: "Lug", material: "Steel", thicknessMm: 4, sheets: 1.5, note: "for maintenance", doneAt: null }),
    });
    expect(h.tx.worklistMachine.deleteMany).not.toHaveBeenCalled();
    expect(h.tx.manualJobPart.deleteMany).not.toHaveBeenCalled();
    // a fixed share above the 25 now left is brought down to it
    expect(h.tx.worklistMachine.updateMany).toHaveBeenCalledWith({ where: { ...KEY, qty: { gt: 25 } }, data: { qty: 25 } });
  });

  it("refuses fewer pieces than are done, an empty title, and a bad number — writing nothing", async () => {
    expect(await updateManualJob(form({ qty: "4" }))).toEqual({ ok: false, error: expect.stringContaining("5 piece(s) are done already") });
    expect(await updateManualJob(form({ title: "  " }))).toEqual({ ok: false, error: "Say what the job is." });
    expect(await updateManualJob(form({ thicknessMm: "-2" }))).toEqual({ ok: false, error: "Thickness must be a number of mm." });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("finishes the job when the pieces equal what is done — off every machine", async () => {
    expect(await updateManualJob(form({ qty: "5" }))).toEqual({ ok: true });
    expect(h.tx.manualJob.update.mock.calls[0][0].data.doneAt).toBeInstanceOf(Date);
    expect(h.tx.worklistMachine.deleteMany).toHaveBeenCalledWith({ where: KEY });
  });

  it("opens a finished job again when more pieces are wanted, on no machine", async () => {
    h.prisma.manualJob.findUnique.mockResolvedValue({ ...JOB, doneQty: 20, doneAt: new Date("2026-10-12T10:00:00Z") });
    expect(await updateManualJob(form({ qty: "25" }))).toEqual({ ok: true });
    expect(h.tx.manualJob.update.mock.calls[0][0].data.doneAt).toBeNull();
    expect(h.tx.worklistMachine.deleteMany).toHaveBeenCalledWith({ where: KEY });
  });

  it("is the department's worklist key's, and a job gone is said so", async () => {
    h.guard.mockResolvedValue({ error: "You do not have permission for this action — ask the admin." });
    expect(await updateManualJob(form({}))).toEqual({ ok: false, error: expect.stringContaining("permission") });
    expect(h.guard).toHaveBeenCalledWith("Welding");
    h.prisma.manualJob.findUnique.mockResolvedValue(null);
    expect(await updateManualJob(form({}))).toEqual({ ok: false, error: "That job is gone — reload the page." });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("sheet jobs on the fabrication board", () => {
  it("are typed as sheets with every project's part, each BOM in the plan's own spelling, and queued on the machine", async () => {
    const r = await createManualJob(sheetForm({ dept: "Cut", machineId: "1", title: "Nest 14" }));
    expect(r).toEqual({ ok: true, id: 31 });
    expect(h.tx.manualJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        dept: "Cut", bySheet: true, title: "Nest 14", qty: 10, material: "Steel", thicknessMm: 3, sheetSize: "1250*2500", machineId: 1,
        parts: { create: [{ bom: "B1", item: "TN", part: "Bottom", pcs: 4 }, { bom: "B2", item: "TN", part: "Side wall", pcs: 8 }] },
      }),
    });
    expect(h.tx.worklistMachine.create).toHaveBeenCalledWith({ data: expect.objectContaining({ ...SHEET_KEY, mo: "MANUAL-31", machineId: 1, rank: 3, running: false, qty: null }) });
  });

  it("keeps a part typed without its count, its pieces not given", async () => {
    const r = await createManualJob(sheetForm({ dept: "Cut", parts: JSON.stringify([{ bom: "B1", item: "TN", part: "Bottom", pcs: null }]) }));
    expect(r).toEqual({ ok: true, id: 31 });
    expect(h.tx.manualJob.create.mock.calls[0][0].data.parts).toEqual({ create: [{ bom: "B1", item: "TN", part: "Bottom", pcs: null }] });
  });

  it("takes a project the plan does not carry, as typed — and still writes a known one the plan's way", async () => {
    const r = await createManualJob(sheetForm({ dept: "Cut", parts: JSON.stringify([{ bom: "zz9-spare", item: "", part: "Bracket", pcs: 2 }, { bom: "b2", item: "TN", part: "Bottom", pcs: null }]) }));
    expect(r).toEqual({ ok: true, id: 31 });
    expect(h.tx.manualJob.create.mock.calls[0][0].data.parts).toEqual({ create: [{ bom: "zz9-spare", item: "", part: "Bracket", pcs: 2 }, { bom: "B2", item: "TN", part: "Bottom", pcs: null }] });
  });

  it("refuses a sheet job without its thickness, material or parts — writing nothing", async () => {
    expect(await createManualJob(sheetForm({ dept: "Cut", thicknessMm: "" }))).toEqual({ ok: false, error: expect.stringContaining("Thickness") });
    expect(await createManualJob(sheetForm({ dept: "Cut", material: "" }))).toEqual({ ok: false, error: expect.stringContaining("material") });
    expect(await createManualJob(sheetForm({ dept: "Cut", parts: "[]" }))).toEqual({ ok: false, error: expect.stringContaining("at least one") });
    expect(await createManualJob(sheetForm({ dept: "Cut", qty: "2.5" }))).toEqual({ ok: false, error: expect.stringContaining("Sheets must be a whole number") });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("✎ replaces the parts, never below the sheets cut", async () => {
    h.prisma.manualJob.findUnique.mockResolvedValue({ ...SHEET_JOB });
    expect(await updateManualJob(sheetForm({ qty: "3" }))).toEqual({ ok: false, error: expect.stringContaining("4 sheet(s) are cut already") });
    expect(await updateManualJob(sheetForm({ qty: "12" }))).toEqual({ ok: true });
    expect(h.tx.manualJobPart.deleteMany).toHaveBeenCalledWith({ where: { jobId: 30 } });
    expect(h.tx.manualJobPart.createMany).toHaveBeenCalledWith({ data: [{ bom: "B1", item: "TN", part: "Bottom", pcs: 4, jobId: 30 }, { bom: "B2", item: "TN", part: "Side wall", pcs: 8, jobId: 30 }] });
    expect(h.tx.worklistMachine.updateMany).toHaveBeenCalledWith({ where: { ...SHEET_KEY, qty: { gt: 8 } }, data: { qty: 8 } });
  });

  it("✓ counts the sheets cut on the machine, on the sheet cut log, and the last sheet finishes the job", async () => {
    h.prisma.manualJob.findUnique.mockResolvedValue({ ...SHEET_JOB });
    expect(await recordManualDone(form({ id: "30", qty: "7" }, {}))).toEqual({ ok: false, error: "Only 6 sheet(s) left on this job." });
    h.tx.worklistMachine.findFirst.mockResolvedValue({ id: 99, qty: 4 });
    expect(await recordManualDone(form({ id: "30", qty: "3", machineId: "1", date: "2026-10-12" }, {}))).toEqual({ ok: true });
    expect(h.tx.manualJob.updateMany).toHaveBeenCalledWith({ where: { id: 30, doneQty: 4 }, data: { doneQty: 7, doneAt: null, machineId: 1 } });
    expect(h.tx.sheetCutLog.create).toHaveBeenCalledWith({
      data: { date: new Date("2026-10-12T00:00:00.000Z"), ...SHEET_KEY, sheet: "3|Steel|1250*2500", thicknessMm: 3, machineId: 1, qty: 3, createdBy: "Sara" },
    });
    // the 4 sheets fixed on that machine come down to 1
    expect(h.tx.worklistMachine.update).toHaveBeenCalledWith({ where: { id: 99 }, data: { qty: 1 } });
    vi.clearAllMocks();
    h.guard.mockResolvedValue({ user: { name: "Sara" } });
    h.tx.manualJob.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.manualJob.findUnique.mockResolvedValue({ ...SHEET_JOB });
    expect(await recordManualDone(form({ id: "30", qty: "6", machineId: "1" }, {}))).toEqual({ ok: true });
    expect(h.tx.manualJob.updateMany.mock.calls[0][0].data.doneAt).toBeInstanceOf(Date);
    expect(h.tx.worklistMachine.deleteMany).toHaveBeenCalledWith({ where: SHEET_KEY });
  });

  it("✓ on a count someone changed a moment ago writes nothing and says so", async () => {
    h.prisma.manualJob.findUnique.mockResolvedValue({ ...SHEET_JOB });
    h.tx.manualJob.updateMany.mockResolvedValue({ count: 0 });
    expect(await recordManualDone(form({ id: "30", qty: "2", machineId: "1" }, {}))).toEqual({ ok: false, error: expect.stringContaining("reload the page") });
    expect(h.tx.sheetCutLog.create).not.toHaveBeenCalled();
    expect(h.tx.worklistMachine.deleteMany).not.toHaveBeenCalled();
  });

  it("a fabrication job typed in pieces, before sheets, is kept as it was", async () => {
    h.prisma.manualJob.findUnique.mockResolvedValue({ ...JOB, dept: "Cut", doneAt: new Date("2026-10-12T10:00:00Z") });
    for (const act of [() => updateManualJob(form({})), () => reopenManualJob(form({ more: "2" })), () => recordManualDone(form({ qty: "1" }))]) {
      expect(await act()).toEqual({ ok: false, error: expect.stringContaining("typed in pieces") });
    }
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});
