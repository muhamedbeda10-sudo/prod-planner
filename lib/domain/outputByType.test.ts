import { describe, it, expect } from "vitest";
import {
  LV_ITEM_ORDER, NO_CLASS, NO_TYPE, TR_ITEM_ORDER,
  compareTypes, kvaTypeLabel, lvItemType, lvPlanLine, outputByType, trPlanLines, trTypeStageOf,
} from "./outputByType";
import { STAGES } from "./kpis";
import { LV_STAGES } from "./lv";

describe("the transformers' stages and classes", () => {
  it("counts cutting, welding and each component's own finishing stage only", () => {
    expect(trTypeStageOf("Cut", "TN")).toBe("cut");
    expect(trTypeStageOf("Welding", "TC")).toBe("weld");
    expect(trTypeStageOf("Painting", "TN")).toBe("finish");
    // the core frame is finished at shot blast; a tank's blasting before painting is not its finish
    expect(trTypeStageOf("ShotBlast", "CF")).toBe("finish");
    expect(trTypeStageOf("ShotBlast", "TN")).toBeNull();
    expect(trTypeStageOf("LeakTest", "TN")).toBeNull();
  });
  it("names a class by its kVA, and says so when the order has none", () => {
    expect(kvaTypeLabel(630)).toBe("630 kVA");
    expect(kvaTypeLabel(null)).toBe(NO_CLASS);
    expect(kvaTypeLabel(undefined)).toBe(NO_CLASS);
  });
  it("reads the types in order: by number, then by name, the unknown last", () => {
    expect(["1000 kVA", NO_CLASS, "100 kVA", "630 kVA"].sort(compareTypes)).toEqual(["100 kVA", "630 kVA", "1000 kVA", NO_CLASS]);
    expect(["USS", NO_TYPE, "LSS"].sort(compareTypes)).toEqual(["LSS", "USS", NO_TYPE]);
  });
});

describe("the panels' plans and types", () => {
  it("files a panel order under its plan and the type the sheet names", () => {
    expect(lvItemType({ product: " uss ", family: "" })).toEqual({ item: "LV panels", type: "USS" });
    expect(lvItemType({ product: null, family: "MB" })).toEqual({ item: "Meter boxes", type: NO_TYPE });
    // a record whose order is unknown still lands somewhere, said as untyped
    expect(lvItemType(undefined)).toEqual({ item: "LV panels", type: NO_TYPE });
  });
  it("takes a month order's position on the chain as its line of the plan", () => {
    expect(lvPlanLine({ product: "LSS", family: "", state: { required: 10, punch: 8, bend: 6, weld: 4, paint: 2, delivered: 0 } }))
      .toEqual({ item: "LV panels", type: "LSS", required: 10, done: { Punching: 8, Bending: 6, Welding: 4, Painting: 2 } });
  });
});

describe("what was made, item by item and type by type, against the month's plan", () => {
  it("adds the period's records per type and stage, and the item's types into its total", () => {
    const groups = outputByType(STAGES, [
      { item: "Tank", type: "630 kVA", stage: "cut", qty: 5 },
      { item: "Tank", type: "630 kVA", stage: "cut", qty: 3 },
      { item: "Tank", type: "1000 kVA", stage: "weld", qty: 2 },
      { item: "Core Frame", type: "630 kVA", stage: "finish", qty: 4 },
    ], [], TR_ITEM_ORDER);
    // the plant's own item order: core frame before tank
    expect(groups.map((g) => g.item)).toEqual(["Core Frame", "Tank"]);
    const tank = groups[1];
    expect(tank.types.map((t) => t.type)).toEqual(["630 kVA", "1000 kVA"]);
    expect(tank.types[0].made).toEqual({ cut: 8, weld: 0, finish: 0 });
    expect(tank.total.made).toEqual({ cut: 8, weld: 2, finish: 0 });
    expect(tank.total.plan).toBeNull();
  });

  it("caps each plan line at what it asks, so one order's extra never covers another's shortfall", () => {
    const [tank] = outputByType(STAGES, [], [
      { item: "Tank", type: "630 kVA", required: 10, done: { cut: 14, weld: 10, finish: 9 } },
      { item: "Tank", type: "630 kVA", required: 6, done: { cut: 2, weld: 0, finish: 0 } },
    ], TR_ITEM_ORDER);
    expect(tank.types[0].plan).toEqual({ required: 16, done: { cut: 12, weld: 10, finish: 9 }, left: 7, share: 9 / 16 });
    expect(tank.total.plan).toEqual(tank.types[0].plan);
  });

  it("shows a type on the plan with nothing made, and one made off the plan with no plan figures", () => {
    const [panels] = outputByType(LV_STAGES, [
      { item: "LV panels", type: "USS", stage: "Punching", qty: 4 },
    ], [
      { item: "LV panels", type: "LSS", required: 5, done: {} },
    ], LV_ITEM_ORDER);
    expect(panels.types.map((t) => [t.type, t.plan?.required ?? null, t.made.Punching])).toEqual([["LSS", 5, 0], ["USS", null, 4]]);
    expect(panels.total.plan).toEqual({ required: 5, done: { Punching: 0, Bending: 0, Welding: 0, Painting: 0 }, left: 5, share: 0 });
  });

  it("leaves out a type with nothing made and nothing planned, and never shows a stage below nothing", () => {
    const groups = outputByType(STAGES, [
      { item: "Tank", type: "630 kVA", stage: "cut", qty: 5 },
      { item: "Tank", type: "630 kVA", stage: "cut", qty: -3 },
      { item: "Tank", type: "630 kVA", stage: "weld", qty: -2 },
      // corrected away entirely: nothing to show
      { item: "Tank", type: "1000 kVA", stage: "cut", qty: 2 },
      { item: "Tank", type: "1000 kVA", stage: "cut", qty: -3 },
      { item: "Top Cover", type: "630 kVA", stage: "weld", qty: 0 },
    ], [{ item: "Tank", type: "400 kVA", required: 0, done: {} }], TR_ITEM_ORDER);
    expect(groups.map((g) => g.item)).toEqual(["Tank"]);
    expect(groups[0].types.map((t) => t.type)).toEqual(["630 kVA"]);
    expect(groups[0].types[0].made).toEqual({ cut: 2, weld: 0, finish: 0 });
  });
});

