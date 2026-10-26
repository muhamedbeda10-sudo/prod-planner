import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- the daily log and the tank layer have to move together ------------------
// Editing or deleting a log row used to touch only the quantity, which left
// tanks stranded: still painted, still listed in the barcode tab, for a stage
// nothing recorded any more. These cover the wiring that closes that gap —
// that the sync runs inside the same transaction as the write, and that a
// refusal from it rolls the whole thing back.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: { handoverEntry: { findUnique: fn(), findMany: fn(), update: fn(), delete: fn() }, returnEntry: { findMany: fn() }, $transaction: fn() },
    revalidatePath: vi.fn(),
    checkOutputChain: vi.fn(),
    requireDeptEdit: vi.fn(),
    requirePerm: vi.fn(),
    syncTanksToLedgerQty: vi.fn(),
    syncTanksToLedgerDate: vi.fn(),
    getKnownBoms: vi.fn(),
    getSettings: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/server/outputGuard", () => ({ checkOutputChain: h.checkOutputChain, recheckLvChainLocked: async () => {}, ChainRefused: class extends Error {} }));
vi.mock("@/lib/server/auth", () => ({ requireDeptEdit: h.requireDeptEdit, requirePerm: h.requirePerm }));
vi.mock("@/lib/server/tanks", () => ({ syncTanksToLedgerQty: h.syncTanksToLedgerQty, syncTanksToLedgerDate: h.syncTanksToLedgerDate }));
vi.mock("@/lib/server/handover", () => ({ getKnownBoms: h.getKnownBoms }));
vi.mock("@/lib/server/data", () => ({ getSettings: h.getSettings }));
vi.mock("@/lib/server/importHandover", () => ({ importHandoverFile: vi.fn() }));

import { bulkSetHandoverDate, deleteHandover, updateHandover } from "@/app/handover/actions";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** What the transaction body actually did, in order. */
const calls: string[] = [];
/** The returns taken back with a deleted row, by the filter used. */
const returnDeletes: Record<string, unknown>[] = [];

/** The Odoo row linked to the ledger row under test, if any — a painting
 *  record's row on the ODOO log follows the record while it is untouched. */
let odooRow: { id: number; odooMo: string; status: string; _count: { notes: number } } | null = null;

const paintRow = {
  id: 7, dept: "Painting", bom: "25301", mo: "MO/1", item: "TN", qty: 3, note: null, date: new Date("2026-09-01T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  returnDeletes.length = 0;
  h.requireDeptEdit.mockResolvedValue({ user: { name: "tester" } });
  h.requirePerm.mockResolvedValue({ user: { name: "tester" } });
  h.checkOutputChain.mockResolvedValue(null);
  h.syncTanksToLedgerQty.mockResolvedValue({});
  h.syncTanksToLedgerDate.mockResolvedValue({ redated: 0 });
  h.getSettings.mockResolvedValue({ tankTracking: true });
  h.prisma.handoverEntry.findUnique.mockResolvedValue(paintRow);
  h.prisma.returnEntry.findMany.mockResolvedValue([]);
  odooRow = null;
  h.prisma.$transaction.mockImplementation((body: (tx: unknown) => Promise<unknown>) =>
    body({
      handoverEntry: {
        update: async () => { calls.push("ledger.update"); },
        updateMany: async () => { calls.push("ledger.updateMany"); return { count: 1 }; },
        delete: async () => { calls.push("ledger.delete"); },
      },
      returnEntry: { deleteMany: async (a: { where: Record<string, unknown> }) => { returnDeletes.push(a.where); return { count: 1 }; } },
      odooEntry: {
        findUnique: async () => odooRow,
        update: async (a: { data: Record<string, unknown> }) => { calls.push(`odoo.update ${JSON.stringify(a.data)}`); },
        delete: async () => { calls.push("odoo.delete"); },
      },
    })
  );
});

const untouched = { id: 40, odooMo: "", status: "MO to be close", _count: { notes: 0 } };
const worked = { id: 40, odooMo: "SF01/MO/1", status: "MO to be close", _count: { notes: 0 } };

describe("the row's Odoo row follows it", () => {
  it("is CANCELLED with a reason, never silently deleted, while nobody has touched it", async () => {
    // it used to be deleted, and the row then vanished from the Odoo tab with
    // nothing to say where it went — the planner was left hunting a close-out
    // he remembered writing. Cancelled it stays on its day, reads red, and
    // carries the reason.
    odooRow = untouched;
    await deleteHandover(form({ id: "7" }));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('"status":"Cancelled"');
    expect(calls[0]).toContain('"ledgerId":null');
    expect(calls[0]).toContain("daily-log record this row was born from was deleted");
    expect(calls[0].startsWith("odoo.update")).toBe(true);
    expect(calls[1]).toBe("ledger.delete");
  });
  it("only loses the link once the office has worked it", async () => {
    odooRow = worked;
    await deleteHandover(form({ id: "7" }));
    expect(calls).toEqual(['odoo.update {"ledgerId":null}', "ledger.delete"]);
  });
  it("takes the row's new quantity and date while untouched, and not after", async () => {
    odooRow = untouched;
    await updateHandover(form({ id: "7", qty: "2", date: "2026-09-10" }));
    expect(calls).toEqual(["ledger.update", 'odoo.update {"qty":2,"date":"2026-09-10T00:00:00.000Z"}']);
    calls.length = 0;
    odooRow = worked;
    await updateHandover(form({ id: "7", qty: "2" }));
    expect(calls).toEqual(["ledger.update"]);
  });
});

