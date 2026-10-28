import { describe, expect, it, vi } from "vitest";
import { pageRpc, pullLog, pullOdoo, pullStock, rowsHash, splitPayload, type ChildRow, type OdooPullPayload, type OdooPullPlan } from "./odooPull";
import { fakeOdoo, mo } from "../../tests/helpers/odooFake";

// The pull the scheduled task runs inside an Odoo page: reads only, one
// compact payload for odoo_ingest(), a part that fails leaves the others.

const mos = [
  mo(1, "SF01/MO/15295-002", "FB-022-1", { state: "done", date_finished: "2026-10-27 07:37:49", product_qty: 10, qty_produced: 10 }),
  mo(2, "SF01/MO/12686-001", "FB-022-1", { state: "done", date_finished: "2026-09-01 08:00:00" }), // Odoo renamed SF01/MO/12686
  mo(3, "SF01/MO/10416-004", "USS-1", { state: "progress" }),
  // a transformer order with one tank, and an LV order with two batches
  mo(10, "PF01/MO/100", "FG-1"),
  mo(11, "SF01/MO/200", "FB-022-AAA", { origin: "PF01/MO/100", product_qty: 2 }),
  mo(20, "SF01/MO/300-001", "USS-9", { state: "done", date_finished: "2026-10-01 10:00:00" }),
  mo(21, "SF01/MO/300-002", "USS-9"),
  mo(22, "SF01/MO/300-003", "USS-9", { state: "cancel" }),
];
const stock = {
  locations: [{ id: 192, complete_name: "SF01/Shop Floor Warehouse" }, { id: 197, complete_name: "SF01/Pre-Production" }],
  products: [{ id: 50, default_code: "C-SHR-003" }, { id: 51, default_code: "C-SHR-004" }],
  quants: [
    { location: 192, product: 50, quantity: 300 }, { location: 192, product: 50, quantity: 31.16271 },
    { location: 197, product: 51, quantity: 99 }, // another location: not the store's
  ],
};
const plan: OdooPullPlan = {
  logNames: ["SF01/MO/15295-002", "sf01/mo/12686", "SF01/MO/10416-004", "SF01/MO/99999"],
  tr: ["PF01/MO/100"], lv: ["SF01/MO/300"], codes: ["C-SHR-003", "C-SHR-004", "NOT-IN-ODOO"], hashes: {},
};

