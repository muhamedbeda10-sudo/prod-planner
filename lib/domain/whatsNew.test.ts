import { describe, it, expect } from "vitest";
import { WHATS_NEW, unseenCount } from "./whatsNew";

describe("whatsNew", () => {
  it("ids are unique and dates run newest first", () => {
    expect(new Set(WHATS_NEW.map((e) => e.id)).size).toBe(WHATS_NEW.length);
    const dates = WHATS_NEW.map((e) => e.dateISO);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
  it("counts what is newer than the last one seen", () => {
    const e = [{ id: "c" }, { id: "b" }, { id: "a" }].map((x) => ({ ...x, dateISO: "", title: "", where: "", body: "" }));
    expect(unseenCount("c", e)).toBe(0);
    expect(unseenCount("a", e)).toBe(2);
    expect(unseenCount(null, e)).toBe(3);
    expect(unseenCount("gone", e)).toBe(3);
  });
});
