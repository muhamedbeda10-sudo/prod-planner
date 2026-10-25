// Core geometry types shared by every engine module. Everything is 2D and in
// millimetres once the DXF units have been resolved (see dxf/units.ts).

export interface Point {
  x: number;
  y: number;
}

/** A straight segment. */
export interface LineSeg {
  kind: "line";
  a: Point;
  b: Point;
}

/**
 * A circular arc from `a` to `b` about `center`. `ccw` is the direction of
 * travel from a to b; `r` is redundant with the points but kept so a loop can be
 * reproduced exactly (bulge ↔ arc conversions are lossless in both directions).
 * A full circle is an arc with a == b and `full: true`.
 */
export interface ArcSeg {
  kind: "arc";
  a: Point;
  b: Point;
  center: Point;
  r: number;
  ccw: boolean;
  full?: boolean;
}

export type Seg = LineSeg | ArcSeg;

/**
 * A closed loop of segments: segs[i].b == segs[i+1].a and the last joins the
 * first. Orientation is whatever the source had; use `orientLoop` to normalise.
 */
export interface Loop {
  segs: Seg[];
}

/** Axis-aligned bounding box. */
export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A polygon as a plain vertex list (closed implicitly). */
export type Polygon = Point[];

/** Rigid transform (rotation about origin, optional mirror about the Y axis
 *  applied BEFORE rotation, then translation). */
export interface Transform {
  rotationDeg: number;
  mirror: boolean;
  dx: number;
  dy: number;
}

export const IDENTITY: Transform = { rotationDeg: 0, mirror: false, dx: 0, dy: 0 };

export function emptyBBox(): BBox {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function bboxWidth(b: BBox): number {
  return b.maxX - b.minX;
}
export function bboxHeight(b: BBox): number {
  return b.maxY - b.minY;
}
export function bboxUnion(a: BBox, b: BBox): BBox {
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}
export function bboxOverlaps(a: BBox, b: BBox, tol = 0): boolean {
  return a.minX <= b.maxX + tol && b.minX <= a.maxX + tol && a.minY <= b.maxY + tol && b.minY <= a.maxY + tol;
}

/** Provenance of a segment: which source entity it came from and what it is for. */
export interface SegTag {
  layer: string;
  /** DXF handle of the source entity (null when the file has none) */
  handle: string | null;
  entityType: string;
  /** index in the ENTITIES section — stable within one file */
  entityIndex: number;
  role: "cut" | "mark";
}

export type TaggedSeg = Seg & { tag: SegTag };
