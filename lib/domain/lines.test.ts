import { describe, expect, it } from "vitest";
import { DEFAULT_LINE, LINE_LABEL, PRODUCT_LINES, hrefWithLine, pinnedLine, showsBothLines, isProductLine, lineParam, resolveLine } from "./lines";

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

  it("reads a line off a form or an address however it was spelled", () => {
    expect(resolveLine("lv")).toBe("LV");
    expect(resolveLine(" TR ")).toBe("TR");
  });

  it("lands on transformers when the value is missing or unknown — a screen has to land somewhere", () => {
    expect(resolveLine(undefined)).toBe("TR");
    expect(resolveLine("")).toBe("TR");
    expect(resolveLine("panels")).toBe("TR");
    expect(resolveLine(42)).toBe("TR");
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

describe("screens pinned to one line", () => {
  it("names the transformers' and the panels' own screens", () => {
    expect(pinnedLine("/import")).toBe("TR");
    expect(pinnedLine("/worklist/cut")).toBe("TR");
    expect(pinnedLine("/worklist/punching")).toBe("LV");
    expect(pinnedLine("/worklist/welding")).toBeNull();
    expect(pinnedLine("/tracker")).toBeNull();
  });
});


describe("the screens that show both lines", () => {
  it("are the plant dashboards, read off a path or an href", () => {
    expect(showsBothLines("/")).toBe(true);
    expect(showsBothLines("/dashboards/production?from=2026-10-01#lv")).toBe(true);
    expect(showsBothLines("/?dept=Welding")).toBe(true);
    expect(showsBothLines("/dashboards/material")).toBe(false);
    expect(showsBothLines("/tracker")).toBe(false);
  });
});
