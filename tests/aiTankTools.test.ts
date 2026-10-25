import { beforeEach, describe, expect, it, vi } from "vitest";

// The assistant's tank tools (lib/server/ai/tools/tanks.ts): tanks piece by
// piece by their serials and the badges of who did the work — what each card
// says, which of the tank screens' own actions it runs with what, and how it
// is undone — against a stubbed database, workers and actions.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: { tankUnit: { findMany: fn(), groupBy: fn() } },
    perms: new Set<string>(),
    settings: { tankTracking: true },
    tanks: [] as unknown[],
    workers: new Map<string, unknown>(),
    checkOutputChain: fn(),
    restoreTanks: fn(),
    actions: {
      assignTankWelder: fn(), markTankRepaired: fn(), recordLeakTest: fn(), paintTanks: fn(), sendTankBackToWelding: fn(), recordTankQa: fn(), deleteTanks: fn(),
    },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ hasPerm: (_u: unknown, k: string) => h.perms.has(k) }));
vi.mock("@/lib/server/data", () => ({ getSettings: async () => h.settings }));
vi.mock("@/lib/server/outputGuard", () => ({ checkOutputChain: h.checkOutputChain, recheckLvChainLocked: async () => {}, ChainRefused: class extends Error {} }));
vi.mock("@/lib/server/workers", () => ({
  resolveWorkerByEmpId: async (badge: string, dept: string) => {
    const w = h.workers.get(badge) as { depts: string[]; name: string } | undefined;
    if (!w) return { error: `No worker has the ID ${badge}.` };
    return w.depts.includes(dept) ? { worker: w } : { error: `${badge} — ${w.name} is not registered for this stage.` };
  },
}));
vi.mock("@/lib/server/rowSnapshots", () => ({
  readTanks: async (serials: string[]) => (h.tanks as { serial: string }[]).filter((t) => serials.includes(t.serial)),
  restoreTanks: h.restoreTanks,
}));
vi.mock("@/app/tanks/actions", () => h.actions);

import type { User } from "@prisma/client";
import type { ToolCtx } from "@/lib/server/ai/tools/types";
import type { TankSnapshot } from "@/lib/server/rowSnapshots";
import {
  assignTankWelderTool, deleteTanksTool, getTanksTool, markTankRepairedTool, paintTanksTool, recordLeakTestTool, recordTankQaTool, restoreTanksTool, sendTankBackTool,
} from "@/lib/server/ai/tools/tanks";
import { checkToolInput } from "@/lib/server/ai/tools";

const sara = { id: 1, name: "Sara", isAdmin: false } as User;
const ctx = (user: User = sara, hidden: string[] = []): ToolCtx => ({ user, hidden: new Set(hidden), now: new Date("2026-10-12T08:00:00Z"), todayISO: "2026-10-12", conversationId: 4, automationId: null });
const fd = (m: ReturnType<typeof vi.fn>, call = 0) => Object.fromEntries((m.mock.calls[call][0] as FormData).entries());
const parsed = <I>(tool: Parameters<typeof checkToolInput<I>>[0], raw: unknown): I => {
  const c = checkToolInput<I>(tool, raw);
  if (!c.ok) throw new Error(c.error);
  return c.input;
};

