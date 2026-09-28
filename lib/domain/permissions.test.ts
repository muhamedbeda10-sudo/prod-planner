import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCESS_PERM_KEYS, PERMISSIONS, PERM_KEYS, deptPermKey, ledgerPermKey, linePermKey, parsePerms, shiftPermKey, trackerPermKey } from "./permissions";

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

describe("admins follow their ticks", () => {
  it("start ticked with every access right but no notification", () => {
    const notify = PERMISSIONS.filter((p) => p.notify).map((p) => p.key);
    expect(notify.sort()).toEqual(["odoo.alerts", "odoo.needMo"]);
    for (const k of notify) expect(ACCESS_PERM_KEYS).not.toContain(k);
    expect(ACCESS_PERM_KEYS.length + notify.length).toBe(PERM_KEYS.size);
  });
  it("were ticked by the migration with exactly the access rights of the day", () => {
    const sql = readFileSync("prisma/migrations/20260928160000_admins_follow_ticks/migration.sql", "utf8");
    const list = /SET "perms" = '([^']+)'/.exec(sql)?.[1].split(",") ?? [];
    // every right in the migration exists; a right added later is ticked by hand
    for (const k of list) expect(ACCESS_PERM_KEYS, k).toContain(k);
    expect(list).not.toContain("odoo.alerts");
    expect(list).not.toContain("odoo.needMo");
  });
});
