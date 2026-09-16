import { describe, expect, it } from "vitest";
import { DEFAULT_LINE, LINE_LABEL, PRODUCT_LINES, isProductLine, otherLine, resolveLine } from "./lines";

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

  it("lands on transformers when the value is missing or unknown — the toggle has to land somewhere", () => {
    expect(resolveLine(undefined)).toBe("TR");
    expect(resolveLine("")).toBe("TR");
    expect(resolveLine("panels")).toBe("TR");
    expect(resolveLine(42)).toBe("TR");
  });

  it("switches to the other line", () => {
    expect(otherLine("TR")).toBe("LV");
    expect(otherLine("LV")).toBe("TR");
  });
});