const tank = (serial: string, o: Partial<TankSnapshot> = {}): TankSnapshot => ({
  id: Number(serial.replace(/\D/g, "")), serial, status: "welded", weldLedgerId: 50, paintLedgerId: null,
  weldedAt: "2026-10-10T00:00:00.000Z", weldedById: 7, weldedBy: "Ali", weldedStamp: "A", weldedLogBy: "Sara",
  testedAt: null, testedById: null, testedBy: null, testResult: null, testNote: null, paintedAt: null, paintedById: null, paintedBy: null,
  qaAt: null, qaById: null, qaBy: null, qaResult: null, qaNote: null, events: [1], ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.perms.clear();
  h.settings = { tankTracking: true };
  h.tanks = [tank("S-001"), tank("S-002"), tank("S-003", { status: "tested" }), tank("S-004", { status: "repair", testNote: "leak at seam" })];
  h.workers = new Map([
    ["101", { id: 11, empId: "101", name: "Omar", stamp: "O", depts: ["Welding"] }],
    ["202", { id: 22, empId: "202", name: "Hany", stamp: null, depts: ["LeakTest"] }],
    ["303", { id: 33, empId: "303", name: "Mona", stamp: null, depts: ["Painting"] }],
  ]);
  h.checkOutputChain.mockResolvedValue(null);
  h.restoreTanks.mockResolvedValue({ ok: true });
  for (const f of Object.values(h.actions)) f.mockResolvedValue({ ok: true, count: 1 });
});

describe("record_leak_test", () => {
  const raw = { serials: ["s-001", "S-002"], result: "pass", tester: "202" };

  it("needs what is wrong for a repair", () => {
    expect(checkToolInput(recordLeakTestTool, { ...raw, result: "repair" })).toMatchObject({ ok: false, error: expect.stringContaining("what is wrong") });
    expect(parsed<{ serials: string[] }>(recordLeakTestTool, raw).serials).toEqual(["S-001", "S-002"]);
  });

  it("is the leak test's own: its key, its worklist, tracking on, tanks waiting for it and a tester of that stage", async () => {
    const i = parsed<Parameters<typeof recordLeakTestTool.describe>[0]>(recordLeakTestTool, raw);
    expect(await recordLeakTestTool.describe(i, ctx())).toEqual({ error: expect.stringContaining("leaktest.edit") });
    h.perms.add("leaktest.edit");
    expect(await recordLeakTestTool.describe(i, ctx(sara, ["worklist.leak-test"]))).toEqual({ error: expect.stringContaining("not opened for you") });
    h.settings = { tankTracking: false };
    expect(await recordLeakTestTool.describe(i, ctx())).toEqual({ error: expect.stringContaining("switched off") });
    h.settings = { tankTracking: true };
    expect(await recordLeakTestTool.describe({ ...i, serials: ["S-001", "S-009"] }, ctx())).toEqual({ error: "No tank carries the serial: S-009." });
    expect(await recordLeakTestTool.describe({ ...i, serials: ["S-003"] }, ctx())).toEqual({ error: "S-003: This tank has already passed the leak test." });
    expect(await recordLeakTestTool.describe({ ...i, tester: "303" }, ctx())).toEqual({ error: "303 — Mona is not registered for this stage." });
    expect(await recordLeakTestTool.describe({ ...i, date: "2026-10-13" }, ctx())).toEqual({ error: "2026-10-13 has not come yet." });
    expect(await recordLeakTestTool.describe(i, ctx())).toMatchObject({
      summary: "Record Hany's leak test on 2026-10-12: S-001, S-002 passed.",
      changes: [{ label: "S-001", after: "passed — to painting" }, { label: "S-002", after: "passed — to painting" }],
    });
  });

  it("carries the day in what is approved: today by default, the day given otherwise", async () => {
    h.perms.add("leaktest.edit");
    const i = parsed<Parameters<typeof recordLeakTestTool.describe>[0]>(recordLeakTestTool, raw);
    expect(await recordLeakTestTool.describe(i, ctx())).toMatchObject({ snapshot: { tanks: [{ serial: "S-001" }, { serial: "S-002" }], date: "2026-10-12" } });
    expect(await recordLeakTestTool.describe({ ...i, date: "2026-10-10" }, ctx())).toMatchObject({ snapshot: { date: "2026-10-10" } });
  });

  it("runs the leak test's own action and is undone by the tanks as they were", async () => {
    h.perms.add("leaktest.edit");
    const i = parsed<Parameters<typeof recordLeakTestTool.describe>[0]>(recordLeakTestTool, { ...raw, result: "repair", note: "leak at the flange" });
    const before = [tank("S-001"), tank("S-002")];
    const out = await recordLeakTestTool.execute(i, ctx());
    expect(fd(h.actions.recordLeakTest)).toEqual({ serials: "S-001,S-002", result: "repair", workerId: "22", note: "leak at the flange", date: "2026-10-12" });
    expect(out).toEqual({ ok: true, message: "Leak test recorded on 1 tank(s).", undo: { tool: "restore_tanks", input: { stage: "LeakTest", tanks: JSON.stringify(before) } } });
  });
});

