import { describe, expect, it } from "vitest";
import { ITEMS } from "./constants";
import { trackerOdooQuantities, trackerOdooTotal } from "./trackerOdoo";
const order = (mo = "MO-1", bom = "BOM-A", soi: string | null = "SO-1") => ({ mo, bom, soi, line: "TR" });
const entry = (extra = {}) => ({ id: 1, line: "TR", ledgerId: null as number | null, soi: "SO-1", fgCode: "FB-022-BOM-A", product: "Tank", qty: 5, status: "Done", ...extra });
describe("Odoo closed quantities on the plan tracker", () => {
  it("reads quantities only from Done/Closed TR log rows, not pending attempts or LV", () => {
    const result = trackerOdooQuantities([order()], [entry(), entry({ status: " Closed ", qty: 3 }), ...["Pending", "Blocked", "Cancelled", "MO to be close"].map((status) => entry({ status, qty: 100 })), entry({ line: "LV", qty: 100 }), entry({ qty: 0 })], []);
    expect(result.counts.get("MO-1")?.TN).toBe(8);
  });
  it("keeps each component independent, supporting the Odoo tab's product aliases", () => {
    const result = trackerOdooQuantities([order()], ["CF", "top cover", "Tank", "cable-box", "Arrestor Bracket", "Mono Box"].map((product, i) => entry({ product, qty: i + 1 })), []);
    expect(ITEMS.map((it) => result.counts.get("MO-1")?.[it])).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("uses the linked planner MO when available, without confusing it with Odoo's MO or capping real quantities", () => {
    const result = trackerOdooQuantities([order(), order("MO-2")], [entry({ ledgerId: 7, soi: "OTHER-SOI", fgCode: "FB-022-OTHER", qty: 42 })], [{ id: 7, mo: "MO-2", bom: "BOM-A", item: "TN" }]);
    expect(result.counts.get("MO-2")?.TN).toBe(42);
    expect(result.counts.has("MO-1")).toBe(false);
  });
  it("resolves an imported drawing code through a unique SOI, as the Odoo tab does", () => {
    const result = trackerOdooQuantities([order()], [entry({ fgCode: "FB-022-DRAWING-REV-2" })], []);
    expect(result.counts.get("MO-1")?.TN).toBe(5);
  });
  it("counts an ambiguous project quantity once in its complete merged BOM, never on every MO or a partial filter", () => {
    const orders = [order(), order("MO-2")];
    const progress = trackerOdooQuantities(orders, [entry(), entry({ ledgerId: 7, qty: 2 })], [{ id: 7, mo: "MO-1", bom: "BOM-A", item: "TN" }]);
    const rows = orders.map((o) => ({ mo: o.mo, items: Object.fromEntries(ITEMS.map((it) => [it, { odooClosed: progress.counts.get(o.mo)?.[it] ?? 0 }])) as Record<(typeof ITEMS)[number], { odooClosed: number }>, odooShared: progress.pools }));
    expect(trackerOdooTotal(rows, "TN")).toEqual({ qty: 7, unallocated: 0 });
    expect(trackerOdooTotal([rows[0]], "TN")).toEqual({ qty: 2, unallocated: 5 });
    expect(trackerOdooTotal([rows[1]], "TN")).toEqual({ qty: 0, unallocated: 5 });
  });
  it("does not guess a project when an SOI names several BOMs and the FG code cannot distinguish them", () => {
    expect(trackerOdooQuantities([order(), order("MO-2", "BOM-B")], [entry({ fgCode: "FB-022-UNKNOWN" })], []).counts.size).toBe(0);
    expect(trackerOdooQuantities([order(), order("MO-2", "BOM-B")], [entry({ fgCode: "FB-022-BOM-B" })], []).counts.get("MO-2")?.TN).toBe(5);
  });
  it("follows status and quantity changes on the next read", () => {
    expect(trackerOdooQuantities([order()], [entry({ qty: 9 })], []).counts.get("MO-1")?.TN).toBe(9);
    expect(trackerOdooQuantities([order()], [entry({ status: "Pending" })], []).counts.size).toBe(0);
  });
});
