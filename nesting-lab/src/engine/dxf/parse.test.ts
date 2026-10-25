import { describe, expect, it } from "vitest";
import { parseDxf } from "./parse";
import { tokenizeDxf, DxfFormatError, decodeDxfBytes } from "./tokenize";
import { extractPrimitives, layerUsage } from "./primitives";
import { analyzeDxf } from "./analyze";
import { dxfText, lwpolyline, circle, line, arc, rect, text } from "../test-support/dxf";

const enc = (s: string) => new TextEncoder().encode(s);

describe("tokenizer", () => {
  it("rejects binary DXF with a clear message", () => {
    expect(() => tokenizeDxf("AutoCAD Binary DXF\r\n\u001a\u0000")).toThrow(DxfFormatError);
    expect(() => tokenizeDxf("AutoCAD Binary DXF\r\n")).toThrow(/Binary DXF/);
  });
  it("rejects text that is not a DXF", () => {
    expect(() => tokenizeDxf("hello world\nthis is not dxf\n")).toThrow(/Not an ASCII DXF/);
    expect(() => tokenizeDxf("")).toThrow(/empty/);
  });
  it("reads CRLF and LF alike", () => {
    const a = tokenizeDxf("0\r\nSECTION\r\n2\r\nHEADER\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n");
    const b = tokenizeDxf("0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n");
    expect(a.map((p) => p.value)).toEqual(b.map((p) => p.value));
  });
  it("decodes latin-1 bytes without losing them", () => {
    expect(decodeDxfBytes(new Uint8Array([0x30, 0x0a, 0xe9]))).toBe("0\né");
  });
});

