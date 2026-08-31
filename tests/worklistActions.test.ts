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
    mintTankSerials: vi.fn(),
    unmintTankSerials: vi.fn(),
    resolveWorker: vi.fn(),
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
vi.mock("@/lib/server/tanks", () => ({
  mintTankSerials: h.mintTankSerials,
  unmintTankSerials: h.unmintTankSerials,
}));
vi.mock("@/lib/server/workers", () => ({ resolveWorker: h.resolveWorker }));

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
  h.getSettings.mockResolvedValue({ leadCut: 4, tankTracking: true });
  h.prisma.plan.upsert.mockResolvedValue({});
  h.prisma.handoverEntry.create.mockResolvedValue({ id: 1 });
  h.prisma.handoverEntry.aggregate.mockResolvedValue({ _sum: { qty: 0 } });
  h.prisma.masterOrder.findMany.mockResolvedValue([]);
  h.prisma.handoverEntry.groupBy.mockResolvedValue([]);
  // tanks: a named welder resolves, minting hands back the serials it made
  h.resolveWorker.mockResolvedValue({ worker: { id: 7, name: "Sayed" } });
  h.mintTankSerials.mockImplementation(async (_tx: unknown, o: { count: number }) =>
    Array.from({ length: o.count }, (_, i) => ({ seq: i + 1, serial: `SF-B-000${i + 1}` }))
  );
  h.unmintTankSerials.mockResolvedValue({ removed: 0, short: 0 });
  // run the transaction body against a tx whose create() we can inspect
  txWrites.length = 0;
  h.prisma.$transaction.mockImplementation((body: (tx: unknown) => Promise<unknown>) => {
    const p = body({
      handoverEntry: { create: async ({ data }: { data: Record<string, unknown> }) => { txWrites.push(data); return { id: 1 }; } },
      returnEntry: { create: async () => ({ id: 1 }) },
    });
    // the real client returns a promise with .catch — the actions rely on it
    return p;
  });
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
    expect(txWrites).toEqual([
      expect.objectContaining({ dept: "Cut", bom: "B", mo: "MO-1", item: "CF", qty: 3, planNo: 0, source: "worklist" }),
    ]);
    // nothing but tanks is tracked per piece
    expect(h.mintTankSerials).not.toHaveBeenCalled();
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
    expect(txWrites).toEqual([expect.objectContaining({ qty: 3, source: "tracker" })]);
  });
});

