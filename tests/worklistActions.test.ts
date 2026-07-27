import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- mock harness for the worklist server actions ----------------------------
// The actions orchestrate Prisma + Next cache + auth guards around the (already
// unit-tested) domain helpers. We stub the I/O boundary and assert on the
// validation guards and the DB writes each action decides to make.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      masterOrder: { findFirst: fn(), findUnique: fn() },
      planSchedule: { findFirst: fn() },
      planOrder: { findFirst: fn() },
      handoverEntry: { findFirst: fn(), create: fn(), aggregate: fn(), groupBy: fn() },
      plan: { upsert: fn() },
    },
    revalidatePath: vi.fn(),
    checkOutputChain: vi.fn(),
    requireDeptEdit: vi.fn(),
    requireAdmin: vi.fn(),
    requirePerm: vi.fn(),
    getPlanWindows: vi.fn(),
    getSettings: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@vercel/blob", () => ({ put: vi.fn(), del: vi.fn() }));
vi.mock("@/lib/server/outputGuard", () => ({ checkOutputChain: h.checkOutputChain }));
vi.mock("@/lib/server/data", () => ({ getPlanWindows: h.getPlanWindows, getSettings: h.getSettings }));
vi.mock("@/lib/server/auth", () => ({
  requireDeptEdit: h.requireDeptEdit,
  requireAdmin: h.requireAdmin,
  requirePerm: h.requirePerm,
}));

import { recordOutput, recordTrackerTotal, returnToUpstream } from "@/app/worklist/actions";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const OK_GUARD = { user: { name: "tester" } };
const DATE = "2026-07-22";

beforeEach(() => {
  vi.clearAllMocks();
  // default: permitted, chain clear, empty plan windows
  h.requireDeptEdit.mockResolvedValue(OK_GUARD);
  h.requireAdmin.mockResolvedValue(OK_GUARD);
  h.requirePerm.mockResolvedValue(OK_GUARD);
  h.checkOutputChain.mockResolvedValue(null);
  h.getPlanWindows.mockResolvedValue([]);
  h.getSettings.mockResolvedValue({ leadCut: 4 });
  h.prisma.plan.upsert.mockResolvedValue({});
  h.prisma.handoverEntry.create.mockResolvedValue({ id: 1 });
  h.prisma.handoverEntry.aggregate.mockResolvedValue({ _sum: { qty: 0 } });
});

describe("recordOutput — validation guards run before any DB write", () => {
  it("rejects an invalid date", async () => {
    const res = await recordOutput(form({ date: "not-a-date", dept: "Cut", bom: "B", item: "CF", qty: "1", planNo: "0" }));
    expect(res).toEqual({ ok: false, error: "Invalid date." });
    expect(h.prisma.handoverEntry.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown department", async () => {
    const res = await recordOutput(form({ date: DATE, dept: "Foo", bom: "B", item: "CF", qty: "1", planNo: "0" }));
    expect(res).toEqual({ ok: false, error: "Invalid department." });
  });

  it("surfaces the permission error from the dept guard", async () => {
    h.requireDeptEdit.mockResolvedValue({ error: "You do not have permission for this action — ask the admin." });
    const res = await recordOutput(form({ date: DATE, dept: "Cut", bom: "B", item: "CF", qty: "1", planNo: "0" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/permission/);
    expect(h.prisma.handoverEntry.create).not.toHaveBeenCalled();
  });

  it("rejects a missing BOM", async () => {
    const res = await recordOutput(form({ date: DATE, dept: "Cut", bom: "", item: "CF", qty: "1", planNo: "0" }));
    expect(res).toEqual({ ok: false, error: "Missing BOM." });
  });

  it("rejects an invalid component", async () => {
    const res = await recordOutput(form({ date: DATE, dept: "Cut", bom: "B", item: "ZZ", qty: "1", planNo: "0" }));
    expect(res).toEqual({ ok: false, error: "Invalid component." });
  });

  it("rejects a non-positive quantity", async () => {
    const res = await recordOutput(form({ date: DATE, dept: "Cut", bom: "B", item: "CF", qty: "0", planNo: "0" }));
    expect(res).toEqual({ ok: false, error: "Enter a quantity greater than zero." });
  });

  it("rejects a negative plan number", async () => {
    const res = await recordOutput(form({ date: DATE, dept: "Cut", bom: "B", item: "CF", qty: "1", planNo: "-1" }));
    expect(res).toEqual({ ok: false, error: "Invalid plan number." });
  });

  it("rejects an MO that is in no registry or plan", async () => {
    h.prisma.masterOrder.findFirst.mockResolvedValue(null);
    h.prisma.planSchedule.findFirst.mockResolvedValue(null);
    h.prisma.planOrder.findFirst.mockResolvedValue(null);
    h.prisma.handoverEntry.findFirst.mockResolvedValue(null);
    const res = await recordOutput(form({ date: DATE, dept: "Cut", bom: "B", mo: "MO-404", item: "CF", qty: "1", planNo: "0" }));
    expect(res).toEqual({ ok: false, error: "This MO is not in the orders registry or any plan." });
    expect(h.prisma.handoverEntry.create).not.toHaveBeenCalled();
  });

  it("writes a dated ledger entry on the happy path", async () => {
    h.prisma.masterOrder.findFirst.mockResolvedValue({ mo: "MO-1" });
    const res = await recordOutput(form({ date: DATE, dept: "Cut", bom: "B", mo: "MO-1", item: "CF", qty: "3", planNo: "0" }));
    expect(res).toEqual({ ok: true });
    expect(h.prisma.handoverEntry.create).toHaveBeenCalledTimes(1);
    expect(h.prisma.handoverEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dept: "Cut", bom: "B", mo: "MO-1", item: "CF", qty: 3, planNo: 0, source: "worklist" }),
      }),
    );
    expect(h.revalidatePath).toHaveBeenCalled();
  });

  it("blocks a write that would break the physical chain", async () => {
    h.prisma.masterOrder.findFirst.mockResolvedValue({ mo: "MO-1" });
    h.checkOutputChain.mockResolvedValue("Cut 3 would exceed the order quantity.");
    const res = await recordOutput(form({ date: DATE, dept: "Cut", bom: "B", mo: "MO-1", item: "CF", qty: "3", planNo: "0" }));
    expect(res).toEqual({ ok: false, error: "Cut 3 would exceed the order quantity." });
    expect(h.prisma.handoverEntry.create).not.toHaveBeenCalled();
  });
});

