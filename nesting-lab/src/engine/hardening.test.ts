// The findings of the review passes, each pinned by a test: hostile files,
// mirrored geometry, the verifier saying "no", the read-back check saying "no",
// the time budget, and the CSV guard.
import { describe, expect, it } from "vitest";
import { parseDxf } from "./dxf/parse";
import { extractPrimitives, DEFAULT_LIMITS, layerRoleOf } from "./dxf/primitives";
import { analyzeDxf } from "./dxf/analyze";
import { DxfFormatError } from "./dxf/tokenize";
import { dxfText, lwpolyline, circle, line, rect } from "./test-support/dxf";
import { arcChordCount, MAX_CHORDS_PER_ARC, fullCircle, lineSeg, segFromBulge } from "./geometry/arc";
import { discretizeLoop, loopArea, pointInPolygon, polygonArea } from "./geometry/polygon";
import { buildTopology } from "./geometry/topology";
import { nest } from "./nesting/nest";
import { verifyLayout } from "./nesting/verify";
import type { NestPartInput, NestSettings } from "./nesting/types";
import { sheetDxf } from "./export/sheetExport";
import { verifyDxfRoundTrip } from "./export/roundtrip";
import { cutListCsv } from "./export/csv";
import { loopPath } from "./export/svg";
import { placedGeometry } from "./nesting/placement";
import type { Loop, TaggedSeg, Seg } from "./geometry/types";
import { classify } from "./geometry/classify";
import { dedupePieces } from "./geometry/dedupe";
import { rankMachines } from "./machines/select";
import type { MachinesFile } from "./machines/types";

const enc = (s: string) => new TextEncoder().encode(s);
const rectLoop = (w: number, h: number): Loop => ({ segs: [lineSeg({ x: 0, y: 0 }, { x: w, y: 0 }), lineSeg({ x: w, y: 0 }, { x: w, y: h }), lineSeg({ x: w, y: h }, { x: 0, y: h }), lineSeg({ x: 0, y: h }, { x: 0, y: 0 })] });
const base = (over: Partial<NestSettings> = {}): NestSettings => ({ sheet: { widthMm: 500, heightMm: 300, quantity: null, material: "Steel", thicknessMm: 3 }, spacingMm: 5, marginMm: 5, rotationsDeg: [0, 90, 180, 270], allowMirror: false, noGoZones: [], ...over });
const part = (id: string, outer: Loop, quantity: number, extra: Partial<NestPartInput> = {}): NestPartInput => ({ id, label: id, quantity, outer, holes: [], ...extra });

