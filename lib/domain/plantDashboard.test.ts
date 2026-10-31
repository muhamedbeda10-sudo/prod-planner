import { describe, it, expect } from "vitest";
import { dashboardActions, planCentreOf, plantDashboardOf } from "./plantDashboard";
import type { CockpitAction } from "./kpis";

const TODAY = "2026-10-31";

describe("the dashboard's one address", () => {
  it("shows both lines and the floor's default period with nothing chosen", () => {
    const { f, req } = plantDashboardOf({}, TODAY);
    expect(f.scope).toBe("all");
    expect(req.scope).toBe("all");
    expect(f.centre).toBeNull();
    expect(f.lvDept).toBeNull();
    expect(req.isDefault).toBe(true);
  });

  it("reads the line switch either case, the plan and the floor alike", () => {
    for (const scope of ["tr", "TR"]) {
      const { f, req } = plantDashboardOf({ scope }, TODAY);
      expect([f.scope, req.scope]).toEqual(["tr", "TR"]);
    }
    const lv = plantDashboardOf({ scope: "lv" }, TODAY);
    expect([lv.f.scope, lv.req.scope]).toEqual(["lv", "LV"]);
    expect(plantDashboardOf({ scope: "nonsense" }, TODAY).f.scope).toBe("all");
  });

  it("lets a department name its line on both halves, and narrows the plan to its centre", () => {
    const weld = plantDashboardOf({ dept: "Welding" }, TODAY);
    expect(weld.req.scope).toBe("TR");
    expect(weld.f.scope).toBe("tr");
    expect(weld.f.centre).toBe("Welding");

    const lv = plantDashboardOf({ dept: "PaintingLV" }, TODAY);
    expect([lv.f.scope, lv.req.scope, lv.f.lvDept]).toEqual(["lv", "LV", "PaintingLV"]);

    // Fabrication as a whole is three centres: the plan stays whole, a centre narrows it
    const fab = plantDashboardOf({ dept: "Fabrication" }, TODAY);
    expect([fab.f.scope, fab.f.centre]).toEqual(["tr", null]);
    const fins = plantDashboardOf({ dept: "Fabrication", centre: "Fins" }, TODAY);
    expect([fins.f.centre, fins.req.centre, fins.req.trDept]).toEqual(["Fins", "Fins", "Fabrication"]);
  });

  it("keeps an older Planning address's centre and panels' department", () => {
    const c = plantDashboardOf({ centre: "Painting", plan: "42", item: "TN" }, TODAY);
    expect([c.f.scope, c.f.centre, c.f.plan, c.f.item]).toEqual(["tr", "Painting", 42, "TN"]);
    const l = plantDashboardOf({ lvDept: "Bending", family: "mb" }, TODAY);
    expect([l.f.scope, l.f.lvDept, l.f.family]).toEqual(["lv", "Bending", "MB"]);
  });

  it("reads the floor's period from the same address", () => {
    const { f, req } = plantDashboardOf({ from: "2026-10-01", to: "2026-10-25", shift: "night" }, TODAY);
    expect([req.fromISO, req.toISO, req.shift]).toEqual(["2026-10-01", "2026-10-25", "night"]);
    expect([f.from, f.to]).toEqual(["2026-10-01", "2026-10-25"]);
  });
});

describe("the plan's centre for the floor's choice", () => {
  it("is the centre named, else a department that is one centre", () => {
    expect(planCentreOf({ centre: "Bending", trDept: "Fabrication" })).toBe("Bending");
    expect(planCentreOf({ centre: null, trDept: "ShotBlast" })).toBe("ShotBlast");
    expect(planCentreOf({ centre: null, trDept: "Fabrication" })).toBeNull();
    expect(planCentreOf({ centre: null, trDept: "all" })).toBeNull();
  });
});

describe("the bar's one list of decisions", () => {
  const a = (tone: CockpitAction["tone"], text: string, line: "TR" | "LV", floor = false) => ({ tone, text, href: "/", line, ...(floor ? { floor: true as const } : {}) });

  it("puts the worst first, keeping each list's own order within a tone", () => {
    const plan = [a("warn", "plan warn", "TR"), a("bad", "plan bad", "TR")];
    const floor = [a("bad", "floor bad", "LV"), a("info", "floor info", "TR")];
    expect(dashboardActions(plan, floor).map((x) => x.text)).toEqual(["plan bad", "floor bad", "plan warn", "floor info"]);
  });

  it("leaves the plan's own floor warnings out when the floor's figures are on the page", () => {
    const plan = [a("warn", "Welding worked at 60%", "TR", true), a("bad", "short of people", "TR", true), a("info", "today not recorded", "TR", true)];
    const floor = [a("warn", "Welding worked at 61% — ask why", "TR", true)];
    expect(dashboardActions(plan, floor).map((x) => x.text)).toEqual(["short of people", "Welding worked at 61% — ask why", "today not recorded"]);
    // without them, the plan keeps every one
    expect(dashboardActions(plan, null)).toHaveLength(3);
  });

  it("says a sentence once, and never more than the cap", () => {
    const same = a("bad", "same", "TR");
    expect(dashboardActions([same], [same])).toHaveLength(1);
    expect(dashboardActions([same], [a("bad", "same", "LV")])).toHaveLength(2);
    const many = Array.from({ length: 15 }, (_, i) => a("info", `n${i}`, "TR"));
    expect(dashboardActions(many, [], 10)).toHaveLength(10);
  });
});
