// Canonical form of a loop: consecutive collinear lines become one line and
// consecutive arcs on the same circle become one arc. Common-line cuts split
// an outline at every neighbour's corner, so without this two identical parts
// would have different vertex counts and never compare equal.

import type { Loop, Seg } from "./types";
import { arcSweep, dist } from "./arc";

export function simplifyLoop(loop: Loop, tol = 1e-6): Loop {
  let segs = loop.segs.slice();
  if (segs.length <= 1) return loop;
  const canMerge = (p: Seg, q: Seg): boolean => {
    if (dist(p.b, q.a) > tol) return false;
    if (p.kind === "line" && q.kind === "line") {
      const ux = p.b.x - p.a.x;
      const uy = p.b.y - p.a.y;
      const vx = q.b.x - q.a.x;
      const vy = q.b.y - q.a.y;
      const lu = Math.hypot(ux, uy);
      const lv = Math.hypot(vx, vy);
      if (lu < tol || lv < tol) return true;
      const cross = (ux * vy - uy * vx) / (lu * lv);
      const dot = (ux * vx + uy * vy) / (lu * lv);
      return Math.abs(cross) <= 1e-9 && dot > 0;
    }
    if (p.kind === "arc" && q.kind === "arc") {
      if (p.full || q.full) return false;
      if (p.ccw !== q.ccw) return false;
      if (dist(p.center, q.center) > tol || Math.abs(p.r - q.r) > tol) return false;
      // the merged sweep must stay below a full turn
      return arcSweep(p) + arcSweep(q) < Math.PI * 2 - 1e-9;
    }
    return false;
  };
  const merge = (p: Seg, q: Seg): Seg => (p.kind === "line" ? { kind: "line", a: p.a, b: q.b } : { ...p, b: q.b });
  let changed = true;
  while (changed && segs.length > 1) {
    changed = false;
    for (let i = 0; i < segs.length; i++) {
      const j = (i + 1) % segs.length;
      if (i === j) break;
      if (canMerge(segs[i], segs[j])) {
        const merged = merge(segs[i], segs[j]);
        if (j > i) segs.splice(i, 2, merged);
        else {
          segs.splice(i, 1);
          segs.splice(j, 1, merged);
        }
        changed = true;
        break;
      }
    }
  }
  return { segs };
}
