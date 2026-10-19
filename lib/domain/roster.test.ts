import { describe, expect, it } from "vitest";
import { ROSTER_SECTIONS, parseRosterFilter, rosterDepts, rosterLineMatches } from "./roster";

describe("roster filter", () => {
  it("reads the URL: a line, a section, else everyone", () => {
    expect(parseRosterFilter("line:LV")).toBe("line:LV");
    expect(parseRosterFilter("Fins")).toBe("Fins");
    expect(parseRosterFilter("nonsense")).toBe("");
    // leak testing and quality keep no shift log, so they are not a roster filter
    expect(parseRosterFilter("LeakTest")).toBe("");
    expect(parseRosterFilter("Quality")).toBe("");
    expect(parseRosterFilter(undefined)).toBe("");
  });
  it("selects the departments the filter covers", () => {
    expect(rosterDepts("")).toHaveLength(8);
    expect(rosterDepts("line:LV")).toEqual(["Punching", "Bending", "WeldingLV", "PaintingLV"]);
    expect(rosterDepts("Fins")).toEqual(["Cut"]);
    expect(rosterDepts("ShotBlast")).toEqual(["ShotBlast"]);
  });
  it("offers only the sections whose department keeps a shift log", () => {
    const codes = ROSTER_SECTIONS.map((s) => s.code as string);
    expect(codes).toContain("Fins");
    expect(codes).toContain("PaintingLV");
    expect(codes).not.toContain("LeakTest");
    expect(codes).not.toContain("Quality");
  });
  it("matches a line by its department's line or its sections", () => {
    const l = { dept: "Cut" as const, sections: ["Fins", "BendingTX"] };
    expect(rosterLineMatches(l, "")).toBe(true);
    expect(rosterLineMatches(l, "line:TR")).toBe(true);
    expect(rosterLineMatches(l, "line:LV")).toBe(false);
    expect(rosterLineMatches(l, "Fins")).toBe(true);
    expect(rosterLineMatches(l, "LaserCutTX")).toBe(false);
  });
});
