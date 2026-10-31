import { describe, it, expect } from "vitest";
import { productionHref, productionRedirectOf } from "./dashboardLinks";

describe("the dashboard's floor addresses", () => {
  it("writes the filters that have a value; a department names its line", () => {
    expect(productionHref()).toBe("/");
    expect(productionHref({ from: "2026-10-01", to: "", dept: "Welding", lvDept: "all" })).toBe("/?from=2026-10-01&dept=Welding");
    expect(productionHref({ lvDept: "WeldingLV", section: "lv" })).toBe("/?dept=WeldingLV");
    expect(productionHref({ section: "lv" })).toBe("/?scope=lv");
    expect(productionHref({ scope: "TR" })).toBe("/?scope=tr");
    expect(productionHref({ scope: "all", shift: "night", centre: "Fins" })).toBe("/?centre=Fins&shift=night");
    // each line's own department, both on All
    expect(productionHref({ dept: "Welding", lvDept: "PaintingLV" })).toBe("/?dept=Welding&lvDept=PaintingLV");
  });
});

describe("an old link to the Production dashboard", () => {
  it("lands on the one dashboard with every choice it carried", () => {
    expect(productionRedirectOf({ dept: "Welding", from: "2026-10-01" })).toBe("/?dept=Welding&from=2026-10-01");
    expect(productionRedirectOf({ scope: "LV", shift: "night", focus: "earned" })).toBe("/?scope=LV&shift=night&focus=earned");
    // a repeated parameter is not one the page reads
    expect(productionRedirectOf({ dept: ["a", "b"], to: "" })).toBe("/");
    expect(productionRedirectOf({})).toBe("/");
  });
});
