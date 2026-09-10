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
    prisma: { handoverEntry: { findUnique: fn(), update: fn(), delete: fn() }, $transaction: fn() },
    revalidatePath: vi.fn(),
    checkOutputChain: vi.fn(),
    requireDeptEdit: vi.fn(),
    requirePerm: vi.fn(),
    syncTanksToLedgerQty: vi.fn(),
    getKnownBoms: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/server/outputGuard", () => ({ checkOutputChain: h.checkOutputChain }));
vi.mock("@/lib/server/auth", () => ({ requireDeptEdit: h.requireDeptEdit, requirePerm: h.requirePerm }));
vi.mock("@/lib/server/tanks", () => ({ syncTanksToLedgerQty: h.syncTanksToLedgerQty }));
vi.mock("@/lib/server/handover", () => ({ getKnownBoms: h.getKnownBoms }));
vi.mock("@/lib/server/importHandover", () => ({ importHandoverFile: vi.fn() }));

import { deleteHandover, updateHandover } from "@/app/handover/actions";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** What the transaction body actually did, in order. */
const calls: string[] = [];

/** The Odoo row linked to the ledger row under test, if any — a painting
 *  record's row on the ODOO tab follows the record while it is untouched. */
let odooRow: { id: number; odooMo: string; status: string; _count: { notes: number } } | null = null;

const paintRow = {
  id: 7, dept: "Painting", bom: "25301", mo: "MO/1", item: "TN", qty: 3, note: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  h.requireDeptEdit.mockResolvedValue({ user: { name: "tester" } });
  h.requirePerm.mockResolvedValue({ user: { name: "tester" } });
  h.checkOutputChain.mockResolvedValue(null);
  h.syncTanksToLedgerQty.mockResolvedValue({});
  h.prisma.handoverEntry.findUnique.mockResolvedValue(paintRow);
  odooRow = null;
  h.prisma.$transaction.mockImplementation((body: (tx: unknown) => Promise<unknown>) =>
    body({
      handoverEntry: {
        update: async () => { calls.push("ledger.update"); },
        delete: async () => { calls.push("ledger.delete"); },
      },
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
  it("is deleted with the row while nobody has touched it", async () => {
    odooRow = untouched;
    await deleteHandover(form({ id: "7" }));
    expect(calls).toEqual(["odoo.delete", "ledger.delete"]);
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

  it("leaves a quantity that grew alone — nothing to give back", async () => {
    await updateHandover(form({ id: "7", qty: "9" }));
    expect(h.syncTanksToLedgerQty).toHaveBeenCalledWith(expect.anything(), paintRow, 9);
  });
});
