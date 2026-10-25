import { beforeEach, describe, expect, it, vi } from "vitest";

// The Tools → Machines and Tools → Workers lists (app/admin/machines/actions.ts,
// app/admin/workers/actions.ts): deleting a machine is refused while anything
// still names it — history, typed times per piece, jobs, sheet-cut records —
// so nothing is dropped by the cascade; and a save that loses the race with
// another save of the same code / ID / name gets the same friendly sentence
// the check gives, not a crash.

const h = vi.hoisted(() => {
  const count = () => vi.fn(async () => 0);
  return {
    prisma: {
      shiftEntry: { count: count() }, machineDowntime: { count: count() }, handoverEntry: { count: count() },
      machineItemTime: { count: count() }, manualJob: { count: count() }, sheetCutLog: { count: count() },
      machine: { delete: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
      worker: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    },
    requirePerm: vi.fn(),
  };
});
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ requirePerm: h.requirePerm, requireAdmin: h.requirePerm }));
vi.mock("@/lib/server/workers", () => ({ serializeWorkerDepts: (d: string[]) => d.join(",") }));
vi.mock("@/lib/server/consumableHeadcount", () => ({ snapshotHeadcount: vi.fn() }));

import { createMachine, deleteMachine, updateMachine } from "@/app/admin/machines/actions";
import { createWorker, updateWorker } from "@/app/admin/workers/actions";

const form = (id: number) => { const fd = new FormData(); fd.set("id", String(id)); return fd; };
const formOf = (fields: Record<string, string | string[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one);
  return fd;
};
/** What Prisma throws when the unique index catches a duplicate. */
const p2002 = (target: string[]) => Object.assign(new Error("Unique constraint failed on the fields: (`x`)"), { name: "PrismaClientKnownRequestError", code: "P2002", meta: { target } });
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.requirePerm.mockResolvedValue({ user: { name: "Sara" } });
  for (const t of [h.prisma.shiftEntry, h.prisma.machineDowntime, h.prisma.handoverEntry, h.prisma.machineItemTime, h.prisma.manualJob, h.prisma.sheetCutLog]) t.count.mockResolvedValue(0);
  h.prisma.machine.findUnique.mockResolvedValue(null);
  h.prisma.worker.findUnique.mockResolvedValue(null);
});

describe("createMachine / updateMachine", () => {
  const machine = { code: "b4-10", name: "Laser", dept: "Cut", center: "", hoursPerDay: "", sortOrder: "2" };
  it("a duplicate code that slipped past the check reads as 'already taken'", async () => {
    h.prisma.machine.create.mockRejectedValue(p2002(["code"]));
    expect(await createMachine(formOf(machine))).toEqual({ ok: false, error: "Code B4-10 is already taken." });
    h.prisma.machine.update.mockRejectedValue(p2002(["code"]));
    expect(await updateMachine(formOf({ id: "3", ...machine }))).toEqual({ ok: false, error: "Code B4-10 is already taken." });
  });
  it("any other database failure reads as one plain sentence", async () => {
    h.prisma.machine.create.mockRejectedValue(new Error("connection lost at db.internal:5432"));
    expect(await createMachine(formOf(machine))).toEqual({ ok: false, error: expect.stringMatching(/^Could not add the machine — /) });
    h.prisma.machine.update.mockRejectedValue(Object.assign(new Error("gone"), { code: "P2025" }));
    expect(await updateMachine(formOf({ id: "3", ...machine }))).toEqual({ ok: false, error: expect.stringMatching(/^Could not save the machine — that record is no longer there/) });
  });
  it("saves when nothing clashes", async () => {
    h.prisma.machine.create.mockResolvedValue({ id: 9 });
    expect(await createMachine(formOf(machine))).toEqual({ ok: true });
    expect(h.prisma.machine.create).toHaveBeenCalledWith({ data: { code: "B4-10", name: "Laser", dept: "Cut", center: "", hoursPerDay: null, sortOrder: 2 } });
  });
});

describe("createWorker / updateWorker", () => {
  const worker = { empId: "1203", name: "Ahmed", depts: ["Welding"] };
  it("a duplicate that slipped past the checks names the column it hit", async () => {
    h.prisma.worker.create.mockRejectedValue(p2002(["empId"]));
    expect(await createWorker(formOf(worker))).toEqual({ ok: false, error: "ID 1203 is already taken by another worker." });
    h.prisma.worker.create.mockRejectedValue(p2002(["name"]));
    expect(await createWorker(formOf(worker))).toEqual({ ok: false, error: "A worker with this name already exists." });
    // the driver may name the index instead of the column
    h.prisma.worker.update.mockRejectedValue(Object.assign(p2002([]), { meta: { target: "Worker_empId_key" } }));
    expect(await updateWorker(formOf({ id: "4", ...worker }))).toEqual({ ok: false, error: "ID 1203 is already taken by another worker." });
    h.prisma.worker.update.mockRejectedValue(p2002(["name"]));
    expect(await updateWorker(formOf({ id: "4", ...worker }))).toEqual({ ok: false, error: "Another worker already has this name." });
  });
  it("any other database failure reads as one plain sentence", async () => {
    h.prisma.worker.create.mockRejectedValue(new Error("connection lost at db.internal:5432"));
    expect(await createWorker(formOf(worker))).toEqual({ ok: false, error: expect.stringMatching(/^Could not add the worker — /) });
    h.prisma.worker.update.mockRejectedValue(new Error("connection lost at db.internal:5432"));
    expect(await updateWorker(formOf({ id: "4", ...worker }))).toEqual({ ok: false, error: expect.stringMatching(/^Could not save the worker — /) });
  });
  it("saves when nothing clashes", async () => {
    h.prisma.worker.create.mockResolvedValue({ id: 9 });
    expect(await createWorker(formOf(worker))).toEqual({ ok: true });
    expect(h.prisma.worker.create).toHaveBeenCalledWith({ data: expect.objectContaining({ empId: "1203", name: "Ahmed", depts: "Welding" }) });
  });
});

describe("deleteMachine", () => {
  it("refuses while typed times per piece, jobs or sheet-cut records name the machine", async () => {
    h.prisma.machineItemTime.count.mockResolvedValue(2);
    expect(await deleteMachine(form(5))).toEqual({ ok: false, error: expect.stringContaining("2 typed time(s) per piece, 0 job(s) and 0 sheet-cut record(s)") });
    h.prisma.machineItemTime.count.mockResolvedValue(0);
    h.prisma.sheetCutLog.count.mockResolvedValue(3);
    expect(await deleteMachine(form(5))).toMatchObject({ ok: false });
    expect(h.prisma.machine.delete).not.toHaveBeenCalled();
  });
  it("deletes a machine nothing names", async () => {
    expect(await deleteMachine(form(5))).toEqual({ ok: true });
    expect(h.prisma.machine.delete).toHaveBeenCalledWith({ where: { id: 5 } });
  });
});