describe("the transformers' month plan, component by component", () => {
  const tierOf = (mo: string | null | undefined, bom: string) => (mo === "MO-2" ? 1000 : bom === "B1" ? 630 : null);
  const order = (o: Partial<{ mo: string; bom: string; planQty: number; kva: string; ospTN: number; excludedItems: string }>) =>
    ({ mo: "MO-1", bom: "B1", planQty: 10, kva: "630", rating: null, includedItems: null, excludedItems: null, ...o });

  it("asks each applicable component's pieces less the outsourced ones, at the order's class", () => {
    const lines = trPlanLines([order({ ospTN: 4, excludedItems: "CB" })], [], tierOf);
    const by = Object.fromEntries(lines.map((l) => [l.item, l]));
    expect(by.Tank).toMatchObject({ type: "630 kVA", required: 6 });
    expect(by["Core Frame"]).toMatchObject({ type: "630 kVA", required: 10 });
    expect(by["Cable Box"]).toBeUndefined();
  });

  it("keeps each order its own line, so one order's surplus never covers its sibling's shortfall", () => {
    const lines = trPlanLines([order({}), order({ mo: "MO-3", planQty: 6 })], [
      { mo: "MO-1", bom: "B1", item: "TN", dept: "Painting", qty: 14 },
      { mo: "MO-3", bom: "B1", item: "TN", dept: "Painting", qty: 2 },
    ], tierOf);
    const [tank] = outputByType(STAGES, [], lines, TR_ITEM_ORDER).filter((g) => g.item === "Tank");
    // MO-1 counts 10 of its 14, MO-3 its 2 of 6: 4 still to finish
    expect(tank.types[0].plan).toMatchObject({ required: 16, left: 4 });
    expect(tank.types[0].plan?.done.finish).toBe(12);
  });

  it("puts each record on its order at the order's class, and a record without one into its project's orders in turn", () => {
    const lines = trPlanLines([order({}), order({ mo: "MO-2", planQty: 5 })], [
      { mo: "MO-1", bom: "B1", item: "TN", dept: "Cut", qty: 7 },
      // no order number: fills MO-1's welding first (10), then MO-2's (5); the rest is beyond the plan
      { mo: null, bom: "B1", item: "TN", dept: "Welding", qty: 12 },
      { mo: null, bom: "B1", item: "TN", dept: "Welding", qty: 9 },
      { mo: "MO-2", bom: "B1", item: "TN", dept: "Painting", qty: 5 },
      // not a stage of the card, and an order the plan does not have
      { mo: "MO-1", bom: "B1", item: "TN", dept: "ShotBlast", qty: 9 },
      { mo: "MO-9", bom: "B9", item: "TN", dept: "Cut", qty: 9 },
    ], tierOf);
    const tanks = lines.filter((l) => l.item === "Tank");
    expect(tanks.find((l) => l.type === "630 kVA")).toMatchObject({ required: 10, done: { cut: 7, weld: 10, finish: 0 } });
    expect(tanks.find((l) => l.type === "1000 kVA")).toMatchObject({ required: 5, done: { cut: 0, weld: 5, finish: 5 } });
  });
});
