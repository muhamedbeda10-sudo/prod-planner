import { describe, it, expect } from "vitest";
import { groupKey, bomPrefix, makeBomGrouper } from "./bom";

describe("groupKey", () => {
  it("merges same base + same M number regardless of E number", () => {
    expect(groupKey("12011E13M12")).toBe("12011|M12");
    expect(groupKey("12011E14M12")).toBe("12011|M12");
    expect(groupKey("12011E16M12")).toBe("12011|M12");
  });

  it("separates different base numbers", () => {
    expect(groupKey("64016E11M11")).toBe("64016|M11");
    expect(groupKey("64015E11M11")).toBe("64015|M11");
    expect(groupKey("64016E11M11")).not.toBe(groupKey("64015E11M11"));
  });

  it("separates different M numbers", () => {
    expect(groupKey("12011E13M12")).not.toBe(groupKey("12011E13M13"));
  });

  it("returns the code unchanged when it does not match the E/M pattern", () => {
    expect(groupKey("SAD091203L00X00")).toBe("SAD091203L00X00");
  });
});

describe("bomPrefix", () => {
  it("takes everything before the first E<digit>", () => {
    expect(bomPrefix("12011E13M12")).toBe("12011");
    expect(bomPrefix("64016E11M11")).toBe("64016");
  });
  it("returns the whole (uppercased) code when there is no E<digit>", () => {
    expect(bomPrefix("sad091203l00x00")).toBe("SAD091203L00X00");
  });
});

describe("makeBomGrouper", () => {
  it("maps every family member to the FIRST member found in Plan Orders", () => {
    // Plan Orders order: E13 appears first -> representative for the whole family
    const g = makeBomGrouper(["12011E13M12", "12011E14M12", "12011E16M12"]);
    expect(g("12011E14M12")).toBe("12011E13M12");
    expect(g("12011E16M12")).toBe("12011E13M12");
    expect(g("12011E13M12")).toBe("12011E13M12");
  });

  it("uppercases/trims input and unknown families fall back to the raw code", () => {
    const g = makeBomGrouper(["64016E11M11"]);
    expect(g("  64016e11m11 ")).toBe("64016E11M11");
    expect(g("99999E99M99")).toBe("99999E99M99"); // not in Plan Orders -> itself
  });
});
