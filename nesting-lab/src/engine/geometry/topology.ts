// Planar topology of cut geometry. Nesting software often exports "common
// line" cuts: two neighbouring parts share one edge drawn once, so a part's
// outline is not a closed polyline but a set of segments that only close up
// together with its neighbours' edges. Chaining by endpoints cannot recover
// those parts; a planar face extraction can — every bounded face of the
// arrangement is a piece that falls out of the sheet after cutting.
//
// Steps: node every intersection (proper crossings, T-junctions, overlaps),
// snap endpoints into shared nodes, drop duplicates, then walk the half-edges
// keeping the face on the left. Positive-area cycles are pieces; dangling
// spikes are reported as open geometry.

import type { ArcSeg, Point, Seg } from "./types";
import type { SegTag, TaggedSeg } from "./types";

type TaggedArc = ArcSeg & { tag: SegTag };
import { angleOf, arcSweep, dist, normAngle, reverseSeg, segBBox, segCurvature, segLength, segTangent, TWO_PI } from "./arc";
import { loopArea } from "./polygon";

export interface TopologyOptions {
  /** endpoints closer than this (mm) are the same node */
  snapTol: number;
}

export interface Cycle {
  segs: TaggedSeg[];
  /** per segment: true when the other side of the edge is also a bounded face
   *  (a common-line cut shared with a neighbouring piece) */
  shared: boolean[];
  area: number; // signed, ccw positive
  /** half-edges that were spikes (dangling) removed from this cycle */
  spikes: TaggedSeg[];
  componentId: number;
}

export interface OpenChain {
  segs: TaggedSeg[];
  length: number;
  endpoints: [Point, Point];
}

export interface TopologyResult {
  /** bounded faces, ccw */
  faces: Cycle[];
  /** outer boundaries of connected components (cw) — one per component */
  outerBoundaries: Cycle[];
  /** geometry that encloses nothing: open chains and spikes */
  open: OpenChain[];
  /** duplicate edges removed (identical geometry drawn twice) */
  duplicatesRemoved: number;
  /** intersections that split segments (common cuts, T-junctions, crossings) */
  splitsApplied: number;
  /** gaps closed by snapping endpoints (largest gap closed, mm) */
  maxGapClosed: number;
  nodes: number;
  edges: number;
}

interface Edge {
  seg: TaggedSeg;
  u: number;
  v: number;
}

interface HalfEdge {
  edge: number;
  from: number;
  to: number;
  /** travel direction along edge.seg: true = seg.a → seg.b */
  forward: boolean;
  angle: number;
  curvature: number;
}

// ---- intersections between exact primitives ----

interface Hit {
  /** parameter on the segment (0..1, by angle for arcs) */
  t: number;
  p: Point;
}

function lineParam(s: Seg, p: Point): number {
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-24) return 0;
  return ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / l2;
}

function arcParam(s: ArcSeg, p: Point): number {
  const a0 = angleOf(s.center, s.a);
  const ap = angleOf(s.center, p);
  const sweep = arcSweep(s);
  const rel = s.ccw ? normAngle(ap - a0) : normAngle(a0 - ap);
  return rel / sweep;
}

/** Parameter of a point assumed to lie on the segment, or null if it does not
 *  (within tol). */
function paramOn(s: Seg, p: Point, tol: number): number | null {
  if (s.kind === "line") {
    const t = lineParam(s, p);
    const q = { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t };
    if (dist(p, q) > tol) return null;
    const len = dist(s.a, s.b);
    const tolT = len > 0 ? tol / len : 0;
    if (t < -tolT || t > 1 + tolT) return null;
    return Math.max(0, Math.min(1, t));
  }
  if (Math.abs(dist(p, s.center) - s.r) > tol) return null;
  if (s.full) return arcParam(s, p);
  const t = arcParam(s, p);
  const sweep = arcSweep(s);
  const tolT = s.r * sweep > 0 ? tol / (s.r * sweep) : 0;
  if (t <= 1 + tolT) return Math.min(1, t);
  // t is measured from the start around the full circle: a point just before
  // the start wraps to t ≈ 2π/sweep
  if (dist(p, s.a) <= tol) return 0;
  return null;
}

function pointAt(s: Seg, t: number): Point {
  if (s.kind === "line") return { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t };
  const a0 = angleOf(s.center, s.a);
  const sweep = arcSweep(s);
  const ang = s.ccw ? a0 + sweep * t : a0 - sweep * t;
  return { x: s.center.x + s.r * Math.cos(ang), y: s.center.y + s.r * Math.sin(ang) };
}

