import { describe, expect, it } from "vitest";
import { nest, validateSettings } from "./nest";
import { verifyLayout } from "./verify";
import type { NestPartInput, NestSettings } from "./types";
import { lineSeg, fullCircle, segFromBulge } from "../geometry/arc";
import type { Loop } from "../geometry/types";
import { computeNfpConvex } from "./nfp";
import { convexPieces, convexMinkowski, isConvex } from "./convex";
import { fromPath } from "./clipper";

const rect = (w: number, h: number): Loop => ({ segs: [lineSeg({ x: 0, y: 0 }, { x: w, y: 0 }), lineSeg({ x: w, y: 0 }, { x: w, y: h }), lineSeg({ x: w, y: h }, { x: 0, y: h }), lineSeg({ x: 0, y: h }, { x: 0, y: 0 })] });
const poly = (pts: [number, number][]): Loop => ({ segs: pts.map((p, i) => lineSeg({ x: p[0], y: p[1] }, { x: pts[(i + 1) % pts.length][0], y: pts[(i + 1) % pts.length][1] })) });
const Lshape = poly([[0, 0], [100, 0], [100, 50], [50, 50], [50, 100], [0, 100]]);
const base = (over: Partial<NestSettings> = {}): NestSettings => ({ sheet: { widthMm: 500, heightMm: 300, quantity: null, material: "Steel", thicknessMm: 3 }, spacingMm: 5, marginMm: 5, rotationsDeg: [0, 90, 180, 270], allowMirror: false, noGoZones: [], ...over });
const part = (id: string, outer: Loop, quantity: number, extra: Partial<NestPartInput> = {}): NestPartInput => ({ id, label: id, quantity, outer, holes: [], ...extra });

describe("convex decomposition and NFP", () => {
  it("decomposes an L into few convex pieces and sums convex polygons", () => {
    const pieces = convexPieces([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 100 }]);
    expect(pieces.length).toBeLessThanOrEqual(3);
    for (const p of pieces) expect(isConvex(p)).toBe(true);
    const s = convexMinkowski([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }]);
    expect(s).toHaveLength(4);
    expect(Math.max(...s.map((p) => p.x))).toBe(15);
  });
  it("the NFP of two squares is the expected rectangle", () => {
    const sq = (s: number) => [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }];
    const nfp = computeNfpConvex(convexPieces(sq(100)), convexPieces(sq(50)));
    expect(nfp).toHaveLength(1);
    const pts = fromPath(nfp[0]);
    expect(Math.min(...pts.map((p) => p.x))).toBeCloseTo(-50, 3);
    expect(Math.max(...pts.map((p) => p.x))).toBeCloseTo(100, 3);
  });
});

