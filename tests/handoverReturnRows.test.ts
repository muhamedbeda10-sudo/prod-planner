import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- a return's rows on the Daily log move with the return ------------------
// Sending pieces back writes a NEGATIVE row upstream and an open ReturnEntry
// pointing at it; re-delivering writes the credit back. Editing either by hand
// used to leave the return saying something else — the credit then counted
// pieces that were never taken off. The rows' notes are kept on edit, too.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      handoverEntry: { findUnique: fn(), findMany: fn() },
      returnEntry: { findFirst: fn(), findMany: fn() },
      $transaction: fn(),
    },
    requirePerm: fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ requirePerm: h.requirePerm, requireDeptEdit: h.requirePerm }));
vi.mock("@/lib/server/outputGuard", () => ({ checkOutputChain: async () => null, recheckLvChainLocked: async () => {}, ChainRefused: class extends Error {} }));
vi.mock("@/lib/server/tanks", () => ({ syncTanksToLedgerQty: async () => ({}), syncTanksToLedgerDate: async () => ({ redated: 0 }) }));
vi.mock("@/lib/server/odooMirror", () => ({ mirrorLedgerToOdoo: async () => {}, syncMirroredOdoo: async () => {} }));
vi.mock("@/lib/server/handover", () => ({ getKnownBoms: async () => [] }));
vi.mock("@/lib/server/importHandover", () => ({ importHandoverFile: vi.fn() }));
vi.mock("@/lib/server/data", () => ({ getSettings: async () => ({ tankTracking: false }) }));
vi.mock("@/lib/server/events", () => ({ emitEvent: async () => {} }));

import { bulkDeleteHandover, bulkSetHandoverDate, deleteHandover, updateHandover } from "@/app/handover/actions";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** Every write the actions made inside the transaction, in order. */
const writes: { table: string; op: string; args: Record<string, unknown> }[] = [];
const row = (o: Record<string, unknown> = {}) => ({ id: 7, date: new Date("2026-10-05T00:00:00Z"), dept: "Cut", bom: "B1", mo: "MO-1", item: "CF", qty: 4, note: null, source: "worklist", planNo: 0, ...o });
/** The deduction a return made upstream (−3) and the credit of its re-delivery (+3). */
const deduction = row({ id: 8, qty: -3, source: "return", note: "burrs" });
const credit = row({ id: 9, qty: 3, source: "return", note: "re-delivered (was: burrs)" });

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
  h.requirePerm.mockResolvedValue({ user: { name: "Sara" } });
  h.prisma.returnEntry.findFirst.mockResolvedValue(null);
  h.prisma.returnEntry.findMany.mockResolvedValue([]);
  const op = (table: string, name: string) => async (args: Record<string, unknown>) => { writes.push({ table, op: name, args }); return { count: 1 }; };
  h.prisma.$transaction.mockImplementation((body: (tx: unknown) => Promise<unknown>) =>
    body({
      handoverEntry: { update: op("handoverEntry", "update"), updateMany: op("handoverEntry", "updateMany"), delete: op("handoverEntry", "delete"), deleteMany: op("handoverEntry", "deleteMany") },
      returnEntry: { update: op("returnEntry", "update"), deleteMany: op("returnEntry", "deleteMany"), findFirst: h.prisma.returnEntry.findFirst },
    })
  );
});

