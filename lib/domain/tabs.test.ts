import { describe, it, expect } from "vitest";
import { canSeePath, firstVisiblePath, parseHiddenTabs, serializeHiddenTabs, tabForPath, TABS } from "./tabs";

describe("tabs — which screens an account sees", () => {
  it("finds a path's screen, the home page only for /", () => {
    expect(tabForPath("/")?.id).toBe("dashboard");
    expect(tabForPath("/tracker")?.id).toBe("tracker");
    expect(tabForPath("/worklist/cut")?.id).toBe("worklist.cut");
    expect(tabForPath("/tank/ABC-1")?.id).toBe("barcode");
    expect(tabForPath("/import")?.id).toBe("orders");
    expect(tabForPath("/odoo?day=all")?.id).toBe("odoo");
    expect(tabForPath("/trace")).toBeNull();
    expect(tabForPath("/admin/users")).toBeNull();
  });
  it("sees each dashboard with the screen it reads, so nobody's access changes with the Dashboards tab", () => {
    expect(tabForPath("/dashboards/production")?.id).toBe("shifts");
    expect(tabForPath("/dashboards/material?days=30")?.id).toBe("analytics");
    expect(tabForPath("/dashboards/consumables")?.id).toBe("consumables");
    expect(tabForPath("/dashboards/odoo")?.id).toBe("odoo");
    expect(tabForPath("/analytics")?.id).toBe("analytics");
    const hidden = parseHiddenTabs("shifts,consumables");
    expect(canSeePath(hidden, "/dashboards/production")).toBe(false);
    expect(canSeePath(hidden, "/dashboards/consumables")).toBe(false);
    expect(canSeePath(hidden, "/dashboards/odoo")).toBe(true);
  });
  it("keeps what is not hidden, and every screen outside the catalog", () => {
    const hidden = parseHiddenTabs("odoo,dashboard,nonsense");
    expect([...hidden].sort()).toEqual(["dashboard", "odoo"]);
    expect(canSeePath(hidden, "/odoo")).toBe(false);
    expect(canSeePath(hidden, "/")).toBe(false);
    expect(canSeePath(hidden, "/tracker")).toBe(true);
    expect(canSeePath(hidden, "/admin/users")).toBe(true);
  });
  it("sends a hidden screen's visitor to the first one they see", () => {
    expect(firstVisiblePath(new Set())).toBe("/tracker");
    expect(firstVisiblePath(new Set(["tracker", "dashboard"]))).toBe("/material");
    expect(firstVisiblePath(new Set(TABS.map((t) => t.id)))).toBeNull();
    // the what-ifs have no screen: never a place to land, nor a path's screen
    expect(firstVisiblePath(new Set(TABS.filter((t) => t.id !== "simulate").map((t) => t.id)))).toBeNull();
    expect(tabForPath("/simulate")).toBeNull();
    expect(TABS.find((t) => t.id === "simulate")).toMatchObject({ paths: [] });
  });
  it("stores the ids sorted, unknown ones dropped", () => {
    expect(serializeHiddenTabs(["odoo", "chat", "odoo", "x"])).toBe("chat,odoo");
  });
});