describe("nesting", () => {
  it("places four squares on one sheet with the spacing and margin respected", () => {
    const parts = [part("R", rect(100, 100), 4)];
    const r = nest(parts, base({ sheet: { widthMm: 216, heightMm: 216, quantity: null, material: "Steel", thicknessMm: 3 }, rotationsDeg: [0] }));
    expect(r.sheets).toHaveLength(1);
    expect(r.sheets[0].placements).toHaveLength(4);
    const v = verifyLayout(parts, r);
    expect(v.ok, v.violations.map((x) => x.message).join("; ")).toBe(true);
    expect(v.stats.minClearanceMm!).toBeGreaterThanOrEqual(5);
    expect(v.stats.minEdgeDistanceMm!).toBeGreaterThanOrEqual(5 - 1e-6);
  });
  it("nests true shapes: two L's interlock on a sheet a box nester could not use", () => {
    const parts = [part("L", Lshape, 2)];
    const r = nest(parts, base({ sheet: { widthMm: 101, heightMm: 151, quantity: 1, material: "Steel", thicknessMm: 3 }, spacingMm: 0, marginMm: 0 }));
    expect(r.unplaced).toEqual([]);
    expect(r.sheets[0].placements).toHaveLength(2);
    expect(verifyLayout(parts, r).ok).toBe(true);
    // bounding boxes alone would need 100×200
    const boxes = nest([part("B", rect(100, 100), 2)], base({ sheet: { widthMm: 101, heightMm: 151, quantity: 1, material: "Steel", thicknessMm: 3 }, spacingMm: 0, marginMm: 0 }));
    expect(boxes.unplaced.reduce((n, u) => n + u.quantity, 0)).toBe(1);
  });
  it("reports a part larger than the sheet with the reason, and still nests the rest", () => {
    const parts = [part("big", rect(600, 100), 1), part("small", rect(50, 50), 3)];
    const r = nest(parts, base());
    expect(r.unplaced).toEqual([{ partId: "big", quantity: 1, reason: expect.stringMatching(/larger than the usable sheet/) }]);
    expect(r.sheets[0].placements).toHaveLength(3);
    expect(verifyLayout(parts, r).ok).toBe(true);
  });
  it("respects the allowed rotations", () => {
    const parts = [part("tall", rect(50, 280), 1)];
    const noRot = nest(parts, base({ sheet: { widthMm: 300, heightMm: 100, quantity: null, material: "Steel", thicknessMm: 3 }, rotationsDeg: [0] }));
    expect(noRot.unplaced).toHaveLength(1);
    const rot = nest(parts, base({ sheet: { widthMm: 300, heightMm: 100, quantity: null, material: "Steel", thicknessMm: 3 }, rotationsDeg: [0, 90] }));
    expect(rot.unplaced).toHaveLength(0);
    expect(rot.sheets[0].placements[0].rotationDeg).toBe(90);
    expect(verifyLayout(parts, rot).ok).toBe(true);
  });
  it("spills onto more sheets and stops at the stock", () => {
    const parts = [part("R", rect(200, 200), 5)];
    const r = nest(parts, base({ sheet: { widthMm: 500, heightMm: 300, quantity: null, material: "Steel", thicknessMm: 3 } }));
    expect(r.sheets).toHaveLength(3);
    expect(r.sheets.map((s) => s.placements.length)).toEqual([2, 2, 1]);
    expect(verifyLayout(parts, r).ok).toBe(true);
    const limited = nest(parts, base({ sheet: { widthMm: 500, heightMm: 300, quantity: 2, material: "Steel", thicknessMm: 3 } }));
    expect(limited.sheets).toHaveLength(2);
    expect(limited.unplaced).toEqual([{ partId: "R", quantity: 1, reason: "sheet stock exhausted (2 sheets)" }]);
    expect(verifyLayout(parts, limited).ok).toBe(true);
  });
  it("keeps parts out of no-go zones", () => {
    const parts = [part("R", rect(100, 100), 4)];
    const settings = base({ sheet: { widthMm: 250, heightMm: 250, quantity: null, material: "Steel", thicknessMm: 3 }, noGoZones: [{ x: 0, y: 0, w: 120, h: 120, label: "clamp" }], rotationsDeg: [0] });
    const r = nest(parts, settings);
    const v = verifyLayout(parts, r);
    expect(v.ok, v.violations.map((x) => x.message).join("; ")).toBe(true);
    expect(r.sheets[0].placements.every((p) => p.x >= 125 - 1e-6 || p.y >= 125 - 1e-6)).toBe(true);
  });
  it("accounts for every requested piece and is deterministic", () => {
    const parts = [part("A", Lshape, 3), part("B", rect(120, 40), 5), part("C", { segs: [fullCircle({ x: 0, y: 0 }, 30)] }, 4), part("D", { segs: [lineSeg({ x: 0, y: 0 }, { x: 80, y: 0 }), segFromBulge({ x: 80, y: 0 }, { x: 80, y: 60 }, 0.4), lineSeg({ x: 80, y: 60 }, { x: 0, y: 60 }), lineSeg({ x: 0, y: 60 }, { x: 0, y: 0 })] }, 2)];
    const r1 = nest(parts, base());
    const r2 = nest(parts, base());
    const placed = r1.sheets.reduce((n, s) => n + s.placements.length, 0) + r1.unplaced.reduce((n, u) => n + u.quantity, 0);
    expect(placed).toBe(14);
    expect(r1.sheets.map((s) => s.placements)).toEqual(r2.sheets.map((s) => s.placements));
    const v = verifyLayout(parts, r1);
    expect(v.ok, v.violations.map((x) => x.message).join("; ")).toBe(true);
    for (const p of r1.parts) expect(p.placed + r1.unplaced.filter((u) => u.partId === p.id).reduce((n, u) => n + u.quantity, 0)).toBe(p.quantity);
  });
  it("uses mirrored placements only when allowed", () => {
    const parts = [part("L", Lshape, 2)];
    const r = nest(parts, base({ allowMirror: true, rotationsDeg: [0] }));
    expect(r.sheets[0].placements).toHaveLength(2);
    expect(verifyLayout(parts, r).ok).toBe(true);
    const r2 = nest(parts, base({ allowMirror: false }));
    expect(r2.sheets[0].placements.every((p) => !p.mirrored)).toBe(true);
  });
  it("validates settings before running", () => {
    expect(validateSettings(base({ spacingMm: -1 }), [part("A", rect(10, 10), 1)])).toContain("Part spacing must be zero or positive.");
    expect(validateSettings(base({ rotationsDeg: [] }), [part("A", rect(10, 10), 1)]).length).toBeGreaterThan(0);
    expect(validateSettings(base(), [part("A", rect(10, 10), 0.5)]).length).toBeGreaterThan(0);
    expect(() => nest([], base())).toThrow(/No parts/);
  });
  it("the verifier catches a corrupted layout", () => {
    const parts = [part("R", rect(100, 100), 2)];
    const r = nest(parts, base());
    const p0 = r.sheets[0].placements[0];
    r.sheets[0].placements[1] = { ...r.sheets[0].placements[1], x: p0.x + 50, y: p0.y, bbox: { minX: p0.x + 50, minY: p0.y, maxX: p0.x + 150, maxY: p0.y + 100 } }; // force an overlap
    const v = verifyLayout(parts, r);
    expect(v.ok).toBe(false);
    expect(v.violations.some((x) => x.kind === "overlap")).toBe(true);
  });
});
