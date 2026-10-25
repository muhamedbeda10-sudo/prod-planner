// A thin, typed layer over clipper-lib (Angus Johnson's Clipper 6.4.2, pure
// JS). Clipper works on integers: millimetres are scaled by SCALE so every
// boolean operation is exact to a thousandth of a millimetre.

import ClipperLib, { type Path, type Paths } from "clipper-lib";
import type { Polygon } from "../geometry/types";

export const SCALE = 1000;

export type IPath = Path;
export type IPaths = Paths;

export function toPath(poly: Polygon): IPath {
  return poly.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
}
export function fromPath(path: IPath): Polygon {
  return path.map((p) => ({ x: p.X / SCALE, y: p.Y / SCALE }));
}
export function pathArea(path: IPath): number {
  return ClipperLib.Clipper.Area(path) / (SCALE * SCALE);
}
export function orientation(path: IPath): boolean {
  return ClipperLib.Clipper.Orientation(path);
}

export function unionPaths(paths: IPaths): IPaths {
  const c = new ClipperLib.Clipper();
  c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const out: IPaths = [];
  c.Execute(ClipperLib.ClipType.ctUnion, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out;
}

export function differencePaths(subject: IPaths, clip: IPaths): IPaths {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const out: IPaths = [];
  c.Execute(ClipperLib.ClipType.ctDifference, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out;
}

/** Offset closed polygons by `delta` mm with round joins. */
export function offsetPaths(paths: IPaths, deltaMm: number, arcToleranceMm = 0.02): IPaths {
  const co = new ClipperLib.ClipperOffset(2, arcToleranceMm * SCALE);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out: IPaths = [];
  co.Execute(out, deltaMm * SCALE);
  return out;
}

export function translatePath(path: IPath, dx: number, dy: number): IPath {
  const X = Math.round(dx * SCALE);
  const Y = Math.round(dy * SCALE);
  return path.map((p) => ({ X: p.X + X, Y: p.Y + Y }));
}

export function rectPath(x0: number, y0: number, x1: number, y1: number): IPath {
  return toPath([
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ]);
}
