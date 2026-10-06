import { describe, it, expect } from "vitest";
import { parseStockGrid, stockColumnOf, stockGroupOf, stockView, summarizeStock } from "./physicalStock";

describe("physical stock", () => {
  it("reads the sheet's own headers, misspelling included", () => {
    expect(stockColumnOf("Product Code ")).toBe("code");
    expect(stockColumnOf("Product Name")).toBe("name");
    expect(stockColumnOf("Phsically Stock Internal Store")).toBe("physical");
    expect(stockColumnOf("UOM")).toBe("uom");
    expect(stockColumnOf("SF01 Stock In Odoo")).toBe("odoo");
  });

  it("parses rows, skips blanks, keeps the last of a doubled code", () => {
    const p = parseStockGrid([
      ["Product Code ", "Product Name", "Phsically Stock Internal Store", "UOM", "SF01 Stock In Odoo"],
      ["C-SHR-010", "HR Sheet 10mm- 1220x2440mm", 85, "PC", "96.75"],
      ["", "", "", "", ""],
      ["T-CRC-1.2X600", "Cold Rolled Coil 1.2x600mm", "7,840.00", "kg", 39222.28],
      ["C-SHR-010", "HR Sheet 10mm- 1220x2440mm", 90, "PC", 96.75],
      ["C-X", "Nothing", "", "PC", ""],
    ]);
    expect(p.headerRow).toBe(1);
    expect(p.rows).toEqual([
      { code: "C-SHR-010", name: "HR Sheet 10mm- 1220x2440mm", uom: "PC", physical: 90, odoo: 96.75 },
      { code: "T-CRC-1.2X600", name: "Cold Rolled Coil 1.2x600mm", uom: "KG", physical: 7840, odoo: 39222.28 },
    ]);
    expect(p.issues).toHaveLength(2);
  });

  it("is empty with a note when no header is found", () => {
    expect(parseStockGrid([["a", "b"], [1, 2]]).issues[0]).toMatch(/No header/);
  });

  it("groups by the product's name", () => {
    expect(stockGroupOf("HR Sheet 4x1220x2440mm")).toBe("HR Sheet");
    expect(stockGroupOf("Cold Rolled Coil 1.5x900mm")).toBe("Cold Rolled Coil");
    expect(stockGroupOf("Hot Dipped Galvanized Steel Sheet G90 - 1220x2.0mm (Mother Coil)")).toBe("Galvanized Coil");
    expect(stockGroupOf("Galvanized Iron Sheet 1550x1220x2mm")).toBe("Galvanized Sheet");
    expect(stockGroupOf("GI Sheet, 3 x 1500 x 3050mm")).toBe("Galvanized Sheet");
    expect(stockGroupOf("Aluminum Mother Coil - 1220x1.00mm")).toBe("Aluminium");
    expect(stockGroupOf("Angle bar 50X50X5mmx6Mt")).toBe("Angle Bar");
    expect(stockGroupOf("Iron Channel UPN 100X50X6X12mt")).toBe("Channel");
    expect(stockGroupOf("U CHANNEL -140x50x7")).toBe("Channel");
  });

  it("judges the gap: short, over, matching within a tolerance, empty", () => {
    expect(stockView({ code: "a", name: "", uom: "PC", physical: 1, odoo: 323.02 })).toMatchObject({ status: "short", diff: -322.02, diffPct: -100 });
    expect(stockView({ code: "b", name: "", uom: "PC", physical: 20, odoo: 1.92 })).toMatchObject({ status: "over", diff: 18.08 });
    expect(stockView({ code: "c", name: "", uom: "KG", physical: 3696, odoo: 3696.59 })).toMatchObject({ status: "match", diff: 0 });
    expect(stockView({ code: "d", name: "", uom: "PC", physical: 0, odoo: 0 })).toMatchObject({ status: "empty", diffPct: null });
  });

  it("sums per unit of measure, never mixing pieces and kilos", () => {
    const s = summarizeStock([
      stockView({ code: "a", name: "", uom: "PC", physical: 10, odoo: 12 }),
      stockView({ code: "b", name: "", uom: "KG", physical: 100, odoo: 90 }),
      stockView({ code: "c", name: "", uom: "PC", physical: 5, odoo: 5 }),
    ]);
    expect(s.byUom).toEqual([{ uom: "PC", physical: 15, odoo: 17, diff: -2 }, { uom: "KG", physical: 100, odoo: 90, diff: 10 }]);
    expect([s.short, s.over, s.match]).toEqual([1, 1, 1]);
  });
});