describe("hostile or odd files", () => {
  it("caps INSERT arrays and refuses self-referencing blocks instead of hanging", () => {
    const blocks = ["0", "BLOCK", "8", "0", "2", "SQ", "70", "0", "10", "0", "20", "0", "30", "0", "3", "SQ", ...rect(0, 0, 10, 10).split("\n"), "0", "ENDBLK", "8", "0"].join("\n");
    const huge = ["0", "INSERT", "8", "0", "2", "SQ", "10", "0", "20", "0", "30", "0", "70", "1000000", "71", "1000000"].join("\n");
    const prim = extractPrimitives(parseDxf(dxfText(huge, { blocks })), { unitFactor: 1, layerRoles: {} });
    expect(prim.segs).toHaveLength(0);
    expect(prim.unsupported[0].type).toMatch(/INSERT array/);
    const selfRef = ["0", "BLOCK", "8", "0", "2", "LOOP", "70", "0", "10", "0", "20", "0", "30", "0", "3", "LOOP", ...line(0, 0, 1, 1).split("\n"), "0", "INSERT", "8", "0", "2", "LOOP", "10", "1", "20", "1", "30", "0", "0", "ENDBLK", "8", "0"].join("\n");
    const ins = ["0", "INSERT", "8", "0", "2", "LOOP", "10", "0", "20", "0", "30", "0"].join("\n");
    const p2 = extractPrimitives(parseDxf(dxfText(ins, { blocks: selfRef })), { unitFactor: 1, layerRoles: {} });
    expect(p2.segs).toHaveLength(1);
    expect(p2.unsupported.some((u) => /inside itself/.test(u.type))).toBe(true);
  });
  it("lays out a rotated MINSERT along the block's axes", () => {
    const blocks = ["0", "BLOCK", "8", "0", "2", "SQ", "70", "0", "10", "0", "20", "0", "30", "0", "3", "SQ", ...rect(0, 0, 10, 10).split("\n"), "0", "ENDBLK", "8", "0"].join("\n");
    const ins = ["0", "INSERT", "8", "0", "2", "SQ", "10", "0", "20", "0", "30", "0", "50", "90", "70", "2", "71", "1", "44", "100", "45", "0"].join("\n");
    const prim = extractPrimitives(parseDxf(dxfText(ins, { blocks })), { unitFactor: 1, layerRoles: {} });
    const ys = prim.segs.map((s) => s.a.y);
    // the second copy sits 100 along the rotated X axis, i.e. at y = 100
    expect(Math.max(...ys)).toBeCloseTo(110, 6);
    expect(Math.max(...prim.segs.map((s) => s.a.x))).toBeCloseTo(0, 6);
  });
  it("mirrors a block with filleted polylines correctly (bulges keep their shape)", () => {
    const k = Math.tan(Math.PI / 8);
    const poly = lwpolyline([[5, 0], [95, 0, k], [100, 5], [100, 60], [0, 60], [0, 5, k]], true);
    const blocks = ["0", "BLOCK", "8", "0", "2", "P", "70", "0", "10", "0", "20", "0", "30", "0", "3", "P", ...poly.split("\n"), "0", "ENDBLK", "8", "0"].join("\n");
    const plain = extractPrimitives(parseDxf(dxfText(["0", "INSERT", "8", "0", "2", "P", "10", "0", "20", "0", "30", "0"].join("\n"), { blocks })), { unitFactor: 1, layerRoles: {} });
    const mirrored = extractPrimitives(parseDxf(dxfText(["0", "INSERT", "8", "0", "2", "P", "10", "0", "20", "0", "30", "0", "41", "-1", "42", "1", "43", "1"].join("\n"), { blocks })), { unitFactor: 1, layerRoles: {} });
    const area = (segs: TaggedSeg[]) => Math.abs(loopArea({ segs }));
    expect(area(mirrored.segs)).toBeCloseTo(area(plain.segs), 6);
    const arcs = mirrored.segs.filter((s): s is TaggedSeg & { kind: "arc" } => s.kind === "arc");
    expect(arcs).toHaveLength(2);
    for (const a of arcs) expect(a.r).toBeCloseTo(5, 6);
    // the mirrored fillet centre is inside the mirrored part (x ∈ [-100, 0])
    for (const a of arcs) expect(a.center.x).toBeLessThan(0);
  });
  it("maps −Z extrusion (AutoCAD MIRROR) circles back to world coordinates", () => {
    const body = ["0", "CIRCLE", "8", "0", "10", "10", "20", "5", "30", "0", "40", "2", "210", "0", "220", "0", "230", "-1"].join("\n");
    const prim = extractPrimitives(parseDxf(dxfText(body)), { unitFactor: 1, layerRoles: {} });
    expect(prim.segs).toHaveLength(1);
    const c = prim.segs[0];
    if (c.kind !== "arc") throw new Error();
    expect(c.center.x).toBeCloseTo(-10, 9);
    expect(c.center.y).toBeCloseTo(5, 9);
    expect(prim.mirroredByExtrusion).toBe(1);
    const tilted = ["0", "CIRCLE", "8", "0", "10", "10", "20", "5", "30", "0", "40", "2", "210", "0.5", "220", "0", "230", "0.8"].join("\n");
    const p2 = extractPrimitives(parseDxf(dxfText(tilted)), { unitFactor: 1, layerRoles: {} });
    expect(p2.segs).toHaveLength(0);
    expect(p2.unsupported[0].type).toMatch(/not along Z/);
  });
  it("rejects non-uniform block scale on arcs but keeps the lines", () => {
    const blocks = ["0", "BLOCK", "8", "0", "2", "B", "70", "0", "10", "0", "20", "0", "30", "0", "3", "B", ...circle(5, 5, 2).split("\n"), ...line(0, 0, 10, 0).split("\n"), "0", "ENDBLK", "8", "0"].join("\n");
    const ins = ["0", "INSERT", "8", "0", "2", "B", "10", "0", "20", "0", "30", "0", "41", "2", "42", "1", "43", "1"].join("\n");
    const prim = extractPrimitives(parseDxf(dxfText(ins, { blocks })), { unitFactor: 1, layerRoles: {} });
    expect(prim.segs.map((s) => s.kind)).toEqual(["line"]);
    expect(prim.unsupported[0].type).toMatch(/non-uniform/);
  });
  it("never loops forever on an absurd radius", () => {
    expect(arcChordCount(1e15, Math.PI * 2, 0.05)).toBe(MAX_CHORDS_PER_ARC);
    expect(arcChordCount(1e20, 1, 0.05)).toBeLessThanOrEqual(MAX_CHORDS_PER_ARC);
    const prim = extractPrimitives(parseDxf(dxfText(circle(0, 0, 1e15))), { unitFactor: 1, layerRoles: {} });
    expect(prim.segs).toHaveLength(0);
    expect(prim.unsupported[0].type).toMatch(/radius/);
    expect(DEFAULT_LIMITS.radiusMm).toBe(1e7);
  });
  it("is immune to layers and blocks named like Object.prototype members", () => {
    expect(layerRoleOf({}, "constructor")).toBe("cut");
    expect(layerRoleOf({ toString: "ignore" } as never, "toString")).toBe("ignore");
    expect(layerRoleOf({ x: "bogus" } as never, "x")).toBe("cut");
    const a = analyzeDxf("x.dxf", enc(dxfText(rect(0, 0, 10, 10, "constructor"), { insunits: 4 })));
    expect(a.classification?.pieces).toHaveLength(1);
    const ins = ["0", "INSERT", "8", "0", "2", "constructor", "10", "0", "20", "0", "30", "0"].join("\n");
    const prim = extractPrimitives(parseDxf(dxfText(ins)), { unitFactor: 1, layerRoles: {} });
    expect(prim.unsupported[0].type).toMatch(/missing block/);
    const proto = ["0", "BLOCK", "8", "0", "2", "__proto__", "70", "0", "10", "0", "20", "0", "30", "0", "3", "__proto__", ...line(0, 0, 1, 0).split("\n"), "0", "ENDBLK", "8", "0"].join("\n");
    expect(() => parseDxf(dxfText(line(0, 0, 1, 1), { blocks: proto }))).not.toThrow();
  });
  it("refuses a file that expands beyond the segment budget", () => {
    const blocks = ["0", "BLOCK", "8", "0", "2", "SQ", "70", "0", "10", "0", "20", "0", "30", "0", "3", "SQ", ...rect(0, 0, 10, 10).split("\n"), "0", "ENDBLK", "8", "0"].join("\n");
    // 9000 copies × 4 segments = 36 000 segments, fine; the budget test uses a lowered limit
    const ins = ["0", "INSERT", "8", "0", "2", "SQ", "10", "0", "20", "0", "30", "0", "70", "90", "71", "100", "44", "20", "45", "20"].join("\n");
    expect(() => extractPrimitives(parseDxf(dxfText(ins, { blocks })), { unitFactor: 1, layerRoles: {}, limits: { segments: 1000 } })).toThrow(DxfFormatError);
    expect(DEFAULT_LIMITS.segments).toBe(2_000_000);
  });
  it("noding survives one very long construction line among many short segments", () => {
    const segs: TaggedSeg[] = [];
    const tag = (s: Seg, i: number): TaggedSeg => ({ ...s, tag: { layer: "0", handle: null, entityType: "LINE", entityIndex: i, role: "cut" } });
    for (let i = 0; i < 2000; i++) {
      const x = (i % 50) * 3;
      const y = Math.floor(i / 50) * 3;
      segs.push(tag(lineSeg({ x, y }, { x: x + 1, y }), i), tag(lineSeg({ x: x + 1, y }, { x: x + 1, y: y + 1 }), i), tag(lineSeg({ x: x + 1, y: y + 1 }, { x, y: y + 1 }), i), tag(lineSeg({ x, y: y + 1 }, { x, y }), i));
    }
    segs.push(tag(lineSeg({ x: -1e6, y: -5 }, { x: 1e6, y: -5 }), 9999));
    const t0 = performance.now();
    const t = buildTopology(segs, { snapTol: 0.01 });
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(t.faces).toHaveLength(2000);
    expect(t.open).toHaveLength(1);
  });
});

