import { beforeEach, describe, expect, it, vi } from "vitest";

// Putting a department's machine queues back from a snapshot — the undo of a
// board change made through the assistant. Every row is checked before the
// department's queues are replaced, in one transaction — the lines the person
// schedules on the shared machines, never the other line's.

const h = vi.hoisted(() => ({
  prisma: {
    machine: { findMany: vi.fn() },
    worklistMachine: { deleteMany: vi.fn(), createMany: vi.fn() },
    $transaction: vi.fn(),
  },
  requireBayAccess: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ getCurrentUser: vi.fn(), bayAccess: vi.fn(), requireBayAccess: h.requireBayAccess, requireMachineLineEdit: vi.fn() }));
vi.mock("@/lib/server/machineMaterial", () => ({ getLinesMaterial: vi.fn() }));
vi.mock("@/lib/server/machineBoard", () => ({ getOptimizerInputs: vi.fn() }));

import { restoreMachineQueues } from "@/app/worklist/machineActions";

const row = (o: Record<string, unknown> = {}) => ({ bom: "B1", mo: "M1", item: "TN", machineId: 1, rank: 1, running: false, qty: null, sheet: "", sheetDone: 0, ...o });
const fd = (dept: string, rows: unknown) => {
  const f = new FormData();
  f.set("dept", dept);
  f.set("rows", typeof rows === "string" ? rows : JSON.stringify(rows));
  return f;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.requireBayAccess.mockResolvedValue({ user: { name: "Sara (AI)" }, access: { tr: true, lv: true } });
  h.prisma.machine.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
  h.prisma.worklistMachine.deleteMany.mockReturnValue("delete");
  h.prisma.worklistMachine.createMany.mockReturnValue("create");
  h.prisma.$transaction.mockResolvedValue([]);
});

describe("restoreMachineQueues", () => {
  it("replaces the department's queues with the snapshot, in one transaction", async () => {
    const rows = [row(), row({ machineId: 2, rank: 1, running: true, qty: 4 })];
    const r = await restoreMachineQueues(fd("Welding", rows));
    expect(r).toEqual({ ok: true, summary: expect.stringContaining("back as they were (2 lines)") });
    expect(h.prisma.worklistMachine.deleteMany).toHaveBeenCalledWith({ where: { dept: "Welding" } });
    expect(h.prisma.worklistMachine.createMany).toHaveBeenCalledWith({ data: rows.map((x) => ({ dept: "Welding", ...x, setBy: "Sara (AI)" })) });
    expect(h.prisma.$transaction).toHaveBeenCalledWith(["delete", "create"]);
  });

  it("on the fabrication machines puts back the jobs and the panels, never a transformer plan line of its own", async () => {
    const job = row({ bom: "MANUAL", mo: "MANUAL-7", item: "JOB", qty: 3 });
    const panel = row({ machineId: 2, item: "PNL", mo: "M7" });
    const r = await restoreMachineQueues(fd("Cut", [row(), job, panel]));
    expect(r).toEqual({ ok: true, summary: expect.stringContaining("(2 lines)") });
    expect(h.prisma.worklistMachine.createMany).toHaveBeenCalledWith({ data: [job, panel].map((x) => ({ dept: "Cut", ...x, setBy: "Sara (AI)" })) });
  });

  it("needs a key for the bay's machines", async () => {
    h.requireBayAccess.mockResolvedValue({ error: "No permission." });
    expect(await restoreMachineQueues(fd("Cut", [row()]))).toEqual({ ok: false, error: "No permission." });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("puts back only the lines the person schedules, and leaves the other line's work as it is", async () => {
    h.requireBayAccess.mockResolvedValue({ user: { name: "Lina (AI)" }, access: { tr: false, lv: true } });
    const rows = [row(), row({ machineId: 2, item: "PNL", mo: "M7" })];
    expect(await restoreMachineQueues(fd("Cut", rows))).toEqual({ ok: true, summary: expect.stringContaining("(1 line)") });
    expect(h.prisma.worklistMachine.deleteMany).toHaveBeenCalledWith({ where: { dept: "Cut", item: "PNL" } });
    expect(h.prisma.worklistMachine.createMany).toHaveBeenCalledWith({ data: [{ dept: "Cut", ...rows[1], setBy: "Lina (AI)" }] });
  });

  it("refuses a snapshot it cannot trust, and changes nothing", async () => {
    const bad: [unknown, string][] = [
      ["not json", "cannot be read"],
      [{ rows: [] }, "not a list"],
      [[row({ machineId: 9 })], "another department"],
      [[row(), row()], "twice"],
      [[row({ qty: 0 })], "bad quantity"],
      [[row({ rank: -1 })], "bad rank"],
      [[row({ running: "yes" })], "running state"],
      [[row({ bom: "" })], "incomplete"],
      [[row({ sheet: "x".repeat(121) })], "incomplete"],
    ];
    for (const [rows, msg] of bad) {
      const r = await restoreMachineQueues(fd("Cut", rows));
      expect(r.ok, msg).toBe(false);
      expect(r.error, msg).toContain(msg);
    }
    expect(await restoreMachineQueues(fd("Assembly", [row()]))).toEqual({ ok: false, error: "This worklist has no machines." });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("puts back an empty board", async () => {
    expect(await restoreMachineQueues(fd("Painting", []))).toMatchObject({ ok: true });
    expect(h.prisma.worklistMachine.createMany).toHaveBeenCalledWith({ data: [] });
  });
});
