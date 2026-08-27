import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- mock harness for the per-tank server actions ---------------------------
// Same shape as the worklist-action harness: the I/O boundary (Prisma, the Next
// cache, the auth guards, the workers list) is stubbed, and the assertions are
// about the gates each action enforces and the rows it decides to write.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      tankUnit: { findUnique: fn(), findMany: fn(), update: fn() },
      tankEvent: { create: fn() },
      handoverEntry: { create: fn() },
      plan: { upsert: fn() },
      $transaction: fn(),
    },
    revalidatePath: vi.fn(),
    checkOutputChain: vi.fn(),
    requireDeptEdit: vi.fn(),
    requirePerm: vi.fn(),
    resolveWorker: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/server/outputGuard", () => ({ checkOutputChain: h.checkOutputChain }));
vi.mock("@/lib/server/auth", () => ({
  requireDeptEdit: h.requireDeptEdit,
  requirePerm: h.requirePerm,
}));
vi.mock("@/lib/server/workers", () => ({ resolveWorker: h.resolveWorker }));

import {
  recordLeakTest,
  markTankRepaired,
  paintTanks,
  sendTankBackToWelding,
  recordTankQa,
} from "@/app/tanks/actions";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** Rows written inside the last $transaction, per model. */
const writes = {
  tankUpdates: [] as Record<string, unknown>[],
  events: [] as Record<string, unknown>[],
  ledger: [] as Record<string, unknown>[],
};

const tank = (over: Record<string, unknown> = {}) => ({
  id: 1,
  serial: "SF-B-0001",
  bom: "B",
  mo: "MO-1",
  planNo: 0,
  status: "welded",
  weldedBy: "Sayed",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  writes.tankUpdates.length = 0;
  writes.events.length = 0;
  writes.ledger.length = 0;

  h.requireDeptEdit.mockResolvedValue({ user: { name: "tester" } });
  h.requirePerm.mockResolvedValue({ user: { name: "tester" } });
  h.resolveWorker.mockResolvedValue({ worker: { id: 7, name: "Sayed" } });
  h.checkOutputChain.mockResolvedValue(null);

  h.prisma.$transaction.mockImplementation((body: (tx: unknown) => Promise<unknown>) =>
    body({
      tankUnit: { update: async (a: { data: Record<string, unknown> }) => { writes.tankUpdates.push(a.data); } },
      tankEvent: { create: async (a: { data: Record<string, unknown> }) => { writes.events.push(a.data); } },
      handoverEntry: { create: async (a: { data: Record<string, unknown> }) => { writes.ledger.push(a.data); } },
      plan: { upsert: async () => ({}) },
    })
  );
});