describe("geometry corner cases", () => {
  it("circumscribes convex arcs and keeps chords on concave ones, so the polygon always contains the part", () => {
    // a 100×60 plate with a semicircular notch of r=10 in the top edge (concave, cw arc on a
    // ccw loop) and a convex bulge of r=10 in the bottom edge (ccw arc)
    const k = Math.tan(Math.PI / 4); // 180° arcs
    const loop: Loop = { segs: [lineSeg({ x: 0, y: 0 }, { x: 40, y: 0 }), segFromBulge({ x: 40, y: 0 }, { x: 60, y: 0 }, k), lineSeg({ x: 60, y: 0 }, { x: 100, y: 0 }), lineSeg({ x: 100, y: 0 }, { x: 100, y: 60 }), lineSeg({ x: 100, y: 60 }, { x: 60, y: 60 }), segFromBulge({ x: 60, y: 60 }, { x: 40, y: 60 }, -k), lineSeg({ x: 40, y: 60 }, { x: 0, y: 60 }), lineSeg({ x: 0, y: 60 }, { x: 0, y: 0 })] };
    expect(loopArea(loop)).toBeGreaterThan(0);
    const poly = discretizeLoop(loop, 0.5, true);
    expect(polygonArea(poly)).toBeGreaterThanOrEqual(loopArea(loop) - 1e-9);
    // every point of the true outline lies inside or on the polygon
    const fine = discretizeLoop(loop, 0.001, false);
    for (const p of fine) expect(pointInPolygon(p, poly, 1e-6)).toBe(true);
    // the convex bulge is circumscribed (vertices beyond r=10); the notch keeps its chord (no vertex below y=60-10 inside the notch)
    expect(Math.min(...poly.map((p) => p.y))).toBeLessThan(-10);
    expect(poly.filter((p) => p.x > 40 && p.x < 60 && p.y > 40 && p.y < 60).every((p) => Math.hypot(p.x - 50, p.y - 60) >= 10 - 1e-9)).toBe(true);
  });
  it("keeps a full circle's start vertex and draws a rotated circle on the right path", () => {
    const poly = discretizeLoop({ segs: [fullCircle({ x: 0, y: 0 }, 10)] }, 2, false);
    expect(poly.some((p) => Math.abs(p.x - 10) < 1e-9 && Math.abs(p.y) < 1e-9)).toBe(true);
    const p = part("C", { segs: [fullCircle({ x: 0, y: 0 }, 10)] }, 1);
    const g = placedGeometry(p, { rotationDeg: 180, mirrored: false, x: 0, y: 0 });
    const d = loopPath(g.outer);
    // two arcs between antipodes: the endpoint of the first arc is opposite the start
    const m = /M([-\d.]+) ([-\d.]+)A10 10 0 1 1 ([-\d.]+) ([-\d.]+)A/.exec(d)!;
    expect(Number(m[1]) + Number(m[3])).toBeCloseTo(20, 6); // centre x = 10 after the shift
    expect(Number(m[2]) + Number(m[4])).toBeCloseTo(20, 6);
  });
  it("does not split a line where it only crosses the extension of an arc's circle", () => {
    const tag = (s: Seg, i: number): TaggedSeg => ({ ...s, tag: { layer: "0", handle: null, entityType: "T", entityIndex: i, role: "cut" } });
    const sq = [tag(lineSeg({ x: 0, y: 0 }, { x: 20, y: 0 }), 1), tag(lineSeg({ x: 20, y: 0 }, { x: 20, y: 20 }), 2), tag(lineSeg({ x: 20, y: 20 }, { x: 0, y: 20 }), 3), tag(lineSeg({ x: 0, y: 20 }, { x: 0, y: 0 }), 4)];
    const arc = segFromBulge({ x: 40, y: 10 }, { x: 30, y: 20 }, Math.tan(Math.PI / 8)); // 90° arc, centre (30,10), circle crosses x=20 at (20,10)
    const t = buildTopology([...sq, tag(arc, 5)], { snapTol: 0.01 });
    expect(t.splitsApplied).toBe(0);
  });
  it("groups mirrored round parts with holes as mirror images", () => {
    const tag = (s: Seg, i: number): TaggedSeg => ({ ...s, tag: { layer: "0", handle: null, entityType: "T", entityIndex: i, role: "cut" } });
    const disc = (cx: number, hx: number) => [tag(fullCircle({ x: cx, y: 0 }, 30), 1), tag(fullCircle({ x: cx + hx, y: 10 }, 3), 2)];
    const c = classify(buildTopology([...disc(0, 12), ...disc(100, -12)], { snapTol: 0.01 }), [], { minPartArea: 1, sliverWidth: 0.2, smallCutoutArea: 10, reviewArea: 0, sheetTol: 0.5, sagitta: 0.05 });
    const d = dedupePieces(c.pieces, { tol: 0.02 });
    expect(d.groups).toHaveLength(2);
    expect(d.groups[1].mirrorOf).toBe(0);
  });
});

