import { describe, it, expect } from "vitest";
import {
  KVA_TIERS, TIER_HOURS, TIER_ITEM_HOURS, FG_TIER,
  nearestTier, tierForOrder, stdHoursFor,
} from "./standardTimes";
import { SHEET_ITEMS } from "./constants";

describe("generated data reconciles with the sheet", () => {
  it("per-item hours sum back to the tier's stage totals (every tier)", () => {
    for (const tier of KVA_TIERS) {
      const t = TIER_HOURS[tier];
      const items = Object.values(TIER_ITEM_HOURS[tier]);
      const sum = (k: "cut" | "weld" | "finish") => items.reduce((s, p) => s + p[k], 0);
      expect(sum("cut")).toBeCloseTo(t.cut, 1);
      expect(sum("weld")).toBeCloseTo(t.weld, 1);
      expect(sum("finish")).toBeCloseTo(t.shb + t.paint, 1);
    }
  });

  it("spot values straight off the sheet", () => {
    expect(TIER_HOURS[1500].weld).toBe(23); // SF-LV TX Welding @ 1500
    expect(TIER_HOURS[100].paint).toBe(5.26); // SF-TX Paint Line @ 100
    // total per tank @ 1500 = 41.12 (the product table's TOT column)
    const t = TIER_HOURS[1500];
    expect(t.cut + t.weld + t.shb + t.paint).toBeCloseTo(41.12, 2);
  });

  it("covers the four sheet components and only those", () => {
    for (const tier of KVA_TIERS) {
      expect(Object.keys(TIER_ITEM_HOURS[tier]).sort()).toEqual([...SHEET_ITEMS].sort());
    }
  });
});

describe("nearestTier", () => {
  it("exact classes map to themselves", () => {
    for (const t of KVA_TIERS) expect(nearestTier(t)).toBe(t);
  });
  it("in-between sizes go to the nearest class, ties DOWN", () => {
    expect(nearestTier(630)).toBe(500); // 130 vs 370
    expect(nearestTier(1600)).toBe(1500);
    expect(nearestTier(3150)).toBe(3000);
    expect(nearestTier(750)).toBe(500); // tie 250/250 → down
    expect(nearestTier(6000)).toBe(4000); // above the top class
    expect(nearestTier(50)).toBe(100); // below the bottom class
  });
});

describe("tierForOrder", () => {
  it("the sheet's FG map wins over the numeric KVA", () => {
    // FG-64020 is a 112 KVA unit the sheet FILES UNDER 200 — nearestTier(112)
    // would say 100, so the FG map must take precedence
    expect(FG_TIER["FG64020"]).toBe(200);
    expect(tierForOrder({ fgCode: "FG-64020", kva: "112" })).toBe(200);
  });
  it("normalizes punctuation and case in the FG code", () => {
    expect(tierForOrder({ fgCode: "fg-10003" })).toBe(1500);
  });
  it("falls back through a trailing M-revision the sheet doesn't list", () => {
    expect(FG_TIER["FG10004M99"]).toBeUndefined();
    expect(tierForOrder({ fgCode: "FG-10004M99" })).toBe(1500); // base FG-10004
  });
  it("unknown FG falls back to the numeric KVA", () => {
    expect(tierForOrder({ fgCode: "FG-NOPE", kva: "1600" })).toBe(1500);
  });
  it("the ambiguous repair code was dropped from the map (two KVAs in the sheet)", () => {
    expect(FG_TIER["FGRPRXMR"]).toBeUndefined();
  });
  it("null when neither field says anything", () => {
    expect(tierForOrder({ fgCode: null, kva: null })).toBeNull();
    expect(tierForOrder({ kva: "-" })).toBeNull();
  });
});

describe("stdHoursFor", () => {
  it("splits an item's fab hours between Cut and Welding, finishing at ONE stage", () => {
    const tn = TIER_ITEM_HOURS[1500].TN;
    expect(stdHoursFor("Cut", "TN", 1500)).toBe(tn.cut);
    expect(stdHoursFor("Welding", "TN", 1500)).toBe(tn.weld);
    expect(stdHoursFor("Painting", "TN", 1500)).toBe(tn.finish); // TN is painted
    expect(stdHoursFor("ShotBlast", "TN", 1500)).toBe(0);
  });
  it("the paint-exempt core earns its finishing at Shot Blast, not Painting", () => {
    const cf = TIER_ITEM_HOURS[1500].CF;
    expect(stdHoursFor("ShotBlast", "CF", 1500)).toBe(cf.finish);
    expect(stdHoursFor("Painting", "CF", 1500)).toBe(0);
  });
  it("weighs 0 for AR/MB, Delivered, and unresolved orders", () => {
    expect(stdHoursFor("Cut", "AR", 1500)).toBe(0);
    expect(stdHoursFor("Delivered", "TN", 1500)).toBe(0);
    expect(stdHoursFor("Cut", "TN", null)).toBe(0);
  });
  it("a full 1500 KVA tank earns 41.12 hours across the whole chain", () => {
    let total = 0;
    for (const it of SHEET_ITEMS) {
      for (const dept of ["Cut", "Welding", "Painting", "ShotBlast"]) {
        total += stdHoursFor(dept, it, 1500);
      }
    }
    expect(total).toBeCloseTo(41.12, 1);
  });
});
