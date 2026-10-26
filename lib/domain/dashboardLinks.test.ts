import { describe, it, expect } from "vitest";
import { productionHref, productionRedirectOf } from "./dashboardLinks";

describe("the plant dashboards' addresses", () => {
  it("writes the filters that have a value; a department names its line", () => {
    expect(productionHref()).toBe("/dashboards/production");
    expect(productionHref({ from: "2026-10-01", to: "", dept: "Welding", lvDept: "all" })).toBe("/dashboards/production?from=2026-10-01&dept=Welding");
    expect(productionHref({ lvDept: "WeldingLV", section: "lv" })).toBe("/dashboards/production?dept=WeldingLV");
    expect(productionHref({ section: "lv" })).toBe("/dashboards/production?scope=LV");
    expect(productionHref({ scope: "all", shift: "night", centre: "Fins" })).toBe("/dashboards/production?centre=Fins&shift=night");
    // each line's own department, both on All
    expect(productionHref({ dept: "Welding", lvDept: "PaintingLV" })).toBe("/dashboards/production?dept=Welding&lvDept=PaintingLV");
  });
});

describe("an old link to the floor's figures on the Planning page", () => {
  it("lands on the Production dashboard when it names a department, on its line", () => {
    expect(productionRedirectOf({ dept: "Welding", from: "2026-10-01" })).toBe("/dashboards/production?from=2026-10-01&dept=Welding");
    expect(productionRedirectOf({ dept: "PaintingLV", line: "LV" })).toBe("/dashboards/production?dept=PaintingLV");
    // a period alone is the panels' stage table's, on Planning itself
    expect(productionRedirectOf({ from: "2026-10-01", to: "2026-10-07" })).toBeNull();
    expect(productionRedirectOf({})).toBeNull();
  });
});
