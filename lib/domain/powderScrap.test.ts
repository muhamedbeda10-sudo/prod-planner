import { describe, expect, it } from "vitest";
import {
  buildPowderReport, describeScrap, figures, isKgUnit, isPowderItem, parseScrapSnapshot, powderSpan, readScrapForm, sameScrap, scrapChanges,
  type PowderWithdrawal, type ScrapEntry,
} from "./powderScrap";

const form = (f: Record<string, string>) => (n: string) => f[n] ?? null;
const valid = { day: "2026-09-28", department: "PaintingTX", kg: "12.5", notes: "" };
const TODAY = "2026-09-29";
const EARLIEST = "2025-09-28";

describe("the powder items and units", () => {
  it("finds powder by name, in any case", () => {
    expect(isPowderItem("Powder RAL 7035")).toBe(true);
    expect(isPowderItem("epoxy POWDER grey")).toBe(true);
    expect(isPowderItem("Paint thinner")).toBe(false);
  });

  it("takes kilos, and a typed item's missing unit as kilos", () => {
    expect(isKgUnit("KG")).toBe(true);
    expect(isKgUnit("kgs")).toBe(true);
    expect(isKgUnit("Kg.")).toBe(true);
    expect(isKgUnit(null)).toBe(true);
    expect(isKgUnit("BOX")).toBe(false);
    expect(isKgUnit("PC")).toBe(false);
  });
});

describe("the scrap form", () => {
  it("reads a weighing", () => {
    expect(readScrapForm(form({ ...valid, notes: " filter  change " }), TODAY, EARLIEST).fields).toEqual({ dayISO: "2026-09-28", department: "PaintingTX", kg: 12.5, notes: "filter change" });
    expect(readScrapForm(form(valid), TODAY, EARLIEST).fields?.notes).toBeNull();
  });

  it("refuses a bad day, a future one and one too far back", () => {
    expect(readScrapForm(form({ ...valid, day: "" }), TODAY, EARLIEST).error).toMatch(/Pick the day/);
    expect(readScrapForm(form({ ...valid, day: "2026-02-30" }), TODAY, EARLIEST).error).toMatch(/Pick the day/);
    expect(readScrapForm(form({ ...valid, day: "2026-09-30" }), TODAY, EARLIEST).error).toMatch(/future/);
    expect(readScrapForm(form({ ...valid, day: "2025-09-27" }), TODAY, EARLIEST).error).toMatch(/year back/);
  });

  it("takes only the painting sections", () => {
    expect(readScrapForm(form({ ...valid, department: "PaintingLV" }), TODAY, EARLIEST).fields?.department).toBe("PaintingLV");
    expect(readScrapForm(form({ ...valid, department: "WeldingTX" }), TODAY, EARLIEST).error).toMatch(/painting section/);
  });

  it("refuses a missing, zero, negative, over-precise or absurd kg", () => {
    expect(readScrapForm(form({ ...valid, kg: "" }), TODAY, EARLIEST).error).toMatch(/Enter the scrap/);
    expect(readScrapForm(form({ ...valid, kg: "0" }), TODAY, EARLIEST).error).toMatch(/more than zero/);
    expect(readScrapForm(form({ ...valid, kg: "-1" }), TODAY, EARLIEST).error).toMatch(/number/);
    expect(readScrapForm(form({ ...valid, kg: "1.2345" }), TODAY, EARLIEST).error).toMatch(/decimals/);
    expect(readScrapForm(form({ ...valid, kg: "50001" }), TODAY, EARLIEST).error).toMatch(/cannot exceed/);
    expect(readScrapForm(form({ ...valid, notes: "x".repeat(301) }), TODAY, EARLIEST).error).toMatch(/too long/);
  });
});

