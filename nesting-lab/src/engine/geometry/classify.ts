// From planar faces to pieces: which face is the sheet boundary, which faces
// are parts, which are holes (or slugs) inside parts, and what the file is —
// a single part, several parts, or a finished nesting.

import { bboxHeight, bboxUnion, bboxWidth, type BBox, type Loop, type Point, type Polygon, type Seg } from "./types";
import type { Cycle, TopologyResult } from "./topology";
import type { SegTag, TaggedSeg } from "./types";
import { discretizeLoop, interiorPoint, isAxisAlignedRectangle, loopBBox, loopPerimeter, orientLoop, pointInPolygon } from "./polygon";
import { dist, segBBox, segLength } from "./arc";
import { simplifyLoop } from "./simplifyLoop";

export interface PieceLoop {
  loop: Loop;
  segs: TaggedSeg[];
  area: number;
  perimeter: number;
  bbox: BBox;
  layers: string[];
  /** share of the perimeter that is a common-line cut with a neighbouring piece */
  sharedFraction: number;
}

export interface Piece {
  id: string;
  /** ccw outer contour */
  outer: PieceLoop;
  /** cw hole contours (closed cuts inside the outer contour) */
  holes: PieceLoop[];
  /** containment depth: 0 = top level (or directly inside the sheet boundary) */
  depth: number;
  area: number; // outer area − holes
  bbox: BBox;
  /** mark-role geometry that lies inside this piece (engraving, centre marks) */
  marks: TaggedSeg[];
  /** facts about the piece (common-line cuts, nesting depth) */
  flags: string[];
  /** reasons a person should check it is a part at all (scrap between cuts, tiny) */
  review: string[];
}

export interface ClassifyOptions {
  /** loops smaller than this (mm²) are not parts; they are still holes */
  minPartArea: number;
  /** faces narrower than this mean width (mm) are slivers between near-coincident edges */
  sliverWidth: number;
  /** an island inside a cut-out smaller than this (mm²) is lettering, not a part */
  smallCutoutArea: number;
  /** parts smaller than this (mm²) are flagged for review */
  reviewArea: number;
  /** sheet-boundary detection tolerance on the bbox match (mm) */
  sheetTol: number;
  /** sagitta for the polygons used in containment tests (mm) */
  sagitta: number;
}

export type FileKind = "single-part" | "multi-part" | "nesting-ready" | "no-closed-geometry";

export interface Classification {
  kind: FileKind;
  pieces: Piece[];
  /** the loop detected as the sheet boundary (not a part), if any */
  sheetBoundary: PieceLoop | null;
  /** the sheet boundary's size, when found */
  sheetSize: { w: number; h: number } | null;
  /** faces that were neither parts nor holes (too small, odd depth) */
  ignoredFaces: { area: number; bbox: BBox; reason: string }[];
  overallBBox: BBox | null;
  warnings: string[];
}

function pieceLoop(c: Cycle): PieceLoop {
  const raw: Loop = { segs: c.segs };
  const perimeter = loopPerimeter(raw);
  let sharedLen = 0;
  c.segs.forEach((s, i) => {
    if (c.shared[i]) sharedLen += segLength(s);
  });
  // canonical segments: split points left by neighbours' corners are removed
  const simplified = simplifyLoop(raw, 1e-6);
  const tagOf = (seg: Seg): SegTag => c.segs.find((s) => dist(s.a, seg.a) < 1e-9)?.tag ?? c.segs[0].tag;
  const segs: TaggedSeg[] = simplified.segs.map((seg) => ({ ...seg, tag: tagOf(seg) }) as TaggedSeg);
  const loop: Loop = { segs };
  const b = loopBBox(loop);
  return { loop, segs, area: Math.abs(c.area), perimeter, bbox: b, layers: [...new Set(c.segs.map((s) => s.tag.layer))], sharedFraction: perimeter > 0 ? sharedLen / perimeter : 0 };
}

interface FaceInfo {
  loop: PieceLoop;
  poly: Polygon;
  inner: Point | null;
  depth: number;
  parent: number | null;
  index: number;
}

