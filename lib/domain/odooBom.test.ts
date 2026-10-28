import { describe, it, expect } from "vitest";
import {
  bomItems, checkItems, expandBom, flattenNodes, itemCheckOk, itemNodes, itemOfCode, materialNeed, normBom,
  cutByOrder, odooRateOf, panelsToPunch, partBomId, partRates, rawMaterials, remainingToCut, rootCodeCandidates, stockAfterPlan, treeStats,
  type BomIndex, type BomLineRec, type BomRec,
} from "./odooBom";

const line = (seq: number, productCode: string, qty: number, childOdooId: number | null = null, uom = "PC"): BomLineRec =>
  ({ seq, productCode, productName: productCode, qty, uom, stockQty: qty, stockUom: uom, childOdooId });
const bom = (odooId: number, code: string, lines: BomLineRec[], qty = 1): BomRec =>
  ({ odooId, code, productCode: code.replace(/^(FG|TX)-/, ""), productName: code, qty, uom: "PC", lines });

// a transformer much like FG-64022E11M11: final assembly with a tank (and its
// fins) and a top cover, two cable boxes outside it, the core frame deep inside
function plant(): BomIndex {
  const list: BomRec[] = [
    bom(1, "FG-64022E11M11", [line(1, "T-TMG-000-AA", 1), line(2, "FB-024-00009D12", 1, 20), line(3, "FB-024-00030D12", 1, 30), line(4, "FA-64022E11M11", 1, 2)]),
    bom(2, "FA-64022E11M11", [line(1, "T-OIL-G1-AA", 470, null, "KG"), line(2, "CC-64022E11M11", 1, 3), line(3, "FB-022-64022E11M11", 1, 4), line(4, "FB-051-64022E11M11", 1, 5)]),
    bom(3, "CC-64022E11M11", [line(1, "CO-64022E11M11", 1, 6)]),
    bom(6, "CO-64022E11M11", [line(1, "T-LM4-050", 7.14, null, "KG"), line(2, "FB-058-64022E11M11", 1, 7)]),
    bom(7, "FB-058-64022E11M11", [line(1, "C-SHR-005", 0.742), line(2, "C-UPN-80X45X6X12", 0.18)]),
    bom(4, "FB-022-64022E11M11", [line(1, "C-SHR-004", 2.23), line(2, "C-SHR-005", 0.268), line(3, "FB-036-64022E11M11", 1, 8)]),
    bom(8, "FB-036-64022E11M11", [line(1, "T-CRC-1.5X1100", 377.53, null, "KG")]),
    bom(5, "FB-051-64022E11M11", [line(1, "C-SHR-005", 0.34)]),
    // a cable box: the outer BoM holds hardware and its sheet sub-BoM
    bom(20, "FB-024-00009D12", [line(1, "C-CON-BOL-HEX-GI-M8x30", 9), line(2, "FB-024-00009S12", 1, 21)]),
    bom(21, "FB-024-00009S12", [line(1, "C-SHR-003", 0.68)]),
    bom(30, "FB-024-00030D12", [line(1, "FB-024-00030S12", 1, 31)]),
    bom(31, "FB-024-00030S12", [line(1, "C-SHR-003", 1.3)]),
  ];
  return new Map(list.map((b) => [b.odooId, b]));
}

describe("odoo boms — codes", () => {
  it("tries FG-, TX- and the code itself, upper-cased", () => {
    expect(rootCodeCandidates(" 64022e11m11 ")).toEqual(["FG-64022E11M11", "TX-64022E11M11", "64022E11M11"]);
    expect(rootCodeCandidates("")).toEqual([]);
    expect(normBom(null)).toBe("");
  });

  it("knows each component by its part code, mono box included", () => {
    expect(itemOfCode("FB-022-64022E11M11")).toBe("TN");
    expect(itemOfCode("fb-051-x")).toBe("TC");
    expect(itemOfCode("FB-052-1")).toBe("MB");
    expect(itemOfCode("FB-036-64022E11M11")).toBeNull(); // fins are part of the tank
    expect(itemOfCode("FB-0220")).toBeNull();
  });
});

