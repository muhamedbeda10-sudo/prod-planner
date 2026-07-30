import { describe, it, expect } from "vitest";
import { KVA_TIERS, TIER_HOURS, TIER_ITEM_HOURS, FG_TIER } from "./standardTimes";
import { nearestTierIn, tierForOrder, stdHoursFor, itemHoursFor, requiredHoursForLines, type StdData } from "./stdEngine";
import { SHEET_ITEMS } from "./constants";

// the engine under the SEED data — exactly what a fresh database holds
const SEED: StdData = { tiers: TIER_HOURS, fgMap: FG_TIER };
const nearestTier = (kva: number) => nearestTierIn([...KVA_TIERS], kva)!;

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
    expect(tierForOrder(SEED, { fgCode: "FG-64020", kva: "112" })).toBe(200);
  });
  it("normalizes punctuation and case in the FG code", () => {
    expect(tierForOrder(SEED, { fgCode: "fg-10003" })).toBe(1500);
  });
  it("falls back through a trailing M-revision the sheet doesn't list", () => {
    expect(FG_TIER["FG10004M99"]).toBeUndefined();
    expect(tierForOrder(SEED, { fgCode: "FG-10004M99" })).toBe(1500); // base FG-10004
  });
  it("unknown FG falls back to the numeric KVA", () => {
    expect(tierForOrder(SEED, { fgCode: "FG-NOPE", kva: "1600" })).toBe(1500);
  });
  it("the ambiguous repair code was dropped from the map (two KVAs in the sheet)", () => {
    expect(FG_TIER["FGRPRXMR"]).toBeUndefined();
  });
  it("null when neither field says anything", () => {
    expect(tierForOrder(SEED, { fgCode: null, kva: null })).toBeNull();
    expect(tierForOrder(SEED, { kva: "-" })).toBeNull();
  });
});

describe("stdHoursFor", () => {
  it("splits an item's fab hours between Cut and Welding, finishing at ONE stage", () => {
    const tn = TIER_ITEM_HOURS[1500].TN;
    // the engine rebuilds from shares, the seed matrix is rounded to 4dp
    expect(stdHoursFor(SEED, "Cut", "TN", 1500)).toBeCloseTo(tn.cut, 3);
    expect(stdHoursFor(SEED, "Welding", "TN", 1500)).toBeCloseTo(tn.weld, 3);
    expect(stdHoursFor(SEED, "Painting", "TN", 1500)).toBeCloseTo(tn.finish, 3); // TN is painted
    expect(stdHoursFor(SEED, "ShotBlast", "TN", 1500)).toBe(0);
  });
  it("the paint-exempt core earns its finishing at Shot Blast, not Painting", () => {
    const cf = TIER_ITEM_HOURS[1500].CF;
    expect(stdHoursFor(SEED, "ShotBlast", "CF", 1500)).toBeCloseTo(cf.finish, 3);
    expect(stdHoursFor(SEED, "Painting", "CF", 1500)).toBe(0);
  });
  it("weighs 0 for AR/MB, Delivered, and unresolved orders", () => {
    expect(stdHoursFor(SEED, "Cut", "AR", 1500)).toBe(0);
    expect(stdHoursFor(SEED, "Delivered", "TN", 1500)).toBe(0);
    expect(stdHoursFor(SEED, "Cut", "TN", null)).toBe(0);
  });
  it("a full 1500 KVA tank earns 41.12 hours across the whole chain", () => {
    let total = 0;
    for (const it of SHEET_ITEMS) {
      for (const dept of ["Cut", "Welding", "Painting", "ShotBlast"]) {
        total += stdHoursFor(SEED, dept, it, 1500);
      }
    }
    expect(total).toBeCloseTo(41.12, 1);
  });
});

describe("the engine under ADMIN-EDITED data (not the seed)", () => {
  it("an edited class's item hours follow the new totals, shares preserved", () => {
    const edited: StdData = { tiers: { ...TIER_HOURS, 1500: { cut: 10, weld: 30, shb: 2, paint: 8 } }, fgMap: FG_TIER };
    const per = itemHoursFor(edited, 1500);
    const sum = (k: "cut" | "weld" | "finish") => Object.values(per).reduce((s, p) => s + p[k], 0);
    expect(sum("cut")).toBeCloseTo(10, 6);
    expect(sum("weld")).toBeCloseTo(30, 6);
    expect(sum("finish")).toBeCloseTo(10, 6); // shb + paint
  });
  it("a class the sheet never had borrows the nearest seed class's shares", () => {
    const withNew: StdData = { tiers: { ...TIER_HOURS, 5000: { cut: 16, weld: 40, shb: 2.5, paint: 9 } }, fgMap: FG_TIER };
    expect(tierForOrder(withNew, { kva: "5200" })).toBe(5000);
    const per = itemHoursFor(withNew, 5000);
    expect(Object.values(per).reduce((s, p) => s + p.weld, 0)).toBeCloseTo(40, 6);
  });
  it("an FG pointing at a DELETED class falls back to the numeric KVA", () => {
    const t = { ...TIER_HOURS } as Record<number, (typeof TIER_HOURS)[number]>;
    delete t[200];
    const data: StdData = { tiers: t, fgMap: FG_TIER };
    // FG-64020 maps to 200, which the admin removed → nearest to 112 among what remains
    expect(tierForOrder(data, { fgCode: "FG-64020", kva: "112" })).toBe(100);
  });
});

describe("requiredHoursForLines (the plan capacity check)", () => {
  const order1500 = { fgCode: "FG-10003", kva: null };
  it("sums per stage, sending each item's finishing to ITS stage", () => {
    const r = requiredHoursForLines(SEED, [
      { item: "TN", qty: 2, order: order1500 },
      { item: "CF", qty: 2, order: order1500 },
    ]);
    const per = itemHoursFor(SEED, 1500);
    expect(r.byStage.Cut).toBeCloseTo(2 * (per.TN.cut + per.CF.cut), 4);
    expect(r.byStage.Welding).toBeCloseTo(2 * (per.TN.weld + per.CF.weld), 4);
    expect(r.byStage.Painting).toBeCloseTo(2 * per.TN.finish, 4); // TN painted
    expect(r.byStage.ShotBlast).toBeCloseTo(2 * per.CF.finish, 4); // core → SHB
    expect(r.totalPcs).toBe(4);
    expect(r.uncoveredPcs).toBe(0);
  });
  it("counts unresolvable lines as uncovered instead of pricing them 0 silently", () => {
    const r = requiredHoursForLines(SEED, [
      { item: "TN", qty: 3, order: null },
      { item: "AR", qty: 5, order: order1500 }, // AR: no std times — outside coverage
    ]);
    expect(r.uncoveredPcs).toBe(3);
    expect(r.totalPcs).toBe(3);
    expect(r.byStage.Welding).toBe(0);
  });
});