export function classify(topo: TopologyResult, marks: TaggedSeg[], opts: ClassifyOptions): Classification {
  const warnings: string[] = [];
  const faces: FaceInfo[] = topo.faces
    .map((c, index) => {
      const loop = pieceLoop(c);
      const poly = discretizeLoop(loop.loop, opts.sagitta);
      return { loop, poly, inner: interiorPoint(poly), depth: 0, parent: null, index };
    })
    .sort((a, b) => b.loop.area - a.loop.area);
  if (faces.length === 0) {
    return { kind: "no-closed-geometry", pieces: [], sheetBoundary: null, sheetSize: null, ignoredFaces: [], overallBBox: null, warnings: ["No closed cut contour was found — nothing can be nested from this file."] };
  }
  // overall bbox of all cut geometry (faces + open chains)
  let overall: BBox = { ...faces[0].loop.bbox };
  for (const f of faces) overall = bboxUnion(overall, f.loop.bbox);
  for (const o of topo.open) for (const s of o.segs) overall = bboxUnion(overall, segBBox(s));
  // containment: parent = smallest face strictly containing this one (faces sorted by area desc)
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    if (!f.inner) continue;
    let best: number | null = null;
    for (let j = 0; j < i; j++) {
      const g = faces[j];
      if (g.loop.area <= f.loop.area) continue;
      const b = g.loop.bbox;
      if (f.inner.x < b.minX || f.inner.x > b.maxX || f.inner.y < b.minY || f.inner.y > b.maxY) continue;
      if (pointInPolygon(f.inner, g.poly)) best = j; // j iterates largest→smallest, keep the smallest
    }
    f.parent = best;
    f.depth = best === null ? 0 : faces[best].depth + 1;
  }
  // sheet boundary: a top-level axis-aligned rectangle matching the overall bbox and containing ≥ 1 face
  let sheet: FaceInfo | null = null;
  for (const f of faces) {
    if (f.depth !== 0) continue;
    const b = f.loop.bbox;
    const matches = Math.abs(b.minX - overall.minX) <= opts.sheetTol && Math.abs(b.minY - overall.minY) <= opts.sheetTol && Math.abs(b.maxX - overall.maxX) <= opts.sheetTol && Math.abs(b.maxY - overall.maxY) <= opts.sheetTol;
    if (!matches) continue;
    if (!isAxisAlignedRectangle(f.poly, 1e-6)) continue;
    const children = faces.filter((g) => g.parent !== null && faces[g.parent] === f);
    if (children.length === 0) continue;
    sheet = f;
    break;
  }
  if (sheet) {
    // everything directly inside the sheet moves up one level
    for (const f of faces) if (f.parent !== null && faces[f.parent] === sheet) f.parent = null;
    for (const f of faces) {
      // recompute depth from the (possibly updated) parent chain
      let d = 0;
      let p = f.parent;
      while (p !== null) {
        d++;
        p = faces[p].parent;
      }
      f.depth = d;
    }
  }
  const pieces: Piece[] = [];
  const ignored: Classification["ignoredFaces"] = [];
  const pieceByFace = new Map<FaceInfo, Piece>();
  let seq = 0;
  for (const f of faces) {
    if (f === sheet) continue;
    if (f.depth % 2 === 1) continue; // inside a part: a hole region (or the slug that falls out of it)
    const meanWidth = f.loop.area / Math.max(1e-9, f.loop.perimeter / 2);
    if (meanWidth < opts.sliverWidth) {
      ignored.push({ area: f.loop.area, bbox: f.loop.bbox, reason: `sliver ${meanWidth.toFixed(3)} mm wide — two edges drawn almost on top of each other, not a part` });
      continue;
    }
    if (f.loop.area < opts.minPartArea) {
      ignored.push({ area: f.loop.area, bbox: f.loop.bbox, reason: f.depth === 0 ? `smaller than the minimum part area (${opts.minPartArea} mm²)` : `island inside a cut-out, smaller than ${opts.minPartArea} mm²` });
      continue;
    }
    if (f.depth >= 2 && f.parent !== null && faces[f.parent].loop.area < opts.smallCutoutArea) {
      ignored.push({ area: f.loop.area, bbox: f.loop.bbox, reason: `island inside a small cut-out of ${faces[f.parent].loop.area.toFixed(0)} mm² (lettering or a marking shape), not a part` });
      continue;
    }
    const outerLoop = orientLoop(f.loop.loop, true);
    const outer: PieceLoop = { ...f.loop, loop: outerLoop, segs: outerLoop.segs as TaggedSeg[] };
    const flags: string[] = [];
    const review: string[] = [];
    if (f.depth > 0) flags.push(`nested inside another piece's cut-out (depth ${f.depth})`);
    if (f.loop.sharedFraction > 0) flags.push(`${Math.round(f.loop.sharedFraction * 100)}% of its outline is a common-line cut shared with neighbours`);
    const fill = f.loop.area / Math.max(1e-9, bboxWidth(f.loop.bbox) * bboxHeight(f.loop.bbox));
    if (fill < 0.5 && f.loop.segs.length > 8) review.push(`irregular outline (fills ${Math.round(fill * 100)}% of its box, ${f.loop.segs.length} segments) — check it is a part and not scrap between neighbours`);
    if (f.loop.area < opts.reviewArea) review.push(`small (${f.loop.area.toFixed(0)} mm²) — check it is a part and not a corner scrap`);
    const piece: Piece = { id: `P${++seq}`, outer, holes: [], depth: f.depth, area: f.loop.area, bbox: f.loop.bbox, marks: [], flags, review };
    pieces.push(piece);
    pieceByFace.set(f, piece);
  }
  // holes: faces at odd depth whose parent is a piece
  for (const f of faces) {
    if (f.depth % 2 !== 1 || f.parent === null) continue;
    const parentPiece = pieceByFace.get(faces[f.parent]);
    if (!parentPiece) continue;
    const holeLoop = orientLoop(f.loop.loop, false);
    parentPiece.holes.push({ ...f.loop, loop: holeLoop, segs: holeLoop.segs as TaggedSeg[] });
    parentPiece.area -= f.loop.area;
  }
  // marks: assign by a point of the mark to the smallest piece containing it
  const pieceFaces = [...pieceByFace.entries()].sort((a, b) => a[0].loop.area - b[0].loop.area);
  for (const m of marks) {
    const p: Point = m.kind === "arc" && m.full ? m.center : { x: (m.a.x + m.b.x) / 2, y: (m.a.y + m.b.y) / 2 };
    let home: Piece | null = null;
    for (const [f, piece] of pieceFaces) {
      const b = f.loop.bbox;
      if (p.x < b.minX || p.x > b.maxX || p.y < b.minY || p.y > b.maxY) continue;
      if (pointInPolygon(p, f.poly)) {
        home = piece;
        break;
      }
    }
    if (home) home.marks.push(m);
    else warnings.push(`A mark (${m.tag.entityType} on layer ${m.tag.layer}) lies outside every piece and was dropped.`);
  }
  // warnings
  if (topo.open.length > 0) {
    const total = topo.open.reduce((s, o) => s + o.length, 0);
    warnings.push(`${topo.open.length} open chain(s) totalling ${total.toFixed(1)} mm enclose nothing and are not part of any piece (lead-ins, construction lines or a gap larger than the snap tolerance).`);
  }
  if (topo.duplicatesRemoved > 0) warnings.push(`${topo.duplicatesRemoved} duplicate segment(s) drawn twice were merged.`);
  if (topo.splitsApplied > 0) warnings.push(`${topo.splitsApplied} segment split(s) at crossings or shared edges — the file uses common-line cuts or overlapping entities; pieces were reconstructed from the planar faces.`);
  const topLevel = pieces.filter((p) => p.depth === 0);
  let kind: FileKind;
  if (sheet) kind = "nesting-ready";
  else if (topLevel.length === 1) kind = "single-part";
  else if (topLevel.length > 1) kind = "multi-part";
  else kind = "no-closed-geometry";
  return {
    kind,
    pieces,
    sheetBoundary: sheet ? sheet.loop : null,
    sheetSize: sheet ? { w: bboxWidth(sheet.loop.bbox), h: bboxHeight(sheet.loop.bbox) } : null,
    ignoredFaces: ignored,
    overallBBox: overall,
    warnings,
  };
}