function lineLine(p: Seg, q: Seg, tol: number): [Hit[], Hit[]] {
  const r = { x: p.b.x - p.a.x, y: p.b.y - p.a.y };
  const s = { x: q.b.x - q.a.x, y: q.b.y - q.a.y };
  const denom = r.x * s.y - r.y * s.x;
  const hp: Hit[] = [];
  const hq: Hit[] = [];
  const lp = Math.hypot(r.x, r.y);
  const lq = Math.hypot(s.x, s.y);
  if (Math.abs(denom) > 1e-12 * lp * lq) {
    const qp = { x: q.a.x - p.a.x, y: q.a.y - p.a.y };
    const t = (qp.x * s.y - qp.y * s.x) / denom;
    const u = (qp.x * r.y - qp.y * r.x) / denom;
    const tolT = tol / lp;
    const tolU = tol / lq;
    if (t >= -tolT && t <= 1 + tolT && u >= -tolU && u <= 1 + tolU) {
      const pt = { x: p.a.x + r.x * t, y: p.a.y + r.y * t };
      hp.push({ t: Math.max(0, Math.min(1, t)), p: pt });
      hq.push({ t: Math.max(0, Math.min(1, u)), p: pt });
    }
    return [hp, hq];
  }
  // parallel: overlapping collinear segments split at each other's endpoints
  for (const e of [q.a, q.b]) {
    const t = paramOn(p, e, tol);
    if (t !== null) hp.push({ t, p: e });
  }
  for (const e of [p.a, p.b]) {
    const t = paramOn(q, e, tol);
    if (t !== null) hq.push({ t, p: e });
  }
  return [hp, hq];
}

function lineCircle(l: Seg, c: ArcSeg, tol: number): [Hit[], Hit[]] {
  const hl: Hit[] = [];
  const hc: Hit[] = [];
  const d = { x: l.b.x - l.a.x, y: l.b.y - l.a.y };
  const f = { x: l.a.x - c.center.x, y: l.a.y - c.center.y };
  const A = d.x * d.x + d.y * d.y;
  const B = 2 * (f.x * d.x + f.y * d.y);
  const C = f.x * f.x + f.y * f.y - c.r * c.r;
  let disc = B * B - 4 * A * C;
  if (A < 1e-24) return [hl, hc];
  const len = Math.sqrt(A);
  // tangency within tolerance
  if (disc < 0 && disc > -4 * A * tol * (2 * c.r + tol)) disc = 0;
  if (disc < 0) return [hl, hc];
  const sq = Math.sqrt(disc);
  const ts = disc === 0 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  const tolT = tol / len;
  for (const t of ts) {
    if (t < -tolT || t > 1 + tolT) continue;
    const pt = { x: l.a.x + d.x * t, y: l.a.y + d.y * t };
    const tc = paramOn(c, pt, tol * 2);
    if (tc === null) continue;
    hl.push({ t: Math.max(0, Math.min(1, t)), p: pt });
    hc.push({ t: tc, p: pt });
  }
  return [hl, hc];
}

function circleCircle(a: ArcSeg, b: ArcSeg, tol: number): [Hit[], Hit[]] {
  const ha: Hit[] = [];
  const hb: Hit[] = [];
  const d = dist(a.center, b.center);
  if (d < 1e-12) return [ha, hb]; // concentric: no proper crossing (overlaps are handled by endpoint tests)
  if (d > a.r + b.r + tol || d < Math.abs(a.r - b.r) - tol) return [ha, hb];
  const x = (d * d - b.r * b.r + a.r * a.r) / (2 * d);
  let h2 = a.r * a.r - x * x;
  if (h2 < 0) h2 = 0;
  const h = Math.sqrt(h2);
  const ex = (b.center.x - a.center.x) / d;
  const ey = (b.center.y - a.center.y) / d;
  const px = a.center.x + x * ex;
  const py = a.center.y + x * ey;
  const pts = h < 1e-12 ? [{ x: px, y: py }] : [{ x: px - h * ey, y: py + h * ex }, { x: px + h * ey, y: py - h * ex }];
  for (const p of pts) {
    const ta = paramOn(a, p, tol * 2);
    const tb = paramOn(b, p, tol * 2);
    if (ta === null || tb === null) continue;
    ha.push({ t: ta, p });
    hb.push({ t: tb, p });
  }
  return [ha, hb];
}

