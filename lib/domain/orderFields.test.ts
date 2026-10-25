import { describe, it, expect } from "vitest";
import { ORDER_TEXT_KEYS, orderTextValue } from "./orderFields";

describe("orderTextValue", () => {
  it("stores the trimmed text, and nothing for an empty field", () => {
    expect(orderTextValue("customer", "  ATC  ")).toEqual({ value: "ATC" });
    expect(orderTextValue("customer", "   ")).toEqual({ value: null });
    expect(orderTextValue("customer", null)).toEqual({ value: null });
  });
  it("refuses an over-long field in the planner's words, not the column's", () => {
    expect(orderTextValue("materialsRemarks", "x".repeat(401))).toEqual({ error: "Keep Materials remarks under 400 characters." });
    expect(orderTextValue("fgCode", "x".repeat(41))).toEqual({ error: "Keep FG code under 40 characters." });
    expect(orderTextValue("fgCode", "x".repeat(40))).toEqual({ value: "x".repeat(40) });
  });
  it("covers the registry row's ten text fields", () => {
    expect(ORDER_TEXT_KEYS).toHaveLength(10);
  });
});
