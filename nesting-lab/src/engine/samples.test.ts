// The two factory files: what the engine says about them must stay what it
// says today, and every re-nest of their parts must verify and read back.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { analyzeDxf } from "./dxf/analyze";
import { partsFromAnalysis } from "./parts";
import { nest } from "./nesting/nest";
import { verifyLayout } from "./nesting/verify";
import { sheetDxf } from "./export/sheetExport";
import { verifyDxfRoundTrip } from "./export/roundtrip";
import type { NestSettings } from "./nesting/types";

const dir = join(__dirname, "..", "..", "samples");
const files = readdirSync(dir).filter((f) => f.endsWith(".dxf"));
const load = (name: string) => analyzeDxf(name, new Uint8Array(readFileSync(join(dir, name))), { unit: "mm", thicknessMm: 5 });

describe("factory samples", () => {
  it("has both files", () => {
    expect(files).toEqual(expect.arrayContaining(["12003E14M13 - 93-Result1-1.dxf", "12005E14M13-5mm-50U-Result1-1.dxf"]));
  });
  it("12003E14M13 - 93: unitless AC1018, a 1210×2430 nesting of 9 pieces in 5 types with a mirrored plate", () => {
    const a = load("12003E14M13 - 93-Result1-1.dxf");
    expect(a.acadVersion).toBe("AC1018");
    expect(a.units.stated).toBe(false);
    expect(a.units.code).toBe(0);
    expect(a.entityCounts).toEqual(expect.arrayContaining([{ type: "CIRCLE", count: 259 }, { type: "LWPOLYLINE", count: 98 }]));
    expect(a.layers.map((l) => l.name).sort()).toEqual(["0", "02___PRT_ALL_AXES", "1"]);
    expect(a.classification?.kind).toBe("nesting-ready");
    expect(a.classification?.sheetSize).toEqual({ w: 1210, h: 2430 });
    expect(a.classification?.pieces).toHaveLength(9);
    expect(a.topology?.openChains).toBe(0);
    expect(a.topology?.splitsApplied).toBeGreaterThan(0); // common-line cuts
    const groups = a.parts!.groups;
    expect(groups).toHaveLength(5);
    expect(groups.map((g) => g.instances.length)).toEqual([2, 1, 1, 1, 4]);
    expect(groups[1].mirrorOf).toBe(0);
    const plate = groups[0].representative;
    expect(plate.bbox.maxX - plate.bbox.minX).toBeCloseTo(1050, 6);
    expect(plate.bbox.maxY - plate.bbox.minY).toBeCloseTo(630, 6);
    expect(plate.holes).toHaveLength(101);
    expect(a.warnings.some((w) => /102 round hole\(s\) are smaller than the sheet thickness/.test(w))).toBe(true);
  });
  it("12005E14M13-5mm-50U: unitless AC1018, a 1220×2440 nesting with LINE common cuts", () => {
    const a = load("12005E14M13-5mm-50U-Result1-1.dxf");
    expect(a.units.stated).toBe(false);
    expect(a.entityCounts).toEqual(expect.arrayContaining([{ type: "LWPOLYLINE", count: 145 }, { type: "CIRCLE", count: 216 }, { type: "LINE", count: 2 }]));
    expect(a.classification?.kind).toBe("nesting-ready");
    expect(a.classification?.sheetSize).toEqual({ w: 1220, h: 2440 });
    expect(a.classification?.pieces.length).toBe(60);
    expect(a.parts?.groups.length).toBe(35);
    expect(a.classification?.ignoredFaces.some((g) => /sliver/.test(g.reason))).toBe(true);
    const big = a.parts!.groups[0].representative;
    expect(big.bbox.maxX - big.bbox.minX).toBeCloseTo(1125, 6);
    expect(big.holes).toHaveLength(125);
  });
  it("marking the axes layer as marks turns its circles into marks, not holes", () => {
    const a = analyzeDxf("f.dxf", new Uint8Array(readFileSync(join(dir, "12003E14M13 - 93-Result1-1.dxf"))), { unit: "mm", layerRoles: { "02___PRT_ALL_AXES": "mark" } });
    const plate = a.parts!.groups[0].representative;
    // 81 of the plate's 101 holes were circles on the axes layer; the 20 windows and slots on layer 0 stay holes
    expect(plate.holes).toHaveLength(20);
    expect(plate.marks).toHaveLength(81);
  });
  it("re-nests the first file onto its own sheet at 2 mm and verifies and reads back", () => {
    const a = load("12003E14M13 - 93-Result1-1.dxf");
    const { parts } = partsFromAnalysis(a);
    const s: NestSettings = { sheet: { widthMm: 1210, heightMm: 2430, quantity: null, material: "Steel", thicknessMm: 5 }, spacingMm: 2, marginMm: 2, rotationsDeg: [0, 90, 180, 270], allowMirror: false, noGoZones: [] };
    const r = nest(parts, s);
    expect(r.sheets).toHaveLength(1);
    expect(r.unplaced).toEqual([]);
    expect(r.sheets[0].utilization).toBeGreaterThan(0.9);
    const v = verifyLayout(parts, r);
    expect(v.ok, v.violations.map((x) => x.message).join("; ")).toBe(true);
    const rt = verifyDxfRoundTrip(sheetDxf(r, r.sheets[0], parts), r, r.sheets[0], parts);
    expect(rt.ok, rt.mismatches.join("; ")).toBe(true);
    expect(rt.holesFound).toBe(rt.holesExpected);
  });
  it("re-nests the second file's 59 parts at 5 mm, verified, within a sane time", () => {
    const a = load("12005E14M13-5mm-50U-Result1-1.dxf");
    const { parts, skipped } = partsFromAnalysis(a);
    expect(skipped.map((x) => x.id)).toEqual(["T32"]);
    const s: NestSettings = { sheet: { widthMm: 1220, heightMm: 2440, quantity: null, material: "Steel", thicknessMm: 5 }, spacingMm: 5, marginMm: 5, rotationsDeg: [0, 90, 180, 270], allowMirror: false, noGoZones: [], timeBudgetMs: 60_000 };
    const t0 = performance.now();
    const r = nest(parts, s);
    expect(performance.now() - t0).toBeLessThan(60_000);
    expect(r.unplaced).toEqual([]);
    expect(r.sheets.length).toBeLessThanOrEqual(2);
    const v = verifyLayout(parts, r);
    expect(v.ok, v.violations.map((x) => x.message).join("; ")).toBe(true);
    for (const sh of r.sheets) expect(verifyDxfRoundTrip(sheetDxf(r, sh, parts), r, sh, parts).ok).toBe(true);
  });
});