function intersect(p: Seg, q: Seg, tol: number): [Hit[], Hit[]] {
  let hp: Hit[];
  let hq: Hit[];
  if (p.kind === "line" && q.kind === "line") [hp, hq] = lineLine(p, q, tol);
  else if (p.kind === "line" && q.kind === "arc") [hp, hq] = lineCircle(p, q, tol);
  else if (p.kind === "arc" && q.kind === "line") {
    const [a, b] = lineCircle(q, p, tol);
    hp = b;
    hq = a;
  } else [hp, hq] = circleCircle(p as ArcSeg, q as ArcSeg, tol);
  // T-junctions and overlaps: an endpoint of one lying on the other
  if (!(p.kind === "arc" && p.full)) {
    for (const e of [p.a, p.b]) {
      const t = paramOn(q, e, tol);
      if (t !== null) hq.push({ t, p: e });
    }
  }
  if (!(q.kind === "arc" && q.full)) {
    for (const e of [q.a, q.b]) {
      const t = paramOn(p, e, tol);
      if (t !== null) hp.push({ t, p: e });
    }
  }
  return [hp, hq];
}

// ---- grid index ----

/** Pairs of segments the noding step may try; above this the file is refused
 *  rather than left to run for hours. */
export const MAX_NODING_PAIRS = 20_000_000;

class Grid {
  private cells = new Map<string, number[]>();
  /** segments spanning too many cells are matched against everything instead */
  private big: number[] = [];
  private count = 0;
  constructor(
    private size: number,
    private boxes: { minX: number; minY: number; maxX: number; maxY: number }[],
    private tol: number,
  ) {}
  private key(ix: number, iy: number) {
    return `${ix},${iy}`;
  }
  insert(id: number, b: { minX: number; minY: number; maxX: number; maxY: number }) {
    this.count++;
    const x0 = Math.floor(b.minX / this.size);
    const x1 = Math.floor(b.maxX / this.size);
    const y0 = Math.floor(b.minY / this.size);
    const y1 = Math.floor(b.maxY / this.size);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) {
      this.big.push(id);
      return;
    }
    for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) {
      const k = this.key(ix, iy);
      const arr = this.cells.get(k);
      if (arr) arr.push(id);
      else this.cells.set(k, [id]);
    }
  }
  private overlaps(a: number, b: number): boolean {
    const bi = this.boxes[a];
    const bj = this.boxes[b];
    const t = this.tol;
    return !(bi.minX > bj.maxX + t || bj.minX > bi.maxX + t || bi.minY > bj.maxY + t || bj.minY > bi.maxY + t);
  }
  *pairs(): Generator<[number, number]> {
    const seen = new Set<number>();
    let yielded = 0;
    const emit = function* (this: Grid, a0: number, b0: number): Generator<[number, number]> {
      if (!this.overlaps(a0, b0)) return;
      const a = Math.min(a0, b0);
      const b = Math.max(a0, b0);
      const k = a * 2_000_003 + b;
      if (seen.has(k)) return;
      seen.add(k);
      if (++yielded > MAX_NODING_PAIRS) throw new Error(`The geometry has more than ${MAX_NODING_PAIRS} overlapping segment pairs; it is beyond what this tool handles.`);
      yield [a, b];
    }.bind(this);
    for (const arr of this.cells.values()) {
      for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) yield* emit(arr[i], arr[j]);
    }
    for (const id of this.big) {
      for (let other = 0; other < this.count; other++) if (other !== id) yield* emit(id, other);
    }
  }
}

class NodeIndex {
  points: Point[] = [];
  private cells = new Map<string, number[]>();
  maxGap = 0;
  constructor(private tol: number) {}
  find(p: Point): number {
    const cs = this.tol * 2 || 1e-6;
    const ix = Math.floor(p.x / cs);
    const iy = Math.floor(p.y / cs);
    let best = -1;
    let bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const arr = this.cells.get(`${ix + dx},${iy + dy}`);
      if (!arr) continue;
      for (const id of arr) {
        const d = dist(this.points[id], p);
        if (d <= this.tol && d < bestD) {
          bestD = d;
          best = id;
        }
      }
    }
    if (best >= 0) {
      if (bestD > this.maxGap) this.maxGap = bestD;
      return best;
    }
    const id = this.points.length;
    this.points.push({ x: p.x, y: p.y });
    const k = `${ix},${iy}`;
    const arr = this.cells.get(k);
    if (arr) arr.push(id);
    else this.cells.set(k, [id]);
    return id;
  }
}

