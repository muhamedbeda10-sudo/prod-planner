import { describe, it, expect } from "vitest";
import { openFirst } from "./trackerSummary";

describe("openFirst", () => {
  const sheet = [{ id: 1, status: "open" }, { id: 2, status: "closed" }, { id: 3, status: "open" }, { id: 4, status: "closed" }];
  it("sends the open orders and counts the closed ones", () => {
    expect(openFirst(sheet, false)).toEqual({ rows: [sheet[0], sheet[2]], hasClosed: false, closedTotal: 2 });
  });
  it("sends every order, in its order, when the closed ones are asked for", () => {
    expect(openFirst(sheet, true)).toEqual({ rows: sheet, hasClosed: true, closedTotal: 2 });
  });
  it("handles an empty sheet", () => {
    expect(openFirst([], false)).toEqual({ rows: [], hasClosed: false, closedTotal: 0 });
  });
});
