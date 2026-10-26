import { describe, it, expect } from "vitest";
import { trackerHref, traceHref } from "./links";

describe("trackerHref", () => {
  it("sends a weekly reader back to the WEEKLY table, not the monthly one", () => {
    expect(trackerHref(30, "weekly")).toBe("/tracker?view=weekly&plan=30");
  });

  it("keeps the monthly link as it was — plan only, no view", () => {
    expect(trackerHref(30)).toBe("/tracker?plan=30");
  });

  it("drops a missing or zero plan (plan 0 is the setup-balances bucket)", () => {
    expect(trackerHref()).toBe("/tracker");
    expect(trackerHref(0)).toBe("/tracker");
    expect(trackerHref(0, "weekly")).toBe("/tracker?view=weekly");
  });

  it("ignores an unknown view rather than passing it through", () => {
    expect(trackerHref(30, "quarterly")).toBe("/tracker?plan=30");
  });
});

describe("traceHref", () => {
  it("links a BOM and remembers the weekly origin", () => {
    expect(traceHref({ bom: "B-4411" }, 30, "weekly")).toBe("/trace?bom=B-4411&plan=30&view=weekly");
  });

  it("links an MO", () => {
    expect(traceHref({ mo: "MO-8010" })).toBe("/trace?mo=MO-8010");
  });

  it("prefers the MO when both are given — it is the narrower scope", () => {
    expect(traceHref({ mo: "MO-8010", bom: "B-4411" })).toBe("/trace?mo=MO-8010");
  });

  it("falls back to the BOM when the MO is null or empty", () => {
    expect(traceHref({ mo: null, bom: "B-4411" })).toBe("/trace?bom=B-4411");
    expect(traceHref({ mo: "", bom: "B-4411" })).toBe("/trace?bom=B-4411");
  });

  it("escapes codes that are not URL-safe", () => {
    // slashes and spaces appear in real BOM codes and must not split the query
    expect(traceHref({ bom: "SAD 09/12" })).toBe("/trace?bom=SAD+09%2F12");
  });
});

describe("links that name the product line", () => {
  it("names the line on a tracker link, after the plan and view", () => {
    expect(trackerHref(0, undefined, "LV")).toBe("/tracker?line=LV");
    expect(trackerHref(30, "weekly", "TR")).toBe("/tracker?view=weekly&plan=30&line=TR");
    expect(trackerHref(30, "weekly")).toBe("/tracker?view=weekly&plan=30");
  });

  it("names the line on a trace link when given, and leaves it out otherwise", () => {
    expect(traceHref({ mo: "SF01/MO/1", line: "LV" })).toBe("/trace?mo=SF01%2FMO%2F1&line=LV");
    expect(traceHref({ bom: "B 1", line: "TR" }, 30, "weekly")).toBe("/trace?bom=B+1&plan=30&view=weekly&line=TR");
    expect(traceHref({ mo: "SF01/MO/1" })).toBe("/trace?mo=SF01%2FMO%2F1");
  });
});

