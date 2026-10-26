import { describe, expect, it } from "vitest";
import { DEFAULT_LINE, LINE_LABEL, PRODUCT_LINES, defaultLineOf, hrefWithLine, isProductLine, lineParam, otherLine, resolveLine } from "./lines";

describe("product lines — transformers and LV panels, never mixed", () => {
  it("knows exactly two lines, transformers first", () => {
    expect(PRODUCT_LINES).toEqual(["TR", "LV"]);
    expect(DEFAULT_LINE).toBe("TR");
    expect(LINE_LABEL.LV).toBe("LV Panels");
  });

  it("tells a line from anything else", () => {
    expect(isProductLine("TR")).toBe(true);
    expect(isProductLine("LV")).toBe(true);
    expect(isProductLine("lv")).toBe(false);
    expect(isProductLine("")).toBe(false);
    expect(isProductLine(null)).toBe(false);
  });

  it("reads a line off a cookie or a form however it was spelled", () => {
    expect(resolveLine("lv")).toBe("LV");
    expect(resolveLine(" TR ")).toBe("TR");
  });

  it("lands on transformers when the value is missing or unknown — a screen has to land somewhere", () => {
    expect(resolveLine(undefined)).toBe("TR");
    expect(resolveLine("")).toBe("TR");
    expect(resolveLine("panels")).toBe("TR");
    expect(resolveLine(42)).toBe("TR");
  });

  it("switches to the other line", () => {
    expect(otherLine("TR")).toBe("LV");
    expect(otherLine("LV")).toBe("TR");
  });

  it("reads the line an address names, and nothing else", () => {
    expect(lineParam("LV")).toBe("LV");
    expect(lineParam(" tr ")).toBe("TR");
    expect(lineParam(undefined)).toBeNull();
    expect(lineParam("")).toBeNull();
    expect(lineParam("panels")).toBeNull();
    expect(lineParam(["LV"])).toBeNull();
  });

  it("puts the line into an address, keeping its query and fragment", () => {
    expect(hrefWithLine("/tracker", "LV")).toBe("/tracker?line=LV");
    expect(hrefWithLine("/handover?q=MO%2F1", "LV")).toBe("/handover?q=MO%2F1&line=LV");
    expect(hrefWithLine("/orders?line=LV", "TR")).toBe("/orders?line=TR");
    expect(hrefWithLine("/material?view=x#row", "LV")).toBe("/material?view=x&line=LV#row");
  });
});

describe("the line a screen opens on for a person", () => {
  it("is the transformers' for admins, whatever they hold", () => {
    expect(defaultLineOf(["lv.punching"], true)).toBe("TR");
  });

  it("is the panels' for someone who records only on the panels", () => {
    expect(defaultLineOf(["lv.punching", "lv.bending"], false)).toBe("LV");
    expect(defaultLineOf(["shifts.lv", "consumables.edit", "odoo.alerts"], false)).toBe("LV");
    expect(defaultLineOf(["lv.import", "lv.material"], false)).toBe("LV");
  });

  it("is the transformers' as soon as a transformer key is held too", () => {
    expect(defaultLineOf(["lv.welding", "welding.edit"], false)).toBe("TR");
    expect(defaultLineOf(["lv.status", "tracker.status"], false)).toBe("TR");
    expect(defaultLineOf(["lv.material", "material.edit"], false)).toBe("TR");
    expect(defaultLineOf(["lv.import", "plans.import"], false)).toBe("TR");
    expect(defaultLineOf(["lv.odoo", "odoo.edit"], false)).toBe("TR");
  });

  it("is the transformers' for someone tied to neither line", () => {
    expect(defaultLineOf([], false)).toBe("TR");
    expect(defaultLineOf(["consumables.edit", "stock.edit"], false)).toBe("TR");
  });
});
