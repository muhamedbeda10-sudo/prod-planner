import { describe, it, expect } from "vitest";
import { dashHref, productionRedirectOf, resolveDashScope } from "./dashboardScope";

describe("the dashboards' line scope", () => {
  it("reads all, a line, or falls back to the line the screens are on", () => {
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
  it("always names the scope in an address, with the filters that have a value", () => {
    expect(dashHref("/dashboards/production", "TR")).toBe("/dashboards/production?line=TR");
    expect(dashHref("/dashboards/production", "all", { from: "2026-10-01", to: "", dept: null })).toBe("/dashboards/production?line=all&from=2026-10-01");
    expect(dashHref("/", "LV")).toBe("/?line=LV");
  });
});

describe("an old link to the floor's figures on the Planning page", () => {
  it("lands on the Production dashboard with its filters, unless it is the panels' own period", () => {
    expect(productionRedirectOf({ dept: "Welding", from: "2026-10-01" }, "TR")).toBe("/dashboards/production?from=2026-10-01&dept=Welding&line=TR");
    expect(productionRedirectOf({ from: "2026-10-01", to: "2026-10-07" }, "TR")).toBe("/dashboards/production?from=2026-10-01&to=2026-10-07&line=TR");
    expect(productionRedirectOf({ from: "2026-10-01", to: "2026-10-07", line: "all" }, "all")).toBe("/dashboards/production?from=2026-10-01&to=2026-10-07&line=all");
    expect(productionRedirectOf({ from: "2026-10-01", to: "2026-10-07" }, "LV")).toBeNull();
    expect(productionRedirectOf({ dept: "Welding", line: "lv" }, "LV")).toBe("/dashboards/production?dept=Welding&line=LV");
    expect(productionRedirectOf({}, "TR")).toBeNull();
  });
});
