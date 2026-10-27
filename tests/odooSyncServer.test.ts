import { beforeEach, describe, expect, it, vi } from "vitest";

// One Odoo sync (lib/server/odooSync.ts) against an Odoo in memory: it claims
// its slot once, reads the log's MOs (a renamed first batch included), never
// touches a row anyone typed, fills the store's SF01 column, and a part that
// fails leaves the others done.

const h = vi.hoisted(() => {
  const state = {
    runs: [] as { id: number; slot: string; status: string; summary?: unknown; error?: string | null }[],
    moStates: [] as Record<string, unknown>[],
    stock: [{ id: 1, code: "C-SHR-003", odoo: 1 }, { id: 2, code: "C-SHR-004", odoo: 21.073 }, { id: 3, code: "NOT-IN-ODOO", odoo: 5 }],
    stockWrites: [] as { id: number; data: Record<string, unknown> }[],
    entryWrites: 0,
    childFails: false,
  };
  const prisma = {
    odooSyncRun: {
      findUnique: vi.fn(async ({ where }: { where: { slot: string } }) => state.runs.find((r) => r.slot === where.slot) ?? null),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: { slot: string } }) => {
        if (state.runs.some((r) => r.slot === data.slot)) {
          const { Prisma } = await import("@prisma/client");
          throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });
        }
        const r = { id: state.runs.length + 1, slot: data.slot, status: "running" };
        state.runs.push(r);
        return r;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => Object.assign(state.runs.find((r) => r.id === where.id)!, data)),
    },
    odooEntry: {
      findMany: vi.fn(async () => [
        { odooMo: "SF01/MO/15295-002", status: "Done", fgCode: "FB-022-1" },
        { odooMo: "SF01/MO/12686", status: "Done", fgCode: "FB-022-1" }, // Odoo renamed it -001
        { odooMo: "SF01/MO/10416-004", status: "Cancelled", fgCode: "USS" }, // a cancelled attempt of an MO…
        { odooMo: "SF01/MO/10416-004", status: "Done", fgCode: "USS" }, // …whose other row still counts: open in Odoo
        { odooMo: "SF01/MO/99999", status: "Done", fgCode: "FB-022-1" }, // no such MO
        { odooMo: "SF01/MO/77777", status: "Cancelled", fgCode: "FB-022-1" }, // cancelled here: not read
      ]),
      update: vi.fn(async () => { state.entryWrites++; }),
      updateMany: vi.fn(async () => { state.entryWrites++; }),
    },
    odooSettings: { findUnique: vi.fn(async () => ({ enabled: true, apiKeyEnc: "v1:x" })) },
    odooMoState: {
      findMany: vi.fn(async () => state.moStates),
      upsert: vi.fn(({ create }: { create: Record<string, unknown> }) => { state.moStates = [...state.moStates.filter((m) => m.name !== create.name), create]; return create; }),
    },
    masterOrder: { findMany: vi.fn(async () => { if (state.childFails) throw new Error("child walk broke"); return []; }) },
    odooChildMo: { deleteMany: vi.fn(() => ({})), createMany: vi.fn(() => ({})) },
    physicalStock: {
      findMany: vi.fn(async () => state.stock),
      update: vi.fn(({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { state.stockWrites.push({ id: where.id, data }); return data; }),
    },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  };
  const mos: Record<string, { id: number; name: string; state: string; date_finished?: string; product_id: [number, string] }> = {
    "SF01/MO/15295-002": { id: 1, name: "SF01/MO/15295-002", state: "done", date_finished: "2026-10-27 07:37:49", product_id: [1, "[FB-022-1] Tank"] },
    "SF01/MO/12686-001": { id: 2, name: "SF01/MO/12686-001", state: "done", date_finished: "2026-09-01 08:00:00", product_id: [1, "[FB-022-1] Tank"] },
    "SF01/MO/10416-004": { id: 3, name: "SF01/MO/10416-004", state: "progress", product_id: [2, "[USS-1] USS"] },
  };
  const calls: string[] = [];
  const rpc = vi.fn(async (model: string, method: string, args: unknown[]) => {
    calls.push(method);
    if (model === "mrp.production") {
      const names = ((args[0] as unknown[][])[0][2] as string[]);
      return names.flatMap((n) => (mos[n] ? [{ product_qty: 1, qty_produced: 0, product_uom_id: [1, "Units"], origin: false, move_finished_ids: [], procurement_group_id: false, ...mos[n] }] : []));
    }
    if (model === "stock.location") return [{ id: 192 }];
    if (model === "product.product") return [{ id: 50, default_code: "C-SHR-003" }, { id: 51, default_code: "C-SHR-004" }];
    if (model === "stock.quant") return [{ product_id: [50, "x"], quantity: 331.16271 }, { product_id: [51, "y"], quantity: 21.073 }];
    throw new Error(`unexpected ${model}.${method}`);
  });
  return { state, prisma, rpc, calls };
});

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/odooApi", () => ({
  getOdooSettings: async () => ({ enabled: true, apiKeyEnc: "v1:x" }),
  getOdooConn: async () => ({ conn: { url: "https://x.odoo.com", db: "d", login: "l", apiKey: "k" }, reason: null }),
  connectOdoo: async () => ({ rpc: h.rpc, uid: 7 }),
}));

