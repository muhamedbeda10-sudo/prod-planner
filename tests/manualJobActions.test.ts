import { beforeEach, describe, expect, it, vi } from "vitest";

// ✎ Edit on a manual job (app/worklist/manualActions.ts → updateManualJob):
// the job's own fields change, where it is queued does not; the pieces never
// drop below what is done; exactly what is done finishes it (off every
// machine); a fixed share on a machine never asks for more than is left.
// Against a stubbed database and guard.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  const tx = { manualJob: { update: fn() }, worklistMachine: { deleteMany: fn(), updateMany: fn() } };
  return {
    tx,
    prisma: {
      manualJob: { findUnique: fn() },
      $transaction: vi.fn(async (f: (t: typeof tx) => Promise<unknown>) => f(tx)),
    },
    guard: fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ requireDeptEdit: h.guard }));

import { updateManualJob } from "@/app/worklist/manualActions";

const JOB = {
  id: 12, dept: "Cut", title: "Brackets", bom: "", item: "", qty: 20, doneQty: 5, material: "", thicknessMm: null, sheetSize: "", sheets: null, note: null,
  machineId: 1, createdBy: "Sara", createdAt: new Date("2026-10-11T07:00:00Z"), doneAt: null as Date | null, updatedAt: new Date(),
};
const KEY = { dept: "Cut", bom: "MANUAL", mo: "MANUAL-12", item: "JOB" };

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ id: "12", title: "Brackets", qty: "20", ...fields })) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.manualJob.findUnique.mockResolvedValue({ ...JOB });
  h.guard.mockResolvedValue({ user: { name: "Sara" } });
});

describe("updateManualJob", () => {
  it("writes the job's fields as typed and keeps it where it is queued", async () => {
    const r = await updateManualJob(form({ title: "  Lifting lugs ", qty: "30", bom: "B-1", item: "Lug", material: "mild steel", thicknessMm: "4", sheetSize: "1250x2500", sheets: "1.5", note: "for maintenance" }));
    expect(r).toEqual({ ok: true });
    expect(h.tx.manualJob.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: expect.objectContaining({ title: "Lifting lugs", qty: 30, bom: "B-1", item: "Lug", material: "Steel", thicknessMm: 4, sheets: 1.5, note: "for maintenance", doneAt: null }),
    });
    expect(h.tx.worklistMachine.deleteMany).not.toHaveBeenCalled();
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
    expect(h.guard).toHaveBeenCalledWith("Cut");
    h.prisma.manualJob.findUnique.mockResolvedValue(null);
    expect(await updateManualJob(form({}))).toEqual({ ok: false, error: "That job is gone — reload the page." });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});
