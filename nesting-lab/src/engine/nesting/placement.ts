// What a placement means, in one place. `Placement.x/y` is where the bbox-min
// corner of the part's exact outer contour lands after the rotation (and the
// optional mirror) about the part's own origin. Everything that draws, exports
// or verifies a result derives the placed geometry from here, never from the
// solver.

import type { Loop, Seg, Transform } from "../geometry/types";
import { loopBBox, transformLoop, transformSeg } from "../geometry/polygon";
import type { NestPartInput, Placement } from "./types";

export type PlacementPose = Pick<Placement, "rotationDeg" | "mirrored" | "x" | "y">;

export function placementTransform(part: Pick<NestPartInput, "outer">, pl: PlacementPose): Transform {
  const rotated = transformLoop(part.outer, { rotationDeg: pl.rotationDeg, mirror: pl.mirrored, dx: 0, dy: 0 });
  const b = loopBBox(rotated);
  return { rotationDeg: pl.rotationDeg, mirror: pl.mirrored, dx: -b.minX + pl.x, dy: -b.minY + pl.y };
}

export interface PlacedGeometry {
  outer: Loop;
  holes: Loop[];
  marks: Seg[];
  transform: Transform;
}

/** The part's exact contours where the placement puts them. */
export function placedGeometry(part: Pick<NestPartInput, "outer" | "holes" | "marks">, pl: PlacementPose): PlacedGeometry {
  const t = placementTransform(part, pl);
  return { outer: transformLoop(part.outer, t), holes: part.holes.map((h) => transformLoop(h, t)), marks: (part.marks ?? []).map((m) => transformSeg(m, t)), transform: t };
}