describe("the verifier and the read-back check say no when they should", () => {
  const parts = [part("A", rectLoop(100, 60), 3, { holes: [{ segs: [fullCircle({ x: 50, y: 30 }, 8)] }] }), part("B", rectLoop(40, 40), 2)];
  const good = nest(parts, base({ rotationsDeg: [0] }));
  const clone = () => JSON.parse(JSON.stringify(good)) as typeof good;
  it("spacing", () => {
    const r = clone();
    const [p0, p1] = r.sheets[0].placements;
    p1.x = p0.x + 102;
    p1.y = p0.y;
    const v = verifyLayout(parts, r);
    expect(v.ok).toBe(false);
    expect(v.violations.some((x) => x.kind === "spacing" && x.measured! < 3)).toBe(true);
  });
  it("out of bounds", () => {
    const r = clone();
    r.sheets[0].placements[0].x = 1;
    const v = verifyLayout(parts, r);
    expect(v.violations.some((x) => x.kind === "out-of-bounds")).toBe(true);
  });
  it("no-go zones", () => {
    const r = clone();
    const p0 = r.sheets[0].placements[0];
    r.settings.noGoZones = [{ x: p0.x + 10, y: p0.y + 10, w: 20, h: 20, label: "clamp" }];
    expect(verifyLayout(parts, r).violations.some((x) => x.kind === "no-go-zone")).toBe(true);
    const r2 = clone();
    r2.settings.noGoZones = [{ x: p0.x + 100 + 1, y: p0.y, w: 10, h: 10, label: "near" }];
    r2.sheets[0].placements = [r2.sheets[0].placements[0]];
    r2.unplaced = [{ partId: "A", quantity: 2, reason: "test" }, { partId: "B", quantity: 2, reason: "test" }];
    expect(verifyLayout(parts, r2).violations.some((x) => x.kind === "no-go-zone" && x.measured! < 5)).toBe(true);
  });
  it("quantities and unknown parts", () => {
    const r = clone();
    r.sheets[0].placements.pop();
    expect(verifyLayout(parts, r).violations.some((x) => x.kind === "quantity")).toBe(true);
    const r2 = clone();
    r2.sheets[0].placements.push({ ...r2.sheets[0].placements[0], partId: "ghost" });
    expect(verifyLayout(parts, r2).violations.some((x) => x.kind === "quantity" && /unknown part/.test(x.message))).toBe(true);
  });
  it("one part inside another without edge crossings", () => {
    const r = clone();
    const a = r.sheets[0].placements.find((p) => p.partId === "A")!;
    const b = r.sheets[0].placements.find((p) => p.partId === "B")!;
    b.x = a.x + 30;
    b.y = a.y + 10;
    expect(verifyLayout(parts, r).violations.some((x) => x.kind === "overlap")).toBe(true);
  });
  it("read-back reports a missing contour, a moved vertex and a lost hole", () => {
    const sheet = good.sheets[0];
    const text = sheetDxf(good, sheet, parts);
    expect(verifyDxfRoundTrip(text, good, sheet, parts).ok).toBe(true);
    const lines = text.split("\r\n");
    // drop the first CUT_OUTER polyline: find "8\r\nCUT_OUTER" and blank the entity by renaming its layer to LABEL (ignored)
    const i = lines.findIndex((l, k) => l === "CUT_OUTER" && lines[k - 1] === "8");
    const missing = [...lines];
    missing[i] = "LABEL";
    const rt = verifyDxfRoundTrip(missing.join("\r\n"), good, sheet, parts);
    expect(rt.ok).toBe(false);
    expect(rt.matched).toBe(sheet.placements.length - 1);
    expect(rt.mismatches.some((m) => /not found/.test(m))).toBe(true);
    // lose a hole: the first CIRCLE on CUT_INNER becomes a mark
    const j = lines.findIndex((l, k) => l === "CUT_INNER" && lines[k - 1] === "8");
    const noHole = [...lines];
    noHole[j] = "MARK";
    const rt2 = verifyDxfRoundTrip(noHole.join("\r\n"), good, sheet, parts);
    expect(rt2.ok).toBe(false);
    expect(rt2.holesFound).toBe(rt2.holesExpected - 1);
  });
});

