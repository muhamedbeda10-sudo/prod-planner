import { describe, expect, it } from "vitest";
import { segFromBulge, bulgeOf, arcSweep, sampleSeg, fullCircle, lineSeg, dist } from "./arc";
import { loopArea, discretizeLoop, polygonsOverlap, polygonBoundaryDistance, pointInPolygon, orientLoop, transformLoop, simplifyPolygon, loopPerimeter } from "./polygon";
import { buildTopology } from "./topology";
import { classify } from "./classify";
import { dedupePieces, alignPieces } from "./dedupe";
import { simplifyLoop } from "./simplifyLoop";
import type { TaggedSeg } from "../dxf/primitives";
import type { Loop, Seg } from "./types";

const tag = (s: Seg, layer = "0", i = 0): TaggedSeg => ({ ...s, tag: { layer, handle: null, entityType: "T", entityIndex: i, role: "cut" } });
const rectSegs = (x: number, y: number, w: number, h: number, layer = "0"): TaggedSeg[] => [
  tag(lineSeg({ x, y }, { x: x + w, y }), layer, 1),
  tag(lineSeg({ x: x + w, y }, { x: x + w, y: y + h }), layer, 2),
  tag(lineSeg({ x: x + w, y: y + h }, { x, y: y + h }), layer, 3),
  tag(lineSeg({ x, y: y + h }, { x, y }), layer, 4),
];
const CLS = { minPartArea: 1, sliverWidth: 0.2, smallCutoutArea: 10, reviewArea: 0, sheetTol: 0.5, sagitta: 0.05 };

describe("bulges and arcs", () => {
  it("round-trips a bulge through an arc", () => {
    for (const b of [0.1, -0.3, 0.41421356, 1, -1, 2.5]) {
      const s = segFromBulge({ x: 0, y: 0 }, { x: 10, y: 4 }, b);
      expect(s.kind).toBe("arc");
      if (s.kind === "arc") expect(bulgeOf(s)).toBeCloseTo(b, 9);
    }
  });
  it("a quarter fillet has sweep π/2 and the right centre", () => {
    const s = segFromBulge({ x: 10, y: 0 }, { x: 0, y: 10 }, Math.tan(Math.PI / 8));
    if (s.kind !== "arc") throw new Error();
    expect(arcSweep(s)).toBeCloseTo(Math.PI / 2, 9);
    expect(s.center.x).toBeCloseTo(0, 9);
    expect(s.center.y).toBeCloseTo(0, 9);
    expect(s.r).toBeCloseTo(10, 9);
  });
  it("outer sampling circumscribes the arc (no sample inside the circle)", () => {
    const s = fullCircle({ x: 0, y: 0 }, 10);
    const pts = sampleSeg(s, 0.5, true);
    for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeGreaterThanOrEqual(10 - 1e-9);
    const inner = sampleSeg(s, 0.5, false);
    for (const p of inner) expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 9);
  });
  it("loop area of a circle is πr² and of a filleted square is exact", () => {
    expect(loopArea({ segs: [fullCircle({ x: 0, y: 0 }, 5)] })).toBeCloseTo(Math.PI * 25, 9);
    const r = 5;
    const k = Math.tan(Math.PI / 8);
    const loop: Loop = {
      segs: [lineSeg({ x: r, y: 0 }, { x: 100 - r, y: 0 }), segFromBulge({ x: 100 - r, y: 0 }, { x: 100, y: r }, k), lineSeg({ x: 100, y: r }, { x: 100, y: 100 - r }), segFromBulge({ x: 100, y: 100 - r }, { x: 100 - r, y: 100 }, k), lineSeg({ x: 100 - r, y: 100 }, { x: r, y: 100 }), segFromBulge({ x: r, y: 100 }, { x: 0, y: 100 - r }, k), lineSeg({ x: 0, y: 100 - r }, { x: 0, y: r }), segFromBulge({ x: 0, y: r }, { x: r, y: 0 }, k)],
    };
    expect(loopArea(loop)).toBeCloseTo(100 * 100 - (4 - Math.PI) * r * r, 6);
    expect(loopPerimeter(loop)).toBeCloseTo(4 * 90 + 2 * Math.PI * r, 6);
  });
});