describe("the Odoo pull", () => {
  it("reads the log's MOs — a renamed first batch by its new name, a missing one as not found", async () => {
    const { rpc } = fakeOdoo(mos);
    expect(await pullLog(rpc, plan.logNames)).toEqual([
      ["SF01/MO/15295-002", 1, "SF01/MO/15295-002", 1, "done", "FB-022-1", 10, 10, "2026-10-27 07:37:49"],
      ["SF01/MO/12686", 1, "SF01/MO/12686-001", 2, "done", "FB-022-1", 1, 0, "2026-09-01 08:00:00"],
      ["SF01/MO/10416-004", 1, "SF01/MO/10416-004", 3, "progress", "USS-1", 1, 0, null],
      ["SF01/MO/99999", 0, "", null, "", "", 0, 0, null],
    ]);
  });

  it("reads the store's location only, rounded as the column keeps it, and names the codes Odoo lacks", async () => {
    const { rpc } = fakeOdoo(mos, {}, stock);
    expect(await pullStock(rpc, plan.codes)).toEqual({ values: [["C-SHR-003", 331.1627], ["C-SHR-004", 0]], missing: ["NOT-IN-ODOO"] });
  });

  it("sends each order's sub-assemblies with a fingerprint, and leaves out the ones that read the same as last time", async () => {
    const { rpc } = fakeOdoo(mos, {}, stock);
    const first = await pullOdoo(rpc, plan, () => 1_800_000_000_000);
    expect(first.orders.map((o) => o.mo)).toEqual(["PF01/MO/100", "SF01/MO/300"]);
    expect(first.children.map((c) => [c[0], c[1], c[3], c[8], c[10]])).toEqual([
      ["PF01/MO/100", "SF01/MO/200", "TN", "confirmed", "origin"],
      ["SF01/MO/300", "SF01/MO/300-001", "", "done", "self"],
      ["SF01/MO/300", "SF01/MO/300-002", "", "confirmed", "self"],
    ]);
    expect(first).toMatchObject({ v: 1, at: "2027-01-15T08:00:00.000Z", unchanged: 0, issues: [] });
    const hashes = Object.fromEntries(first.orders.map((o) => [o.mo, o.hash]));
    const again = await pullOdoo(rpc, { ...plan, hashes });
    expect(again.orders).toEqual([]);
    expect(again.children).toEqual([]);
    expect(again.unchanged).toBe(2);
  });

  it("keeps going when a part fails, and says which", async () => {
    const { rpc } = fakeOdoo(mos, {}, { ...stock, locations: [] });
    const p = await pullOdoo(rpc, plan);
    expect(p.issues).toEqual(['SF01 stock: Odoo has 0 locations named "SF01/Shop Floor Warehouse".']);
    expect(p.stock).toBeNull();
    expect(p.log).toHaveLength(4);
  });

  it("fingerprints rows whatever their order", () => {
    const a: ChildRow = ["P", "SF01/MO/1", 1, "TN", "FB-022-1", 2, 0, "Units", "confirmed", null, "direct", ""];
    const b: ChildRow = ["P", "SF01/MO/2", 2, "TC", "FB-051-1", 2, 0, "Units", "done", "2026-10-01 10:00:00", "origin", ""];
    expect(rowsHash([a, b])).toBe(rowsHash([b, a]));
    expect(rowsHash([a])).not.toBe(rowsHash([a.map((v, i) => (i === 8 ? "done" : v)) as ChildRow]));
    expect(rowsHash([])).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("cutting the payload into pieces the task can copy", () => {
  const row = (i: number): ChildRow => [`PF01/MO/${i}`, `SF01/MO/${i}00`, i, "TN", "FB-022-AAAAAAAAAA", 2, 0, "Units", "confirmed", null, "direct", ""];
  const big: OdooPullPayload = {
    v: 1, at: "2026-10-28T06:00:00.000Z", ms: 30000, unchanged: 4, issues: ["x"],
    stock: { values: [["C-1", 1]], missing: [] },
    log: Array.from({ length: 40 }, (_, i): [string, 1, string, number, string, string, number, number, null] => [`SF01/MO/${i}`, 1, `SF01/MO/${i}`, i, "done", "FB-022-1", 1, 1, null]),
    orders: Array.from({ length: 30 }, (_, i) => ({ mo: `PF01/MO/${i}`, hash: "deadbeef" })),
    children: Array.from({ length: 30 }, (_, i) => [row(i), row(i)].map((r, k) => { const c = [...r] as ChildRow; c[1] = `${c[1]}-${k}`; c[2] = i * 10 + k; return c; })).flat(),
  };

  it("keeps every row once, an order's rows together, the stock and issues in the first piece", () => {
    const parts = splitPayload(big, 2000);
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.every((p) => p.parts === parts.length && p.at === big.at && p.v === 1)).toBe(true);
    expect(parts.map((p) => p.part)).toEqual(parts.map((_, i) => i));
    expect(parts.flatMap((p) => p.log)).toEqual(big.log);
    expect(parts.flatMap((p) => p.orders)).toEqual(big.orders);
    expect(parts.flatMap((p) => p.children)).toEqual(big.children);
    for (const p of parts) for (const c of p.children) expect(p.orders.map((o) => o.mo)).toContain(c[0]);
    expect(parts[0]).toMatchObject({ stock: big.stock, issues: ["x"], unchanged: 4 });
    expect(parts.slice(1).every((p) => p.stock === null && p.issues.length === 0 && p.unchanged === 0)).toBe(true);
    expect(parts.every((p) => JSON.stringify(p).length <= 2000)).toBe(true);
  });

  it("is one piece when it fits", () => {
    const parts = splitPayload({ ...big, log: big.log.slice(0, 2), orders: [], children: [] });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ part: 0, parts: 1 });
  });
});

describe("the page's own JSON-RPC", () => {
  it("posts as the logged-in user and hands back the result", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", result: [{ id: 1 }] })));
    const rpc = pageRpc(fetchFn as unknown as typeof fetch);
    expect(await rpc("mrp.production", "search_read", [[]], { fields: ["name"] })).toEqual([{ id: 1 }]);
    expect(fetchFn).toHaveBeenCalledWith("/web/dataset/call_kw/mrp.production/search_read", expect.objectContaining({ method: "POST" }));
  });

  it("refuses every method that is not a read, before anything is sent", async () => {
    const fetchFn = vi.fn();
    const rpc = pageRpc(fetchFn as unknown as typeof fetch);
    for (const m of ["write", "create", "unlink", "button_mark_done", "action_confirm"]) {
      await expect(rpc("mrp.production", m, [[1]])).rejects.toThrow(/not a read/);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("passes Odoo's own error words on", async () => {
    const rpc = pageRpc((async () => new Response(JSON.stringify({ jsonrpc: "2.0", error: { message: "Odoo Server Error", data: { message: "Access Denied" } } }))) as unknown as typeof fetch);
    await expect(rpc("mrp.production", "search_read", [[]])).rejects.toThrow("mrp.production.search_read: Access Denied");
  });
});
