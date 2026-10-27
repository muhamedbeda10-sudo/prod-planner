import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- the ODOO log's writes (app/odoo/actions.ts) ----------------------------
// A merged line's edit carries each row's last change as the page drew it, so
// a stale modal cannot put a row someone closed meanwhile back to open; an
// existing row moved to Done is closed NOW whichever control was used; a row
// deleted twice is a message, not a crash.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      odooEntry: { findMany: fn(), findUnique: fn(), updateMany: fn(), deleteMany: fn(), create: fn(), update: fn() },
      odooNote: { count: fn(), findUnique: fn(), deleteMany: fn() },
      $transaction: fn(),
    },
    requirePerm: fn(),
    settle: fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ requirePerm: h.requirePerm }));
vi.mock("@/lib/server/line", () => ({ getActiveLine: async () => "TR" }));
vi.mock("@/lib/server/events", () => ({ emitEvent: async () => {} }));
vi.mock("@/lib/server/odoo", () => ({ importOdooSheet: vi.fn() }));
vi.mock("@/lib/server/odooAutoClose", () => ({ settleOrdersAfterOdoo: h.settle }));

import { createOdooEntry, deleteOdooEntry, deleteOdooNote, setOdooStatus, updateOdooEntry, updateOdooGroup } from "@/app/odoo/actions";
import { CANCEL_NEEDS_NOTE } from "@/lib/domain/odoo";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
const STALE = "Someone changed this row since the page was loaded — refresh and try again.";
const t1 = new Date("2026-10-20T08:00:00Z"), t2 = new Date("2026-10-20T09:00:00Z");
const row = (id: number, o: Record<string, unknown> = {}) => ({ id, line: "TR", status: "MO to be close", doneAt: null, date: new Date("2026-10-10T00:00:00Z"), ledgerId: null, updatedAt: t1, fgCode: "FB-1", fgGuessed: false, ...o });

beforeEach(() => {
  vi.clearAllMocks();
  h.requirePerm.mockResolvedValue({ user: { name: "Sara" } });
  h.prisma.odooEntry.findMany.mockImplementation(async ({ select }: { select?: Record<string, boolean> }) => (select && Object.keys(select).length === 1 && select.line ? [{ line: "TR" }] : [row(1), row(2, { updatedAt: t2 })]));
  h.prisma.odooEntry.updateMany.mockResolvedValue({ count: 1 });
  // interactive transaction: the action's callback runs against the same mocked client
  h.prisma.$transaction.mockImplementation(async (arg: unknown) => (typeof arg === "function" ? (arg as (tx: unknown) => Promise<unknown>)(h.prisma) : Promise.all(arg as Promise<unknown>[])));
});

describe("updateOdooGroup", () => {
  const head = { ids: "1,2", product: "Tank", odooMo: "SF01/MO/9", soi: "S1", status: "Done" };

  it("refuses a modal drawn before one of its rows changed, and writes nothing", async () => {
    const stale = form({ ...head, versions: `${t1.toISOString()},${new Date("2026-10-20T07:00:00Z").toISOString()}` });
    expect(await updateOdooGroup(stale)).toEqual({ ok: false, error: STALE });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.settle).not.toHaveBeenCalled();
  });

  it("refuses a line one of whose rows was deleted meanwhile, and writes nothing", async () => {
    h.prisma.odooEntry.findMany.mockImplementation(async ({ select }: { select?: Record<string, boolean> }) => (select && Object.keys(select).length === 1 && select.line ? [{ line: "TR" }] : [row(1)]));
    expect(await updateOdooGroup(form(head))).toEqual({ ok: false, error: STALE });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.prisma.odooEntry.updateMany).not.toHaveBeenCalled();
  });

  it("writes each row only while it is as drawn, and closes an open row NOW — a row Done already keeps its moment", async () => {
    const closedAt = new Date("2026-10-15T10:00:00Z");
    h.prisma.odooEntry.findMany.mockImplementation(async ({ select }: { select?: Record<string, boolean> }) => (select && Object.keys(select).length === 1 && select.line ? [{ line: "TR" }] : [row(1), row(2, { updatedAt: t2, status: "Done", doneAt: closedAt })]));
    expect(await updateOdooGroup(form({ ...head, versions: `${t1.toISOString()},${t2.toISOString()}` }))).toEqual({ ok: true });
    const writes = h.prisma.odooEntry.updateMany.mock.calls.map((c) => c[0]);
    expect(writes[0]).toMatchObject({ where: { id: 1, updatedAt: t1 }, data: { status: "Done", odooMo: "SF01/MO/9", soi: "S1" } });
    // row 1 was open on 10 Oct and is closed today, not back-dated to its own day
    expect((writes[0].data.doneAt as Date).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(writes[1]).toMatchObject({ where: { id: 2, updatedAt: t2 }, data: { doneAt: closedAt } });
    // the orders the line finishes in Odoo close by themselves
    expect(h.settle).toHaveBeenCalledTimes(1);
  });

  it("tells the person when a row moved between the check and the write, and rolls the line back as one", async () => {
    h.prisma.odooEntry.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect(await updateOdooGroup(form(head))).toEqual({ ok: false, error: STALE });
    // both writes ran inside one interactive transaction, so the first is rolled back with the second
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(typeof h.prisma.$transaction.mock.calls[0][0]).toBe("function");
    expect(h.prisma.odooEntry.updateMany).toHaveBeenCalledTimes(2);
  });
});