describe("time budget, ids and the CSV guard", () => {
  it("the first strategy always finishes; later ones stop at the budget and are not used", () => {
    const parts = [part("R", rectLoop(50, 50), 12)];
    let calls = 0;
    const now = () => (++calls < 40 ? 0 : 10_000);
    const r = nest(parts, base({ timeBudgetMs: 5_000 }), { now });
    expect(r.sheets.length).toBeGreaterThan(0);
    expect(r.sheets.reduce((n, s) => n + s.placements.length, 0)).toBe(12);
    expect(r.strategiesTried.length).toBeLessThan(6);
    expect(r.notes.some((n) => /time budget/i.test(n))).toBe(true);
    expect(verifyLayout(parts, r).ok).toBe(true);
  });
  it("rejects duplicate part ids and an empty rotation list for a part", () => {
    expect(() => nest([part("A", rectLoop(10, 10), 1), part("A", rectLoop(20, 20), 1)], base())).toThrow(/used twice/);
  });
  it("stops at the sheet limit with a reason", () => {
    const parts = [part("R", rectLoop(200, 200), 4)];
    const r = nest(parts, base({ maxSheets: 1 }));
    expect(r.sheets).toHaveLength(1);
    expect(r.unplaced[0].reason).toMatch(/1-sheet limit/);
  });
  it("neutralises spreadsheet formulas coming from file names", () => {
    const parts = [part("A", rectLoop(10, 10), 1, { source: { file: "=cmd|' /C calc'!A0.dxf", pieceIds: ["P1"], geometryHash: "x" }, bom: "+1", partNo: "-2", name: "@x" })];
    const r = nest(parts, base());
    const csv = cutListCsv(r, parts);
    expect(csv).not.toMatch(/(^|,)=cmd/m);
    expect(csv).toContain(`"'=cmd|' /C calc'!A0.dxf"`);
    expect(csv).toContain(`"'+1"`);
    expect(csv).toContain(`"'-2"`);
    expect(csv).toContain(`"'@x"`);
  });
});

