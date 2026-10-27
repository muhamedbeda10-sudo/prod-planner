import { describe, expect, it } from "vitest";
import { coverage, normCode, sheetNeeds, stockCheck, type PartNeed, type StockLine } from "./materialCoverage";
import type { LineSheetSpec } from "./machineMaterial";

const spec = (code: string, perUnit: number, o: Partial<LineSheetSpec> = {}): LineSheetSpec => ({ material: "Steel", materialCode: code, thicknessMm: 3, sheetSize: "1220*2440", perUnit, actual: true, ...o });
const part = (mo: string, item: string, pcsLeft: number, specs: LineSheetSpec[]): PartNeed => ({ mo, item, pcsLeft, specs });
const stock = (code: string, odoo: number, physical = odoo, uom = "PC"): StockLine => ({ code, name: `${code} sheet`, uom, odoo, physical });

describe("the sheets the work still needs", () => {
  it("adds the parts' sheets up per product code, whatever its case or spaces", () => {
    const n = sheetNeeds([
      part("A", "TN", 10, [spec("c-shr-003", 0.5), spec("C-SHR-005", 0.2, { actual: false })]),
      part("B", "TC", 4, [spec(" C-SHR-003", 1)]),
      part("C", "CB", 0, [spec("C-SHR-003", 1)]),
    ]);
    expect(n.byCode).toEqual([
      expect.objectContaining({ code: "C-SHR-003", sheets: 9, estimated: false, jobs: [{ mo: "A", item: "TN", sheets: 5 }, { mo: "B", item: "TC", sheets: 4 }] }),
      expect.objectContaining({ code: "C-SHR-005", sheets: 2, estimated: true }),
    ]);
    // keyed as the stock import keys it: case aside, a space inside is part of the code
    expect(normCode(" t-sss 5mm ")).toBe("T-SSS 5MM");
  });
  it("names the parts with no nesting and the lines with no code", () => {
    const n = sheetNeeds([part("A", "TN", 10, []), part("B", "TC", 2, [spec("", 1)])]);
    expect(n.byCode).toEqual([]);
    expect(n.noNesting).toEqual([{ mo: "A", item: "TN", pcsLeft: 10 }]);
    expect(n.uncoded).toEqual([{ mo: "B", item: "TC", sheet: "3 mm Steel 1220*2440", sheets: 2 }]);
  });
});

describe("the need against Odoo's stock", () => {
  const needs = sheetNeeds([
    part("A", "TN", 10, [spec("C1", 1), spec("C2", 1), spec("C3", 1), spec("C4", 1), spec("C5", 1)]),
  ]).byCode;
  it("covered, short, store-short, not listed and held in KG — short first", () => {
    const rows = coverage(needs, [stock("c1", 20), stock("C2", 6), stock("C3", 15, 4), stock("C5", 900, 900, "KG")]);
    expect(rows.map((r) => [r.code, r.status, r.balance])).toEqual([
      ["C2", "short", -4], ["C3", "store_short", 5], ["C4", "not_listed", null], ["C5", "not_comparable", null], ["C1", "covered", 10],
    ]);
  });
  it("a store count of 0 is not counted, not short", () => {
    expect(coverage(needs.slice(0, 1), [stock("C1", 20, 0)])[0]).toMatchObject({ status: "covered", storeCounted: false });
  });
  it("flags a code the open work wants as much of as Odoo holds, and names the other orders", () => {
    const open = (pcsB: number) => new Map(sheetNeeds([part("A", "TN", 10, [spec("C1", 1)]), part("B", "TC", pcsB, [spec("C1", 1)])]).byCode.map((n) => [n.code, n]));
    const rows = coverage(needs.slice(0, 1), [stock("C1", 20)], open(25));
    expect(rows[0]).toMatchObject({ status: "covered", openDemand: 35, contended: true, competing: [{ mo: "B", item: "TC", sheets: 25 }] });
    expect(coverage(needs.slice(0, 1), [stock("C1", 20)], open(2))[0].contended).toBe(false);
  });
});

describe("the release checklist's material line", () => {
  const mine = [part("A", "TN", 10, [spec("C1", 1)])];
  const rows = (s: StockLine[], others: PartNeed[] = []) => coverage(sheetNeeds(mine).byCode, s, new Map(sheetNeeds([...mine, ...others]).byCode.map((n) => [n.code, n])));
  const gaps = { noNesting: [], uncoded: [] };
  it("ok when Odoo holds it all", () => {
    expect(stockCheck(rows([stock("C1", 12)]), gaps)).toMatchObject({ status: "ok", detail: expect.stringContaining("C1: 10 of 12") });
  });
  it("blocked when Odoo holds less", () => {
    expect(stockCheck(rows([stock("C1", 4)]), gaps)).toMatchObject({ status: "blocked", detail: expect.stringContaining("C1 (needs 10, Odoo 4)") });
  });
  it("a warning when the store counted less or others compete for it", () => {
    expect(stockCheck(rows([stock("C1", 12, 3)]), gaps)).toMatchObject({ status: "warn", detail: expect.stringContaining("store 3") });
    expect(stockCheck(rows([stock("C1", 12)], [part("B", "TC", 20, [spec("C1", 1)])]), gaps)).toMatchObject({ status: "warn", detail: expect.stringContaining("also wanted by B") });
  });
  it("unknown when nothing could be held against the stock", () => {
    expect(stockCheck(rows([]), gaps)).toMatchObject({ status: "unknown", detail: expect.stringContaining("cannot be checked") });
    expect(stockCheck([], { noNesting: [{ mo: "A", item: "TN", pcsLeft: 3 }], uncoded: [] })).toMatchObject({ status: "unknown", detail: expect.stringContaining("no nesting for TN") });
  });
  it("nothing left to cut needs no sheets", () => {
    expect(stockCheck([], gaps)).toMatchObject({ status: "ok", detail: expect.stringContaining("Nothing is left to cut") });
  });
});