describe("updateOdooEntry", () => {
  it("closes an existing open row now, whatever day it was logged", async () => {
    h.prisma.odooEntry.findUnique.mockResolvedValue(row(1));
    expect(await updateOdooEntry(form({ id: "1", date: "2026-10-10", product: "Tank", odooMo: "SF01/MO/9", qty: "4", status: "Done" }))).toEqual({ ok: true });
    const data = h.prisma.odooEntry.updateMany.mock.calls[0][0].data;
    expect((data.doneAt as Date).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(h.settle).toHaveBeenCalledTimes(1);
  });
});

describe("deleteOdooEntry", () => {
  it("says so when the row is gone already", async () => {
    h.prisma.odooEntry.deleteMany.mockResolvedValue({ count: 0 });
    expect(await deleteOdooEntry(form({ id: "42" }))).toEqual({ ok: false, error: "That row no longer exists." });
    h.prisma.odooEntry.deleteMany.mockResolvedValue({ count: 1 });
    expect(await deleteOdooEntry(form({ id: "42" }))).toEqual({ ok: true });
  });
});

describe("cancelling needs a note", () => {
  it("refuses to cancel an open row with no note, and writes nothing", async () => {
    h.prisma.odooNote.count.mockResolvedValue(0);
    expect(await setOdooStatus(form({ ids: "1,2", status: "Cancelled" }))).toEqual({ ok: false, error: CANCEL_NEEDS_NOTE });
    expect(h.prisma.odooNote.count).toHaveBeenCalledWith({ where: { entryId: { in: [1, 2] } } });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("cancels once a note on any row of the line says why", async () => {
    h.prisma.odooNote.count.mockResolvedValue(1);
    expect(await setOdooStatus(form({ ids: "1,2", status: "Cancelled" }))).toEqual({ ok: true });
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("moves to Done without reading the notes", async () => {
    expect(await setOdooStatus(form({ ids: "1", status: "Done" }))).toEqual({ ok: true });
    expect(h.prisma.odooNote.count).not.toHaveBeenCalled();
  });

  it("holds the Edit form and a merged line's edit to the same rule", async () => {
    h.prisma.odooNote.count.mockResolvedValue(0);
    h.prisma.odooEntry.findUnique.mockResolvedValue(row(1));
    expect(await updateOdooEntry(form({ id: "1", date: "2026-10-10", product: "Tank", odooMo: "SF01/MO/9", qty: "4", status: "Cancelled" }))).toEqual({ ok: false, error: CANCEL_NEEDS_NOTE });
    expect(await updateOdooGroup(form({ ids: "1,2", product: "Tank", odooMo: "SF01/MO/9", status: "Cancelled" }))).toEqual({ ok: false, error: CANCEL_NEEDS_NOTE });
    expect(h.prisma.odooEntry.updateMany).not.toHaveBeenCalled();
    // a row cancelled already is edited freely — its reason was given then
    h.prisma.odooEntry.findUnique.mockResolvedValue(row(1, { status: "Cancelled" }));
    expect(await updateOdooEntry(form({ id: "1", date: "2026-10-10", product: "Tank", odooMo: "SF01/MO/9", qty: "5", status: "Cancelled" }))).toEqual({ ok: true });
  });

  it("never adds a new row as cancelled — it has no note yet", async () => {
    expect(await createOdooEntry(form({ date: "2026-10-10", product: "Tank", odooMo: "SF01/MO/9", qty: "4", status: "Cancelled" }))).toEqual({ ok: false, error: CANCEL_NEEDS_NOTE });
    expect(h.prisma.odooEntry.create).not.toHaveBeenCalled();
  });

  it("keeps the last note of a cancelled row", async () => {
    h.prisma.odooNote.findUnique.mockResolvedValue({ entryId: 1, entry: { status: "Cancelled", _count: { notes: 1 } } });
    expect((await deleteOdooNote(form({ noteId: "7" }))).ok).toBe(false);
    expect(h.prisma.odooNote.deleteMany).not.toHaveBeenCalled();
    h.prisma.odooNote.findUnique.mockResolvedValue({ entryId: 1, entry: { status: "Cancelled", _count: { notes: 2 } } });
    expect(await deleteOdooNote(form({ noteId: "7" }))).toEqual({ ok: true });
    expect(h.prisma.odooNote.deleteMany).toHaveBeenCalledWith({ where: { id: 7 } });
  });
});
