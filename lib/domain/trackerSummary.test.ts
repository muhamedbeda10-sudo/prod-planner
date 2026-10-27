import { describe, it, expect } from "vitest";
import { filterMasterTracker, openFirst } from "./trackerSummary";
import { TRANSFORMERS } from "@/evals/planning/fixtures";

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

describe("filterMasterTracker status", () => {
  const mos = (status?: string) => filterMasterTracker(TRANSFORMERS, { status }).map((r) => r.mo);
  it("reads open orders when no status is picked, as the screen opens", () => {
    expect(mos()).toEqual(["MO-A", "MO-C", "MO-E"]);
    expect(mos("open")).toEqual(mos());
  });
  it("reads every order on all, the closed ones on closed, held ones on hold", () => {
    expect(mos("all")).toEqual(["MO-A", "MO-B", "MO-C", "MO-E"]);
    expect(mos("closed")).toEqual(["MO-B"]);
    expect(mos("hold")).toEqual(["MO-C"]);
  });
});
