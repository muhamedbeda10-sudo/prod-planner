import { beforeEach, describe, expect, it, vi } from "vitest";

// Putting a department's machine queues back from a snapshot — the undo of a
// board change made through the assistant. Every row is checked before the
// department's queues are replaced, in one transaction.

const h = vi.hoisted(() => ({
  prisma: {
    machine: { findMany: vi.fn() },
    worklistMachine: { deleteMany: vi.fn(), createMany: vi.fn() },
    $transaction: vi.fn(),
  },
  requireDeptEdit: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ getCurrentUser: vi.fn(), requireDeptEdit: h.requireDeptEdit }));
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
  h.requireDeptEdit.mockResolvedValue({ user: { name: "Sara (AI)" } });
  h.prisma.machine.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
  h.prisma.worklistMachine.deleteMany.mockReturnValue("delete");
  h.prisma.worklistMachine.createMany.mockReturnValue("create");
  h.prisma.$transaction.mockResolvedValue([]);
});

describe("restoreMachineQueues", () => {
  it("replaces the department's queues with the snapshot, in one transaction", async () => {
    const rows = [row(), row({ machineId: 2, rank: 1, running: true, qty: 4, sheet: "3|Steel|1220*2440", sheetDone: 2 })];
    const r = await restoreMachineQueues(fd("Cut", rows));
    expect(r).toEqual({ ok: true, summary: expect.stringContaining("back as they were (2 lines)") });
    expect(h.prisma.worklistMachine.deleteMany).toHaveBeenCalledWith({ where: { dept: "Cut" } });
    expect(h.prisma.worklistMachine.createMany).toHaveBeenCalledWith({ data: rows.map((x) => ({ dept: "Cut", ...x, setBy: "Sara (AI)" })) });
    expect(h.prisma.$transaction).toHaveBeenCalledWith(["delete", "create"]);
  });

  it("needs the department's worklist permission", async () => {
    h.requireDeptEdit.mockResolvedValue({ error: "No permission." });
    expect(await restoreMachineQueues(fd("Cut", [row()]))).toEqual({ ok: false, error: "No permission." });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
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
