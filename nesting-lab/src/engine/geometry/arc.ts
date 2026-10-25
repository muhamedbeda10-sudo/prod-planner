// Arc arithmetic: DXF bulges, angles, discretisation. A bulge is tan(θ/4) of the
// included angle θ, positive when the arc turns counter-clockwise from the
// chord's start to its end. The conversions here are exact in both directions.

import type { ArcSeg, LineSeg, Point, Seg, BBox } from "./types";
import { emptyBBox } from "./types";

export const TWO_PI = Math.PI * 2;

export function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function normAngle(a: number): number {
  let r = a % TWO_PI;
  if (r < 0) r += TWO_PI;
  return r;
}

export function angleOf(center: Point, p: Point): number {
  return Math.atan2(p.y - center.y, p.x - center.x);
}

/** Build an arc segment from a DXF vertex pair and the bulge stored on the
 *  first vertex. A zero bulge gives a line. */
export function segFromBulge(a: Point, b: Point, bulge: number): Seg {
  if (!bulge || Math.abs(bulge) < 1e-12) return { kind: "line", a, b };
  const chord = dist(a, b);
  if (chord < 1e-12) return { kind: "line", a, b };
  const theta = 4 * Math.atan(Math.abs(bulge)); // included angle, 0..2π
  const r = chord / (2 * Math.sin(theta / 2));
  // distance from chord midpoint to the centre (negative when the centre lies
  // on the far side of the chord, i.e. included angle > π)
  const d = (chord / 2) / Math.tan(theta / 2);
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  // unit normal to the chord, pointing left of a→b
  const nx = -(b.y - a.y) / chord;
  const ny = (b.x - a.x) / chord;
  const ccw = bulge > 0;
  // for a ccw arc the centre is on the left of the chord
  const s = ccw ? 1 : -1;
  const center = { x: mx + s * nx * d, y: my + s * ny * d };
  return { kind: "arc", a, b, center, r, ccw };
}

/** The included angle of an arc (0..2π; 2π for a full circle). */
export function arcSweep(arc: ArcSeg): number {
  if (arc.full) return TWO_PI;
  const a0 = angleOf(arc.center, arc.a);
  const a1 = angleOf(arc.center, arc.b);
  let sweep = arc.ccw ? a1 - a0 : a0 - a1;
  sweep = normAngle(sweep);
  if (sweep < 1e-12) sweep = TWO_PI; // a == b: must be a full circle
  return sweep;
}

/** The DXF bulge that reproduces this arc from a to b. */
export function bulgeOf(arc: ArcSeg): number {
  const sweep = arcSweep(arc);
  const b = Math.tan(sweep / 4);
  return arc.ccw ? b : -b;
}

export function segLength(s: Seg): number {
  if (s.kind === "line") return dist(s.a, s.b);
  return s.r * arcSweep(s);
}

/** Point on the arc at fraction t (0..1) of its sweep. */
export function arcPointAt(arc: ArcSeg, t: number): Point {
  const a0 = angleOf(arc.center, arc.a);
  const sweep = arcSweep(arc);
  const ang = arc.ccw ? a0 + sweep * t : a0 - sweep * t;
  return { x: arc.center.x + arc.r * Math.cos(ang), y: arc.center.y + arc.r * Math.sin(ang) };
}

/** Unit tangent of travel at the start (t=0) or end (t=1) of a segment. */
export function segTangent(s: Seg, atEnd: boolean): Point {
  if (s.kind === "line") {
    const l = dist(s.a, s.b) || 1;
    return { x: (s.b.x - s.a.x) / l, y: (s.b.y - s.a.y) / l };
  }
  const p = atEnd ? s.b : s.a;
  const rx = p.x - s.center.x;
  const ry = p.y - s.center.y;
  const l = Math.hypot(rx, ry) || 1;
  // ccw travel: tangent is radius rotated +90°
  return s.ccw ? { x: -ry / l, y: rx / l } : { x: ry / l, y: -rx / l };
}

/** Signed curvature of travel (+ turning left / ccw). 0 for a line. */
export function segCurvature(s: Seg): number {
  if (s.kind === "line") return 0;
  return (s.ccw ? 1 : -1) / s.r;
}