describe("polygon arithmetic", () => {
  const sq = (x: number, y: number, s: number) => [
    { x, y },
    { x: x + s, y },
    { x: x + s, y: y + s },
    { x, y: y + s },
  ];
  it("detects overlap, containment and touching", () => {
    expect(polygonsOverlap(sq(0, 0, 10), sq(5, 5, 10))).toBe(true);
    expect(polygonsOverlap(sq(0, 0, 10), sq(10, 0, 10))).toBe(false); // touching edge
    expect(polygonsOverlap(sq(0, 0, 10), sq(2, 2, 3))).toBe(true); // inside
    expect(polygonBoundaryDistance(sq(0, 0, 10), sq(13, 0, 10))).toBeCloseTo(3, 9);
    expect(pointInPolygon({ x: 5, y: 5 }, sq(0, 0, 10))).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, sq(0, 0, 10))).toBe(false);
  });
  it("transforms keep lengths and areas; a mirror flips orientation back to ccw", () => {
    const loop: Loop = { segs: [lineSeg({ x: 0, y: 0 }, { x: 10, y: 0 }), segFromBulge({ x: 10, y: 0 }, { x: 10, y: 10 }, 0.3), lineSeg({ x: 10, y: 10 }, { x: 0, y: 0 })] };
    const t = transformLoop(loop, { rotationDeg: 37, mirror: true, dx: 5, dy: -3 });
    expect(Math.abs(loopArea(t))).toBeCloseTo(Math.abs(loopArea(loop)), 9);
    expect(loopPerimeter(t)).toBeCloseTo(loopPerimeter(loop), 9);
    expect(Math.sign(loopArea(orientLoop(t)))).toBe(1);
    for (let i = 0; i < t.segs.length; i++) expect(dist(t.segs[i].b, t.segs[(i + 1) % t.segs.length].a)).toBeLessThan(1e-9);
  });
  it("simplifies collinear points but keeps corners", () => {
    const poly = [
      { x: 0, y: 0 },
      { x: 5, y: 0.001 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(simplifyPolygon(poly, 0.01)).toHaveLength(4);
    expect(discretizeLoop({ segs: [fullCircle({ x: 0, y: 0 }, 10)] }, 0.1).length).toBeGreaterThan(20);
  });
});

describe("planar topology", () => {
  it("recovers two parts from a common-line cut (shared edge drawn once)", () => {
    // left square drawn closed; right square drawn as 3 open sides, its left side being the shared edge
    const segs: TaggedSeg[] = [...rectSegs(0, 0, 10, 10), tag(lineSeg({ x: 10, y: 0 }, { x: 20, y: 0 }), "1", 5), tag(lineSeg({ x: 20, y: 0 }, { x: 20, y: 10 }), "1", 6), tag(lineSeg({ x: 20, y: 10 }, { x: 10, y: 10 }), "1", 7)];
    const t = buildTopology(segs, { snapTol: 0.01 });
    expect(t.faces).toHaveLength(2);
    expect(t.faces.map((f) => Math.round(f.area)).sort()).toEqual([100, 100]);
    expect(t.open).toHaveLength(0);
    const right = t.faces.find((f) => f.segs.some((s) => s.tag.layer === "1"))!;
    expect(right.shared.filter(Boolean)).toHaveLength(1);
  });
  it("splits at T-junctions and crossings", () => {
    const segs: TaggedSeg[] = [...rectSegs(0, 0, 20, 10), tag(lineSeg({ x: 10, y: 0 }, { x: 10, y: 10 }), "0", 9)];
    const t = buildTopology(segs, { snapTol: 0.01 });
    expect(t.faces).toHaveLength(2);
    expect(t.splitsApplied).toBe(2);
  });
  it("closes gaps within the snap tolerance and reports the largest gap", () => {
    const segs: TaggedSeg[] = [tag(lineSeg({ x: 0, y: 0 }, { x: 10, y: 0 })), tag(lineSeg({ x: 10, y: 0.004 }, { x: 10, y: 10 })), tag(lineSeg({ x: 10, y: 10 }, { x: 0, y: 10 })), tag(lineSeg({ x: 0, y: 10 }, { x: 0, y: 0 }))];
    const t = buildTopology(segs, { snapTol: 0.01 });
    expect(t.faces).toHaveLength(1);
    expect(t.maxGapClosed).toBeCloseTo(0.004, 6);
    const open = buildTopology(segs, { snapTol: 0.001 });
    expect(open.faces).toHaveLength(0);
    expect(open.open.length).toBeGreaterThan(0);
  });
  it("merges duplicate segments and keeps circles as faces", () => {
    const segs: TaggedSeg[] = [...rectSegs(0, 0, 10, 10), ...rectSegs(0, 0, 10, 10), tag(fullCircle({ x: 5, y: 5 }, 2))];
    const t = buildTopology(segs, { snapTol: 0.01 });
    expect(t.duplicatesRemoved).toBe(4);
    expect(t.faces).toHaveLength(2);
  });
  it("reports dangling lines (lead-ins) as open geometry, not parts", () => {
    const segs: TaggedSeg[] = [...rectSegs(0, 0, 10, 10), tag(lineSeg({ x: 10, y: 5 }, { x: 15, y: 5 }), "0", 8)];
    const t = buildTopology(segs, { snapTol: 0.01 });
    expect(t.faces).toHaveLength(1);
    expect(t.open).toHaveLength(1);
    expect(t.open[0].length).toBeCloseTo(5, 6);
  });
  it("handles arc–line intersections", () => {
    const segs: TaggedSeg[] = [...rectSegs(0, 0, 20, 20), tag(fullCircle({ x: 20, y: 10 }, 5))];
    const t = buildTopology(segs, { snapTol: 0.01 });
    // the circle straddles the right edge: three faces (square minus half-disc, half-disc inside, half-disc outside)
    expect(t.faces.length).toBe(3);
    const total = t.faces.reduce((s, f) => s + f.area, 0);
    expect(total).toBeCloseTo(400 + Math.PI * 25 / 2, 3);
  });
});

