import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCESS_PERM_KEYS, AI_PERM_GROUPS, AI_PERM_KEYS, PERMISSIONS, PERM_ALERTS, PERM_KEYS, PERM_OTHER, PERM_TABLES, bayPermKeys, deptPermKey, ledgerPermKey, linePermKey, machineLinePermKey, mayScheduleLine, parsePerms, serializePerms, shiftPermKey, trackerPermKey, withAiPerms, withoutAiChange } from "./permissions";
import { DELIVERED_STAGE, DEPTS, ITEMS, SHOTBLAST_STAGE } from "./constants";
import { LV_CHAIN, LV_PRODUCTS } from "./lv";
import { MANUAL_ITEM } from "./manualJob";

describe("the panels' own keys", () => {
  it("are all registered, so the Users page offers them and parsePerms keeps them", () => {
    for (const k of ["lv.punching", "lv.bending", "lv.welding", "lv.painting", "lv.tracker.delivered", "lv.status", "lv.import", "lv.odoo", "lv.material", "shifts.lv"]) {
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

  it("schedule a panel on the shared machines by the stage the bay works, never by the bay's key", () => {
    expect(machineLinePermKey("Cut", "PNL")).toBe("lv.punching"); // the punches punch it
    expect(machineLinePermKey("Welding", "PNL")).toBe("lv.welding");
    expect(machineLinePermKey("Painting", "PNL")).toBe("lv.painting");
    expect(machineLinePermKey("ShotBlast", "PNL")).toBeNull(); // takes no panels: no one's
    // a transformer part, and the bay's own jobs, stay the bay's
    expect(machineLinePermKey("Cut", "CF")).toBe("cut.edit");
    expect(machineLinePermKey("Welding", "TN")).toBe("welding.edit");
    expect(machineLinePermKey("Painting", "TC")).toBe("painting.edit");
    expect(machineLinePermKey("ShotBlast", "CF")).toBe("tracker.shp");
    expect(machineLinePermKey("Cut", MANUAL_ITEM)).toBe("cut.edit");
  });

  it("give each bay one key per line, every one of them tickable", () => {
    expect(bayPermKeys("Cut")).toEqual({ tr: "cut.edit", lv: "lv.punching" });
    expect(bayPermKeys("Welding")).toEqual({ tr: "welding.edit", lv: "lv.welding" });
    expect(bayPermKeys("Painting")).toEqual({ tr: "painting.edit", lv: "lv.painting" });
    expect(bayPermKeys("ShotBlast")).toEqual({ tr: "tracker.shp", lv: null });
    for (const bay of ["Cut", "Welding", "Painting", "ShotBlast"]) {
      for (const key of Object.values(bayPermKeys(bay))) if (key) expect(PERM_KEYS.has(key), key).toBe(true);
    }
  });

  it("let one line's keys schedule that line's work and none of the other's", () => {
    const transformers = { tr: true, lv: false };
    const panels = { tr: false, lv: true };
    expect(mayScheduleLine(transformers, "CF")).toBe(true);
    expect(mayScheduleLine(transformers, MANUAL_ITEM)).toBe(true);
    expect(mayScheduleLine(transformers, "PNL")).toBe(false);
    expect(mayScheduleLine(panels, "PNL")).toBe(true);
    expect(mayScheduleLine(panels, "CF")).toBe(false);
    expect(mayScheduleLine(panels, MANUAL_ITEM)).toBe(false);
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
  it("start ticked with every access right but no notification and no opt-in choice", () => {
    const notify = PERMISSIONS.filter((p) => p.notify).map((p) => p.key);
    const optIn = PERMISSIONS.filter((p) => p.optIn).map((p) => p.key);
    expect(notify.sort()).toEqual(["ai.suggestions", "odoo.alerts", "odoo.needMo"]);
    expect(optIn).toEqual(["ai.act.noconfirm"]);
    for (const k of [...notify, ...optIn]) expect(ACCESS_PERM_KEYS).not.toContain(k);
    expect(ACCESS_PERM_KEYS.length + notify.length + optIn.length).toBe(PERM_KEYS.size);
  });
  it("were ticked by the migration with exactly the access rights of the day", () => {
    const sql = readFileSync("prisma/migrations/20260928160000_admins_follow_ticks/migration.sql", "utf8");
    const list = /SET "perms" = '([^']+)'/.exec(sql)?.[1].split(",") ?? [];
    // every right in the migration exists, or lives on in the key it was
    // merged into; a right added later is ticked by hand
    for (const k of list) for (const now of parsePerms(k)) expect(ACCESS_PERM_KEYS, k).toContain(now);
    expect(list).not.toContain("odoo.alerts");
    expect(list).not.toContain("odoo.needMo");
  });
});

describe("the assistant's keys", () => {
  it("are registered, one per area, plus deletions, automations and the two personal choices", () => {
    for (const k of ["ai.act.tracker", "ai.act.machines", "ai.act.simulator", "ai.act.data", "ai.act.delete", "ai.automations", "ai.automations.act", "ai.act.noconfirm", "ai.suggestions", "simulator.edit"]) {
      expect(PERM_KEYS.has(k), k).toBe(true);
    }
  });
  it("hand the owner every right but never 'small changes without asking' — that one is ticked by hand", () => {
    expect(ACCESS_PERM_KEYS).toContain("ai.act.delete");
    expect(ACCESS_PERM_KEYS).not.toContain("ai.act.noconfirm");
    expect(ACCESS_PERM_KEYS).not.toContain("ai.suggestions");
  });
});

describe("one key per department", () => {
  it("records the worklist and types the tracker column alike", () => {
    for (const d of ["Cut", "Welding", "Painting", "ShotBlast", "Delivered"]) expect(trackerPermKey(d), d).toBe(ledgerPermKey(d, "CF"));
    for (const d of LV_CHAIN) expect(PERM_KEYS.has(ledgerPermKey(d, "PNL")), d).toBe(true);
  });

  it("gives whoever held either of the old two keys the merged one", () => {
    expect([...parsePerms("tracker.cut")]).toEqual(["cut.edit"]);
    expect([...parsePerms("tracker.weld,tracker.paint")]).toEqual(["welding.edit", "painting.edit"]);
    expect([...parsePerms("lv.tracker.punch,lv.tracker.bend,lv.tracker.weld,lv.tracker.paint")]).toEqual(["lv.punching", "lv.bending", "lv.welding", "lv.painting"]);
    // saved again, only the merged keys remain
    expect(serializePerms(parsePerms("tracker.cut,cut.edit,lv.tracker.delivered"))).toBe("cut.edit,lv.tracker.delivered");
    for (const old of ["tracker.cut", "tracker.weld", "tracker.paint", "lv.tracker.punch", "lv.tracker.bend", "lv.tracker.weld", "lv.tracker.paint"]) expect(PERM_KEYS.has(old), old).toBe(false);
  });
});

describe("the Users page's layout", () => {
  it("shows every key but the assistant's exactly once", () => {
    const shown = [...PERM_TABLES.flatMap((t) => t.rows.flatMap((r) => r.cells.filter((c): c is string => c !== null))), ...PERM_OTHER, ...PERM_ALERTS];
    expect(new Set(shown).size).toBe(shown.length);
    expect(new Set([...shown, ...AI_PERM_KEYS])).toEqual(PERM_KEYS);
    for (const k of AI_PERM_KEYS) expect(shown).not.toContain(k);
    for (const t of PERM_TABLES) for (const r of t.rows) expect(r.cells.length, `${t.title} ${r.label}`).toBe(t.columns.length);
  });

  it("has every key once in the catalogue", () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("the assistant's keys and the rest", () => {
  it("are all grouped on AI assistant settings, once each", () => {
    const grouped = AI_PERM_GROUPS.flatMap((g) => g.keys);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(grouped.sort()).toEqual([...AI_PERM_KEYS].sort());
  });

  it("are written each by its own page, never the other's", () => {
    const stored = "cut.edit,tracker.status,ai.act.tracker,ai.automations";
    // AI assistant settings: only the assistant's keys change
    expect(withAiPerms(stored, ["ai.act.data", "cut.edit"])).toBe("cut.edit,tracker.status,ai.act.data");
    expect(withAiPerms(stored, [])).toBe("cut.edit,tracker.status");
    // Users & Permissions: everything but the assistant's
    expect(withoutAiChange(stored, ["welding.edit", "ai.act.delete"])).toBe("welding.edit,ai.act.tracker,ai.automations");
    expect(withoutAiChange(stored, [])).toBe("ai.act.tracker,ai.automations");
  });
});
