// Convex decomposition and convex Minkowski sums. The Minkowski sum of two
// filled polygons equals the union of the sums of their convex pieces, and the
// sum of two convex polygons is a simple edge merge — orders of magnitude
// cheaper than unioning n×m parallelograms.

import type { Point, Polygon } from "../geometry/types";
import { dist } from "../geometry/arc";

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Remove duplicate and collinear vertices; keeps ccw orientation. */
export function cleanPolygon(poly: Polygon, eps = 1e-7): Polygon {
  let pts = poly.filter((p, i) => {
    const q = poly[(i + 1) % poly.length];
    return dist(p, q) > eps;
  });
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      const l = dist(a, c) || 1;
      if (Math.abs(cross(a, b, c)) / l <= eps) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

export function isConvex(poly: Polygon, eps = 1e-9): boolean {
  const n = poly.length;
  if (n < 4) return true;
  for (let i = 0; i < n; i++) {
    const c = cross(poly[i], poly[(i + 1) % n], poly[(i + 2) % n]);
    if (c < -eps) return false;
  }
  return true;
}

function pointInTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** Ear-clipping triangulation of a simple ccw polygon → index triples. */
export function triangulate(poly: Polygon): [number, number, number][] {
  const n = poly.length;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  const tris: [number, number, number][] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const ia = idx[(k - 1 + idx.length) % idx.length];
      const ib = idx[k];
      const ic = idx[(k + 1) % idx.length];
      const a = poly[ia];
      const b = poly[ib];
      const c = poly[ic];
      if (cross(a, b, c) <= 1e-12) continue; // reflex or degenerate
      let ok = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (pointInTriangle(poly[j], a, b, c)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      tris.push([ia, ib, ic]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // numerically stuck (near-degenerate polygon): clip the least-bad ear
      let bestK = 0;
      let bestC = -Infinity;
      for (let k = 0; k < idx.length; k++) {
        const c = cross(poly[idx[(k - 1 + idx.length) % idx.length]], poly[idx[k]], poly[idx[(k + 1) % idx.length]]);
        if (c > bestC) {
          bestC = c;
          bestK = k;
        }
      }
      tris.push([idx[(bestK - 1 + idx.length) % idx.length], idx[bestK], idx[(bestK + 1) % idx.length]]);
      idx.splice(bestK, 1);
    }
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

/** Hertel–Mehlhorn: merge triangles across diagonals while convex. */
export function convexPieces(polyIn: Polygon): Polygon[] {
  const poly = cleanPolygon(polyIn);
  if (poly.length < 3) return [];
  if (isConvex(poly)) return [poly];
  const tris = triangulate(poly);
  // pieces as index rings (ccw)
  let pieces: number[][] = tris.map((t) => [...t]);
  const edgeKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  let merged = true;
  while (merged) {
    merged = false;
    const byEdge = new Map<string, number[]>();
    pieces.forEach((p, pi) => {
      for (let i = 0; i < p.length; i++) {
        const k = edgeKey(p[i], p[(i + 1) % p.length]);
        const arr = byEdge.get(k) ?? [];
        arr.push(pi);
        byEdge.set(k, arr);
      }
    });
    for (const [k, owners] of byEdge) {
      if (owners.length !== 2) continue;
      const [pa, pb] = owners;
      const A = pieces[pa];
      const B = pieces[pb];
      const [e0, e1] = k.split("-").map(Number);
      // orient the diagonal as A walks it (u → v); B walks it v → u
      let u = -1;
      let v = -1;
      for (let i = 0; i < A.length; i++) {
        const x = A[i];
        const y = A[(i + 1) % A.length];
        if ((x === e0 && y === e1) || (x === e1 && y === e0)) {
          u = x;
          v = y;
          break;
        }
      }
      if (u < 0) continue;
      // merge A and B along diagonal u-v: walk A from v to u, then B from u to v
      const ia = A.indexOf(v);
      const ib = B.indexOf(u);
      if (ia < 0 || ib < 0) continue;
      const ring: number[] = [];
      for (let i = 0; i < A.length; i++) ring.push(A[(ia + i) % A.length]); // v … u
      if (ring[ring.length - 1] !== u) continue;
      for (let i = 1; i < B.length - 1; i++) ring.push(B[(ib + i) % B.length]); // after u … before v
      const ptsRing = ring.map((i) => poly[i]);
      if (!isConvex(ptsRing, -1e-9)) continue;
      pieces = pieces.filter((_, i) => i !== pa && i !== pb);
      pieces.push(ring);
      merged = true;
      break;
    }
  }
  return pieces.map((ring) => cleanPolygon(ring.map((i) => poly[i])));
}

/** Minkowski sum of two convex ccw polygons (edge merge). */
export function convexMinkowski(A: Polygon, B: Polygon): Polygon {
  const lowest = (P: Polygon) => {
    let k = 0;
    for (let i = 1; i < P.length; i++) if (P[i].y < P[k].y || (P[i].y === P[k].y && P[i].x < P[k].x)) k = i;
    return k;
  };
  const ia = lowest(A);
  const ib = lowest(B);
  const n = A.length;
  const m = B.length;
  const out: Polygon = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const a = A[(ia + i) % n];
    const b = B[(ib + j) % m];
    out.push({ x: a.x + b.x, y: a.y + b.y });
    const a2 = A[(ia + i + 1) % n];
    const b2 = B[(ib + j + 1) % m];
    const ca = { x: a2.x - a.x, y: a2.y - a.y };
    const cb = { x: b2.x - b.x, y: b2.y - b.y };
    const cr = ca.x * cb.y - ca.y * cb.x;
    if (i >= n) j++;
    else if (j >= m) i++;
    else if (cr > 1e-12) i++;
    else if (cr < -1e-12) j++;
    else {
      i++;
      j++;
    }
  }
  return cleanPolygon(out);
}