describe("editing a row", () => {
  it("appends the edit to the note it carries instead of replacing it", async () => {
    h.prisma.handoverEntry.findUnique.mockResolvedValue(row({ note: "tanks: SF-B-0001, SF-B-0002" }));
    expect(await updateHandover(form({ id: "7", qty: "4", date: "2026-10-06" }))).toEqual({ ok: true });
    expect(writes[0].args).toMatchObject({ data: { qty: 4, note: "tanks: SF-B-0001, SF-B-0002 · edited by Sara", date: new Date("2026-10-06T00:00:00Z") } });
    // a second edit does not stamp the same name twice
    h.prisma.handoverEntry.findUnique.mockResolvedValue(row({ note: "tanks: SF-B-0001 · edited by Sara" }));
    expect(await updateHandover(form({ id: "7", qty: "3" }))).toEqual({ ok: true });
    expect(writes[1].args).toMatchObject({ data: { qty: 3, note: "tanks: SF-B-0001 · edited by Sara" } });
  });

  it("cuts a long note short so the edit stamp still fits under the note limit", async () => {
    const long = "x".repeat(999);
    h.prisma.handoverEntry.findUnique.mockResolvedValue(row({ note: long }));
    expect(await updateHandover(form({ id: "7", qty: "4" }))).toEqual({ ok: true });
    const note = (writes[0].args.data as { note: string }).note;
    expect(note.length).toBeLessThanOrEqual(1000);
    expect(note.endsWith(" · edited by Sara")).toBe(true);
    // what the row said is kept up to the room left, marked as cut
    expect(note).toBe(`${"x".repeat(982)}… · edited by Sara`);
    // a note that just fits is kept whole
    const fits = "y".repeat(1000 - " · edited by Sara".length);
    h.prisma.handoverEntry.findUnique.mockResolvedValue(row({ note: fits }));
    expect(await updateHandover(form({ id: "7", qty: "3" }))).toEqual({ ok: true });
    expect((writes[1].args.data as { note: string }).note).toBe(`${fits} · edited by Sara`);
  });

  it("refuses to re-quantify the deduction of an open return, but re-dates it", async () => {
    h.prisma.handoverEntry.findUnique.mockResolvedValue(deduction);
    h.prisma.returnEntry.findFirst.mockResolvedValue({ id: 5, status: "open", qty: 3 });
    expect(await updateHandover(form({ id: "8", qty: "0" }))).toEqual({ ok: false, error: "That row is the deduction of a return (3 × CF waiting with Fabrication) — delete the row to cancel the return, or change the date only." });
    expect(await updateHandover(form({ id: "8", qty: "2" }))).toMatchObject({ ok: false });
    expect(writes).toEqual([]);
    // the same figure with a new date is a date change
    expect(await updateHandover(form({ id: "8", qty: "-3", date: "2026-10-06" }))).toEqual({ ok: true });
    expect(writes[0].args).toMatchObject({ data: { qty: -3, note: "burrs · edited by Sara" } });
    // a resolved return's deduction stays as written
    h.prisma.returnEntry.findFirst.mockResolvedValue({ id: 5, status: "resolved", qty: 3 });
    expect(await updateHandover(form({ id: "8", qty: "0" }))).toEqual({ ok: false, error: "That row is the deduction of a return whose pieces were re-delivered — it stays as written." });
  });

  it("refuses to re-quantify a re-delivery's credit", async () => {
    h.prisma.handoverEntry.findUnique.mockResolvedValue(credit);
    h.prisma.returnEntry.findFirst.mockResolvedValue({ id: 5 });
    expect(await updateHandover(form({ id: "9", qty: "1" }))).toEqual({ ok: false, error: "That row is a re-delivery's credit — delete it to reopen the return, or change the date only." });
    expect(h.prisma.returnEntry.findFirst).toHaveBeenCalledWith({
      where: { status: "resolved", toDept: "Cut", bom: "B1", item: "CF", qty: 3, mo: "MO-1" },
      orderBy: { id: "desc" },
      select: { id: true },
    });
    expect(writes).toEqual([]);
  });

  it("still refuses a negative figure on any other row", async () => {
    h.prisma.handoverEntry.findUnique.mockResolvedValue(row());
    expect(await updateHandover(form({ id: "7", qty: "-1" }))).toEqual({ ok: false, error: "Invalid quantity." });
  });
});

describe("deleting a re-delivery's credit reopens the return", () => {
  it("one row", async () => {
    h.prisma.handoverEntry.findUnique.mockResolvedValue(credit);
    h.prisma.returnEntry.findFirst.mockResolvedValue({ id: 5 });
    expect(await deleteHandover(form({ id: "9" }))).toEqual({ ok: true });
    expect(writes.map((w) => `${w.table}.${w.op}`)).toEqual(["returnEntry.update", "returnEntry.deleteMany", "handoverEntry.delete"]);
    expect(writes[0].args).toEqual({ where: { id: 5 }, data: { status: "open" } });
  });

  it("in a batch, while an ordinary row in the same batch reopens nothing", async () => {
    h.prisma.handoverEntry.findMany.mockResolvedValue([row(), credit]);
    h.prisma.returnEntry.findFirst.mockResolvedValue({ id: 5 });
    expect(await bulkDeleteHandover(form({ ids: "7,9" }))).toEqual({ ok: true, deleted: 2 });
    expect(writes.map((w) => `${w.table}.${w.op}`)).toEqual(["returnEntry.update", "returnEntry.deleteMany", "handoverEntry.deleteMany"]);
  });
});

describe("re-dating rows in bulk", () => {
  it("keeps each row's own note, with one write per distinct note rather than one per row", async () => {
    h.prisma.handoverEntry.findMany.mockResolvedValue([row({ note: "tracker correction: total 10 → 8" }), row({ id: 8, note: null }), row({ id: 10, note: null })]);
    expect(await bulkSetHandoverDate(form({ ids: "7,8,10", date: "2026-10-06" }))).toEqual({ ok: true, updated: 3 });
    expect(writes.map((w) => `${w.table}.${w.op}`)).toEqual(["handoverEntry.updateMany", "handoverEntry.updateMany"]);
    expect(writes.map((w) => w.args)).toEqual([
      { where: { id: { in: [7] } }, data: { date: new Date("2026-10-06T00:00:00Z"), note: "tracker correction: total 10 → 8 · edited by Sara" } },
      { where: { id: { in: [8, 10] } }, data: { date: new Date("2026-10-06T00:00:00Z"), note: "edited by Sara" } },
    ]);
  });
});