describe("classification", () => {
  it("finds the sheet boundary, the parts and their holes in a finished nesting", () => {
    const segs: TaggedSeg[] = [...rectSegs(0, 0, 1000, 500), ...rectSegs(10, 10, 300, 200), tag(fullCircle({ x: 100, y: 100 }, 20)), ...rectSegs(400, 10, 300, 200)];
    const c = classify(buildTopology(segs, { snapTol: 0.01 }), [], CLS);
    expect(c.kind).toBe("nesting-ready");
    expect(c.sheetSize).toEqual({ w: 1000, h: 500 });
    expect(c.pieces).toHaveLength(2);
    const withHole = c.pieces.find((p) => p.holes.length === 1)!;
    expect(withHole.area).toBeCloseTo(300 * 200 - Math.PI * 400, 6);
  });
  it("a lone rectangle is a single part; two are a multi-part file", () => {
    expect(classify(buildTopology(rectSegs(0, 0, 50, 20), { snapTol: 0.01 }), [], CLS).kind).toBe("single-part");
    expect(classify(buildTopology([...rectSegs(0, 0, 50, 20), ...rectSegs(100, 0, 50, 20)], { snapTol: 0.01 }), [], CLS).kind).toBe("multi-part");
  });
  it("does not take a rectangle for a sheet when nothing is inside it", () => {
    const c = classify(buildTopology(rectSegs(0, 0, 1220, 2440), { snapTol: 0.01 }), [], CLS);
    expect(c.kind).toBe("single-part");
    expect(c.sheetBoundary).toBeNull();
  });
  it("ignores slivers between near-coincident edges and lettering islands", () => {
    const segs: TaggedSeg[] = [...rectSegs(0, 0, 100, 50), tag(lineSeg({ x: 0, y: 50.05 }, { x: 100, y: 50.05 }), "0", 9), tag(lineSeg({ x: 100, y: 50.05 }, { x: 100, y: 100 }), "0", 10), tag(lineSeg({ x: 100, y: 100 }, { x: 0, y: 100 }), "0", 11), tag(lineSeg({ x: 0, y: 100 }, { x: 0, y: 50.05 }), "0", 12), tag(lineSeg({ x: 0, y: 50.05 }, { x: 0, y: 50 }), "0", 13), tag(lineSeg({ x: 100, y: 50 }, { x: 100, y: 50.05 }), "0", 14)];
    const c = classify(buildTopology(segs, { snapTol: 0.001 }), [], CLS);
    expect(c.pieces).toHaveLength(2);
    expect(c.ignoredFaces.some((g) => /sliver/.test(g.reason))).toBe(true);
    // a "0" glyph cut into a plate: outer loop 3×3 with an inner island → the island is not a part
    // (a second plate keeps the first from being taken for a sheet boundary)
    const glyph: TaggedSeg[] = [...rectSegs(0, 0, 100, 100), ...rectSegs(10, 10, 3, 3, "0"), ...rectSegs(11, 11, 1, 1.5, "0"), ...rectSegs(150, 0, 40, 40)];
    const g = classify(buildTopology(glyph, { snapTol: 0.001 }), [], CLS);
    expect(g.pieces).toHaveLength(2);
    expect(g.pieces[0].holes).toHaveLength(1);
    expect(g.ignoredFaces.some((x) => /lettering/.test(x.reason))).toBe(true);
  });
  it("assigns marks to the piece that contains them", () => {
    const segs = rectSegs(0, 0, 100, 100);
    const mark: TaggedSeg = { ...fullCircle({ x: 50, y: 50 }, 1), tag: { layer: "AXES", handle: null, entityType: "CIRCLE", entityIndex: 99, role: "mark" } };
    const c = classify(buildTopology(segs, { snapTol: 0.01 }), [mark], CLS);
    expect(c.pieces[0].marks).toHaveLength(1);
    expect(c.pieces[0].holes).toHaveLength(0);
  });
});