describe("deleteHandover — the row takes its tanks with it", () => {
  it("syncs the tank layer to zero before dropping the row", async () => {
    const res = await deleteHandover(form({ id: "7" }));
    expect(res).toEqual({ ok: true });
    expect(h.syncTanksToLedgerQty).toHaveBeenCalledWith(expect.anything(), paintRow, 0);
    expect(calls).toEqual(["ledger.delete"]);
  });

  it("refreshes the barcode tab, not just the worklists", async () => {
    await deleteHandover(form({ id: "7" }));
    const paths = h.revalidatePath.mock.calls.map((c) => c[0]);
    expect(paths).toContain("/barcode");
    expect(paths).toContain("/worklist/leak-test");
  });

  it("rolls the deletion back when the tanks cannot follow", async () => {
    h.syncTanksToLedgerQty.mockResolvedValue({
      error: "2 of these tanks have already moved past welding (SF-A-0001, SF-A-0002).",
    });
    const res = await deleteHandover(form({ id: "7" }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("already moved past welding");
    // the row survives — the sync refused before anything was written
    expect(calls).toEqual([]);
  });

  it("still stops at the physical chain before it gets that far", async () => {
    h.checkOutputChain.mockResolvedValue("Chain check: welded must stay ≤ cut.");
    const res = await deleteHandover(form({ id: "7" }));
    expect(res).toEqual({ ok: false, error: "Chain check: welded must stay ≤ cut." });
    expect(h.syncTanksToLedgerQty).not.toHaveBeenCalled();
  });
});

describe("updateHandover — a smaller quantity gives pieces back", () => {
  it("syncs the tank layer down to the new quantity", async () => {
    const res = await updateHandover(form({ id: "7", qty: "1" }));
    expect(res).toEqual({ ok: true });
    expect(calls).toEqual(["ledger.update"]);
    expect(h.syncTanksToLedgerQty).toHaveBeenCalledWith(expect.anything(), paintRow, 1);
  });

  it("rolls the edit back when the tanks cannot follow", async () => {
    h.syncTanksToLedgerQty.mockResolvedValue({ error: "already moved past welding" });
    const res = await updateHandover(form({ id: "7", qty: "1" }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("already moved past welding");
  });

  it("leaves a quantity that grew alone — nothing to give back (tracking off)", async () => {
    h.getSettings.mockResolvedValue({ tankTracking: false });
    await updateHandover(form({ id: "7", qty: "9" }));
    expect(h.syncTanksToLedgerQty).toHaveBeenCalledWith(expect.anything(), paintRow, 9);
  });

  it("will not raise a tank row while tanks are tracked — they are added on the worklists", async () => {
    const res = await updateHandover(form({ id: "7", qty: "9" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Painting worklist/);
    expect(calls).toEqual([]);
  });
});

describe("re-dating a tank row moves its tanks' day with it", () => {
  // the Daily log and the tracker read the row's date; the tank page, the
  // leak-test queue and the barcode sheet read weldedAt / paintedAt — a date
  // edit used to move only the first, and the two then named different days
  const newDay = new Date("2026-09-10T00:00:00Z");

  it("a single row's edit hands the tank layer the new date, in the same transaction, after the quantity", async () => {
    const order: string[] = [];
    h.syncTanksToLedgerQty.mockImplementation(async () => { order.push("qty"); return {}; });
    h.syncTanksToLedgerDate.mockImplementation(async () => { order.push("date"); return { redated: 3 }; });
    const res = await updateHandover(form({ id: "7", qty: "3", date: "2026-09-10" }));
    expect(res).toEqual({ ok: true });
    expect(h.syncTanksToLedgerDate).toHaveBeenCalledWith(expect.anything(), paintRow, newDay);
    expect(order).toEqual(["qty", "date"]);
  });

  it("an edit without a date leaves the tanks' day alone", async () => {
    await updateHandover(form({ id: "7", qty: "2" }));
    expect(h.syncTanksToLedgerDate).not.toHaveBeenCalled();
  });

  it("a bulk re-date reaches every selected row's tanks, with what the tank layer needs to find them", async () => {
    const weldRow = { id: 8, dept: "Welding", item: "TN", mo: "MO/2", qty: 2, note: null, date: new Date("2026-09-02T00:00:00Z") };
    h.prisma.handoverEntry.findMany.mockResolvedValue([paintRow, weldRow]);
    const res = await bulkSetHandoverDate(form({ ids: "7,8", date: "2026-09-10" }));
    expect(res).toEqual({ ok: true, updated: 2 });
    expect(h.prisma.handoverEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ mo: true, qty: true, date: true, dept: true, item: true }),
    }));
    expect(h.syncTanksToLedgerDate.mock.calls.map((c) => [c[1], c[2]])).toEqual([[paintRow, newDay], [weldRow, newDay]]);
    expect(calls).toEqual(["ledger.updateMany"]);
  });
});

describe("a return's own row on the Daily log", () => {
  const returnRow = { id: 8, dept: "Cut", bom: "25301", mo: "MO/1", item: "TN", qty: -2, note: "returned", source: "return" };

  it("takes the open return back with it when it is deleted", async () => {
    h.prisma.handoverEntry.findUnique.mockResolvedValue(returnRow);
    const res = await deleteHandover(form({ id: "8" }));
    expect(res.ok).toBe(true);
    expect(returnDeletes).toEqual([{ handoverId: 8, status: "open" }]);
    expect(calls.at(-1)).toBe("ledger.delete");
  });

  it("stays once its pieces were re-delivered — the re-delivery would count pieces never taken off", async () => {
    h.prisma.handoverEntry.findUnique.mockResolvedValue(returnRow);
    h.prisma.returnEntry.findMany.mockResolvedValue([{ mo: "MO/1", bom: "25301", item: "TN", qty: 2 }]);
    const res = await deleteHandover(form({ id: "8" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/re-delivered since/);
    expect(calls).toEqual([]);
    expect(returnDeletes).toEqual([]);
  });
});