describe("a weighing's versions", () => {
  const a = { dayISO: "2026-09-28", department: "PaintingTX", kg: 12.5, notes: null };
  it("compares, reads back and describes", () => {
    expect(sameScrap(a, { ...a })).toBe(true);
    expect(sameScrap(a, { ...a, kg: 12 })).toBe(false);
    expect(parseScrapSnapshot(JSON.parse(JSON.stringify(a)))).toEqual(a);
    expect(parseScrapSnapshot({ junk: 1 })).toBeNull();
    expect(describeScrap(a)).toBe("12.5 kg · Transformer Painting · 28/09/2026");
    expect(scrapChanges(a, { ...a, kg: 10, department: "PaintingLV" })).toEqual(["Section: Transformer Painting → USS Painting", "Kg: 12.5 → 10"]);
  });
});

describe("the month's powder report", () => {
  const w = (over: Partial<PowderWithdrawal>): PowderWithdrawal => ({ dayISO: "2026-09-10", department: "PaintingTX", item: "Powder RAL 7035", uom: "KG", qty: 100, ...over });
  const s = (over: Partial<ScrapEntry>): ScrapEntry => ({ dayISO: "2026-09-20", department: "PaintingTX", kg: 8, ...over });

  it("sets each section's scrap against the powder it drew, and both together", () => {
    const r = buildPowderReport("2026-09", [w({}), w({ department: "PaintingLV", qty: 50 })], [s({}), s({ department: "PaintingLV", kg: 10 })]);
    const [tx, lv] = r.departments;
    expect(tx).toMatchObject({ department: "PaintingTX", label: "Transformer Painting", withdrawn: 100, scrap: 8, net: 92 });
    expect(tx.rate).toBeCloseTo(0.08);
    expect(lv.rate).toBeCloseTo(0.2);
    expect(r.total).toMatchObject({ withdrawn: 150, scrap: 18, net: 132 });
    expect(r.total.rate).toBeCloseTo(0.12);
  });

  it("gives no rate when nothing was drawn, and a negative net when more was scrapped", () => {
    const r = buildPowderReport("2026-09", [], [s({})]);
    expect(r.departments[0]).toMatchObject({ withdrawn: 0, scrap: 8, net: -8, rate: null });
  });

  it("compares with the month before and trends six months", () => {
    const r = buildPowderReport("2026-09", [w({}), w({ dayISO: "2026-08-03", qty: 40 }), w({ dayISO: "2026-03-31", qty: 999 })], [s({}), s({ dayISO: "2026-08-31", kg: 4 })]);
    expect(r.prevMonth).toBe("2026-08");
    expect(r.departments[0].prev).toMatchObject({ withdrawn: 40, scrap: 4 });
    expect(r.trendMonths).toEqual(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
    expect(r.total.trend.map((t) => t.withdrawn)).toEqual([0, 0, 0, 0, 40, 100]); // March is outside
  });

  it("keeps a non-kg powder item and powder sent elsewhere out of the rate, and says so", () => {
    const r = buildPowderReport("2026-09", [w({}), w({ uom: "BOX", qty: 3, item: "Powder touch-up kit" }), w({ department: "Maintenance", qty: 5 })], [s({})]);
    expect(r.total.withdrawn).toBe(100);
    expect(r.notKg).toEqual([{ item: "Powder touch-up kit", uom: "BOX", qty: 3 }]);
    expect(r.elsewhere).toEqual([{ department: "Maintenance", label: "Maintenance", qty: 5 }]);
  });

  it("lists what was drawn by item and section, a typed item as kg", () => {
    const r = buildPowderReport("2026-09", [w({}), w({ qty: 20 }), w({ item: "powder black", uom: null, qty: 7 })], []);
    expect(r.items).toEqual([
      { item: "Powder RAL 7035", uom: "KG", department: "PaintingTX", qty: 120, handOuts: 2 },
      { item: "powder black", uom: "kg", department: "PaintingTX", qty: 7, handOuts: 1 },
    ]);
  });

  it("reads the trend's whole span", () => {
    expect(powderSpan("2026-09")).toEqual({ from: "2026-04-01", to: "2026-09-30" });
    expect(figures(0.1 + 0.2, 0)).toMatchObject({ withdrawn: 0.3 });
  });
});
