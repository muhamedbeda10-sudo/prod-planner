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
      returnEntry: { findUnique: fn() },
      handoverEntry: { findFirst: fn(), create: fn(), aggregate: fn(), groupBy: fn() },
      plan: { upsert: fn(), findUnique: fn() },
      $transaction: fn(),
    },
    revalidatePath: vi.fn(),
    checkOutputChain: vi.fn(),
    recheck: vi.fn(),
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
vi.mock("@/lib/server/outputGuard", () => ({ checkOutputChain: h.checkOutputChain, recheckLvChainLocked: h.recheck, ChainRefused: class extends Error {} }));
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

import { recordOutput, recordTrackerTotal, recordGroupOutput, redeliverReturn, returnToUpstream } from "@/app/worklist/actions";

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
  h.prisma.masterOrder.findUnique.mockResolvedValue(null);
  h.prisma.handoverEntry.groupBy.mockResolvedValue([]);
  // tanks: a named welder resolves, minting hands back the serials it made
  h.resolveWorker.mockResolvedValue({ worker: { id: 7, name: "Sayed" } });
  h.mintTankSerials.mockImplementation(async (_tx: unknown, o: { count: number }) =>
    Array.from({ length: o.count }, (_, i) => ({ seq: i + 1, serial: `SF-B-000${i + 1}` }))
  );
  h.unmintTankSerials.mockResolvedValue({ removed: 0, short: 0 });
  // run the transaction body against a tx whose create() we can inspect
  txWrites.length = 0;
  openReturns.clear();
  h.prisma.$transaction.mockImplementation((body: (tx: unknown) => Promise<unknown>) => {
    const p = body({
      handoverEntry: { create: async ({ data }: { data: Record<string, unknown> }) => { txWrites.push(data); return { id: 1 }; } },
      returnEntry: {
        create: async () => ({ id: 1 }),
        // closing a return is conditional on it still being open
        updateMany: async ({ where }: { where: { id: number; status: string } }) => ({ count: openReturns.delete(where.id) ? 1 : 0 }),
      },
    });
    // the real client returns a promise with .catch — the actions rely on it
    return p;
  });
});

