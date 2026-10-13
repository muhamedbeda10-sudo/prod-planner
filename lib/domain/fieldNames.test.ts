import { describe, expect, it } from "vitest";
import { humanizeKey, looksLikeColumn, readableDate, readableValue } from "./fieldNames";

const now = new Date("2026-10-13T10:00:00Z");

describe("humanizeKey", () => {
  it("turns database column names into words, keeping the plant's abbreviations", () => {
    expect(humanizeKey("odooMo")).toBe("Odoo MO");
    expect(humanizeKey("fgCode")).toBe("FG code");
    expect(humanizeKey("soi")).toBe("SOI");
    expect(humanizeKey("plan_qty")).toBe("Plan qty");
    expect(humanizeKey("by")).toBe("By");
  });
  it("leaves a name already written for people as it is", () => {
    expect(humanizeKey("Due date")).toBe("Due date");
    expect(humanizeKey("الكمية")).toBe("الكمية");
  });
});

describe("looksLikeColumn", () => {
  it("knows camelCase and snake_case from words", () => {
    expect(looksLikeColumn("odooMo")).toBe(true);
    expect(looksLikeColumn("plan_qty")).toBe(true);
    expect(looksLikeColumn("status")).toBe(false);
    expect(looksLikeColumn("Due date")).toBe(false);
  });
});

describe("readable values", () => {
  it("writes a stored day as a day and a moment on the factory clock", () => {
    expect(readableDate("2026-10-12T00:00:00.000Z", now)).toBe("Mon 12 Oct");
    expect(readableDate("2026-10-12", now)).toBe("Mon 12 Oct");
    expect(readableDate("2026-10-12T11:05:00.000Z", now)).toBe("12 Oct 14:05");
    expect(readableDate("SF01/MO/1", now)).toBeNull();
  });
  it("is nothing for an empty value, and plain for the rest", () => {
    expect(readableValue(null)).toBeNull();
    expect(readableValue("   ")).toBeNull();
    expect(readableValue(true)).toBe("Yes");
    expect(readableValue(2.345)).toBe("2.35");
    expect(readableValue({ toNumber: () => 7 })).toBe("7");
    expect(readableValue(new Date("2026-10-12T00:00:00Z"), now)).toBe("Mon 12 Oct");
  });
});