describe("paint_tanks", () => {
  it("paints only tanks that passed, checks the chain per MO, and is undone as the Daily log undoes it", async () => {
    h.perms.add("painting.edit");
    const i = parsed<Parameters<typeof paintTanksTool.describe>[0]>(paintTanksTool, { serials: ["S-001"], painter: "303" });
    expect(await paintTanksTool.describe(i, ctx())).toEqual({ error: expect.stringContaining("S-001: This tank has not had its leak test yet") });
    h.prisma.tankUnit.findMany.mockResolvedValue([{ serial: "S-003", mo: "M1", bom: "B1" }]);
    h.checkOutputChain.mockResolvedValueOnce("Chain check: M1 TN would have 9 painted but only 8 welded.");
    expect(await paintTanksTool.describe({ ...i, serials: ["S-003"] }, ctx())).toEqual({ error: expect.stringContaining("Chain check") });
    expect(await paintTanksTool.describe({ ...i, serials: ["S-003"] }, ctx())).toMatchObject({ summary: "Record S-003 as painted by Mona on 2026-10-12 — 1 Daily log row(s), one per MO (M1 ×1)." });
    // the day is part of what was approved
    expect(await paintTanksTool.describe({ ...i, serials: ["S-003"] }, ctx())).toMatchObject({ snapshot: { tanks: [{ serial: "S-003" }], date: "2026-10-12" } });
    expect(await paintTanksTool.describe({ ...i, serials: ["S-003"], date: "2026-10-10" }, ctx())).toMatchObject({ snapshot: { date: "2026-10-10" } });
    expect(h.checkOutputChain).toHaveBeenLastCalledWith({ dept: "Painting", bom: "B1", mo: "M1", item: "TN", qty: 1 });
    h.actions.paintTanks.mockResolvedValue({ ok: true, count: 1, ledgerIds: [501] });
    expect(await paintTanksTool.execute({ ...i, serials: ["S-003"] }, ctx())).toEqual({ ok: true, message: "1 tank(s) are painted.", undo: { tool: "delete_log_entries", input: { ids: [501] } } });
    expect(fd(h.actions.paintTanks)).toEqual({ serials: "S-003", workerId: "33", date: "2026-10-12" });
  });
});

describe("the welding side", () => {
  it("renames a tank's welder, and confirms a repair only on a tank sent back", async () => {
    h.perms.add("welding.edit");
    expect(await assignTankWelderTool.describe({ serial: "S-001", welder: "101" }, ctx())).toMatchObject({ changes: [{ before: "Ali (A)", after: "Omar (O)" }] });
    expect(await assignTankWelderTool.execute({ serial: "S-001", welder: "101" }, ctx())).toMatchObject({ undo: { tool: "restore_tanks", input: { stage: "Welding" } } });
    expect(fd(h.actions.assignTankWelder)).toEqual({ serial: "S-001", workerId: "11" });
    expect(await markTankRepairedTool.describe({ serial: "S-001", welder: "101" }, ctx())).toEqual({ error: "S-001: Nobody sent this tank back for repair." });
    expect(await markTankRepairedTool.describe({ serial: "S-004", welder: "101", note: "rewelded" }, ctx())).toMatchObject({ summary: expect.stringContaining("(sent back: \"leak at seam\") — \"rewelded\"") });
  });

  it("sends a tank back from painting with the reason, not a painted one", async () => {
    h.perms.add("painting.edit");
    expect(checkToolInput(sendTankBackTool, { serial: "S-003", reason: " " })).toMatchObject({ ok: false });
    h.tanks.push(tank("S-005", { status: "painted" }));
    expect(await sendTankBackTool.describe({ serial: "S-005", reason: "dent" }, ctx())).toEqual({ error: "S-005 is painted already — talk to the admin." });
    expect(await sendTankBackTool.execute({ serial: "S-003", reason: "dent" }, ctx())).toMatchObject({ undo: { tool: "restore_tanks", input: { stage: "Painting" } } });
  });
});

