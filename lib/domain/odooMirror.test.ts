import { describe, expect, it } from "vitest";
import { ITEM_PRODUCT, isUntouched, mirrorFgCode, mirrorSource, sameProduct, sourceLabel } from "./odooMirror";
import { ITEMS } from "./constants";
import { PART_PRESETS } from "./material";

describe("mirrorSource", () => {
  it("is painting for any painted component, shot blast for the core only", () => {
    expect(mirrorSource("Painting", "TN")).toBe("painting");
    expect(mirrorSource("Painting", "TC")).toBe("painting");
    expect(mirrorSource("ShotBlast", "CF")).toBe("shotblast");
    expect(mirrorSource("ShotBlast", "TN")).toBeNull();
    expect(mirrorSource("Welding", "TN")).toBeNull();
    expect(mirrorSource("Cut", "CF")).toBeNull();
  });
});

describe("ITEM_PRODUCT", () => {
  it("names every component and agrees with the Material tab's part codes", () => {
    for (const it of ITEMS) expect(ITEM_PRODUCT[it].product).toBeTruthy();
    const preset = Object.fromEntries(PART_PRESETS.map((p) => [p.code, p.name]));
    expect(preset[ITEM_PRODUCT.TN.partCode!]).toBe("TANK");
    expect(preset[ITEM_PRODUCT.TC.partCode!]).toBe("TOP COVER");
    expect(preset[ITEM_PRODUCT.CF.partCode!]).toBe("CORE FRAME");
    expect(preset[ITEM_PRODUCT.CB.partCode!]).toBe("CABLE BOX");
  });
});

describe("mirrorFgCode", () => {
  it("copies the prior row's code as it is", () => {
    expect(mirrorFgCode("fb-051-12011e12m12", "TC", "12011E16M13")).toEqual({ fgCode: "FB-051-12011E12M12", guessed: false });
  });
  it("composes part + BOM and says it guessed when there is no prior row", () => {
    expect(mirrorFgCode(null, "TN", "14003e11m11")).toEqual({ fgCode: "FB-022-14003E11M11", guessed: true });
    expect(mirrorFgCode("  ", "CF", "14003E11M11")).toEqual({ fgCode: "FB-058-14003E11M11", guessed: true });
  });
  it("leaves it empty for a part without a code", () => {
    expect(mirrorFgCode(null, "MB", "14003E11M11")).toEqual({ fgCode: "", guessed: true });
    expect(mirrorFgCode(null, "TN", "")).toEqual({ fgCode: "", guessed: true });
  });
});

describe("sameProduct", () => {
  it("folds the sheet's names and the abbreviations together", () => {
    expect(sameProduct("Top Cover", "TC")).toBe(true);
    expect(sameProduct("top-cover", "Top Cover")).toBe(true);
    expect(sameProduct("Tank", "Top Cover")).toBe(false);
  });
});

describe("isUntouched", () => {
  it("is true only while no MO, the starting status and no notes", () => {
    expect(isUntouched({ odooMo: "", status: "MO to be close", notes: [] })).toBe(true);
    expect(isUntouched({ odooMo: "", status: "MO to be close", notes: 0 })).toBe(true);
    expect(isUntouched({ odooMo: "SF01/MO/1", status: "MO to be close", notes: [] })).toBe(false);
    expect(isUntouched({ odooMo: "", status: "Pending", notes: [] })).toBe(false);
    expect(isUntouched({ odooMo: "", status: "MO to be close", notes: [{}] })).toBe(false);
  });
});

describe("sourceLabel", () => {
  it("names the born rows and says nothing for a typed one", () => {
    expect(sourceLabel("painting")).toBe("from Painting");
    expect(sourceLabel("shotblast")).toBe("from Shot Blast");
    expect(sourceLabel("manual")).toBeNull();
  });
});
