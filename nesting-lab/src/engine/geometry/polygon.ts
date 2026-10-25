// Plain polygon arithmetic on vertex lists and exact arithmetic on loops of
// lines and arcs. No external library: this module is also what the independent
// verifier uses, so it must not share code with the Clipper-based nesting core.

import type { BBox, Loop, Point, Polygon, Seg, Transform } from "./types";
import { bboxUnion, emptyBBox } from "./types";
import { arcSweep, dist, reverseSeg, sampleSeg, segBBox, segLength } from "./arc";

export function polygonArea(poly: Polygon): number {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function polygonPerimeter(poly: Polygon): number {
  let l = 0;
  for (let i = 0, n = poly.length; i < n; i++) l += dist(poly[i], poly[(i + 1) % n]);
  return l;
}

export function polygonBBox(poly: Polygon): BBox {
  const b = emptyBBox();
  for (const p of poly) {
    if (p.x < b.minX) b.minX = p.x;
    if (p.y < b.minY) b.minY = p.y;
    if (p.x > b.maxX) b.maxX = p.x;
    if (p.y > b.maxY) b.maxY = p.y;
  }
  return b;
}

export function polygonCentroid(poly: Polygon): Point {
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-12) {
    const b = polygonBBox(poly);
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** Even-odd point in polygon; points on the boundary count as inside. */
export function pointInPolygon(p: Point, poly: Polygon, eps = 1e-9): boolean {
  let inside = false;
  for (let i = 0, n = poly.length, j = n - 1; i < n; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (pointSegmentDistance(p, a, b) <= eps) return true;
    if (a.y > p.y !== b.y > p.y) {
      const x = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < x) inside = !inside;
    }
  }
  return inside;
}

export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-24) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Whether two closed segments intersect (touching counts). */
export function segmentsIntersect(p1: Point, p2: Point, q1: Point, q2: Point, eps = 1e-9): boolean {
  const d1 = cross(q1, q2, p1);
  const d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1);
  const d4 = cross(p1, p2, q2);
  if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) return true;
  if (Math.abs(d1) <= eps && pointSegmentDistance(p1, q1, q2) <= eps) return true;
  if (Math.abs(d2) <= eps && pointSegmentDistance(p2, q1, q2) <= eps) return true;
  if (Math.abs(d3) <= eps && pointSegmentDistance(q1, p1, p2) <= eps) return true;
  if (Math.abs(d4) <= eps && pointSegmentDistance(q2, p1, p2) <= eps) return true;
  return false;
}

export function segmentSegmentDistance(p1: Point, p2: Point, q1: Point, q2: Point): number {
  if (segmentsIntersect(p1, p2, q1, q2)) return 0;
  return Math.min(pointSegmentDistance(p1, q1, q2), pointSegmentDistance(p2, q1, q2), pointSegmentDistance(q1, p1, p2), pointSegmentDistance(q2, p1, p2));
}

/**
 * Exact minimum distance between two simple polygons' boundaries; 0 when the
 * boundaries cross or touch. Does NOT consider containment — callers that need
 * "no overlap" also test a vertex of each polygon against the other.
 */
export function polygonBoundaryDistance(a: Polygon, b: Polygon): number {
  let best = Infinity;
  for (let i = 0, n = a.length; i < n; i++) {
    const a1 = a[i];
    const a2 = a[(i + 1) % n];
    for (let j = 0, m = b.length; j < m; j++) {
      const d = segmentSegmentDistance(a1, a2, b[j], b[(j + 1) % m]);
      if (d < best) {
        best = d;
        if (best === 0) return 0;
      }
    }
  }
  return best;
}