function splitSeg(seg: TaggedSeg, params: number[]): TaggedSeg[] {
  const ts = [...new Set(params.map((t) => Math.round(t * 1e9) / 1e9))].filter((t) => t > 1e-9 && t < 1 - 1e-9).sort((a, b) => a - b);
  if (seg.kind === "arc" && seg.full) {
    // a circle: split into arcs between the sorted parameters (needs ≥ 1 point;
    // with one point the arc runs the full way round from it)
    if (ts.length === 0) return [seg];
    const cuts = params.map((t) => Math.round(t * 1e9) / 1e9).filter((t, i, arr) => arr.indexOf(t) === i).sort((a, b) => a - b);
    const out: TaggedSeg[] = [];
    for (let i = 0; i < cuts.length; i++) {
      const t0 = cuts[i];
      const t1 = cuts[(i + 1) % cuts.length];
      const a = pointAt(seg, t0);
      const b = pointAt(seg, t1);
      out.push({ ...seg, a, b, full: cuts.length === 1 ? true : undefined, tag: seg.tag });
    }
    return out;
  }
  if (ts.length === 0) return [seg];
  const out: TaggedSeg[] = [];
  let prev = 0;
  let prevP = seg.a;
  for (const t of [...ts, 1]) {
    const p = t === 1 ? seg.b : pointAt(seg, t);
    if (seg.kind === "line") out.push({ kind: "line", a: prevP, b: p, tag: seg.tag });
    else out.push({ ...seg, a: prevP, b: p, full: undefined, tag: seg.tag });
    prev = t;
    prevP = p;
  }
  void prev;
  return out;
}

function geomKey(s: Seg, u: number, v: number): string {
  const lo = Math.min(u, v);
  const hi = Math.max(u, v);
  if (s.kind === "line") return `L:${lo}:${hi}`;
  // orient by node order so a↔b reversals compare equal
  const ccw = u < v ? s.ccw : !s.ccw;
  return `A:${lo}:${hi}:${s.center.x.toFixed(4)}:${s.center.y.toFixed(4)}:${s.r.toFixed(4)}:${ccw ? 1 : 0}`;
}

