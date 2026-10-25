// No-fit polygons from convex decompositions. For a fixed polygon A and a
// moving polygon B, NFP(A,B) is the set of translations t of B's origin for
// which B+t overlaps A — the Minkowski sum A ⊕ (−B). Both polygons are split
// into convex pieces; the sum of two convex polygons is a simple edge merge,
// and the union of all piece sums is exactly the NFP of the filled shapes
// (pockets come out as holes, solid interiors stay solid).
//
// NFPs are rotation-covariant — NFP(A@r, B@s) = rot_r(NFP(A@0, B@(s−r))) up to
// the parts' bbox shifts — so the cache is keyed on the relative rotation and
// a cached result is rotated and shifted on retrieval.

import { discretizeLoop, loopBBox, polygonArea, polygonBBox, simplifyPolygon } from "../geometry/polygon";
import type { Loop, Polygon } from "../geometry/types";
import { fromPath, offsetPaths, orientation, pathArea, toPath, unionPaths, SCALE, type IPath, type IPaths } from "./clipper";
import { convexMinkowski, convexPieces } from "./convex";
import { placementTransform } from "./placement";
import { transformLoop } from "../geometry/polygon";

export interface Variant {
  /** "partId@rot[m]" */
  key: string;
  /** convex decomposition of `grown` (mm) */
  convex: Polygon[];
  partId: string;
  rotationDeg: number;
  mirrored: boolean;
  /** exact loop, rotated/mirrored, translated so the outer bbox min is (0,0) */
  loop: Loop;
  /** translation that moved the bbox min to the origin */
  shift: { dx: number; dy: number };
  /** circumscribing polygon of the outer contour, bbox min at (0,0) */
  poly: Polygon;
  /** poly offset outward by spacing/2 */
  grown: IPath;
  grownBounds: { minX: number; minY: number; maxX: number; maxY: number };
  width: number;
  height: number;
  area: number;
}

export interface VariantOptions {
  /** arc tolerance of the circumscribing polygon (mm) */
  sagittaMm: number;
  /** vertex simplification (mm); added to the offset so the result stays conservative */
  simplifyTolMm: number;
  spacingMm: number;
  /** round-join tolerance of the offset (mm); added to the offset as well */
  arcTolMm?: number;
}

/** How much farther apart than `spacing` two parts may end up because of the
 *  conservative polygons: at most 2 × (simplifyTol + arcTol). */
export function conservativenessMm(opts: VariantOptions): number {
  return 2 * (opts.simplifyTolMm + (opts.arcTolMm ?? DEFAULT_ARC_TOL));
}

export const DEFAULT_ARC_TOL = 0.1;

export function makeVariant(partId: string, outer: Loop, rotationDeg: number, mirrored: boolean, opts: VariantOptions): Variant {
  // the pose at (0,0): the same definition every consumer of a placement uses
  const t = placementTransform({ outer }, { rotationDeg, mirrored, x: 0, y: 0 });
  const loop = transformLoop(outer, t);
  const shift = { dx: t.dx, dy: t.dy };
  let poly = discretizeLoop(loop, opts.sagittaMm, true);
  if (polygonArea(poly) < 0) poly = poly.slice().reverse();
  const simplified = simplifyPolygon(poly, opts.simplifyTolMm);
  // Simplification may move the boundary inward by up to simplifyTol and the
  // round joins of the offset are inscribed chords up to arcTol inside the true
  // offset: both are added to the offset so the grown polygon always contains
  // the true contour grown by spacing/2.
  const arcTol = opts.arcTolMm ?? DEFAULT_ARC_TOL;
  const delta = opts.spacingMm / 2 + opts.simplifyTolMm + arcTol;
  const grownPaths = delta > 0 ? offsetPaths([toPath(simplified)], delta, arcTol) : [toPath(simplified)];
  // offsetting a simple polygon yields one outer path (it may also produce tiny
  // artefacts); keep the largest
  let grown = grownPaths[0] ?? toPath(simplified);
  for (const p of grownPaths) if (Math.abs(pathArea(p)) > Math.abs(pathArea(grown))) grown = p;
  if (!orientation(grown)) grown = grown.slice().reverse();
  const grownPoly = fromPath(grown);
  const gb = polygonBBox(grownPoly);
  const b = loopBBox(loop);
  return {
    key: `${partId}@${rotationDeg}${mirrored ? "m" : ""}`,
    convex: convexPieces(grownPoly),
    partId,
    rotationDeg,
    mirrored,
    loop,
    shift,
    poly: simplified,
    grown,
    grownBounds: gb,
    width: b.maxX - b.minX,
    height: b.maxY - b.minY,
    area: polygonArea(simplified),
  };
}