describe("parser", () => {
  it("reads the header units, version and extents", () => {
    const doc = parseDxf(dxfText(rect(0, 0, 10, 10), { insunits: 4, version: "AC1018" }));
    expect(doc.acadVersion).toBe("AC1018");
    expect(doc.units).toEqual({ code: 4, name: "mm", toMm: 1 });
  });
  it("treats a missing or zero $INSUNITS as unitless, never as mm", () => {
    expect(parseDxf(dxfText(rect(0, 0, 10, 10), { insunits: 0 })).units.toMm).toBeNull();
    expect(parseDxf(dxfText(rect(0, 0, 10, 10), { insunits: null })).units.toMm).toBeNull();
    expect(parseDxf(dxfText(rect(0, 0, 10, 10), { insunits: 1 })).units.toMm).toBe(25.4);
  });
  it("parses LWPOLYLINE vertices with bulges and the closed flag", () => {
    const doc = parseDxf(dxfText(lwpolyline([[0, 0, 0.5], [10, 0], [10, 10]], false)));
    const e = doc.entities[0];
    expect(e.type).toBe("LWPOLYLINE");
    if (e.type !== "LWPOLYLINE") throw new Error();
    expect(e.closed).toBe(false);
    expect(e.vertices.map((v) => v.bulge)).toEqual([0.5, 0, 0]);
  });
  it("parses POLYLINE/VERTEX/SEQEND chains", () => {
    const body = ["0", "POLYLINE", "8", "0", "70", "1", "0", "VERTEX", "8", "0", "10", "0", "20", "0", "42", "1", "0", "VERTEX", "8", "0", "10", "10", "20", "0", "0", "SEQEND"].join("\n");
    const doc = parseDxf(dxfText(body));
    expect(doc.entities).toHaveLength(1);
    const e = doc.entities[0];
    if (e.type !== "POLYLINE") throw new Error(e.type);
    expect(e.closed).toBe(true);
    expect(e.vertices).toHaveLength(2);
    expect(e.vertices[0].bulge).toBe(1);
  });
  it("keeps the layer table and lists layers used but undefined", () => {
    const doc = parseDxf(dxfText(rect(0, 0, 5, 5, "CUT") + "\n" + circle(2, 2, 1, "MARKS"), { layers: ["0", "CUT"] }));
    const usage = layerUsage(doc);
    expect(usage.find((l) => l.name === "CUT")?.defined).toBe(true);
    expect(usage.find((l) => l.name === "MARKS")?.defined).toBe(false);
    expect(usage.find((l) => l.name === "MARKS")?.total).toBe(1);
  });
  it("records entity types it does not cut and never drops them silently", () => {
    const body = [rect(0, 0, 10, 10), text(1, 1, "hello"), ["0", "SPLINE", "8", "0", "70", "0", "71", "3", "10", "0", "20", "0", "10", "1", "20", "1", "10", "2", "20", "0"].join("\n"), ["0", "ELLIPSE", "8", "0", "10", "5", "20", "5", "30", "0", "11", "2", "21", "0", "31", "0", "40", "0.5"].join("\n"), ["0", "HATCH", "8", "0"].join("\n")].join("\n");
    const prim = extractPrimitives(parseDxf(dxfText(body)), { unitFactor: 1, layerRoles: {} });
    expect(prim.segs).toHaveLength(4);
    expect(prim.annotations).toEqual([{ type: "TEXT", layer: "0", count: 1 }, { type: "HATCH", layer: "0", count: 1 }]);
    expect(prim.unsupported.map((u) => u.type).sort()).toEqual(["ELLIPSE", "SPLINE"]);
  });
  it("expands INSERTs with translation, rotation and uniform scale", () => {
    const blocks = ["0", "BLOCK", "8", "0", "2", "SQ", "70", "0", "10", "0", "20", "0", "30", "0", "3", "SQ", ...rect(0, 0, 10, 10).split("\n"), "0", "ENDBLK", "8", "0"].join("\n");
    const ins = ["0", "INSERT", "8", "0", "2", "SQ", "10", "100", "20", "50", "30", "0", "41", "2", "42", "2", "43", "1", "50", "90"].join("\n");
    const prim = extractPrimitives(parseDxf(dxfText(ins, { blocks })), { unitFactor: 1, layerRoles: {} });
    expect(prim.insertsExpanded).toEqual([{ block: "SQ", count: 1 }]);
    expect(prim.segs).toHaveLength(4);
    const xs = prim.segs.flatMap((s) => [s.a.x, s.b.x]);
    const ys = prim.segs.flatMap((s) => [s.a.y, s.b.y]);
    // 10×10 scaled ×2 then rotated 90° about the insertion point (100,50): x ∈ [80,100], y ∈ [50,70]
    expect(Math.min(...xs)).toBeCloseTo(80, 6);
    expect(Math.max(...xs)).toBeCloseTo(100, 6);
    expect(Math.min(...ys)).toBeCloseTo(50, 6);
    expect(Math.max(...ys)).toBeCloseTo(70, 6);
  });
  it("applies the unit factor and ignores layers by role", () => {
    const prim = extractPrimitives(parseDxf(dxfText(line(0, 0, 1, 0, "A") + "\n" + line(0, 0, 1, 0, "B"))), { unitFactor: 25.4, layerRoles: { B: "ignore" } });
    expect(prim.segs).toHaveLength(1);
    expect(prim.segs[0].b.x).toBeCloseTo(25.4, 9);
    expect(prim.ignoredByLayer).toEqual([{ type: "LINE", layer: "B", count: 1 }]);
  });
  it("turns ARC entities into arcs with the right sweep", () => {
    const prim = extractPrimitives(parseDxf(dxfText(arc(0, 0, 10, 0, 90))), { unitFactor: 1, layerRoles: {} });
    const s = prim.segs[0];
    expect(s.kind).toBe("arc");
    if (s.kind !== "arc") throw new Error();
    expect(s.a.x).toBeCloseTo(10, 9);
    expect(s.b.y).toBeCloseTo(10, 9);
    expect(s.ccw).toBe(true);
  });
});

describe("analysis of unusable files", () => {
  it("needs a unit for a unitless file and gives no geometry until it has one", () => {
    const a = analyzeDxf("x.dxf", enc(dxfText(rect(0, 0, 10, 10), { insunits: 0 })));
    expect(a.needsUnit).toBe(true);
    expect(a.classification).toBeNull();
    expect(a.warnings.some((w) => /does not state its unit/.test(w))).toBe(true);
    const b = analyzeDxf("x.dxf", enc(dxfText(rect(0, 0, 10, 10), { insunits: 0 })), { unit: "in" });
    expect(b.needsUnit).toBe(false);
    expect(b.classification?.pieces[0].bbox.maxX).toBeCloseTo(254, 6);
  });
  it("reports a file with no closed geometry instead of nesting nothing", () => {
    const a = analyzeDxf("x.dxf", enc(dxfText(line(0, 0, 10, 0) + "\n" + line(10, 0, 10, 10))), { unit: "mm" });
    expect(a.classification?.kind).toBe("no-closed-geometry");
  });
  it("throws a format error for a non-DXF upload", () => {
    expect(() => analyzeDxf("x.dxf", enc("%PDF-1.4 not a dxf"))).toThrow(DxfFormatError);
  });
});