describe("odoo boms — the tree", () => {
  it("unfolds every sub-BoM with what one transformer takes", () => {
    const tree = expandBom(1, plant());
    const all = flattenNodes(tree);
    const fins = all.find((n) => n.productCode === "T-CRC-1.5X1100")!;
    expect(fins.level).toBe(4);
    expect(fins.perRoot).toBe(377.53);
    expect(fins.key).toBe("4.3.3.1");
    const tank = all.find((n) => n.productCode === "FB-022-64022E11M11")!;
    expect(tank.item).toBe("TN");
    expect(tank.childCode).toBe("FB-022-64022E11M11");
    expect(tank.childId).toBe(4);
    expect(treeStats(tree)).toEqual({ nodes: all.length, depth: 5, raw: all.filter((n) => !n.children.length && !n.childCode).length, missing: 0 });
  });

  it("divides by the BoM's own quantity", () => {
    const idx = new Map([[1, bom(1, "FG-X", [line(1, "A", 1, 2)])], [2, bom(2, "A", [line(1, "STEEL", 6)], 3)]]);
    const steel = flattenNodes(expandBom(1, idx)).find((n) => n.productCode === "STEEL")!;
    expect(steel.qty).toBe(2);
    expect(steel.perRoot).toBe(2);
  });

  it("flags a sub-BoM the mirror does not hold and survives a loop", () => {
    const idx = new Map([
      [1, bom(1, "FG-X", [line(1, "A", 1, 2), line(2, "B", 1, 99)])],
      [2, bom(2, "A", [line(1, "LOOP", 1, 1)])],
    ]);
    const all = flattenNodes(expandBom(1, idx));
    expect(all.find((n) => n.productCode === "B")!.childMissing).toBe(true);
    expect(all.find((n) => n.productCode === "LOOP")!.children).toEqual([]);
    expect(treeStats(expandBom(1, idx)).missing).toBe(1);
  });
});

describe("odoo boms — raw materials", () => {
  it("sums the bought lines through every level, per unit of the product", () => {
    const r = rawMaterials(1, plant());
    expect(r.lines.get("C-SHR-005")!.qty).toBe(1.35); // core frame 0.742 + tank 0.268 + top cover 0.34
    expect(r.lines.get("C-SHR-003")!.qty).toBe(1.98); // two cable boxes
    expect(r.lines.get("T-OIL-G1-AA")!.uom).toBe("KG");
    expect(r.lines.has("FB-022-64022E11M11")).toBe(false); // built, not bought
    expect(r.incomplete).toEqual([]);
  });

  it("names a component whose BoM is not synced instead of guessing", () => {
    const idx = new Map([[1, bom(1, "FG-X", [line(1, "STEEL", 2), line(2, "SUB", 1, 9)])]]);
    const r = rawMaterials(1, idx);
    expect(r.lines.get("STEEL")!.qty).toBe(2);
    expect(r.incomplete).toEqual(["SUB"]);
  });
});

describe("odoo boms — components", () => {
  it("finds each component once, never inside another", () => {
    const tree = expandBom(1, plant());
    const items = bomItems(tree);
    expect([...items.keys()].sort()).toEqual(["CB", "CF", "TC", "TN"]);
    expect(items.get("CB")).toBe(2); // the LV and the HV cable box — not their sheet BoMs again
    expect(itemNodes(tree, "CF")[0].productCode).toBe("FB-058-64022E11M11");
  });

  it("checks the order's components against the BoM's", () => {
    const inBom = bomItems(expandBom(1, plant()));
    expect(checkItems(["CF", "TC", "TN", "CB"], inBom)).toEqual({ notInBom: [], notRequired: [] });
    expect(itemCheckOk(checkItems(["CF", "TC", "TN", "CB"], inBom))).toBe(true);
    const c = checkItems(["TC", "TN", "CB", "AR"], inBom);
    expect(c).toEqual({ notInBom: ["AR"], notRequired: ["CF"] });
    expect(itemCheckOk(c)).toBe(false);
  });
});