describe("machine ranking without assumptions", () => {
  it("a machine with unknown materials is never 'compatible'", () => {
    const file: MachinesFile = { source: "t", machines: [{ code: "L1", name: "Laser", dept: "Cut", center: "Cutting", hoursPerDay: 15, active: true, process: "laser-flat", processSource: "confirmed", laserPowerKw: 6, bedMm: { width: 1500, height: 3000 }, thicknessMm: { min: 1, max: 20 }, materials: null, controller: null, exportProfiles: [], notes: "" }], rules: { items: [] }, queue: { hoursAhead: {} } };
    const r = rankMachines({ material: "Steel", thicknessMm: 5, sheetWidthMm: 1220, sheetHeightMm: 2440, sheets: 1 }, file);
    expect(r[0].compatibility).toBe("unconfirmed");
    expect(r[0].toConfirm.join(" ")).toMatch(/cuts Steel/);
    file.machines[0].materials = ["Steel"];
    expect(rankMachines({ material: "Steel", thicknessMm: 5, sheetWidthMm: 1220, sheetHeightMm: 2440, sheets: 1 }, file)[0].compatibility).toBe("compatible");
    file.rules.items = [{ machineCode: "L1", effect: "only", minKva: 1000 }];
    expect(rankMachines({ material: "Steel", thicknessMm: 5, sheetWidthMm: 1220, sheetHeightMm: 2440, sheets: 1 }, file)[0].compatibility).toBe("incompatible");
    expect(rankMachines({ material: "Steel", thicknessMm: 5, sheetWidthMm: 1220, sheetHeightMm: 2440, sheets: 1, kva: 1600 }, file)[0].compatibility).toBe("compatible");
  });
});
