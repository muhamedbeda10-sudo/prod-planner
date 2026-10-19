import { describe, it, expect } from "vitest";
import { readBase, shownStageTotal, staleTotalError } from "./trackerEdit";

describe("shownStageTotal", () => {
  it("caps the ledger total at the order's quantity", () => {
    expect(shownStageTotal(12, 10)).toBe(10);
    expect(shownStageTotal(7, 10)).toBe(7);
  });

  it("shows the ledger as it is when the order has no quantity", () => {
    expect(shownStageTotal(12, 0)).toBe(12);
    expect(shownStageTotal(-2, 0)).toBe(-2);
  });
});

describe("readBase", () => {
  it("reads a whole number, and nothing as no base", () => {
    expect(readBase("10")).toBe(10);
    expect(readBase("0")).toBe(0);
    expect(readBase(null)).toBeNull();
    expect(readBase("  ")).toBeNull();
    expect(readBase("1.5")).toBeNull();
  });
});

describe("staleTotalError", () => {
  it("lets a total typed from the current figure through", () => {
    expect(staleTotalError(10, 10)).toBeNull();
    expect(staleTotalError(null, 14)).toBeNull();
  });

  it("refuses a total typed from a page the ledger has moved on from", () => {
    // the page showed 10; welding recorded 4 more since
    expect(staleTotalError(10, 14)).toMatch(/now 14, not the 10 on your screen/);
  });
});
