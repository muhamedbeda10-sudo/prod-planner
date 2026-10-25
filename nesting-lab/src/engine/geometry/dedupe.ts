// Group identical pieces of a nesting into part types by exact rigid
// alignment: two pieces are the same part when one can be rotated and moved
// onto the other with every vertex, arc centre and hole matching within
// tolerance. A mirror image is NOT the same part (a left and a right bracket
// are different pieces to cut); it is recorded as "mirror of" instead.

import { IDENTITY, type Loop, type Point, type Seg, type Transform } from "./types";
import type { Piece } from "./classify";
import { dist, segLength } from "./arc";
import { transformLoop, transformPoint } from "./polygon";

export interface PartInstance {
  pieceId: string;
  /** maps the type's canonical geometry onto the piece as drawn */
  transform: Transform;
}

export interface PartTypeGeometry {
  outer: Loop;
  holes: Loop[];
  marks: Seg[];
}

export interface DedupeResult {
  groups: { representative: Piece; instances: PartInstance[]; mirrorOf: number | null }[];
}

export interface DedupeOptions {
  tol: number;
}

function loopVertices(loop: Loop): Point[] {
  return loop.segs.map((s) => s.a);
}

function sameSegShape(a: Seg, b: Seg, tol: number): boolean {
  if (a.kind !== b.kind) return false;
  if (Math.abs(segLength(a) - segLength(b)) > tol) return false;
  if (a.kind === "arc" && b.kind === "arc") {
    if (Math.abs(a.r - b.r) > tol) return false;
    if (a.ccw !== b.ccw) return false;
    if (!!a.full !== !!b.full) return false;
  }
  return true;
}

/** Rigid transform taking frame (p0, direction d0) onto frame (p1, d1). */
function frameTransform(p0: Point, d0: Point, p1: Point, d1: Point, mirror: boolean): Transform {
  const a0 = Math.atan2(d0.y, d0.x);
  const a1 = Math.atan2(d1.y, d1.x);
  const deg = ((a1 - (mirror ? Math.PI - a0 : a0)) * 180) / Math.PI;
  const t: Transform = { rotationDeg: deg, mirror, dx: 0, dy: 0 };
  const moved = transformPoint(p0, t);
  t.dx = p1.x - moved.x;
  t.dy = p1.y - moved.y;
  return t;
}

function loopsMatch(a: Loop, b: Loop, t: Transform, tol: number): boolean {
  if (a.segs.length !== b.segs.length) return false;
  const ta = transformLoop(a, t);
  // b's start may differ: find the offset where vertices align
  const va = loopVertices(ta);
  const vb = loopVertices(b);
  const n = va.length;
  if (n === 1) {
    // full circles
    const sa = ta.segs[0];
    const sb = b.segs[0];
    return sa.kind === "arc" && sb.kind === "arc" && dist(sa.center, sb.center) <= tol && Math.abs(sa.r - sb.r) <= tol;
  }
  for (let off = 0; off < n; off++) {
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      if (dist(va[i], vb[(i + off) % n]) > tol) ok = false;
      else {
        const sa = ta.segs[i];
        const sb = b.segs[(i + off) % n];
        if (sa.kind !== sb.kind) ok = false;
        else if (sa.kind === "arc" && sb.kind === "arc" && (dist(sa.center, sb.center) > tol || sa.ccw !== sb.ccw)) ok = false;
      }
    }
    if (ok) return true;
  }
  return false;
}

function holesMatch(a: Loop[], b: Loop[], t: Transform, tol: number): boolean {
  if (a.length !== b.length) return false;
  const used = new Array<boolean>(b.length).fill(false);
  for (const ha of a) {
    let found = false;
    for (let j = 0; j < b.length && !found; j++) {
      if (used[j]) continue;
      if (loopsMatch(ha, b[j], t, tol)) {
        used[j] = true;
        found = true;
      }
    }
    if (!found) return false;
  }
  return true;
}

/** Find a rigid transform mapping piece A onto piece B, or null. */
export function alignPieces(a: Piece, b: Piece, tol: number, mirror: boolean): Transform | null {
  if (Math.abs(a.outer.area - b.outer.area) > tol * Math.max(1, a.outer.perimeter)) return null;
  if (Math.abs(a.outer.perimeter - b.outer.perimeter) > tol * 4) return null;
  if (a.holes.length !== b.holes.length) return null;
  const la = a.outer.loop;
  const lb = b.outer.loop;
  if (la.segs.length !== lb.segs.length) return null;
  // mirrored A: reflect then re-orient ccw (transformLoop handles reversal)
  const MIRROR: Transform = { ...IDENTITY, mirror: true };
  const aLoop = mirror ? transformLoop(la, MIRROR) : la;
  const aHoles = mirror ? a.holes.map((h) => transformLoop(h.loop, MIRROR)) : a.holes.map((h) => h.loop);
  const s0 = aLoop.segs[0];
  if (s0.kind === "arc" && s0.full) {
    // circle: translation only
    const sb = lb.segs[0];
    if (sb.kind !== "arc" || !sb.full || Math.abs(s0.r - sb.r) > tol) return null;
    // aLoop is already reflected when `mirror` is set: translate its centre as is
    const t: Transform = { rotationDeg: 0, mirror, dx: sb.center.x - s0.center.x, dy: sb.center.y - s0.center.y };
    return holesMatch(aHoles, b.holes.map((h) => h.loop), { ...t, mirror: false }, tol) ? t : null;
  }
  const d0 = { x: s0.b.x - s0.a.x, y: s0.b.y - s0.a.y };
  for (let k = 0; k < lb.segs.length; k++) {
    const sb = lb.segs[k];
    if (!sameSegShape(s0, sb, tol)) continue;
    const d1 = { x: sb.b.x - sb.a.x, y: sb.b.y - sb.a.y };
    // transform from the already-mirrored aLoop frame to b: no further mirror
    const t = frameTransform(s0.a, d0, sb.a, d1, false);
    if (!loopsMatch(aLoop, lb, t, tol)) continue;
    if (!holesMatch(aHoles, b.holes.map((h) => h.loop), t, tol)) continue;
    // compose: mirror first, then t
    return { rotationDeg: t.rotationDeg, mirror, dx: t.dx, dy: t.dy };
  }
  return null;
}

export function dedupePieces(pieces: Piece[], opts: DedupeOptions): DedupeResult {
  const groups: DedupeResult["groups"] = [];
  for (const p of pieces) {
    let placed = false;
    for (const g of groups) {
      const t = alignPieces(g.representative, p, opts.tol, false);
      if (t) {
        g.instances.push({ pieceId: p.id, transform: t });
        placed = true;
        break;
      }
    }
    if (!placed) groups.push({ representative: p, instances: [{ pieceId: p.id, transform: IDENTITY }], mirrorOf: null });
  }
  // mirror relations between groups
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].mirrorOf !== null) continue;
    for (let j = i + 1; j < groups.length; j++) {
      if (groups[j].mirrorOf !== null) continue;
      if (alignPieces(groups[i].representative, groups[j].representative, opts.tol, true)) groups[j].mirrorOf = i;
    }
  }
  return { groups };
}
