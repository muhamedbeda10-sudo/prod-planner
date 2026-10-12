import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCESS_PERM_KEYS, PERMISSIONS, PERM_KEYS, deptPermKey, ledgerPermKey, linePermKey, parsePerms, shiftPermKey, trackerPermKey } from "./permissions";
import { DELIVERED_STAGE, DEPTS, ITEMS, SHOTBLAST_STAGE } from "./constants";
import { LV_CHAIN, LV_PRODUCTS } from "./lv";

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

  it("govern a panel's ledger row (item PNL) at every stage, whatever its department", () => {
    // "PNL" written out, not LV_ITEM: it is what the panels' rows already in
    // the ledger carry, so this fails if the constant ever drifts from them
    expect(ledgerPermKey("Punching", "PNL")).toBe("lv.punching");
    expect(ledgerPermKey("Bending", "PNL")).toBe("lv.bending");
    expect(ledgerPermKey("Welding", "PNL")).toBe("lv.welding");
    expect(ledgerPermKey("Painting", "PNL")).toBe("lv.painting");
    expect(ledgerPermKey("Delivered", "PNL")).toBe("lv.tracker.delivered");
    // each a key the Users page can tick — one outside the catalog would
    // quietly make the row admin-only
    for (const d of LV_CHAIN) expect(PERM_KEYS.has(ledgerPermKey(d, "PNL")), d).toBe(true);
  });

  it("leave a transformer's row on its department's key — neither line opens the other's", () => {
    expect(ledgerPermKey("Cut", "CF")).toBe("cut.edit");
    expect(ledgerPermKey("Welding", "TN")).toBe("welding.edit");
    expect(ledgerPermKey("Painting", "TC")).toBe("painting.edit");
    expect(ledgerPermKey("ShotBlast", "CF")).toBe("tracker.shp");
    expect(ledgerPermKey("Delivered", "TN")).toBe("tracker.delivered");
    for (const d of [...DEPTS, SHOTBLAST_STAGE, DELIVERED_STAGE]) {
      for (const item of ITEMS) expect(ledgerPermKey(d, item), `${d} ${item}`).not.toMatch(/^lv\./);
    }
  });

  it("go by the ledger's panel item, not the panel type the plan names", () => {
    // USS / LSS is the order's type (MasterOrder.product) — no ledger row
    // carries it, so it opens nothing on the panels' keys
    for (const type of LV_PRODUCTS) expect(ledgerPermKey("Welding", type)).toBe("welding.edit");
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
