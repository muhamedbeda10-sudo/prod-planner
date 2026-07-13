import { describe, it, expect } from "vitest";
import { parseBalance, tokenizeRemark } from "./parseBalance";

describe("parseBalance — real remarks from Plan Orders", () => {
  it('"46 CF. 41 TN & TC BALANCE FROM WEEK-24-25"', () => {
    const r = parseBalance("46 CF. 41 TN & TC BALANCE FROM WEEK-24-25", 100);
    expect(r.hasBalance).toBe(true);
    expect(r.balance).toEqual({ CF: 46, TC: 41, TN: 41, CB: 0 });
  });

  it('"3 CF , 1-TN & TC BALANCE FROM WEEK-26"', () => {
    const r = parseBalance("3 CF , 1-TN & TC BALANCE FROM WEEK-26", 100);
    expect(r.hasBalance).toBe(true);
    expect(r.balance).toEqual({ CF: 3, TC: 1, TN: 1, CB: 0 });
  });

  it('"2 TN TC  BALANCE  FROM WEEK-21-22" (real seed row for 64016E11M11)', () => {
    const r = parseBalance("2 TN TC  BALANCE  FROM WEEK-21-22", 4);
    expect(r.hasBalance).toBe(true);
    // CF & CB unmentioned -> 0; matches Planner Balance CF=0,TC=2,TN=2,CB=0
    expect(r.balance).toEqual({ CF: 0, TC: 2, TN: 2, CB: 0 });
  });

  it('"6 TN & TC BALANCE  FROM WEEK-21-22"', () => {
    const r = parseBalance("6 TN & TC BALANCE  FROM WEEK-21-22", 6);
    expect(r.hasBalance).toBe(true);
    expect(r.balance).toEqual({ CF: 0, TC: 6, TN: 6, CB: 0 });
  });

  it('"FOIL SHORTAGE" — no BALANCE keyword', () => {
    expect(parseBalance("FOIL SHORTAGE", 10).hasBalance).toBe(false);
  });

  it('"URGENT" — no BALANCE keyword', () => {
    expect(parseBalance("URGENT", 10).hasBalance).toBe(false);
  });

  it("item with no preceding number takes the full requiredQty (default)", () => {
    const r = parseBalance("CF BALANCE", 7);
    expect(r.hasBalance).toBe(true);
    expect(r.balance).toEqual({ CF: 7, TC: 0, TN: 0, CB: 0 });
  });

  it("RC is auto-corrected to TC", () => {
    const r = parseBalance("5 RC BALANCE", 10);
    expect(r.balance).toEqual({ CF: 0, TC: 5, TN: 0, CB: 0 });
  });

  it("BALANCE present but no items mentioned -> not a valid balance", () => {
    expect(parseBalance("BALANCE FROM WEEK-26", 10).hasBalance).toBe(false);
  });
});

describe("tokenizeRemark — bidirectional digit/letter split", () => {
  it("splits letter->digit and digit->letter (e.g. 1-TN, WEEK24)", () => {
    expect(tokenizeRemark("1-TN")).toEqual(["1", "TN"]);
    expect(tokenizeRemark("WEEK24")).toEqual(["WEEK", "24"]);
    expect(tokenizeRemark("46CF")).toEqual(["46", "CF"]);
  });
});