describe("recordTrackerTotal — delta accounting", () => {
  it("rejects an unknown department", async () => {
    const res = await recordTrackerTotal(form({ dept: "Foo", bom: "B", mo: "MO-1", item: "CF", total: "5" }));
    expect(res).toEqual({ ok: false, error: "Invalid department." });
  });

  it("refuses shot blast on a painted (non-exempt) component", async () => {
    const res = await recordTrackerTotal(form({ dept: "ShotBlast", bom: "B", mo: "MO-1", item: "TC", total: "5" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/painted, not shot blasted/);
  });

  it("rejects a non-integer total", async () => {
    const res = await recordTrackerTotal(form({ dept: "Cut", bom: "B", mo: "MO-1", item: "CF", total: "2.5" }));
    expect(res).toEqual({ ok: false, error: "Enter a whole number ≥ 0." });
  });

  it("does nothing when the new total equals the current one", async () => {
    h.prisma.handoverEntry.aggregate.mockResolvedValue({ _sum: { qty: 5 } });
    const res = await recordTrackerTotal(form({ dept: "Cut", bom: "B", mo: "MO-1", item: "CF", total: "5" }));
    expect(res).toEqual({ ok: false, error: "Nothing changed — the total is already 5." });
    expect(h.prisma.handoverEntry.create).not.toHaveBeenCalled();
  });

  it("records the DIFFERENCE as a dated entry when the total goes up", async () => {
    h.prisma.handoverEntry.aggregate.mockResolvedValue({ _sum: { qty: 2 } });
    const res = await recordTrackerTotal(form({ dept: "Cut", bom: "B", mo: "MO-1", item: "CF", total: "5" }));
    expect(res).toEqual({ ok: true });
    expect(h.prisma.handoverEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ qty: 3, source: "tracker" }) }),
    );
  });
});

describe("returnToUpstream — can only return what is waiting", () => {
  it("rejects a department with no upstream (Cut)", async () => {
    const res = await returnToUpstream(form({ fromDept: "Cut", bom: "B", item: "CF", qty: "1", reason: "x" }));
    expect(res).toEqual({ ok: false, error: "Invalid department." });
  });

  it("refuses to return more than the queue holds", async () => {
    // Welding returns upstream to Cut: available = cut(5) − welding(0) = 5
    h.prisma.handoverEntry.groupBy.mockResolvedValue([
      { dept: "Cut", _sum: { qty: 5 } },
      { dept: "Welding", _sum: { qty: 0 } },
    ]);
    const res = await returnToUpstream(form({ fromDept: "Welding", bom: "B", mo: "MO-1", item: "CF", qty: "10", reason: "bad weld" }));
    expect(res).toEqual({ ok: false, error: "Only 5 pcs are waiting in this queue — cannot return 10." });
  });

  it("requires a reason", async () => {
    const res = await returnToUpstream(form({ fromDept: "Welding", bom: "B", mo: "MO-1", item: "CF", qty: "1", reason: "" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/reason/);
  });
});
