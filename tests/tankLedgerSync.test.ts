import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- the tank layer following a Daily log row -------------------------------
// These drive the REAL sync helpers in lib/server/tanks against an in-memory
// tank table standing in for the transaction, and assert which tanks each
// helper decides to touch: a row may only move tanks it is responsible for.

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/server/odooMirror", () => ({ syncMirroredOdoo: async () => {} }));

import { syncTanksToLedgerQty, syncTanksToLedgerDate } from "@/lib/server/tanks";
import type { Prisma } from "@prisma/client";

type Tank = { id: number; serial: string; mo: string; seq: number; status: string; weldLedgerId: number | null; paintLedgerId: number | null };

/** The tanks on file, and every query and write the helper made against them. */
let tanks: Tank[] = [];
const queries: Record<string, unknown>[] = [];
const writes: { model: string; op: string; args: Record<string, unknown> }[] = [];

/** A mock transaction with just enough of the client: findMany filters the
 *  in-memory rows on the keys the helpers use, every write is recorded. */
function matches(t: Tank, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "id") { if (!(v as { in: number[] }).in.includes(t.id)) return false; continue; }
    if (t[k as keyof Tank] !== v) return false;
  }
  return true;
}
const tx = {
  tankUnit: {
    findMany: async (a: { where: Record<string, unknown>; take?: number }) => {
      queries.push(a.where);
      const rows = tanks.filter((t) => matches(t, a.where)).sort((x, y) => y.seq - x.seq);
      return a.take == null ? rows : rows.slice(0, a.take);
    },
    updateMany: async (a: Record<string, unknown>) => { writes.push({ model: "tankUnit", op: "updateMany", args: a }); return { count: 1 }; },
    deleteMany: async (a: Record<string, unknown>) => { writes.push({ model: "tankUnit", op: "deleteMany", args: a }); return { count: 1 }; },
  },
  tankEvent: {
    create: async (a: Record<string, unknown>) => { writes.push({ model: "tankEvent", op: "create", args: a }); },
    updateMany: async (a: Record<string, unknown>) => { writes.push({ model: "tankEvent", op: "updateMany", args: a }); return { count: 1 }; },
  },
} as unknown as Prisma.TransactionClient;

const tank = (id: number, over: Partial<Tank> = {}): Tank => ({
  id, serial: `SF-B-000${id}`, mo: "MO-1", seq: id, status: "painted", weldLedgerId: null, paintLedgerId: null, ...over,
});
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const row = (over: Record<string, unknown> = {}) => ({ id: 1, dept: "Painting", mo: "MO-1", item: "TN", qty: 2, date: day("2026-09-01"), ...over });

beforeEach(() => {
  tanks = [];
  queries.length = 0;
  writes.length = 0;
});

describe("an unlinked painting row's tanks — the fallback for rows written before the link", () => {
  // MO-1 has four painted tanks: #1 and #2 from a Daily-log row written before
  // tanks were linked, #3 and #4 painted from the worklist onto row 2
  beforeEach(() => {
    tanks = [tank(1), tank(2), tank(3, { paintLedgerId: 2 }), tank(4, { paintLedgerId: 2 })];
  });

  it("deleting the unlinked row un-paints only the tanks no live row accounts for", async () => {
    const res = await syncTanksToLedgerQty(tx, row(), 0);
    expect(res).toEqual({ unpainted: 2 });
    // its own link first, then the MO's painted tanks that belong to no row
    expect(queries).toEqual([{ paintLedgerId: 1 }, { mo: "MO-1", status: "painted", paintLedgerId: null }]);
    const unpaint = writes.find((w) => w.model === "tankUnit" && w.op === "updateMany")!;
    expect(unpaint.args).toMatchObject({ where: { id: { in: [2, 1] } }, data: { status: "tested", paintLedgerId: null, paintedAt: null } });
    // row 2's tanks keep their paint — it still says 2
    expect(writes.filter((w) => w.model === "tankEvent").map((w) => (w.args as { data: { tankId: number } }).data.tankId)).toEqual([2, 1]);
  });

  it("lowering it to one gives back the newest of its own tanks, never a linked one", async () => {
    await syncTanksToLedgerQty(tx, row(), 1);
    const unpaint = writes.find((w) => w.model === "tankUnit" && w.op === "updateMany")!;
    expect(unpaint.args).toMatchObject({ where: { id: { in: [2] } } });
  });

  it("a welding row's fallback is the same rule — tanks on no row", async () => {
    tanks = [tank(1, { status: "welded" }), tank(2, { status: "welded", weldLedgerId: 9 })];
    const res = await syncTanksToLedgerQty(tx, row({ dept: "Welding", qty: 1 }), 0);
    expect(res).toEqual({ removed: 1 });
    expect(queries).toEqual([{ weldLedgerId: 1 }, { mo: "MO-1", weldLedgerId: null }]);
    expect(writes).toEqual([{ model: "tankUnit", op: "deleteMany", args: { where: { id: { in: [1] } } } }]);
  });
});

