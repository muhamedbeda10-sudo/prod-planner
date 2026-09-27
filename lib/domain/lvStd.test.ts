import { describe, expect, it } from "vitest";
import { indexLvRates, lvRateFor, secItemDigits, type LvRate } from "./lvStd";

const rate = (fg: string, cutH = 7.5): LvRate => ({ fg, description: null, kind: "USS", cutH, bendH: 6.2, weldH: 10.1, shbH: 2.2, paintH: 5, totalH: 77.3 });
const idx = indexLvRates([rate("FG-SUSA-8569105"), rate("FG-SUSA-8569114", 6.5), rate("FG-LV-B-DMB-000002", 0.5)]);

describe("lvRateFor", () => {
  it("finds a panel by its own FG code, however it is written", () => {
    expect(lvRateFor(idx, { fgCode: "fg-susa-8569114", secItem: null })).toMatchObject({ via: "fg", rate: { cutH: 6.5 } });
  });
  it("finds our FG code's panel through its SEC item", () => {
    expect(lvRateFor(idx, { fgCode: "FG-SUA-AS-AA-000004", secItem: "908569105" })).toMatchObject({ via: "sec", rate: { fg: "FG-SUSA-8569105" } });
    expect(lvRateFor(idx, { fgCode: "FG-SUSA-85610XX", secItem: "908569105" })?.rate.fg).toBe("FG-SUSA-8569105");
  });
  it("is null when neither matches", () => {
    expect(lvRateFor(idx, { fgCode: "FG-LSC-AHS-MUN-AD-AA", secItem: null })).toBeNull();
    expect(lvRateFor(idx, { fgCode: null, secItem: "908560000" })).toBeNull();
  });
  it("reads a SEC item's digits", () => {
    expect(secItemDigits("908569105")).toBe("8569105");
    expect(secItemDigits(" 8569105 ")).toBe("8569105");
    expect(secItemDigits("123")).toBeNull();
    expect(secItemDigits(null)).toBeNull();
  });
});
