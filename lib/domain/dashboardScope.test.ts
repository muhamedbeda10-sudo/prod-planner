import { describe, it, expect } from "vitest";
import { dashHref, productionRedirectOf, resolveDashScope } from "./dashboardScope";

describe("the dashboards' line scope", () => {
  it("reads all, a line, or falls back to the toggle's line", () => {
    expect(resolveDashScope("all", "TR")).toBe("all");
    expect(resolveDashScope("ALL", "LV")).toBe("all");
    expect(resolveDashScope("lv", "TR")).toBe("LV");
    expect(resolveDashScope("TR", "LV")).toBe("TR");
    expect(resolveDashScope(undefined, "LV")).toBe("LV");
    expect(resolveDashScope("panels", "TR")).toBe("TR");
    expect(resolveDashScope(["LV", "TR"], "TR")).toBe("LV");
    expect(resolveDashScope(" lv ", "TR")).toBe("LV");
    expect(resolveDashScope("", "LV")).toBe("LV");
  });
  it("writes the scope into an address only when it is not the toggle's own, with the filters", () => {
    expect(dashHref("/dashboards/production", "TR", "TR")).toBe("/dashboards/production");
    expect(dashHref("/dashboards/production", "all", "TR", { from: "2026-10-01", to: "", dept: null })).toBe("/dashboards/production?line=all&from=2026-10-01");
    expect(dashHref("/", "LV", "TR")).toBe("/?line=LV");
  });
});

describe("an old link to the floor's figures on the Planning page", () => {
  it("lands on the Production dashboard with its filters, unless it is the panels' own period", () => {
    expect(productionRedirectOf({ dept: "Welding", from: "2026-10-01" }, "TR")).toBe("/dashboards/production?from=2026-10-01&dept=Welding");
    expect(productionRedirectOf({ from: "2026-10-01", to: "2026-10-07" }, "TR")).toBe("/dashboards/production?from=2026-10-01&to=2026-10-07");
    expect(productionRedirectOf({ from: "2026-10-01", to: "2026-10-07", line: "all" }, "all")).toBe("/dashboards/production?from=2026-10-01&to=2026-10-07&line=all");
    expect(productionRedirectOf({ from: "2026-10-01", to: "2026-10-07" }, "LV")).toBeNull();
    expect(productionRedirectOf({ dept: "Welding", line: "LV" }, "LV")).toBe("/dashboards/production?dept=Welding&line=LV");
    expect(productionRedirectOf({}, "TR")).toBeNull();
  });
});