export function buildTopology(input: TaggedSeg[], opts: TopologyOptions): TopologyResult {
  const tol = opts.snapTol;
  const segs = input.filter((s) => (s.kind === "arc" && s.full) || dist(s.a, s.b) > tol || (s.kind === "arc" && segLength(s) > tol));
  // 1. intersections
  const bboxes = segs.map((s) => segBBox(s));
  // cell size from the typical segment and the overall extent, not from the
  // single longest segment (one long construction line must not collapse the grid)
  let all = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const extents: number[] = [];
  for (const b of bboxes) {
    all = { minX: Math.min(all.minX, b.minX), minY: Math.min(all.minY, b.minY), maxX: Math.max(all.maxX, b.maxX), maxY: Math.max(all.maxY, b.maxY) };
    extents.push(Math.max(b.maxX - b.minX, b.maxY - b.minY));
  }
  extents.sort((a, b) => a - b);
  const median = extents.length ? extents[Math.floor(extents.length / 2)] : 10;
  const span = Math.max(all.maxX - all.minX, all.maxY - all.minY, 1);
  const cell = Math.max(10, tol * 10, Math.min(span / 20, median * 4));
  const grid = new Grid(cell, bboxes, tol);
  bboxes.forEach((b, i) => grid.insert(i, b));
  const splits: number[][] = segs.map(() => []);
  let splitsApplied = 0;
  for (const [i, j] of grid.pairs()) {
    const [hi, hj] = intersect(segs[i], segs[j], tol);
    for (const h of hi) splits[i].push(h.t);
    for (const h of hj) splits[j].push(h.t);
  }
  // 2. split
  const pieces: TaggedSeg[] = [];
  segs.forEach((s, i) => {
    const parts = splitSeg(s, splits[i]);
    if (parts.length > 1) splitsApplied += parts.length - 1;
    for (const part of parts) pieces.push(part);
  });
  // 3. nodes + duplicate removal
  const nodes = new NodeIndex(tol);
  const edges: Edge[] = [];
  const seen = new Set<string>();
  let duplicatesRemoved = 0;
  const circles: TaggedArc[] = [];
  for (const s of pieces) {
    if (s.kind === "arc" && s.full) {
      const key = `C:${s.center.x.toFixed(4)}:${s.center.y.toFixed(4)}:${s.r.toFixed(4)}`;
      if (seen.has(key)) {
        duplicatesRemoved++;
        continue;
      }
      seen.add(key);
      circles.push(s as TaggedArc);
      continue;
    }
    const u = nodes.find(s.a);
    const v = nodes.find(s.b);
    if (u === v) {
      // closed on itself after snapping: only a (near) full arc is meaningful
      if (s.kind === "arc" && arcSweep(s) > Math.PI) {
        const key = `C:${s.center.x.toFixed(4)}:${s.center.y.toFixed(4)}:${s.r.toFixed(4)}`;
        if (!seen.has(key)) {
          seen.add(key);
          circles.push({ ...(s as TaggedArc), full: true, b: { ...s.a } });
        } else duplicatesRemoved++;
      }
      continue;
    }
    const key = geomKey(s, u, v);
    if (seen.has(key)) {
      duplicatesRemoved++;
      continue;
    }
    seen.add(key);
    const snapped: TaggedSeg = s.kind === "line" ? { kind: "line", a: nodes.points[u], b: nodes.points[v], tag: s.tag } : { ...s, a: nodes.points[u], b: nodes.points[v] };
    edges.push({ seg: snapped, u, v });
  }
  // 4. half-edges sorted around nodes
  const halves: HalfEdge[] = [];
  const outgoing: number[][] = nodes.points.map(() => []);
  edges.forEach((e, ei) => {
    const fwdT = segTangent(e.seg, false);
    const rev = reverseSeg(e.seg);
    const revT = segTangent(rev, false);
    halves.push({ edge: ei, from: e.u, to: e.v, forward: true, angle: Math.atan2(fwdT.y, fwdT.x), curvature: segCurvature(e.seg) });
    halves.push({ edge: ei, from: e.v, to: e.u, forward: false, angle: Math.atan2(revT.y, revT.x), curvature: segCurvature(rev) });
    outgoing[e.u].push(halves.length - 2);
    outgoing[e.v].push(halves.length - 1);
  });
  for (const list of outgoing) {
    list.sort((a, b) => {
      const d = halves[a].angle - halves[b].angle;
      if (Math.abs(d) > 1e-9) return d;
      return halves[a].curvature - halves[b].curvature;
    });
  }
  const twin = (h: number) => (h % 2 === 0 ? h + 1 : h - 1);
  // 5. walk faces (face on the left of each half-edge)
  const visited = new Array<boolean>(halves.length).fill(false);
  const rawCycles: { halves: number[] }[] = [];
  const cycleOfHalf = new Array<number>(halves.length).fill(-1);
  for (let h0 = 0; h0 < halves.length; h0++) {
    if (visited[h0]) continue;
    const cyc: number[] = [];
    let h = h0;
    let guard = 0;
    while (!visited[h] && guard++ < halves.length + 1) {
      visited[h] = true;
      cycleOfHalf[h] = rawCycles.length;
      cyc.push(h);
      const at = halves[h].to;
      const list = outgoing[at];
      const idx = list.indexOf(twin(h));
      // the first edge clockwise from the reverse of the incoming edge
      const next = list[(idx - 1 + list.length) % list.length];
      h = next;
    }
    rawCycles.push({ halves: cyc });
  }
  // components (union-find over nodes)
  const parent = nodes.points.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const e of edges) parent[find(e.u)] = find(e.v);
  const compId = new Map<number, number>();
  const componentOf = (node: number) => {
    const r = find(node);
    let id = compId.get(r);
    if (id === undefined) {
      id = compId.size;
      compId.set(r, id);
    }
    return id;
  };
  // 6. spikes and classification
  const faces: Cycle[] = [];
  const outerBoundaries: Cycle[] = [];
  const open: OpenChain[] = [];
  const bounded = new Array<boolean>(rawCycles.length).fill(false);
  const cycleSegs = new Map<number, { hs: number[]; spikes: number[] }>();
  rawCycles.forEach((rc, ci) => {
    // remove spikes (a half-edge immediately followed by its twin) in one
    // stack pass; nested spikes collapse as the stack unwinds, and the wrap-
    // around pair at the cycle's seam is handled after the pass
    const hs: number[] = [];
    const spikes: number[] = [];
    for (const h of rc.halves) {
      if (hs.length > 0 && twin(hs[hs.length - 1]) === h) {
        spikes.push(hs.pop()!);
      } else hs.push(h);
    }
    while (hs.length >= 2 && twin(hs[hs.length - 1]) === hs[0]) {
      spikes.push(hs.pop()!);
      hs.shift();
    }
    const toSeg = (h: number): TaggedSeg => {
      const e = edges[halves[h].edge];
      return halves[h].forward ? e.seg : ({ ...reverseSeg(e.seg), tag: e.seg.tag } as TaggedSeg);
    };
    cycleSegs.set(ci, { hs, spikes });
    if (hs.length > 0 && loopArea({ segs: hs.map(toSeg) }) > 1e-9) bounded[ci] = true;
  });
  for (const [ci, { hs, spikes }] of cycleSegs) {
    const toSeg = (h: number): TaggedSeg => {
      const e = edges[halves[h].edge];
      return halves[h].forward ? e.seg : ({ ...reverseSeg(e.seg), tag: e.seg.tag } as TaggedSeg);
    };
    const spikeSegs = spikes.map(toSeg);
    if (hs.length === 0) {
      if (spikeSegs.length > 0) open.push(chainOf(spikeSegs));
      continue;
    }
    const segsOut = hs.map(toSeg);
    const shared = hs.map((h) => {
      const other = cycleOfHalf[twin(h)];
      return other >= 0 && other !== ci && bounded[other];
    });
    const area = loopArea({ segs: segsOut });
    const comp = componentOf(halves[hs[0]].from);
    if (area > 1e-9) faces.push({ segs: segsOut, shared, area, spikes: spikeSegs, componentId: comp });
    else if (area < -1e-9) outerBoundaries.push({ segs: segsOut, shared, area, spikes: spikeSegs, componentId: comp });
    else {
      open.push(chainOf([...segsOut, ...spikeSegs]));
      continue;
    }
    // a dangling edge attached to a face (a lead-in, a construction line) is open geometry too
    if (spikeSegs.length > 0) open.push(chainOf(spikeSegs));
  }
  // 7. standalone circles are faces of their own component
  let nextComp = compId.size;
  for (const c of circles) {
    const ccw: TaggedSeg = { ...c, ccw: true, tag: c.tag };
    const cw: TaggedSeg = { ...c, ccw: false, tag: c.tag };
    const area = Math.PI * c.r * c.r;
    faces.push({ segs: [ccw], shared: [false], area, spikes: [], componentId: nextComp });
    outerBoundaries.push({ segs: [cw], shared: [false], area: -area, spikes: [], componentId: nextComp });
    nextComp++;
  }
  return { faces, outerBoundaries, open, duplicatesRemoved, splitsApplied, maxGapClosed: nodes.maxGap, nodes: nodes.points.length, edges: edges.length + circles.length };
}

