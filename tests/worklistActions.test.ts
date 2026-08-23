import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- mock harness for the worklist server actions ----------------------------
// The actions orchestrate Prisma + Next cache + auth guards around the (already
// unit-tested) domain helpers. We stub the I/O boundary and assert on the
// validation guards and the DB writes each action decides to make.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      masterOrder: { findFirst: fn(), findUnique: fn(), findMany: fn() },
      planSchedule: { findFirst: fn() },
      planOrder: { findFirst: fn() },
      handoverEntry: { findFirst: fn(), create: fn(), aggregate: fn(), groupBy: fn() },
      plan: { upsert: fn() },
      $transaction: fn(),
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

import { recordOutput, recordTrackerTotal, recordGroupOutput, returnToUpstream } from "@/app/worklist/actions";

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
  h.prisma.masterOrder.findMany.mockResolvedValue([]);
  h.prisma.handoverEntry.groupBy.mockResolvedValue([]);
  // run the transaction body against a tx whose create() we can inspect
  txWrites.length = 0;
  h.prisma.$transaction.mockImplementation(async (body: (tx: unknown) => Promise<void>) =>
    body({ handoverEntry: { create: async ({ data }: { data: Record<string, unknown> }) => { txWrites.push(data); } } })
  );
});

/** Every ledger row written inside the last $transaction. */
const txWrites: Record<string, unknown>[] = [];

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

/* Recording straight onto the WEEKLY plan. It reuses the group distribution
   (a weekly cell aggregates the orders that delivery day owes), but with its
   OWN permission and ADD semantics — a weekly cell shows a day's capped,
   waterfalled slice, so "add N pcs" is the only unambiguous instruction. */
describe("recordGroupOutput — recording from the weekly plan", () => {
  const ORDER = { mo: "MO-1", bom: "B-1", planQty: 10, ospCF: 0, ospTC: 0, ospTN: 0, ospCB: 0, excludedItems: null, kva: "1000", rating: null };
  const weeklyForm = (over: Record<string, string> = {}) =>
    form({ source: "weekly", dept: "Welding", bom: "B-1", item: "CF", mos: "MO-1", qty: "3", dayISO: "2026-08-11", planLabel: "32", ...over });

  beforeEach(() => {
    h.prisma.masterOrder.findMany.mockResolvedValue([ORDER]);
    // 5 already cut, nothing welded — welding headroom is 5
    h.prisma.handoverEntry.groupBy.mockResolvedValue([{ mo: "MO-1", dept: "Cut", _sum: { qty: 5 } }]);
  });

  it("asks for the weekly permission — not a tracker column permission", async () => {
    await recordGroupOutput(weeklyForm());
    expect(h.requirePerm).toHaveBeenCalledWith("weekly.record");
  });

  it("refuses before any write when that permission is missing", async () => {
    h.requirePerm.mockResolvedValue({ error: "You do not have permission for this action — ask the admin." });
    const res = await recordGroupOutput(weeklyForm());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/permission/);
    expect(txWrites).toHaveLength(0);
  });

  it("writes the pieces marked as coming from the weekly plan", async () => {
    const res = await recordGroupOutput(weeklyForm());
    expect(res.ok).toBe(true);
    expect(txWrites).toHaveLength(1);
    expect(txWrites[0]).toMatchObject({ dept: "Welding", bom: "B-1", mo: "MO-1", item: "CF", qty: 3, source: "weekly" });
    // the note names the plan and the delivery day it was recorded against
    expect(String(txWrites[0].note)).toContain("weekly plan 32");
    expect(String(txWrites[0].note)).toContain("2026-08-11");
  });

  it("ADDS pieces — it never reads a 'total' field", async () => {
    // a total field must not be mistaken for the quantity
    await recordGroupOutput(weeklyForm({ qty: "2", total: "99" }));
    expect(txWrites[0]).toMatchObject({ qty: 2 });
  });

  it("rejects a zero or fractional quantity", async () => {
    for (const qty of ["0", "-2", "1.5"]) {
      txWrites.length = 0;
      const res = await recordGroupOutput(weeklyForm({ qty }));
      expect(res.ok).toBe(false);
      expect(txWrites).toHaveLength(0);
    }
  });

  it("splits over the orders the day owes, and never past the chain", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([ORDER, { ...ORDER, mo: "MO-2" }]);
    h.prisma.handoverEntry.groupBy.mockResolvedValue([
      { mo: "MO-1", dept: "Cut", _sum: { qty: 2 } }, // welding headroom 2
      { mo: "MO-2", dept: "Cut", _sum: { qty: 4 } }, // welding headroom 4
    ]);
    const res = await recordGroupOutput(weeklyForm({ mos: "MO-1,MO-2", qty: "5" }));
    expect(res.ok).toBe(true);
    expect(txWrites.map((w) => [w.mo, w.qty])).toEqual([["MO-1", 2], ["MO-2", 3]]);
  });

  it("saves nothing at all when the quantity does not fit the chain", async () => {
    const res = await recordGroupOutput(weeklyForm({ qty: "9" })); // headroom is 5
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Only 5 pcs fit/);
    expect(txWrites).toHaveLength(0);
  });
});