import { runOdooSyncIfDue, startOdooSyncNow } from "@/lib/server/odooSync";

beforeEach(() => {
  h.state.runs = [];
  h.state.moStates = [];
  h.state.stockWrites = [];
  h.state.entryWrites = 0;
  h.state.childFails = false;
  h.calls.length = 0;
  vi.clearAllMocks();
});

const NINE_WED = new Date("2026-10-28T06:01:00Z"); // 09:01 Riyadh, a Wednesday

describe("a scheduled Odoo sync", () => {
  it("runs its slot once, however many ticks ask", async () => {
    await runOdooSyncIfDue(NINE_WED);
    await runOdooSyncIfDue(new Date("2026-10-28T06:02:00Z"));
    expect(h.state.runs.map((r) => [r.slot, r.status])).toEqual([["2026-10-28@09", "ok"]]);
  });

  it("does nothing outside its hours", async () => {
    await runOdooSyncIfDue(new Date("2026-10-30T07:00:00Z")); // Friday
    await runOdooSyncIfDue(new Date("2026-10-28T05:00:00Z")); // 08:00
    expect(h.state.runs).toEqual([]);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("reads the log's MOs — a renamed first batch by its new name — and never writes a row anyone typed", async () => {
    await runOdooSyncIfDue(NINE_WED);
    const by = Object.fromEntries(h.state.moStates.map((m) => [m.name, m]));
    expect(by["SF01/MO/15295-002"]).toMatchObject({ found: true, state: "done", doneAt: new Date("2026-10-27T07:37:49Z"), productCode: "FB-022-1" });
    expect(by["SF01/MO/12686"]).toMatchObject({ found: true, currentName: "SF01/MO/12686-001", state: "done" });
    expect(by["SF01/MO/10416-004"]).toMatchObject({ found: true, state: "progress" });
    expect(by["SF01/MO/99999"]).toMatchObject({ found: false });
    expect(by["SF01/MO/77777"]).toBeUndefined(); // cancelled here: nothing to compare
    expect(h.state.entryWrites).toBe(0);
    expect(new Set(h.calls)).toEqual(new Set(["search_read", "read_group"])); // reads only
    const s = h.state.runs[0].summary as { log: { checked: number; renamed: number; notFound: number } };
    expect(s.log).toMatchObject({ checked: 4, renamed: 1, notFound: 1 });
  });

  it("fills the store's Odoo column from SF01/Shop Floor Warehouse, only where it moved", async () => {
    await runOdooSyncIfDue(NINE_WED);
    expect(h.state.stockWrites).toEqual([{ id: 1, data: { odoo: 331.1627, updatedBy: "Odoo sync" } }]);
    const s = h.state.runs[0].summary as { stock: { updated: number; unchanged: number; missing: number } };
    expect(s.stock).toEqual({ updated: 1, unchanged: 1, missing: 1 });
  });

  it("keeps going when one part fails, and says which", async () => {
    h.state.childFails = true;
    await runOdooSyncIfDue(NINE_WED);
    const run = h.state.runs[0];
    expect(run.status).toBe("partial");
    expect((run.summary as { issues: string[] }).issues).toEqual(["sub-assembly MOs: child walk broke"]);
    expect(h.state.stockWrites).toHaveLength(1); // the stock still synced
  });

  it("an admin's Sync now runs at once", async () => {
    expect(await startOdooSyncNow("Beda")).toEqual({ ok: true });
    // it runs after the answer
    await vi.waitFor(() => expect(h.state.runs[0]).toMatchObject({ status: "ok" }));
    expect(h.state.runs[0].slot).toMatch(/^manual@/);
  });
});