/** True when polygon interiors overlap (shared boundary alone is not overlap). */
export function polygonsOverlap(a: Polygon, b: Polygon, eps = 1e-7): boolean {
  // proper edge crossings
  for (let i = 0, n = a.length; i < n; i++) {
    const a1 = a[i];
    const a2 = a[(i + 1) % n];
    for (let j = 0, m = b.length; j < m; j++) {
      const b1 = b[j];
      const b2 = b[(j + 1) % m];
      const d1 = cross(b1, b2, a1);
      const d2 = cross(b1, b2, a2);
      const d3 = cross(a1, a2, b1);
      const d4 = cross(a1, a2, b2);
      if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) return true;
    }
  }
  // no proper crossing: the interiors still overlap when some point of one
  // boundary (a vertex or an edge midpoint) or an interior point lies strictly
  // inside the other
  const strictlyInside = (p: Point, poly: Polygon) => pointInPolygon(p, poly, -1) && pointSegmentDistanceToPolygon(p, poly) > eps;
  const probes = (poly: Polygon): Point[] => {
    const out: Point[] = [];
    for (let i = 0, n = poly.length; i < n; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % n];
      out.push(p, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
    }
    const c = interiorPoint(poly);
    if (c) out.push(c);
    return out;
  };
  for (const p of probes(a)) if (strictlyInside(p, b)) return true;
  for (const p of probes(b)) if (strictlyInside(p, a)) return true;
  return false;
}

export function pointSegmentDistanceToPolygon(p: Point, poly: Polygon): number {
  let best = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    const d = pointSegmentDistance(p, poly[i], poly[(i + 1) % n]);
    if (d < best) best = d;
  }
  return best;
}

/** A point strictly inside a simple polygon: the centroid when it is inside,
 *  else a point nudged inward from the midpoint of some edge. */
export function interiorPoint(poly: Polygon): Point | null {
  if (poly.length < 3) return null;
  const c = polygonCentroid(poly);
  if (pointInPolygon(c, poly, -1) && pointSegmentDistanceToPolygon(c, poly) > 1e-7) return c;
  const ccw = polygonArea(poly) > 0;
  const b = polygonBBox(poly);
  const scale = Math.max(b.maxX - b.minX, b.maxY - b.minY) || 1;
  for (const step of [1e-4, 1e-3, 1e-2]) {
    const d = scale * step;
    for (let i = 0, n = poly.length; i < n; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % n];
      const l = dist(p, q);
      if (l < 1e-9) continue;
      // left normal of p→q (inside for a ccw polygon)
      let nx = -(q.y - p.y) / l;
      let ny = (q.x - p.x) / l;
      if (!ccw) {
        nx = -nx;
        ny = -ny;
      }
      const m = { x: (p.x + q.x) / 2 + nx * d, y: (p.y + q.y) / 2 + ny * d };
      if (pointInPolygon(m, poly, -1) && pointSegmentDistanceToPolygon(m, poly) > d * 0.5) return m;
    }
  }
  return null;
}

// ---- transforms ----