/** A fixed obstacle that is not a part (a no-go zone): cached by key only. */
export interface FixedObstacle {
  key: string;
  grown: IPath;
  convex?: Polygon[];
}

function rotatePath(path: IPath, deg: number): IPath {
  const r = ((deg % 360) + 360) % 360;
  if (r === 0) return path;
  if (r === 90) return path.map((p) => ({ X: -p.Y, Y: p.X }));
  if (r === 180) return path.map((p) => ({ X: -p.X, Y: -p.Y }));
  if (r === 270) return path.map((p) => ({ X: p.Y, Y: -p.X }));
  const rad = (r * Math.PI) / 180;
  const c = Math.cos(rad);
  const sn = Math.sin(rad);
  return path.map((p) => ({ X: Math.round(p.X * c - p.Y * sn), Y: Math.round(p.X * sn + p.Y * c) }));
}

function translateIntPath(path: IPath, dx: number, dy: number): IPath {
  const X = Math.round(dx * SCALE);
  const Y = Math.round(dy * SCALE);
  return path.map((p) => ({ X: p.X + X, Y: p.Y + Y }));
}

export class NfpCache {
  private base = new Map<string, IPaths>();
  private direct = new Map<string, IPaths>();
  computed = 0;
  hits = 0;
  /** milliseconds spent computing NFPs */
  ms = 0;

  /** @param variantFor builds (or fetches) the variant of a part at any rotation/mirror */
  constructor(private variantFor: (partId: string, rotationDeg: number, mirrored: boolean) => Variant) {}

  /** NFP of moving `b` around fixed `a` placed at the origin. */
  get(a: Variant | FixedObstacle, b: Variant): IPaths {
    if (!("partId" in a)) return this.getDirect(a, b);
    // NFP(A@ra, B@rb) = rot_ra( NFP(A@0, B@(rb−ra)) ) + (shift_a − shift_b), with the
    // base NFP computed on the UNSHIFTED grown polygons
    const rel = (((b.rotationDeg - a.rotationDeg) % 360) + 360) % 360;
    const key = `${a.partId}${a.mirrored ? "m" : ""}|${b.partId}${b.mirrored ? "m" : ""}|${rel}`;
    let base = this.base.get(key);
    if (base) this.hits++;
    else {
      this.computed++;
      const t0 = performance.now();
      const a0 = this.variantFor(a.partId, 0, a.mirrored);
      const bRel = this.variantFor(b.partId, rel, b.mirrored);
      const unshift = (v: Variant) => convexPieces(fromPath(translateIntPath(v.grown, -v.shift.dx, -v.shift.dy)));
      base = computeNfpConvex(unshift(a0), unshift(bRel));
      this.ms += performance.now() - t0;
      this.base.set(key, base);
    }
    const dx = a.shift.dx - b.shift.dx;
    const dy = a.shift.dy - b.shift.dy;
    return base.map((path) => translateIntPath(rotatePath(path, a.rotationDeg), dx, dy));
  }

  private getDirect(a: FixedObstacle, b: Variant): IPaths {
    const k = `${a.key}|${b.key}`;
    const hit = this.direct.get(k);
    if (hit) {
      this.hits++;
      return hit;
    }
    this.computed++;
    const t0 = performance.now();
    const nfp = computeNfpConvex(a.convex ?? convexPieces(fromPath(a.grown)), b.convex);
    this.ms += performance.now() - t0;
    this.direct.set(k, nfp);
    return nfp;
  }
}

/** NFP from convex decompositions: ∪ (Ai ⊕ −Bj) is exactly A ⊕ −B for filled
 *  polygons, so pockets come out as holes and solid interiors stay solid. */
export function computeNfpConvex(fixedPieces: Polygon[], movingPieces: Polygon[]): IPaths {
  // a point reflection is a 180° rotation: orientation stays ccw
  const negated = movingPieces.map((B) => B.map((p) => ({ x: -p.x, y: -p.y })));
  const sums: IPaths = [];
  for (const A of fixedPieces) for (const negB of negated) sums.push(toPath(convexMinkowski(A, negB)));
  if (sums.length === 1) return sums;
  return unionPaths(sums);
}

