import { describe, expect, it } from "vitest";
import { TONES, toneAt, toneFor } from "./tones";

describe("toneAt", () => {
  it("walks the eight tones in turn and starts over", () => {
    expect(toneAt(0)).toBe("tone-1");
    expect(toneAt(7)).toBe("tone-8");
    expect(toneAt(8)).toBe("tone-1");
    expect(toneAt(10)).toBe("tone-3");
  });
  it("never gives two neighbours the same tone", () => {
    for (let i = 0; i < 30; i++) expect(toneAt(i)).not.toBe(toneAt(i + 1));
  });
  it("reads a negative, fractional or missing index as a tone all the same", () => {
    expect(toneAt(-1)).toBe("tone-8");
    expect(toneAt(2.7)).toBe("tone-3");
    expect(toneAt(Number.NaN)).toBe("tone-1");
  });
});

describe("toneFor", () => {
  it("gives a name the same tone every time", () => {
    expect(toneFor("Monthly limits")).toBe(toneFor("Monthly limits"));
  });
  it("stays within the eight tones, the empty name included", () => {
    const seen = new Set(["", "a", "Plan", "Who may use it", "x".repeat(500)].map(toneFor));
    for (const t of seen) expect(t).toMatch(new RegExp(`^tone-[1-${TONES}]$`));
  });
  it("spreads different names over several tones", () => {
    const names = ["Planning", "Production", "Material", "Consumables", "ODOO", "Shifts", "Tracker", "Barcodes", "Users", "Settings"];
    expect(new Set(names.map(toneFor)).size).toBeGreaterThanOrEqual(5);
  });
});