describe("odoo boms — BOM rate of a part", () => {
  const idx = plant();
  const lk = {
    index: idx,
    bomOfProduct: new Map([...idx.values()].map((b) => [b.code, b.odooId])),
    rootOf: new Map([["64022E11M11", 1]]),
  };

  it("uses the part's own BoM when Odoo files one under part-code", () => {
    expect(partBomId("FB-022", "64022e11m11", lk)).toBe(4);
    expect(partBomId("FB-024", "00009S12", lk)).toBe(21);
    expect(partRates("FB-022", "64022E11M11", lk)!.get("C-SHR-004")!.qty).toBe(2.23);
  });

  it("falls back to the part's node in the transformer's tree", () => {
    const noOwn = { ...lk, bomOfProduct: new Map<string, number>() };
    expect(partBomId("FB-058", "64022E11M11", noOwn)).toBe(7);
    expect(partRates("FB-058", "64022E11M11", noOwn)!.get("C-SHR-005")!.qty).toBe(0.742);
  });

  it("will not guess between two of the same part", () => {
    const noOwn = { ...lk, bomOfProduct: new Map<string, number>() };
    expect(partBomId("FB-024", "64022E11M11", noOwn)).toBeNull(); // the LV and the HV cable box
  });

  it("answers null when the mirror cannot say", () => {
    expect(partBomId("FB-027", "64022E11M11", lk)).toBeNull();
    expect(partRates("FB-022", "99999E11M11", lk)).toBeNull();
    expect(partBomId("", "64022E11M11", lk)).toBeNull();
  });
});

describe("odoo boms — the open plan's need", () => {
  const idx = plant();
  const rootOf = new Map([["64022E11M11", 1], ["PANEL-1", 20]]);

  it("counts each component's units still to cut × its own sub-tree", () => {
    const n = materialNeed([{ mo: "MO/1", bom: "64022E11M11", line: "TR", remaining: { TN: 2, TC: 1, CF: 0 } }], rootOf, idx);
    expect(n.lines.get("C-SHR-004")!.qty).toBe(4.46);
    expect(n.lines.get("C-SHR-005")!.qty).toBe(0.876); // 2 × 0.268 + 0.34 — the core is cut already
    expect(n.lines.get("T-CRC-1.5X1100")!.qty).toBe(755.06); // the tank's fins
    expect(n.lines.has("T-OIL-G1-AA")).toBe(false); // not a component's material
    expect(n.counted).toBe(1);
    expect(n.gaps).toEqual([]);
  });

  it("adds orders up and keeps who needs it, biggest first", () => {
    const n = materialNeed([
      { mo: "MO/1", bom: "64022E11M11", line: "TR", remaining: { CB: 1 } },
      { mo: "MO/2", bom: "64022E11M11", line: "TR", remaining: { CB: 3 } },
    ], rootOf, idx);
    const sheet = n.lines.get("C-SHR-003")!;
    expect(sheet.qty).toBe(7.92); // (0.68 + 1.3) × 4
    expect(sheet.orders.map((o) => o.mo)).toEqual(["MO/2", "MO/1"]);
  });

  it("counts a panel order on its whole BoM", () => {
    const n = materialNeed([{ mo: "LV/1", bom: "panel-1", line: "LV", remaining: 5 }], rootOf, idx);
    expect(n.lines.get("C-SHR-003")!.qty).toBe(3.4);
    expect(n.lines.get("C-CON-BOL-HEX-GI-M8x30")!.qty).toBe(45);
  });

  it("names what it could not count", () => {
    const n = materialNeed([
      { mo: "MO/9", bom: "NOPE", line: "TR", remaining: { TN: 1 } },
      { mo: "MO/1", bom: "64022E11M11", line: "TR", remaining: { AR: 1 } },
      { mo: "MO/3", bom: "64022E11M11", line: "TR", remaining: {} },
    ], rootOf, idx);
    expect(n.gaps).toEqual([
      { mo: "MO/9", bom: "NOPE", reason: "no Odoo BoM for this code" },
      { mo: "MO/1", bom: "64022E11M11", reason: "no AR in the BoM" },
    ]);
    expect(n.counted).toBe(0);
  });
});

