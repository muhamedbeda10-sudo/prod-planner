import { describe, it, expect } from "vitest";
import { centreField, readCentreTimes } from "./centreTimes";

const classes = new Set([500, 1000]);

describe("readCentreTimes", () => {
  it("takes typed figures, clears empty cells, and skips what is not a cell", () => {
    const r = readCentreTimes([["c:1000:TN:Cutting", " 1.25 "], ["c:1000:TN:Bending", ""], ["note", "x"], ["c:1000:ZZ:Cutting", "3"]], classes);
    expect(r).toEqual({
      set: [{ kva: 1000, item: "TN", center: "Cutting", hoursPerPc: 1.25 }],
      clear: [{ kva: 1000, item: "TN", center: "Bending" }],
    });
  });

  it("never sets the core's painting, nor a Fabrication centre off the item's route", () => {
    expect(readCentreTimes([["c:500:CF:Painting", "4"], ["c:500:TC:Bending", "1"], ["c:500:TN:Fins", "0.5"]], classes)).toEqual({
      set: [{ kva: 500, item: "TN", center: "Fins", hoursPerPc: 0.5 }],
      clear: [],
    });
    expect(centreField(500, "TN", "Fins")).toBe("c:500:TN:Fins");
  });

  it("refuses a class that does not exist, a word, a negative and an absurd figure", () => {
    expect(readCentreTimes([["c:750:TN:Cutting", "1"]], classes)).toEqual({ error: expect.stringContaining("no 750 kVA class") });
    expect(readCentreTimes([["c:500:TN:Cutting", "abc"]], classes)).toEqual({ error: expect.stringContaining("is not a time") });
    expect(readCentreTimes([["c:500:TN:Cutting", "-1"]], classes)).toEqual({ error: expect.stringContaining("is not a time") });
    expect(readCentreTimes([["c:500:TN:Welding", "999"]], classes)).toEqual({ error: expect.stringContaining("check the figure") });
  });
});