describe("re-dating a row moves the day its tanks were welded or painted", () => {
  it("a welding row: weldedAt and the welded event, for the row's own tanks only", async () => {
    tanks = [tank(1, { status: "welded", weldLedgerId: 1 }), tank(2, { status: "tested", weldLedgerId: 1 }), tank(3, { status: "welded", weldLedgerId: 5 })];
    const res = await syncTanksToLedgerDate(tx, row({ dept: "Welding" }), day("2026-09-10"));
    expect(res).toEqual({ redated: 2 });
    expect(writes).toEqual([
      { model: "tankUnit", op: "updateMany", args: { where: { id: { in: [2, 1] } }, data: { weldedAt: day("2026-09-10") } } },
      { model: "tankEvent", op: "updateMany", args: { where: { tankId: { in: [2, 1] }, kind: "welded" }, data: { at: day("2026-09-10") } } },
    ]);
  });

  it("a painting row: paintedAt and the painted event — the leak test stays on its own day", async () => {
    tanks = [tank(1, { paintLedgerId: 1 }), tank(2, { paintLedgerId: 1 })];
    const res = await syncTanksToLedgerDate(tx, row(), day("2026-09-10"));
    expect(res).toEqual({ redated: 2 });
    expect(writes).toEqual([
      { model: "tankUnit", op: "updateMany", args: { where: { id: { in: [2, 1] } }, data: { paintedAt: day("2026-09-10") } } },
      { model: "tankEvent", op: "updateMany", args: { where: { tankId: { in: [2, 1] }, kind: "painted" }, data: { at: day("2026-09-10") } } },
    ]);
  });

  it("an older row no tank is linked to moves no tank — which of the MO's tanks it made is not known", async () => {
    // two unlinked welding rows on one MO: re-dating the first must not take the second's newest tanks
    tanks = [tank(1, { status: "welded" }), tank(2, { status: "welded" }), tank(3, { status: "welded" })];
    expect(await syncTanksToLedgerDate(tx, row({ dept: "Welding", qty: 2 }), day("2026-09-10"))).toEqual({ redated: 0 });
    expect(queries).toEqual([{ weldLedgerId: 1 }]);
    expect(writes).toEqual([]);
    // the same for a painting row
    tanks = [tank(1), tank(2, { paintLedgerId: 2 })];
    queries.length = 0;
    expect(await syncTanksToLedgerDate(tx, row({ qty: 1 }), day("2026-09-10"))).toEqual({ redated: 0 });
    expect(queries).toEqual([{ paintLedgerId: 1 }]);
    expect(writes).toEqual([]);
  });

  it.each([
    ["a core-frame row", row({ item: "CF" })],
    ["a tank row of the fabrication bay", row({ dept: "Cut", item: "TN" })],
    ["a panel row", row({ item: "PNL" })],
  ])("%s touches no tank", async (_name, entry) => {
    tanks = [tank(1, { paintLedgerId: 1, status: "welded", weldLedgerId: 1 })];
    expect(await syncTanksToLedgerDate(tx, entry, day("2026-09-10"))).toEqual({ redated: 0 });
    expect(queries).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("the same date again is not a change", async () => {
    tanks = [tank(1, { paintLedgerId: 1 })];
    expect(await syncTanksToLedgerDate(tx, row(), day("2026-09-01"))).toEqual({ redated: 0 });
    expect(queries).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("a row with no tanks on file is left as it is", async () => {
    expect(await syncTanksToLedgerDate(tx, row(), day("2026-09-10"))).toEqual({ redated: 0 });
    expect(writes).toEqual([]);
  });
});
