import { describe, expect, it } from "vitest";
import { cell, executionMode, outcomeNote, sameSnapshot, stableJson } from "./aiActions";

describe("executionMode", () => {
  it("runs unasked only a low-risk change for someone who opted in", () => {
    expect(executionMode({ risk: "low", noconfirm: true })).toBe("auto");
    expect(executionMode({ risk: "low", noconfirm: false })).toBe("ask");
    expect(executionMode({ risk: "high", noconfirm: true })).toBe("ask");
    expect(executionMode({ risk: "destructive", noconfirm: true })).toBe("ask");
  });
});

describe("snapshots", () => {
  it("compare equal however the objects were built", () => {
    expect(sameSnapshot({ a: 1, b: { c: [1, 2], d: null } }, { b: { d: null, c: [1, 2] }, a: 1 })).toBe(true);
    expect(stableJson({ b: 2, a: undefined })).toBe('{"a":null,"b":2}');
  });
  it("tell a changed value or order of a list apart", () => {
    expect(sameSnapshot({ qty: 40 }, { qty: 36 })).toBe(false);
    expect(sameSnapshot([1, 2], [2, 1])).toBe(false);
  });
  it("read a date as its ISO text", () => {
    expect(sameSnapshot({ at: new Date("2026-10-12T00:00:00Z") }, { at: "2026-10-12T00:00:00.000Z" })).toBe(true);
  });
});

describe("cell", () => {
  it("writes a value the way the card shows it", () => {
    expect(cell(null)).toBe("—");
    expect(cell("")).toBe("—");
    expect(cell(true)).toBe("yes");
    expect(cell(2 / 3)).toBe("0.667");
    expect(cell(["TC", "TN"])).toBe("TC, TN");
    expect(cell([])).toBe("—");
    expect(cell(new Date("2026-10-12T00:00:00Z"))).toBe("2026-10-12");
  });
});

describe("outcomeNote", () => {
  it("tells the assistant what became of a change in one line", () => {
    expect(outcomeNote({ id: 4, title: "Hold PF01/MO/7", status: "executed", result: "Held.", error: null })).toBe('Change #4 "Hold PF01/MO/7" was approved and done: Held.');
    expect(outcomeNote({ id: 4, title: "X", status: "rejected", result: null, error: null })).toContain("rejected");
    expect(outcomeNote({ id: 4, title: "X", status: "failed", result: null, error: "No permission" })).toContain("refused it: No permission");
    expect(outcomeNote({ id: 4, title: "X", status: "stale", result: null, error: null })).toContain("data changed");
  });
});