describe("identical parts", () => {
  const segsL = (x: number, y: number, mirror = false): TaggedSeg[] => {
    // a chiral L (30 mm bar, 50 mm column) and its mirror image (column on the right)
    const pts = mirror ? [[0, 0], [100, 0], [100, 100], [50, 100], [50, 30], [0, 30]] : [[0, 0], [100, 0], [100, 30], [50, 30], [50, 100], [0, 100]];
    return pts.map((p, i) => tag(lineSeg({ x: x + p[0], y: y + p[1] }, { x: x + pts[(i + 1) % pts.length][0], y: y + pts[(i + 1) % pts.length][1] }), "0", i));
  };
  it("groups rotated copies and keeps mirror images apart", () => {
    const rot = (segs: TaggedSeg[], deg: number, dx: number): TaggedSeg[] => transformLoop({ segs }, { rotationDeg: deg, mirror: false, dx, dy: 0 }).segs.map((s, i) => tag(s, "0", i));
    const all = [...segsL(0, 0), ...rot(segsL(0, 0), 90, 400), ...segsL(0, 300, true)];
    const c = classify(buildTopology(all, { snapTol: 0.01 }), [], CLS);
    expect(c.pieces).toHaveLength(3);
    const d = dedupePieces(c.pieces, { tol: 0.02 });
    expect(d.groups).toHaveLength(2);
    const big = d.groups.find((g) => g.instances.length === 2)!;
    // the representative may be either copy, so the other is +90° or −90° from it
    expect([90, 270]).toContain(((Math.round(big.instances[1].transform.rotationDeg) % 360) + 360) % 360);
    const mirror = d.groups.find((g) => g.instances.length === 1)!;
    expect(mirror.mirrorOf).toBe(d.groups.indexOf(big));
  });
  it("does not merge parts that differ only in a hole", () => {
    const segs: TaggedSeg[] = [...rectSegs(0, 0, 50, 50), ...rectSegs(100, 0, 50, 50), tag(fullCircle({ x: 125, y: 25 }, 5))];
    const c = classify(buildTopology(segs, { snapTol: 0.01 }), [], CLS);
    const d = dedupePieces(c.pieces, { tol: 0.02 });
    expect(d.groups).toHaveLength(2);
    expect(alignPieces(c.pieces[0], c.pieces[1], 0.02, false)).toBeNull();
  });
  it("canonical loops merge collinear pieces left by neighbours' corners", () => {
    const loop: Loop = { segs: [lineSeg({ x: 0, y: 0 }, { x: 5, y: 0 }), lineSeg({ x: 5, y: 0 }, { x: 10, y: 0 }), lineSeg({ x: 10, y: 0 }, { x: 10, y: 10 }), lineSeg({ x: 10, y: 10 }, { x: 0, y: 10 }), lineSeg({ x: 0, y: 10 }, { x: 0, y: 0 })] };
    expect(simplifyLoop(loop).segs).toHaveLength(4);
  });
});
