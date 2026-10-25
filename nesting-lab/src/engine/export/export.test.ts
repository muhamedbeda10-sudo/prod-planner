import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { nest } from "../nesting/nest";
import type { NestPartInput, NestSettings } from "../nesting/types";
import { sheetDxf, partDxf } from "./sheetExport";
import { verifyDxfRoundTrip } from "./roundtrip";
import { parseDxf } from "../dxf/parse";
import { analyzeDxf } from "../dxf/analyze";
import { cutListCsv } from "./csv";
import { sheetSvg } from "./svg";
import { buildReport } from "./report";
import { geometryHash } from "../geometry/hash";
import { lineSeg, fullCircle, segFromBulge } from "../geometry/arc";
import { loopArea, loopPerimeter } from "../geometry/polygon";
import type { Loop } from "../geometry/types";
import { EXPORT_PROFILES } from "./postprocessors";

const rect = (w: number, h: number): Loop => ({ segs: [lineSeg({ x: 0, y: 0 }, { x: w, y: 0 }), lineSeg({ x: w, y: 0 }, { x: w, y: h }), lineSeg({ x: w, y: h }, { x: 0, y: h }), lineSeg({ x: 0, y: h }, { x: 0, y: 0 })] });
const filleted: Loop = { segs: [lineSeg({ x: 5, y: 0 }, { x: 95, y: 0 }), segFromBulge({ x: 95, y: 0 }, { x: 100, y: 5 }, Math.tan(Math.PI / 8)), lineSeg({ x: 100, y: 5 }, { x: 100, y: 60 }), lineSeg({ x: 100, y: 60 }, { x: 0, y: 60 }), lineSeg({ x: 0, y: 60 }, { x: 0, y: 5 }), segFromBulge({ x: 0, y: 5 }, { x: 5, y: 0 }, Math.tan(Math.PI / 8))] };
const holeRect = (x: number, y: number, w: number, h: number): Loop => ({ segs: [lineSeg({ x, y }, { x, y: y + h }), lineSeg({ x, y: y + h }, { x: x + w, y: y + h }), lineSeg({ x: x + w, y: y + h }, { x: x + w, y }), lineSeg({ x: x + w, y }, { x, y })] });
const parts: NestPartInput[] = [
  { id: "A", label: "A", quantity: 3, outer: filleted, holes: [{ segs: [fullCircle({ x: 50, y: 30 }, 8)] }, holeRect(70, 20, 10, 10)], bom: "12005E14M13", partNo: "FB-022", name: "Side", marks: [fullCircle({ x: 20, y: 30 }, 1)] },
  { id: "B", label: "B", quantity: 2, outer: { segs: [fullCircle({ x: 0, y: 0 }, 25)] }, holes: [] },
];
const settings: NestSettings = { sheet: { widthMm: 400, heightMm: 300, quantity: null, material: "Steel", thicknessMm: 5, label: "400*300" }, spacingMm: 4, marginMm: 6, rotationsDeg: [0, 90], allowMirror: false, noGoZones: [] };