export function reverseSeg<T extends Seg>(s: T): T {
  if (s.kind === "line") return { ...s, a: s.b, b: s.a };
  return { ...s, a: s.b, b: s.a, ccw: !s.ccw };
}

/** Number of chords so that the sagitta (chord-to-arc gap) stays ≤ `sagitta`. */
/** Hard cap on chords per arc: a hostile radius must not become an endless loop. */
export const MAX_CHORDS_PER_ARC = 4096;

export function arcChordCount(r: number, sweep: number, sagitta: number): number {
  if (!(r > 0) || !(sweep > 0)) return 1;
  if (r <= sagitta) return Math.max(1, Math.ceil(sweep / (Math.PI / 2)));
  const step = 2 * Math.acos(1 - sagitta / r);
  if (!(step > 0)) return MAX_CHORDS_PER_ARC;
  const n = Math.ceil(sweep / step);
  if (!Number.isFinite(n)) return MAX_CHORDS_PER_ARC;
  return Math.max(1, Math.min(MAX_CHORDS_PER_ARC, n));
}

/**
 * Sample points along a segment, excluding the start point and including the
 * end point. `outer` pushes the intermediate points of an arc outward so the
 * resulting polyline circumscribes the true arc (never cuts inside it).
 */
export function sampleSeg(s: Seg, sagitta: number, outer = false): Point[] {
  if (s.kind === "line") return [s.b];
  const sweep = arcSweep(s);
  const n = arcChordCount(s.r, sweep, sagitta);
  const pts: Point[] = [];
  const a0 = angleOf(s.center, s.a);
  const half = sweep / n / 2;
  const rOut = outer ? s.r / Math.cos(half) : s.r;
  const at = (ang: number, radius: number): Point => ({ x: s.center.x + radius * Math.cos(ang), y: s.center.y + radius * Math.sin(ang) });
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const ang = s.ccw ? a0 + sweep * t : a0 - sweep * t;
    if (outer) {
      // the vertex where the tangents at the two chord ends meet: every edge of
      // the sampled polyline then lies on or outside the true arc
      const angMid = s.ccw ? a0 + sweep * (t - 0.5 / n) : a0 - sweep * (t - 0.5 / n);
      pts.push(at(angMid, rOut));
    }
    if (i === n && !s.full) pts.push(s.b);
    else pts.push(at(ang, s.r));
  }
  if (s.full) {
    // a full circle: the last sample equals the first point, drop it so the
    // polygon closes implicitly
    pts.pop();
  }
  return pts;
}

export function segBBox(s: Seg): BBox {
  const b = emptyBBox();
  const add = (p: Point) => {
    b.minX = Math.min(b.minX, p.x);
    b.minY = Math.min(b.minY, p.y);
    b.maxX = Math.max(b.maxX, p.x);
    b.maxY = Math.max(b.maxY, p.y);
  };
  add(s.a);
  add(s.b);
  if (s.kind === "arc") {
    // include the axis extremes the arc passes through
    const a0 = angleOf(s.center, s.a);
    const sweep = arcSweep(s);
    for (const q of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      const rel = s.ccw ? normAngle(q - a0) : normAngle(a0 - q);
      if (s.full || rel <= sweep + 1e-12) add({ x: s.center.x + s.r * Math.cos(q), y: s.center.y + s.r * Math.sin(q) });
    }
  }
  return b;
}

export function lineSeg(a: Point, b: Point): LineSeg {
  return { kind: "line", a, b };
}

/** An arc given by centre, radius and start/end angles (radians, ccw). */
export function arcFromAngles(center: Point, r: number, startAng: number, endAng: number): ArcSeg {
  const a = { x: center.x + r * Math.cos(startAng), y: center.y + r * Math.sin(startAng) };
  const b = { x: center.x + r * Math.cos(endAng), y: center.y + r * Math.sin(endAng) };
  return { kind: "arc", a, b, center, r, ccw: true };
}

export function fullCircle(center: Point, r: number): ArcSeg {
  const a = { x: center.x + r, y: center.y };
  return { kind: "arc", a, b: { ...a }, center, r, ccw: true, full: true };
}