describe("odoo boms — Odoo's figure beside the sheet's", () => {
  const rates = {
    "FB-022|64022E11M11": { "C-SHR-004": { qty: 2.23, uom: "PC" }, "T-CRC-1.5X1100": { qty: 377.53, uom: "KG" } },
    "FB-051|64022E11M11": null,
  };
  const l = (partCode: string, materialCode: string, sheetsPerUnit: number) => ({ partCode, bom: "64022e11m11", materialCode, sheetsPerUnit });

  it("compares a figure in pieces with the sheet, amber where they part", () => {
    expect(odooRateOf(rates, l("fb-022", "c-shr-004", 2.23))).toEqual({ kind: "value", qty: 2.23, uom: "PC", comparable: true, differs: false });
    expect(odooRateOf(rates, l("FB-022", "C-SHR-004", 2.1))).toMatchObject({ differs: true });
  });

  it("never compares kilos with sheets", () => {
    expect(odooRateOf(rates, l("FB-022", "T-CRC-1.5X1100", 1))).toEqual({ kind: "value", qty: 377.53, uom: "KG", comparable: false, differs: false });
  });

  it("says why it has nothing", () => {
    expect(odooRateOf(rates, l("FB-022", "C-SHR-099", 1))).toEqual({ kind: "absent" });
    expect(odooRateOf(rates, l("FB-051", "C-SHR-005", 1)).kind).toBe("unknown");
    expect(odooRateOf(rates, l("", "C-SHR-005", 1)).kind).toBe("unknown");
    expect(odooRateOf(rates, l("FB-022", " ", 1)).kind).toBe("unknown");
  });
});

describe("odoo boms — what is left and what it leaves", () => {
  it("files cut pieces by order, an MO-less row on its code's only order", () => {
    const orders = [{ mo: "A", bom: "111E11M11" }, { mo: "B", bom: "222E11M11" }, { mo: "C", bom: "222E11M11" }];
    const r = cutByOrder(orders, [
      { mo: "A", bom: "111E11M11", item: "TN", qty: 2 },
      { mo: null, bom: "111e11m11", item: "TN", qty: 3 },
      { mo: "", bom: "222E11M11", item: "TC", qty: 4 },
      { mo: "Z", bom: "111E11M11", item: "TN", qty: 9 }, // an order not open: not ours
      { mo: null, bom: "999E11M11", item: "TN", qty: 1 },
    ]);
    expect(r.done.get("A|TN")).toBe(5);
    expect(r.done.has("B|TC")).toBe(false);
    expect(r.loose).toEqual([{ bom: "222E11M11", orders: 2, qty: 4 }]);
  });

  it("counts each required component's units still to cut, outsourced ones off", () => {
    const cut = { CF: 3, TC: 10, TN: 4 } as Record<string, number>;
    expect(remainingToCut({ planQty: 10, required: ["CF", "TC", "TN", "CB"], osp: { CF: 2 } }, (it) => cut[it] ?? 0))
      .toEqual({ CF: 5, TN: 6, CB: 10 });
    // more cut than planned never goes negative; a component not required is not counted
    expect(remainingToCut({ planQty: 2, required: ["TN"], osp: {} }, () => 5)).toEqual({});
    expect(remainingToCut({ planQty: 4, required: [], osp: {} }, () => 0)).toEqual({});
  });

  it("counts a panel order's panels still to punch", () => {
    expect(panelsToPunch(12, 5)).toBe(7);
    expect(panelsToPunch(3, 9)).toBe(0);
  });

  it("subtracts the need from SF01 only in the same unit", () => {
    expect(stockAfterPlan({ uom: "PC", odoo: 10 }, { qty: 12.345, uom: "pc" })).toEqual({ need: 12.345, uom: "pc", sameUnit: true, after: -2.35 });
    expect(stockAfterPlan({ uom: "", odoo: 5 }, { qty: 1, uom: "KG" })!.after).toBe(4);
    expect(stockAfterPlan({ uom: "KG", odoo: 5 }, { qty: 1, uom: "PC" })).toEqual({ need: 1, uom: "PC", sameUnit: false, after: null });
    expect(stockAfterPlan({ uom: "PC", odoo: 5 }, undefined)).toBeNull();
  });
});
