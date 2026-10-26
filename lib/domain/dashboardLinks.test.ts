import { describe, it, expect } from "vitest";
import { productionHref, productionLegacyRedirect, productionRedirectOf } from "./dashboardLinks";

describe("the plant dashboards' addresses", () => {
  it("writes the filters that have a value, each line's department in its own parameter, and the section to open at", () => {
    expect(productionHref()).toBe("/dashboards/production");
    expect(productionHref({ from: "2026-10-01", to: "", dept: "Welding", lvDept: "all" })).toBe("/dashboards/production?from=2026-10-01&dept=Welding");
    expect(productionHref({ lvDept: "WeldingLV", section: "lv" })).toBe("/dashboards/production?lvDept=WeldingLV#lv");
  });

  it("moves an older link's panels' department to its own parameter, once", () => {
    expect(productionLegacyRedirect({ line: "LV", dept: "WeldingLV", from: "2026-10-01" })).toBe("/dashboards/production?from=2026-10-01&lvDept=WeldingLV#lv");
    // the transformers' department, or none, stays where it is
    expect(productionLegacyRedirect({ dept: "Welding" })).toBeNull();
    expect(productionLegacyRedirect({})).toBeNull();
  });
});

describe("an old link to the floor's figures on the Planning page", () => {
  it("lands on the Production dashboard when it names a department, at the panels' section for theirs", () => {
    expect(productionRedirectOf({ dept: "Welding", from: "2026-10-01" })).toBe("/dashboards/production?from=2026-10-01&dept=Welding");
    expect(productionRedirectOf({ dept: "PaintingLV", line: "LV" })).toBe("/dashboards/production?lvDept=PaintingLV#lv");
    // a period alone is the panels' stage table's, on Planning itself
    expect(productionRedirectOf({ from: "2026-10-01", to: "2026-10-07" })).toBeNull();
    expect(productionRedirectOf({})).toBeNull();
  });
});