describe("DXF export", () => {
  const result = nest(parts, settings);
  const sheet = result.sheets[0];
  const text = sheetDxf(result, sheet, parts);
  it("states millimetres and R2000, and reads back with every part at its exact size", () => {
    const doc = parseDxf(text);
    expect(doc.acadVersion).toBe("AC1015");
    expect(doc.units.code).toBe(4);
    const rt = verifyDxfRoundTrip(text, result, sheet, parts);
    expect(rt.ok, rt.mismatches.join("; ")).toBe(true);
    expect(rt.matched).toBe(sheet.placements.length);
    expect(rt.holesFound).toBe(rt.holesExpected);
    expect(rt.maxBBoxDeltaMm).toBeLessThan(1e-6);
    expect(rt.maxAreaDeltaMm2).toBeLessThan(1e-4);
  });
  it("keeps arcs as bulges and circles as circles (no faceting)", () => {
    const doc = parseDxf(text);
    const polys = doc.entities.filter((e) => e.type === "LWPOLYLINE");
    const bulged = polys.filter((e) => e.type === "LWPOLYLINE" && e.vertices.some((v) => Math.abs(v.bulge) > 1e-9));
    expect(bulged.length).toBe(3); // the three filleted outers
    expect(doc.entities.filter((e) => e.type === "CIRCLE").length).toBe(2 + 3 + 3); // 2 round parts, 3 round holes, 3 marks
    expect(doc.entities.filter((e) => e.type === "TEXT").length).toBe(5);
  });
  it("is readable by an independent DXF library with the same counts", () => {
    // required at run time so the root repo's type-check never looks for this package
    const DxfParser = createRequire(import.meta.url)("dxf-parser") as new () => { parseSync(t: string): { header: Record<string, number>; entities: { type: string }[]; tables: { layer: { layers: Record<string, unknown> } } } };
    const d = new DxfParser().parseSync(text);
    expect(d.header.$INSUNITS).toBe(4);
    const types: Record<string, number> = {};
    for (const e of d.entities) types[e.type] = (types[e.type] ?? 0) + 1;
    expect(types.LWPOLYLINE).toBe(3 + 3 + 1); // outers, square holes, sheet outline
    expect(types.CIRCLE).toBe(8);
    expect(Object.keys(d.tables.layer.layers)).toEqual(expect.arrayContaining(["SHEET", "CUT_INNER", "CUT_OUTER", "MARK", "LABEL"]));
  });
  it("writes inner contours before the outer contour of each part", () => {
    const doc = parseDxf(text);
    // each part ends with its LABEL text: within a part every CUT_INNER must come before the CUT_OUTER
    let innerAfterOuter = 0;
    let outers = 0;
    let sawOuter = false;
    for (const e of doc.entities) {
      if (e.layer === "LABEL") sawOuter = false;
      else if (e.layer === "CUT_OUTER") {
        sawOuter = true;
        outers++;
      } else if (e.layer === "CUT_INNER" && sawOuter) innerAfterOuter++;
    }
    expect(outers).toBe(sheet.placements.length);
    expect(innerAfterOuter).toBe(0);
    expect(doc.entities.filter((e) => e.layer === "CUT_INNER").length).toBe(3 * 2);
  });
  it("re-analysing an exported sheet finds the same parts as a finished nesting", () => {
    const a = analyzeDxf("sheet.dxf", new TextEncoder().encode(text), { layerRoles: { SHEET: "cut", LABEL: "ignore", MARK: "mark" } });
    expect(a.needsUnit).toBe(false);
    expect(a.classification?.kind).toBe("nesting-ready");
    expect(a.classification?.sheetSize).toEqual({ w: 400, h: 300 });
    expect(a.classification?.pieces.length).toBe(5);
    expect(a.parts?.groups.length).toBe(2);
  });
  it("a part library file has the part at the origin with holes and marks", () => {
    const t = partDxf(parts[0]);
    const a = analyzeDxf("A.dxf", new TextEncoder().encode(t), { layerRoles: { MARK: "mark" } });
    const p = a.classification!.pieces[0];
    expect(p.bbox.minX).toBeCloseTo(0, 6);
    expect(p.bbox.maxX).toBeCloseTo(100, 6);
    expect(p.holes).toHaveLength(2);
    expect(p.marks).toHaveLength(1);
    // coordinates are written with six decimals: the area of a 6000 mm² part moves by ~1e-5
    expect(Math.abs(p.outer.area - Math.abs(loopArea(filleted)))).toBeLessThan(1e-3);
    expect(Math.abs(p.outer.perimeter - loopPerimeter(filleted))).toBeLessThan(1e-4);
  });
  it("produces a cut list, an SVG and a report that name every part", () => {
    const csv = cutListCsv(result, parts);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("12005E14M13");
    expect(csv).toContain("FB-022");
    const svg = sheetSvg(result, sheet, parts);
    expect(svg).toContain("<svg");
    expect(svg).toContain("A #1");
    const rep = buildReport({ parts, result, verification: null, roundTrip: [], machines: null, exports: [] });
    expect(rep.parts.map((p) => p.geometryHash)).toEqual(parts.map((p) => geometryHash(p.outer, p.holes)));
    expect(rep.parts[0].holes).toBe(2);
  });
  it("lists machine program formats as not configured rather than faking them", () => {
    expect(EXPORT_PROFILES.filter((p) => p.kind === "program").every((p) => !p.configured)).toBe(true);
    expect(EXPORT_PROFILES.find((p) => p.id === "dxf-r2000-mm")?.configured).toBe(true);
  });
});