export function transformPoint(p: Point, t: Transform): Point {
  let x = t.mirror ? -p.x : p.x;
  const y = p.y;
  const rad = (t.rotationDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const rx = x * c - y * s;
  const ry = x * s + y * c;
  x = rx + t.dx;
  return { x, y: ry + t.dy };
}

export function transformSeg(seg: Seg, t: Transform): Seg {
  if (seg.kind === "line") return { kind: "line", a: transformPoint(seg.a, t), b: transformPoint(seg.b, t) };
  const out: Seg = { ...seg, a: transformPoint(seg.a, t), b: transformPoint(seg.b, t), center: transformPoint(seg.center, t), ccw: t.mirror ? !seg.ccw : seg.ccw };
  return out;
}

export function transformLoop(loop: Loop, t: Transform): Loop {
  const segs = loop.segs.map((s) => transformSeg(s, t));
  // a mirror reverses the traversal order so the loop stays a chain
  if (t.mirror) {
    segs.reverse();
    return { segs: segs.map(reverseSeg) };
  }
  return { segs };
}

// ---- loops ----

/** Exact signed area of a loop with arcs (ccw positive). */
export function loopArea(loop: Loop): number {
  let a = 0;
  for (const s of loop.segs) {
    if (s.kind === "arc" && s.full) return (s.ccw ? 1 : -1) * Math.PI * s.r * s.r;
    a += s.a.x * s.b.y - s.b.x * s.a.y;
    if (s.kind === "arc") {
      const sweep = arcSweep(s);
      const segArea = (s.r * s.r * (sweep - Math.sin(sweep))) / 2;
      a += (s.ccw ? 1 : -1) * 2 * segArea;
    }
  }
  return a / 2;
}

export function loopPerimeter(loop: Loop): number {
  let l = 0;
  for (const s of loop.segs) l += segLength(s);
  return l;
}

export function loopBBox(loop: Loop): BBox {
  let b = emptyBBox();
  for (const s of loop.segs) b = bboxUnion(b, segBBox(s));
  return b;
}

/** Make a loop counter-clockwise (positive area). */
export function orientLoop(loop: Loop, ccw = true): Loop {
  const a = loopArea(loop);
  if ((a > 0) === ccw) return loop;
  return { segs: [...loop.segs].reverse().map(reverseSeg) };
}

/** Vertices of the loop sampled with the given sagitta tolerance. `outer`
 *  circumscribes every arc so the polygon contains the true shape. */
export function discretizeLoop(loop: Loop, sagitta: number, outer = false): Polygon {
  const pts: Point[] = [];
  // An arc bulging outward from the material (convex for the loop) is
  // circumscribed by pushing its vertices away from the centre; a concave arc
  // (a notch) is already over-covered by its chords, pushing would cut into the
  // material. Convex ⇔ the arc turns the same way as the loop.
  const loopCcw = loop.segs.length === 1 && loop.segs[0].kind === "arc" && loop.segs[0].full ? loop.segs[0].ccw : loopArea(loop) >= 0;
  for (const s of loop.segs) {
    pts.push(s.a);
    const convex = s.kind === "arc" && s.ccw === loopCcw;
    const sampled = sampleSeg(s, sagitta, outer && convex);
    if (s.kind === "arc" && s.full) {
      // a full circle's samples already stop before the start point
      for (const q of sampled) pts.push(q);
    } else {
      // the last sample of a segment is the start of the next: skip it
      for (let i = 0; i < sampled.length - 1; i++) pts.push(sampled[i]);
    }
  }
  return dedupeConsecutive(pts);
}

export function dedupeConsecutive(pts: Point[], eps = 1e-9): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) <= eps && Math.abs(last.y - p.y) <= eps) continue;
    out.push(p);
  }
  if (out.length > 1) {
    const f = out[0];
    const l = out[out.length - 1];
    if (Math.abs(f.x - l.x) <= eps && Math.abs(f.y - l.y) <= eps) out.pop();
  }
  return out;
}

/** Ramer–Douglas–Peucker on a closed polygon. Keeps at least a triangle. */
export function simplifyPolygon(poly: Polygon, tol: number): Polygon {
  if (poly.length <= 4 || tol <= 0) return poly;
  // split at the two farthest-apart vertices so the closed ring can be treated as two open chains
  let i0 = 0;
  let i1 = 0;
  let best = -1;
  const b = polygonBBox(poly);
  for (let i = 0; i < poly.length; i++) {
    const d = dist(poly[i], { x: b.minX, y: b.minY });
    if (d > best) {
      best = d;
      i0 = i;
    }
  }
  best = -1;
  for (let i = 0; i < poly.length; i++) {
    const d = dist(poly[i], poly[i0]);
    if (d > best) {
      best = d;
      i1 = i;
    }
  }
  const rot = [...poly.slice(i0), ...poly.slice(0, i0)];
  const k = (i1 - i0 + poly.length) % poly.length;
  const c1 = rdp(rot.slice(0, k + 1), tol);
  const c2 = rdp([...rot.slice(k), rot[0]], tol);
  const out = [...c1.slice(0, -1), ...c2.slice(0, -1)];
  return out.length >= 3 ? out : poly;
}

function rdp(pts: Point[], tol: number): Point[] {
  if (pts.length <= 2) return pts;
  let maxD = 0;
  let idx = 0;
  const a = pts[0];
  const b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointSegmentDistance(pts[i], a, b);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= tol) return [a, b];
  const left = rdp(pts.slice(0, idx + 1), tol);
  const right = rdp(pts.slice(idx), tol);
  return [...left.slice(0, -1), ...right];
}

export function translatePolygon(poly: Polygon, dx: number, dy: number): Polygon {
  return poly.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

export function isAxisAlignedRectangle(poly: Polygon, tol = 1e-6): boolean {
  if (poly.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % 4];
    const horizontal = Math.abs(p.y - q.y) <= tol;
    const vertical = Math.abs(p.x - q.x) <= tol;
    if (!horizontal && !vertical) return false;
  }
  return true;
}
