// No-fit polygons via Minkowski sums (Clipper). For a fixed polygon A and a
// moving polygon B, NFP(A,B) is the set of translations t of B's origin for
// which B+t overlaps A. We compute ∂A ⊕ (−B): the Minkowski sum of A's
// boundary with the reflected B. Its outer boundary is the NFP; a hole in the
// result is either a pocket of A where B fits (kept — a valid position) or the
// interior of A where B would sit fully inside solid material (filled in).

import { discretizeLoop, loopBBox, polygonArea, polygonBBox, simplifyPolygon } from "../geometry/polygon";
import type { Loop, Polygon } from "../geometry/types";
import { transformLoop } from "../geometry/polygon";
import { fromPath, minkowski, negatePath, offsetPaths, orientation, pathArea, pointIn, toPath, unionPaths, type IPath, type IPaths } from "./clipper";
import { convexMinkowski, convexPieces } from "./convex";

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
  const rotated = transformLoop(outer, { rotationDeg, mirror: mirrored, dx: 0, dy: 0 });
  let poly = discretizeLoop(rotated, opts.sagittaMm, true);
  if (polygonArea(poly) < 0) poly = poly.slice().reverse();
  // the shift comes from the EXACT contour so placement boxes are true sizes
  const b = loopBBox(rotated);
  const shift = { dx: -b.minX, dy: -b.minY };
  const loop = transformLoop(rotated, { rotationDeg: 0, mirror: false, dx: shift.dx, dy: shift.dy });
  poly = poly.map((p) => ({ x: p.x + shift.dx, y: p.y + shift.dy }));
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

export class NfpCache {
  private cache = new Map<string, IPaths>();
  computed = 0;
  hits = 0;
  /** milliseconds spent computing NFPs */
  ms = 0;

  /** NFP of moving `b` around fixed `a` placed at the origin. */
  get(a: { key: string; grown: IPath; convex?: Polygon[] }, b: { key: string; grown: IPath; convex?: Polygon[] }): IPaths {
    const k = `${a.key}|${b.key}`;
    const hit = this.cache.get(k);
    if (hit) {
      this.hits++;
      return hit;
    }
    this.computed++;
    const t0 = performance.now();
    const ca = a.convex ?? convexPieces(fromPath(a.grown));
    const cb = b.convex ?? convexPieces(fromPath(b.grown));
    const nfp = computeNfpConvex(ca, cb);
    this.ms += performance.now() - t0;
    this.cache.set(k, nfp);
    return nfp;
  }
}

/** NFP from convex decompositions: ∪ (Ai ⊕ −Bj) is exactly A ⊕ −B for filled
 *  polygons, so pockets come out as holes and solid interiors stay solid. */
export function computeNfpConvex(fixedPieces: Polygon[], movingPieces: Polygon[]): IPaths {
  const sums: IPaths = [];
  for (const A of fixedPieces) {
    for (const B of movingPieces) {
      const negB = B.map((p) => ({ x: -p.x, y: -p.y })); // a point reflection is a 180° rotation: orientation stays ccw
      sums.push(toPath(convexMinkowski(A, negB)));
    }
  }
  if (sums.length === 1) return sums;
  return unionPaths(sums);
}

/** Both inputs are closed ccw integer paths. */
export function computeNfp(fixed: IPath, moving: IPath): IPaths {
  const raw = minkowski(negatePath(moving), fixed);
  const merged = unionPaths(raw);
  const out: IPaths = [];
  const outers = merged.filter((p) => orientation(p));
  const holes = merged.filter((p) => !orientation(p));
  out.push(...outers);
  const ref = moving[0];
  for (const h of holes) {
    // a point strictly inside the hole: average of the vertices works for the
    // convex-ish holes this produces; fall back to the first vertex nudged in
    let cx = 0;
    let cy = 0;
    for (const p of h) {
      cx += p.X;
      cy += p.Y;
    }
    cx /= h.length;
    cy /= h.length;
    let probe = { X: Math.round(cx), Y: Math.round(cy) };
    if (pointIn({ x: probe.X / 1000, y: probe.Y / 1000 }, h) === 0) probe = h[0];
    // B translated by probe: is its reference vertex inside A's solid?
    const inside = pointIn({ x: (ref.X + probe.X) / 1000, y: (ref.Y + probe.Y) / 1000 }, fixed) !== 0;
    if (!inside) out.push(h); // a real pocket: B fits there
    // else: B would be inside A's material — the hole is not a valid position, drop it
  }
  return out;
}