describe("quality and removal", () => {
  it("records quality's verdict with the quality key, the inspector optional", async () => {
    expect(checkToolInput(recordTankQaTool, { serial: "S-003", result: "not-ok" })).toMatchObject({ ok: false });
    expect(await recordTankQaTool.describe({ serial: "S-003", result: "ok" }, ctx())).toEqual({ error: expect.stringContaining("quality.qa") });
    h.perms.add("quality.qa");
    // not tied to tracking: it is about a tank that exists
    h.settings = { tankTracking: false };
    expect(await recordTankQaTool.describe({ serial: "S-003", result: "ok" }, ctx())).toMatchObject({ summary: "Record quality's verdict on tank S-003: OK, by Sara." });
    await recordTankQaTool.execute({ serial: "S-003", result: "ok" }, ctx());
    expect(fd(h.actions.recordTankQa)).toEqual({ serial: "S-003", result: "ok" });
  });

  it("deletes tanks for an admin alone, as a deletion, with no undo", async () => {
    expect(deleteTanksTool.risk).toBe("destructive");
    expect(await deleteTanksTool.describe({ serials: ["S-001"] }, ctx())).toEqual({ error: "Only an admin deletes tanks from the records." });
    const admin = { ...sara, isAdmin: true } as User;
    expect(await deleteTanksTool.describe({ serials: ["S-001"] }, ctx(admin))).toMatchObject({ summary: expect.stringContaining("It cannot be undone.") });
    expect(await deleteTanksTool.execute({ serials: ["S-001"] }, ctx(admin))).toEqual({ ok: true, message: "1 tank(s) are deleted." });
  });
});

describe("restore_tanks", () => {
  it("checks the snapshot, the stage's key, and writes the tanks back", async () => {
    expect(checkToolInput(restoreTanksTool, { stage: "LeakTest", tanks: "[]" })).toMatchObject({ ok: false });
    const state = JSON.stringify([tank("S-001", { status: "welded" })]);
    expect(await restoreTanksTool.describe({ stage: "LeakTest", tanks: state }, ctx())).toEqual({ error: expect.stringContaining("leaktest.edit") });
    h.perms.add("leaktest.edit");
    h.tanks = [tank("S-001", { status: "tested", events: [1, 2] })];
    expect(await restoreTanksTool.describe({ stage: "LeakTest", tanks: state }, ctx())).toMatchObject({ changes: [{ label: "S-001", before: "tested", after: "welded" }] });
    await restoreTanksTool.execute({ stage: "LeakTest", tanks: state }, ctx());
    expect(h.restoreTanks).toHaveBeenCalledWith("LeakTest", JSON.parse(state));
  });
});

describe("get_tanks", () => {
  it("is closed when no tank screen is in sight, and sums the queues with no filter", async () => {
    expect((await getTanksTool.run({}, ctx(sara, ["barcode", "worklist.welding", "worklist.leak-test", "worklist.painting"]))).ok).toBe(false);
    h.prisma.tankUnit.groupBy.mockResolvedValue([{ status: "welded", _count: { _all: 2 } }]);
    h.prisma.tankUnit.findMany.mockResolvedValue([]);
    const out = JSON.parse((await getTanksTool.run({}, ctx())).text);
    expect(out).toEqual({ tracking: true, byStatus: { welded: 2 }, leakTestQueue: [], repairQueue: [] });
  });
});
