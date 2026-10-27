import { describe, expect, it } from "vitest";
import { odooDateTime, walkChildMos } from "./odooChildren";
import { fakeOdoo, mo } from "../../tests/helpers/odooFake";

describe("walking an order down to its sub-assemblies", () => {
  // PF01/MO/100: a tank fed straight into it (direct), a top cover named by
  // origin, fins under the tank, a core frame below an intermediate MO, and a
  // part under the fins that must never be read as the order's
  const mos = [
    mo(1, "PF01/MO/100", "FG-1", { product_qty: 2 }),
    mo(2, "SF01/MO/200", "FB-022-AAA", { origin: "PF01/MO/100", product_qty: 2, move_finished_ids: [21] }),
    mo(3, "SF01/MO/201", "FB-051-AAA", { origin: "PF01/MO/100", product_qty: 2, state: "done", qty_produced: 2, date_finished: "2026-10-26 12:25:30" }),
    mo(4, "SF01/MO/202", "FB-036-AAA", { origin: "SF01/MO/200", product_qty: 4 }),
    mo(5, "SF01/MO/203", "FB-099-ZZZ", { origin: "SF01/MO/202" }),
    mo(6, "SF01/MO/204", "FB-077-INT", { origin: "PF01/MO/100" }),
    mo(7, "SF01/MO/205", "FB-058-AAA", { origin: "SF01/MO/204", product_qty: 2 }),
    mo(8, "SF01/MO/206", "FB-024-AAA", { origin: "PF01/MO/100", state: "cancel" }),
    // PF01/MO/300 is planned without its batch suffix: Odoo split it, -001 done, -002 open
    mo(11, "PF01/MO/300-001", "FG-3", { product_qty: 5, state: "done", procurement_group_id: [30, "PF01/MO/300"] }),
    mo(12, "PF01/MO/300-002", "FG-3", { product_qty: 5, procurement_group_id: [30, "PF01/MO/300"], product_id: [110, "[FG-3] FG-3"] }),
    // a cable box booked against the family, tied by its qty to the open batch
    mo(13, "SF01/MO/400", "FB-024-BBB", { origin: "PF01/MO/300", product_qty: 5 }),
    // PF01/MO/500's cable box is assembled on PF01 (…D11); the shop floor makes
    // and closes the SF01 one under it (…S11)
    mo(21, "PF01/MO/500", "FG-5", { product_qty: 3 }),
    mo(22, "PF01/MO/501", "FB-024-00009D11", { origin: "PF01/MO/500", product_qty: 3 }),
    mo(23, "SF01/MO/502", "FB-024-00009S11", { origin: "PF01/MO/501", product_qty: 3 }),
  ];
  mos[9].product_id = [110, "[FG-3] FG-3"]; // both batches are the same product
  const moves = {
    21: { move_dest_ids: [31], production_id: [2, "SF01/MO/200"] as [number, string] },
    31: { raw_material_production_id: [1, "PF01/MO/100"] as [number, string] },
  };

  it("finds each tracked component once, with how it was tied", async () => {
    const { rpc } = fakeOdoo(mos, moves);
    const w = await walkChildMos(rpc, ["PF01/MO/100"]);
    const got = w.children.map((c) => [c.name, c.item, c.linkHow]).sort();
    expect(got).toEqual([
      ["SF01/MO/200", "TN", "direct"],
      ["SF01/MO/201", "TC", "origin"],
      ["SF01/MO/202", "FN", "origin"],
      ["SF01/MO/205", "CF", "origin"],
    ]);
    expect(w.children.every((c) => c.orderMo === "PF01/MO/100")).toBe(true);
  });

  it("keeps Odoo's quantities, state and closing moment", async () => {
    const { rpc } = fakeOdoo(mos, moves);
    const tc = (await walkChildMos(rpc, ["PF01/MO/100"])).children.find((c) => c.item === "TC")!;
    expect(tc).toMatchObject({ productCode: "FB-051-AAA", qty: 2, qtyProduced: 2, state: "done", doneAt: "2026-10-26 12:25:30", uom: "Units" });
  });

  it("never lists a cancelled MO or anything below the fins", async () => {
    const { rpc } = fakeOdoo(mos, moves);
    const names = (await walkChildMos(rpc, ["PF01/MO/100"])).children.map((c) => c.name);
    expect(names).not.toContain("SF01/MO/206");
    expect(names).not.toContain("SF01/MO/203");
    expect(names).not.toContain("SF01/MO/204"); // the intermediate itself is not a tracked part
  });

  it("reads an order planned without its suffix through its open batch", async () => {
    const { rpc } = fakeOdoo(mos, moves);
    const w = await walkChildMos(rpc, ["PF01/MO/300"]);
    expect(w.planMap["PF01/MO/300"]).toEqual(["PF01/MO/300-002"]);
    expect(w.children.map((c) => [c.name, c.item, c.linkHow, c.orderMo])).toEqual([["SF01/MO/400", "CB", "qty_match", "PF01/MO/300"]]);
  });

  it("walks through a component assembled on another floor to the shop floor's MO", async () => {
    const { rpc } = fakeOdoo(mos, moves);
    const w = await walkChildMos(rpc, ["PF01/MO/500"]);
    expect(w.children.map((c) => [c.name, c.item])).toEqual([["SF01/MO/502", "CB"]]);
  });

  it("says which orders Odoo does not have", async () => {
    const { rpc } = fakeOdoo(mos, moves);
    const w = await walkChildMos(rpc, ["PF01/MO/999", "PF01/MO/998-002"]);
    expect(w.notFound.sort()).toEqual(["PF01/MO/998-002", "PF01/MO/999"]);
    expect(w.children).toEqual([]);
  });

  it("only reads Odoo", async () => {
    const { rpc, calls } = fakeOdoo(mos, moves);
    await walkChildMos(rpc, ["PF01/MO/100", "PF01/MO/300"]);
    expect(new Set(calls.map((c) => c.split(".").pop()))).toEqual(new Set(["search_read", "read"]));
  });
});

describe("Odoo's date-times", () => {
  it("are UTC with no zone", () => {
    expect(odooDateTime("2026-10-26 12:25:30")?.toISOString()).toBe("2026-10-26T12:25:30.000Z");
    expect(odooDateTime(false)).toBeNull();
    expect(odooDateTime("")).toBeNull();
  });
});