function chainOf(segs: TaggedSeg[]): OpenChain {
  // a zero-area cycle walks every edge twice (there and back): keep one direction
  const seen = new Set<string>();
  const uniq: TaggedSeg[] = [];
  const key = (p: Point, q: Point) => `${p.x.toFixed(6)},${p.y.toFixed(6)}|${q.x.toFixed(6)},${q.y.toFixed(6)}`;
  for (const s of segs) {
    if (seen.has(key(s.b, s.a)) || seen.has(key(s.a, s.b))) continue;
    seen.add(key(s.a, s.b));
    uniq.push(s);
  }
  let len = 0;
  for (const s of uniq) len += segLength(s);
  // the chain's ends are the points that occur once
  const count = new Map<string, { p: Point; n: number }>();
  for (const s of uniq) for (const q of [s.a, s.b]) {
    const k = `${q.x.toFixed(6)},${q.y.toFixed(6)}`;
    const e = count.get(k);
    if (e) e.n++;
    else count.set(k, { p: q, n: 1 });
  }
  const ends = [...count.values()].filter((e) => e.n === 1).map((e) => e.p);
  const first = ends[0] ?? uniq[0]?.a ?? { x: 0, y: 0 };
  const last = ends[1] ?? uniq[uniq.length - 1]?.b ?? first;
  return { segs: uniq, length: len, endpoints: [first, last] };
}

export { TWO_PI };