/** Every ledger row written inside the last $transaction. */
const txWrites: Record<string, unknown>[] = [];
/** Returns still open as far as the transaction's conditional close sees. */
const openReturns = new Set<number>();

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

  it("surfaces the permission error from the row's key — a transformer's is its dept's", async () => {
    h.requirePerm.mockResolvedValue({ error: "You do not have permission for this action — ask the admin." });
    const res = await recordOutput(form({ date: DATE, dept: "Cut", bom: "B", item: "CF", qty: "1", planNo: "0" }));
    expect(h.requirePerm).toHaveBeenCalledExactlyOnceWith("cut.edit");
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
    expect(res).toEqual({ ok: true, ledgerId: 1 });
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

describe("recordOutput — a panel off a machine card takes the LV stage's key, not the bay's", () => {
  const NO = { error: "You do not have permission for this action — ask the admin." };
  /** The guard's answer for an account holding exactly these keys. */
  const holding = (...keys: string[]) => h.requirePerm.mockImplementation(async (k: string) => (keys.includes(k) ? OK_GUARD : NO));
  const panel = (dept: string) => form({ date: DATE, dept, bom: "FG-LV-1", mo: "MO-LV", item: "PNL", qty: "2", planNo: "0" });

  it.each([
    ["Cut", "lv.punching"], // the fabrication bay's punches: a panel there is punched
    ["Punching", "lv.punching"],
    ["Bending", "lv.bending"],
    ["Welding", "lv.welding"],
    ["Painting", "lv.painting"],
  ])("a panel recorded at %s asks for %s", async (dept, key) => {
    h.requirePerm.mockResolvedValue(NO);
    expect(await recordOutput(panel(dept))).toEqual({ ok: false, error: NO.error });
    expect(h.requirePerm).toHaveBeenCalledExactlyOnceWith(key);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("the transformer welder's key no longer records a panel; the LV welder's does", async () => {
    h.prisma.masterOrder.findFirst.mockResolvedValue({ mo: "MO-LV", line: "LV", bom: "FG-LV-1" });
    holding("welding.edit");
    expect(await recordOutput(panel("Welding"))).toEqual({ ok: false, error: NO.error });
    expect(txWrites).toEqual([]);
    holding("lv.welding");
    expect(await recordOutput(panel("Welding"))).toEqual({ ok: true, ledgerId: 1 });
    expect(txWrites).toEqual([expect.objectContaining({ dept: "Welding", mo: "MO-LV", item: "PNL", qty: 2, source: "worklist" })]);
  });

  it("and the LV key records nothing on the transformers", async () => {
    holding("lv.welding");
    const res = await recordOutput(form({ date: DATE, dept: "Welding", bom: "B", mo: "MO-1", item: "CF", qty: "1", planNo: "0" }));
    expect(res).toEqual({ ok: false, error: NO.error });
    expect(h.requirePerm).toHaveBeenCalledExactlyOnceWith("welding.edit");
  });

  it("refuses a panel on a transformer order — the row would count on the LV dashboard and show on no tracker", async () => {
    holding("lv.welding");
    h.prisma.masterOrder.findFirst.mockResolvedValue({ mo: "T-1", line: "TR", bom: "TB-1" });
    const res = await recordOutput(form({ date: DATE, dept: "Welding", bom: "TB-1", mo: "T-1", item: "PNL", qty: "2", planNo: "0" }));
    expect(res).toEqual({ ok: false, error: "T-1 is not an LV panel order." });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(txWrites).toEqual([]);
  });

  it("refuses a transformer component on a panel order", async () => {
    holding("welding.edit");
    h.prisma.masterOrder.findFirst.mockResolvedValue({ mo: "P-1", line: "LV", bom: "FG-LV-1" });
    const res = await recordOutput(form({ date: DATE, dept: "Welding", bom: "FG-LV-1", mo: "P-1", item: "CF", qty: "1", planNo: "0" }));
    expect(res).toEqual({ ok: false, error: "P-1 is an LV panel order — panels are recorded on the LV tracker." });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("files a panel under its order's BOM, whatever the form said", async () => {
    holding("lv.punching");
    h.prisma.masterOrder.findFirst.mockResolvedValue({ mo: "MO-LV", line: "LV", bom: "FG-LV-1" });
    const res = await recordOutput(form({ date: DATE, dept: "Punching", bom: "WRONG", mo: "MO-LV", item: "PNL", qty: "2", planNo: "0" }));
    expect(res).toEqual({ ok: true, ledgerId: 1 });
    expect(h.checkOutputChain).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ bom: "FG-LV-1", mo: "MO-LV", item: "PNL" }));
    expect(txWrites).toEqual([expect.objectContaining({ dept: "Punching", bom: "FG-LV-1", mo: "MO-LV", item: "PNL", qty: 2 })]);
    // judged again under the order's lock, inside the write — the LV tracker may be recording on it too
    expect(h.recheck).toHaveBeenCalledExactlyOnceWith(expect.anything(), { dept: "Punching", bom: "FG-LV-1", mo: "MO-LV", item: "PNL", qty: 2 });
  });

  it("writes nothing when the locked re-check refuses the panel", async () => {
    holding("lv.punching");
    h.prisma.masterOrder.findFirst.mockResolvedValue({ mo: "MO-LV", line: "LV", bom: "FG-LV-1" });
    h.recheck.mockRejectedValueOnce(new Error("Chain check: 6 punched would pass the order's 4."));
    const res = await recordOutput(form({ date: DATE, dept: "Punching", bom: "FG-LV-1", mo: "MO-LV", item: "PNL", qty: "2", planNo: "0" }));
    expect(res.ok).toBe(false);
    expect(txWrites).toEqual([]);
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

  it("refuses a total typed from a page the ledger has moved on from", async () => {
    // the page showed 10; welding recorded 4 more since
    h.prisma.handoverEntry.aggregate.mockResolvedValue({ _sum: { qty: 14 } });
    h.prisma.masterOrder.findUnique.mockResolvedValue({ planQty: 20 });
    const res = await recordTrackerTotal(form({ dept: "Welding", bom: "B", mo: "MO-1", item: "CF", total: "11", base: "10" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/now 14, not the 10 on your screen/);
    expect(txWrites).toHaveLength(0);
  });

  it("compares the base with the figure the cell shows — capped at the order's quantity", async () => {
    // 12 recorded against an order of 10: the cell shows 10, and typing 9 takes the ledger to 9
    h.prisma.handoverEntry.aggregate.mockResolvedValue({ _sum: { qty: 12 } });
    h.prisma.masterOrder.findUnique.mockResolvedValue({ planQty: 10 });
    const res = await recordTrackerTotal(form({ dept: "Cut", bom: "B", mo: "MO-1", item: "CF", total: "9", base: "10" }));
    expect(res.ok).toBe(true);
    expect(txWrites[0]).toMatchObject({ qty: -3 });
  });

  it("refuses to ADD to a cell whose ledger already stands above the order quantity, but still lets it be lowered", async () => {
    h.prisma.handoverEntry.aggregate.mockResolvedValue({ _sum: { qty: 12 } });
    h.prisma.masterOrder.findUnique.mockResolvedValue({ planQty: 10 });
    const up = await recordTrackerTotal(form({ dept: "Cut", bom: "B", mo: "MO-1", item: "CF", total: "11", base: "10" }));
    expect(up.ok).toBe(false);
    expect(up.error).toMatch(/MO-1 has 12 recorded at Fabrication but the order is for 10/);
    expect(txWrites).toHaveLength(0);
    const down = await recordTrackerTotal(form({ dept: "Cut", bom: "B", mo: "MO-1", item: "CF", total: "10", base: "10" }));
    expect(down.ok).toBe(true);
    expect(txWrites[0]).toMatchObject({ qty: -2 });
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

    // the worklist / machine-card quantity box too — the leak-test gate has no other guard
    const worklist = await recordOutput(form({ date: DATE, dept: "Painting", bom: "B", mo: "MO-1", item: "TN", qty: "3", planNo: "0" }));
    expect(worklist.ok).toBe(false);
    expect(worklist.error).toMatch(/Painting worklist/);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
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
    expect(res).toEqual({ ok: true, ledgerId: 1 });
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

  it("refuses a group total typed from a stale page", async () => {
    // the page showed 3 cut on the group; the ledger holds 5 now
    const res = await recordGroupOutput(form({ source: "tracker", dept: "Cut", bom: "B-1", item: "CF", mos: "MO-1", total: "6", base: "3" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/now 5, not the 3 on your screen/);
    expect(txWrites).toHaveLength(0);
  });

  it("refuses a group whose MO exists nowhere — a mistyped MO would take every piece the real ones cannot", async () => {
    h.prisma.planSchedule.findFirst.mockResolvedValue(null);
    h.prisma.planOrder.findFirst.mockResolvedValue(null);
    h.prisma.handoverEntry.findFirst.mockResolvedValue(null);
    const res = await recordGroupOutput(form({ source: "tracker", dept: "Cut", bom: "B-1", item: "CF", mos: "MO-1,MO-9", total: "500", base: "5" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/MO-9|not on B-1, or is in no plan or log/);
    expect(txWrites).toHaveLength(0);
  });

  it("refuses a group total while a member's ledger stands above its order quantity", async () => {
    // 12 cut on an order of 10: the page shows 10; typing a group total over it would record from the wrong base
    h.prisma.handoverEntry.groupBy.mockResolvedValue([{ mo: "MO-1", dept: "Cut", _sum: { qty: 12 } }]);
    const res = await recordGroupOutput(form({ source: "tracker", dept: "Cut", bom: "B-1", item: "CF", mos: "MO-1", total: "13", base: "10" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/MO-1 has 12 recorded at Fabrication but the order is for 10/);
    expect(txWrites).toHaveLength(0);
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

describe("redeliverReturn", () => {
  const ret = { id: 5, status: "open", fromDept: "Welding", toDept: "Cut", mo: "MO-1", bom: "B", item: "CF", qty: 3, reason: "burr" };

  it("credits the upstream department and closes the return", async () => {
    h.prisma.returnEntry.findUnique.mockResolvedValue(ret);
    openReturns.add(5);
    const res = await redeliverReturn(form({ id: "5" }));
    expect(res).toEqual({ ok: true, ledgerId: 1 });
    expect(txWrites).toEqual([expect.objectContaining({ dept: "Cut", qty: 3, source: "return" })]);
  });

  it("credits it once when a second screen re-delivers the same return", async () => {
    h.prisma.returnEntry.findUnique.mockResolvedValue(ret);
    // both read it open; the first closed it before this write
    const res = await redeliverReturn(form({ id: "5" }));
    expect(res).toEqual({ ok: false, error: "Already re-delivered." });
    expect(txWrites).toEqual([]);
  });
});


describe("one rule for the two finishing stages — every recording path", () => {
  it("refuses painting the core frame on a worklist line, a tracker cell and a merged row, and shot blast on a painted part", async () => {
    const cf = "CF is shot blasted, not painted — record it on the SHB cell.";
    expect(await recordOutput(form({ date: DATE, dept: "Painting", bom: "B", mo: "MO-1", item: "CF", qty: "1", planNo: "0" }))).toEqual({ ok: false, error: cf });
    expect(await recordTrackerTotal(form({ dept: "Painting", bom: "B", mo: "MO-1", item: "CF", total: "1" }))).toEqual({ ok: false, error: cf });
    expect(await recordGroupOutput(form({ source: "tracker", dept: "Painting", bom: "B", item: "CF", mos: "MO-1", total: "1" }))).toEqual({ ok: false, error: cf });
    expect(await recordTrackerTotal(form({ dept: "ShotBlast", bom: "B", mo: "MO-1", item: "TN", total: "1" }))).toEqual({ ok: false, error: "TN is painted, not shot blasted — SHB applies to the core (CF) only." });
    expect(h.prisma.handoverEntry.create).not.toHaveBeenCalled();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("recordOutput — the plan it files under", () => {
  beforeEach(() => {
    h.prisma.masterOrder.findFirst.mockResolvedValue({ mo: "MO-1", bom: "B" });
  });
  it("creates the global bucket (plan 0) when it is missing", async () => {
    expect(await recordOutput(form({ date: DATE, dept: "Cut", bom: "B", mo: "MO-1", item: "CF", qty: "1", planNo: "0" }))).toMatchObject({ ok: true });
    expect(h.prisma.plan.upsert).toHaveBeenCalledExactlyOnceWith({ where: { planNo: 0 }, create: { planNo: 0, startDate: new Date(`${DATE}T00:00:00.000Z`) }, update: {} });
    expect(h.prisma.plan.findUnique).not.toHaveBeenCalled();
  });
  it("refuses a plan number that was never imported instead of creating it", async () => {
    h.prisma.plan.findUnique.mockResolvedValue(null);
    expect(await recordOutput(form({ date: DATE, dept: "Cut", bom: "B", mo: "MO-1", item: "CF", qty: "1", planNo: "77" }))).toEqual({ ok: false, error: "Plan 77 does not exist — refresh the page." });
    expect(h.prisma.plan.upsert).not.toHaveBeenCalled();
    expect(txWrites).toEqual([]);
    h.prisma.plan.findUnique.mockResolvedValue({ planNo: 77 });
    expect(await recordOutput(form({ date: DATE, dept: "Cut", bom: "B", mo: "MO-1", item: "CF", qty: "1", planNo: "77" }))).toMatchObject({ ok: true });
    expect(txWrites[0]).toMatchObject({ planNo: 77 });
  });
});

describe("recordGroupOutput — a panel order is not a transformer order", () => {
  it("refuses a merged row that holds an LV order", async () => {
    h.prisma.masterOrder.findMany.mockResolvedValue([
      { mo: "MO-1", bom: "B", line: "TR", planQty: 5, status: "open", ospCF: 0, ospTC: 0, ospTN: 0, ospCB: 0, excludedItems: null, includedItems: null, kva: "", rating: null },
      { mo: "P-1", bom: "B", line: "LV", planQty: 5, status: "open", ospCF: 0, ospTC: 0, ospTN: 0, ospCB: 0, excludedItems: null, includedItems: null, kva: "", rating: null },
    ]);
    const res = await recordGroupOutput(form({ source: "tracker", dept: "Cut", bom: "B", item: "CF", mos: "MO-1,P-1", total: "4" }));
    expect(res).toEqual({ ok: false, error: "P-1 is an LV panel order — panels are recorded on the LV tracker." });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a Plan Tracker cell typed on an LV order — a transformer key writes nothing onto a panel MO", async () => {
    h.prisma.masterOrder.findUnique.mockResolvedValue({ planQty: 10, line: "LV" });
    const res = await recordTrackerTotal(form({ dept: "Cut", bom: "LVB-1", mo: "P-100", item: "TN", total: "5" }));
    expect(res).toEqual({ ok: false, error: "P-100 is an LV panel order — panels are recorded on the LV tracker." });
    expect(h.checkOutputChain).not.toHaveBeenCalled();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("returnToUpstream — the line is the order's", () => {
  it("refuses a BOM that is not the MO's, and an MO unknown to the registry and the log", async () => {
    h.prisma.masterOrder.findUnique.mockResolvedValue({ bom: "B1" });
    h.prisma.handoverEntry.findFirst.mockResolvedValue(null);
    h.prisma.planSchedule.findFirst.mockResolvedValue(null);
    expect(await returnToUpstream(form({ fromDept: "Welding", bom: "B9", mo: "MO-1", item: "CF", qty: "1", reason: "burrs" }))).toEqual({ ok: false, error: "MO-1 is on BOM B1, not B9." });
    h.prisma.masterOrder.findUnique.mockResolvedValue(null);
    h.prisma.handoverEntry.findFirst.mockResolvedValue(null);
    expect(await returnToUpstream(form({ fromDept: "Welding", bom: "B9", mo: "MO-X", item: "CF", qty: "1", reason: "burrs" }))).toEqual({ ok: false, error: "MO-X is not in the orders registry or the log for B9." });
    expect(h.prisma.handoverEntry.groupBy).not.toHaveBeenCalled();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("takes the plan sheet's spelling of the BOM when a plan holds the MO under it", async () => {
    // the registry spells it B1; the worklist row comes from a plan that wrote B-1
    h.prisma.masterOrder.findUnique.mockResolvedValue({ bom: "B1" });
    h.prisma.handoverEntry.findFirst.mockResolvedValue(null);
    h.prisma.planSchedule.findFirst.mockResolvedValue({ id: 5 });
    const res = await returnToUpstream(form({ fromDept: "Welding", bom: "B-1", mo: "MO-1", item: "CF", qty: "1", reason: "burrs" }));
    expect(res.error ?? "").not.toMatch(/is on BOM/);
    expect(h.prisma.planSchedule.findFirst).toHaveBeenCalledWith({ where: { bom: "B-1", mo: "MO-1" }, select: { id: true } });
  });
});