describe("recordLeakTest", () => {
  it("passes a batch: every tank moves to tested and the tester is on record", async () => {
    h.prisma.tankUnit.findMany.mockResolvedValue([tank(), tank({ id: 2, serial: "SF-B-0002" })]);
    const res = await recordLeakTest(
      form({ serials: "SF-B-0001,SF-B-0002", result: "pass", workerId: "7", date: "2026-08-27" })
    );
    expect(res).toEqual({ ok: true, count: 2 });
    expect(writes.tankUpdates).toEqual([
      expect.objectContaining({ status: "tested", testResult: "pass", testedBy: "Sayed" }),
      expect.objectContaining({ status: "tested", testResult: "pass", testedBy: "Sayed" }),
    ]);
    expect(writes.events.map((e) => e.kind)).toEqual(["leak-pass", "leak-pass"]);
    // the leak test never moves a quantity — a failed tank is still welded
    expect(writes.ledger).toEqual([]);
  });

  it("sends a failing tank back to welding with the reason attached", async () => {
    h.prisma.tankUnit.findMany.mockResolvedValue([tank()]);
    const res = await recordLeakTest(
      form({ serials: "SF-B-0001", result: "repair", workerId: "7", note: "تسريب من اللحام السفلي" })
    );
    expect(res).toEqual({ ok: true, count: 1 });
    expect(writes.tankUpdates[0]).toMatchObject({ status: "repair", testNote: "تسريب من اللحام السفلي" });
    expect(writes.events[0]).toMatchObject({ kind: "leak-repair" });
  });

  it("will not fail a tank without saying what is wrong", async () => {
    h.prisma.tankUnit.findMany.mockResolvedValue([tank()]);
    const res = await recordLeakTest(form({ serials: "SF-B-0001", result: "repair", workerId: "7" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/اكتب المشكلة/);
    expect(writes.tankUpdates).toEqual([]);
  });

  it("needs a named tester", async () => {
    const res = await recordLeakTest(form({ serials: "SF-B-0001", result: "pass" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/مين اللى عمل الاختبار/);
  });

  it("refuses to re-test a tank that is waiting for its repair", async () => {
    h.prisma.tankUnit.findMany.mockResolvedValue([tank({ status: "repair" })]);
    const res = await recordLeakTest(form({ serials: "SF-B-0001", result: "pass", workerId: "7" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/إصلاح/);
    expect(writes.tankUpdates).toEqual([]);
  });

  it("names the serials it could not find rather than half-saving", async () => {
    h.prisma.tankUnit.findMany.mockResolvedValue([tank()]);
    const res = await recordLeakTest(
      form({ serials: "SF-B-0001,SF-B-0009", result: "pass", workerId: "7" })
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("SF-B-0009");
  });

  it("stops at the permission gate before touching anything", async () => {
    h.requireDeptEdit.mockResolvedValue({ error: "no permission" });
    const res = await recordLeakTest(form({ serials: "SF-B-0001", result: "pass", workerId: "7" }));
    expect(res).toEqual({ ok: false, error: "no permission" });
    expect(h.prisma.tankUnit.findMany).not.toHaveBeenCalled();
  });
});

describe("markTankRepaired", () => {
  it("puts a repaired tank back in the leak-test queue", async () => {
    h.prisma.tankUnit.findUnique.mockResolvedValue(tank({ status: "repair" }));
    const res = await markTankRepaired(form({ serial: "SF-B-0001", workerId: "7" }));
    expect(res).toEqual({ ok: true, count: 1 });
    expect(writes.tankUpdates[0]).toEqual({ status: "welded", testResult: null });
    expect(writes.events[0]).toMatchObject({ kind: "repaired", workerName: "Sayed" });
  });

  it("refuses a tank nobody asked to be repaired", async () => {
    h.prisma.tankUnit.findUnique.mockResolvedValue(tank({ status: "welded" }));
    const res = await markTankRepaired(form({ serial: "SF-B-0001", workerId: "7" }));
    expect(res.ok).toBe(false);
    expect(writes.tankUpdates).toEqual([]);
  });
});

describe("paintTanks", () => {
  it("paints the picked tanks and writes ONE ledger row per order", async () => {
    h.prisma.tankUnit.findMany.mockResolvedValue([
      tank({ status: "tested" }),
      tank({ id: 2, serial: "SF-B-0002", status: "tested" }),
      tank({ id: 3, serial: "SF-C-0001", bom: "C", mo: "MO-2", status: "tested" }),
    ]);
    const res = await paintTanks(
      form({ serials: "SF-B-0001,SF-B-0002,SF-C-0001", workerId: "7", date: "2026-08-27" })
    );
    expect(res).toEqual({ ok: true, count: 3 });
    expect(writes.ledger).toEqual([
      expect.objectContaining({ dept: "Painting", mo: "MO-1", item: "TN", qty: 2 }),
      expect.objectContaining({ dept: "Painting", mo: "MO-2", item: "TN", qty: 1 }),
    ]);
    // the ledger row says which tanks it stands for
    expect(String(writes.ledger[0].note)).toContain("SF-B-0001");
    expect(writes.tankUpdates.every((u) => u.status === "painted")).toBe(true);
  });

  it("refuses a tank that never passed the leak test — the whole point of the gate", async () => {
    h.prisma.tankUnit.findMany.mockResolvedValue([tank({ status: "welded" })]);
    const res = await paintTanks(form({ serials: "SF-B-0001", workerId: "7" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/اختبار تسريب/);
    expect(writes.ledger).toEqual([]);
  });

  it("refuses a tank the leak test sent back", async () => {
    h.prisma.tankUnit.findMany.mockResolvedValue([tank({ status: "repair" })]);
    const res = await paintTanks(form({ serials: "SF-B-0001", workerId: "7" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/رسب/);
  });

  it("still answers to the physical chain", async () => {
    h.prisma.tankUnit.findMany.mockResolvedValue([tank({ status: "tested" })]);
    h.checkOutputChain.mockResolvedValue("Chain check: painted must stay ≤ welded.");
    const res = await paintTanks(form({ serials: "SF-B-0001", workerId: "7" }));
    expect(res).toEqual({ ok: false, error: "Chain check: painted must stay ≤ welded." });
    expect(writes.ledger).toEqual([]);
  });

  it("needs a named painter", async () => {
    const res = await paintTanks(form({ serials: "SF-B-0001" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/مين اللى دهن/);
  });
});

describe("sendTankBackToWelding", () => {
  it("moves the tank to repair and leaves the ledger alone", async () => {
    h.prisma.tankUnit.findUnique.mockResolvedValue(tank({ status: "tested" }));
    const res = await sendTankBackToWelding(form({ serial: "SF-B-0001", reason: "لحام مفتوح" }));
    expect(res).toEqual({ ok: true, count: 1 });
    expect(writes.tankUpdates[0]).toMatchObject({ status: "repair", testNote: "لحام مفتوح" });
    expect(writes.ledger).toEqual([]);
  });

  it("insists on a reason the welder can act on", async () => {
    const res = await sendTankBackToWelding(form({ serial: "SF-B-0001", reason: "" }));
    expect(res.ok).toBe(false);
    expect(writes.tankUpdates).toEqual([]);
  });

  it("will not un-paint a finished tank behind the ledger's back", async () => {
    h.prisma.tankUnit.findUnique.mockResolvedValue(tank({ status: "painted" }));
    const res = await sendTankBackToWelding(form({ serial: "SF-B-0001", reason: "x" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/اتدهن/);
  });
});

describe("recordTankQa", () => {
  it("records a pass, falling back to the app account when no worker is picked", async () => {
    h.resolveWorker.mockResolvedValue({});
    h.prisma.tankUnit.findUnique.mockResolvedValue(tank({ status: "painted" }));
    const res = await recordTankQa(form({ serial: "SF-B-0001", result: "ok" }));
    expect(res).toEqual({ ok: true, count: 1 });
    expect(writes.tankUpdates[0]).toMatchObject({ qaResult: "ok", qaBy: "tester" });
    expect(writes.events[0]).toMatchObject({ kind: "qa-ok" });
  });

  it("will not record a rejection without saying what is wrong", async () => {
    h.prisma.tankUnit.findUnique.mockResolvedValue(tank({ status: "painted" }));
    const res = await recordTankQa(form({ serial: "SF-B-0001", result: "not-ok" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/اكتب المشكلة/);
  });

  it("is gated on the quality permission, not a department", async () => {
    h.requirePerm.mockResolvedValue({ error: "no permission" });
    const res = await recordTankQa(form({ serial: "SF-B-0001", result: "ok" }));
    expect(res).toEqual({ ok: false, error: "no permission" });
    expect(h.requirePerm).toHaveBeenCalledWith("quality.qa");
  });
});