describe("tanks (TN) — the ledger row and the serials move together", () => {
  beforeEach(() => {
    h.prisma.masterOrder.findFirst.mockResolvedValue({ mo: "MO-1" });
  });

  const weld = (extra: Record<string, string> = {}) =>
    form({ date: DATE, dept: "Welding", bom: "B", mo: "MO-1", item: "TN", qty: "3", planNo: "0", workerId: "7", ...extra });

  it("mints one serial per welded tank and hands them back to the technician", async () => {
    const res = await recordOutput(weld());
    expect(res.ok).toBe(true);
    expect(res.serials).toEqual(["SF-B-0001", "SF-B-0002", "SF-B-0003"]);
    expect(txWrites).toEqual([expect.objectContaining({ dept: "Welding", item: "TN", qty: 3 })]);
    expect(h.mintTankSerials).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ bom: "B", mo: "MO-1", count: 3, workerId: 7, workerName: "Sayed" }),
    );
  });

  it("refuses a welded batch with nobody named on it", async () => {
    const fd = weld();
    fd.delete("workerId");
    const res = await recordOutput(fd);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/who welded/);
    expect(txWrites).toEqual([]);
  });

  it("refuses a fractional quantity — a tank is a piece, not a weight", async () => {
    const res = await recordOutput(weld({ qty: "2.5" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/by the piece/);
    expect(txWrites).toEqual([]);
  });

  it("refuses a tank with no MO — a serial belongs to an order", async () => {
    const fd = weld();
    fd.set("mo", "");
    h.prisma.handoverEntry.findFirst.mockResolvedValue({ id: 1 });
    const res = await recordOutput(fd);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/needs an MO/);
  });

  it("passes a rejected welder straight through to the technician", async () => {
    h.resolveWorker.mockResolvedValue({ error: "Sayed is deactivated on the workers list" });
    const res = await recordOutput(weld());
    expect(res).toEqual({ ok: false, error: "Sayed is deactivated on the workers list" });
    expect(txWrites).toEqual([]);
  });

  it("mints from the tracker's Weld cell too, with no welder to name there", async () => {
    h.prisma.handoverEntry.aggregate.mockResolvedValue({ _sum: { qty: 1 } });
    const res = await recordTrackerTotal(form({ dept: "Welding", bom: "B", mo: "MO-1", item: "TN", total: "4" }));
    expect(res).toEqual({ ok: true });
    expect(h.mintTankSerials).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ count: 3, bom: "B", mo: "MO-1" }),
    );
  });

  it("refuses to correct the weld total below tanks that already moved on", async () => {
    h.prisma.handoverEntry.aggregate.mockResolvedValue({ _sum: { qty: 5 } });
    h.unmintTankSerials.mockResolvedValue({ removed: 1, short: 2 });
    const res = await recordTrackerTotal(form({ dept: "Welding", bom: "B", mo: "MO-1", item: "TN", total: "2" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/2 of those tanks/);
  });

  it("sends painting of tanks to the painting worklist, from every quantity box", async () => {
    const tracker = await recordTrackerTotal(form({ dept: "Painting", bom: "B", mo: "MO-1", item: "TN", total: "3" }));
    expect(tracker.ok).toBe(false);
    expect(tracker.error).toMatch(/Painting worklist/);

    const group = await recordGroupOutput(form({ source: "worklist", dept: "Painting", bom: "B", item: "TN", qty: "3", mos: "MO-1" }));
    expect(group.ok).toBe(false);
    expect(group.error).toMatch(/Painting worklist/);
    expect(txWrites).toEqual([]);
  });

  it("sends a bad tank back to welding by serial, not as a quantity", async () => {
    h.prisma.handoverEntry.groupBy.mockResolvedValue([
      { dept: "Welding", _sum: { qty: 5 } },
      { dept: "Painting", _sum: { qty: 0 } },
    ]);
    const res = await returnToUpstream(form({ fromDept: "Painting", bom: "B", mo: "MO-1", item: "TN", qty: "1", reason: "leak" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/by serial/);
  });

  it("still returns a non-tank component from painting as a quantity", async () => {
    h.prisma.handoverEntry.groupBy.mockResolvedValue([
      { dept: "Welding", _sum: { qty: 5 } },
      { dept: "Painting", _sum: { qty: 0 } },
    ]);
    const res = await returnToUpstream(form({ fromDept: "Painting", bom: "B", mo: "MO-1", item: "TC", qty: "1", reason: "chipped" }));
    expect(res.ok).toBe(true);
  });
});

describe("the master switch — with tank tracking OFF a tank is just a quantity", () => {
  beforeEach(() => {
    h.getSettings.mockResolvedValue({ leadCut: 4, tankTracking: false });
    h.prisma.masterOrder.findFirst.mockResolvedValue({ mo: "MO-1" });
  });

  it("welds tanks by quantity again — no serial, no welder asked for", async () => {
    const res = await recordOutput(
      form({ date: DATE, dept: "Welding", bom: "B", mo: "MO-1", item: "TN", qty: "3", planNo: "0" })
    );
    expect(res).toEqual({ ok: true });
    expect(res.serials).toBeUndefined();
    expect(h.mintTankSerials).not.toHaveBeenCalled();
    expect(txWrites).toEqual([expect.objectContaining({ dept: "Welding", item: "TN", qty: 3 })]);
  });

  it("takes a fractional tank quantity, like any other component", async () => {
    const res = await recordOutput(
      form({ date: DATE, dept: "Welding", bom: "B", mo: "MO-1", item: "TN", qty: "2.5", planNo: "0" })
    );
    expect(res.ok).toBe(true);
  });

  it("lets the tracker's Paint cell record tanks again", async () => {
    h.prisma.handoverEntry.aggregate.mockResolvedValue({ _sum: { qty: 0 } });
    const res = await recordTrackerTotal(form({ dept: "Painting", bom: "B", mo: "MO-1", item: "TN", total: "3" }));
    expect(res).toEqual({ ok: true });
    expect(txWrites).toEqual([expect.objectContaining({ dept: "Painting", item: "TN", qty: 3 })]);
  });

  it("lets a BOM group row paint tanks again", async () => {
    // painting is capped at what welding delivered, switch or no switch
    h.prisma.handoverEntry.groupBy.mockResolvedValue([
      { mo: "MO-1", dept: "Welding", _sum: { qty: 5 } },
      { mo: "MO-1", dept: "Painting", _sum: { qty: 0 } },
    ]);
    const res = await recordGroupOutput(
      form({ source: "worklist", dept: "Painting", bom: "B", item: "TN", qty: "2", mos: "MO-1" })
    );
    expect(res.ok).toBe(true);
    expect(txWrites).toEqual([expect.objectContaining({ dept: "Painting", item: "TN", qty: 2 })]);
  });

  it("does not un-mint on a tracker correction — there are no serials to touch", async () => {
    h.prisma.handoverEntry.aggregate.mockResolvedValue({ _sum: { qty: 5 } });
    const res = await recordTrackerTotal(form({ dept: "Welding", bom: "B", mo: "MO-1", item: "TN", total: "2" }));
    expect(res).toEqual({ ok: true });
    expect(h.unmintTankSerials).not.toHaveBeenCalled();
  });

  it("returns a tank from painting as a quantity again", async () => {
    h.prisma.handoverEntry.groupBy.mockResolvedValue([
      { dept: "Welding", _sum: { qty: 5 } },
      { dept: "Painting", _sum: { qty: 0 } },
    ]);
    const res = await returnToUpstream(form({ fromDept: "Painting", bom: "B", mo: "MO-1", item: "TN", qty: "1", reason: "leak" }));
    expect(res.ok).toBe(true);
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
