import { describe, expect, it } from "vitest";
import { PERM_KEYS, deptPermKey, ledgerPermKey, linePermKey, parsePerms, shiftPermKey, trackerPermKey } from "./permissions";

describe("the panels' own keys", () => {
  it("are all registered, so the Users page offers them and parsePerms keeps them", () => {
    for (const k of ["lv.punching", "lv.bending", "lv.welding", "lv.painting", "lv.tracker.punch", "lv.tracker.bend", "lv.tracker.weld", "lv.tracker.paint", "lv.tracker.delivered", "lv.status", "lv.import", "lv.odoo", "lv.material"]) {
      expect(PERM_KEYS.has(k), k).toBe(true);
    }
    expect([...parsePerms("lv.punching, lv.status,nonsense")]).toEqual(["lv.punching", "lv.status"]);
  });

  it("open punching and bending — the panels' stages — and nothing on the transformers", () => {
    expect(deptPermKey("Punching")).toBe("lv.punching");
    expect(deptPermKey("Bending")).toBe("lv.bending");
    expect(deptPermKey("Cut")).toBe("cut.edit");
    expect(deptPermKey("Welding")).toBe("welding.edit");
  });

  it("govern a panel's ledger row whatever its department", () => {
    expect(ledgerPermKey("Welding", "USS")).toBe("lv.welding");
    expect(ledgerPermKey("Painting", "LSS")).toBe("lv.painting");
    expect(ledgerPermKey("Delivered", "USS")).toBe("lv.tracker.delivered");
    expect(ledgerPermKey("Welding", "TN")).toBe("welding.edit");
    expect(ledgerPermKey("Delivered", "TN")).toBe("tracker.delivered");
  });

  it("follow the line for closing, importing, Odoo and material", () => {
    expect(linePermKey("LV", "status")).toBe("lv.status");
    expect(linePermKey("LV", "import")).toBe("lv.import");
    expect(linePermKey("LV", "odoo")).toBe("lv.odoo");
    expect(linePermKey("LV", "material")).toBe("lv.material");
    expect(linePermKey("TR", "status")).toBe("tracker.status");
    expect(linePermKey("TR", "import")).toBe("plans.import");
    expect(linePermKey("TR", "odoo")).toBe("odoo.edit");
    expect(linePermKey("TR", "material")).toBe("material.edit");
  });

  it("leave the transformer keys as they were", () => {
    expect(trackerPermKey("ShotBlast")).toBe("tracker.shp");
    expect(shiftPermKey("ShotBlast")).toBe("shifts.shotblast");
  });
});
