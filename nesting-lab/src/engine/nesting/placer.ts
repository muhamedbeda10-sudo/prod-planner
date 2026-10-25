// Greedy bottom-left-fill with no-fit polygons: for every part, in the given
// order, try each allowed rotation, compute the feasible region (inner-fit
// rectangle minus the union of NFPs with everything already placed and with
// the no-go zones) and pick the best vertex of that region by the objective.

import { fromPath, differencePaths, rectPath, translatePath, unionPaths, SCALE, type IPath, type IPaths } from "./clipper";
import type { FixedObstacle, NfpCache, Variant } from "./nfp";
import type { NestSettings, Objective, Placement } from "./types";
import { bboxUnion, type BBox } from "../geometry/types";

export interface Placed {
  placement: Placement;
  variant: Variant;
}

export type Obstacle = FixedObstacle;

/** The blocked region of one sheet for one moving variant, grown as parts land. */
interface Blocked {
  upTo: number;
  paths: IPaths;
}

export interface PlacerStats {
  candidatesEvaluated: number;
  placementsAttempted: number;
  /** milliseconds spent in union/difference of feasible regions */
  booleanMs: number;
}

export interface SheetContext {
  settings: NestSettings;
  cache: NfpCache;
  stats: PlacerStats;
  /** no-go zones, grown so the moving part keeps `margin` from them */
  zones: Obstacle[];
  /** per moving-variant key: the union of every obstacle NFP placed so far on this sheet */
  blocked: Map<string, Blocked>;
}

export function newSheetContext(settings: NestSettings, cache: NfpCache, stats: PlacerStats, zones: Obstacle[]): SheetContext {
  return { settings, cache, stats, zones, blocked: new Map() };
}

export function zoneObstacles(settings: NestSettings): Obstacle[] {
  const grow = settings.marginMm - settings.spacingMm / 2;
  return settings.noGoZones.map((z, i) => ({
    key: `zone${i}:${z.x},${z.y},${z.w},${z.h}:${grow}`,
    grown: rectPath(z.x - grow, z.y - grow, z.x + z.w + grow, z.y + z.h + grow),
  }));
}

/** Allowed translations of a variant inside the sheet, as a rectangle. Uses
 *  the exact contour's box (the sheet is a rectangle), so nothing is lost to
 *  the conservative polygons at the sheet edge. */
export function innerFit(v: Variant, s: NestSettings): { x0: number; y0: number; x1: number; y1: number } | null {
  const x0 = s.marginMm;
  const y0 = s.marginMm;
  const x1 = s.sheet.widthMm - s.marginMm - v.width;
  const y1 = s.sheet.heightMm - s.marginMm - v.height;
  if (x1 < x0 - 1e-9 || y1 < y0 - 1e-9) return null;
  return { x0, y0, x1: Math.max(x1, x0), y1: Math.max(y1, y0) };
}

function score(objective: Objective, x: number, y: number, v: Variant, used: BBox | null): number {
  switch (objective) {
    case "bottom-left":
      return y * 1e6 + x;
    case "left-bottom":
      return x * 1e6 + y;
    case "min-bbox": {
      const minX = used ? Math.min(used.minX, x) : x;
      const minY = used ? Math.min(used.minY, y) : y;
      const maxX = used ? Math.max(used.maxX, x + v.width) : x + v.width;
      const maxY = used ? Math.max(used.maxY, y + v.height) : y + v.height;
      // area first, then keep it low and left
      return (maxX - minX) * (maxY - minY) * 1e3 + y * 1e-3 + x * 1e-6;
    }
  }
}

/** One integer unit of the nester's coordinate grid. */
const EPS = 1 / SCALE;

/**
 * The union of every obstacle NFP for this moving variant: the no-go zones
 * plus the parts placed so far. Kept per variant key and extended with only
 * the parts placed since the last request (union is associative).
 */
function blockedRegion(ctx: SheetContext, v: Variant, placed: Placed[]): IPaths {
  let entry = ctx.blocked.get(v.key);
  if (!entry) {
    const zonePaths: IPaths = [];
    for (const z of ctx.zones) for (const path of ctx.cache.get(z, v)) zonePaths.push(path);
    entry = { upTo: 0, paths: zonePaths.length > 1 ? unionPaths(zonePaths) : zonePaths };
    ctx.blocked.set(v.key, entry);
  }
  if (entry.upTo < placed.length) {
    const added: IPaths = [...entry.paths];
    for (let i = entry.upTo; i < placed.length; i++) {
      const p = placed[i];
      for (const path of ctx.cache.get(p.variant, v)) added.push(translatePath(path, p.placement.x, p.placement.y));
    }
    const tb = performance.now();
    entry.paths = added.length > 1 ? unionPaths(added) : added;
    ctx.stats.booleanMs += performance.now() - tb;
    entry.upTo = placed.length;
  }
  return entry.paths;
}

/**
 * Try to place one part (given its candidate variants) on the sheet. Returns
 * the chosen placement or null with the reason it did not fit.
 */
export function tryPlace(variants: Variant[], instance: number, placed: Placed[], ctx: SheetContext, objective: Objective): { placed: Placed | null; reason: string } {
  ctx.stats.placementsAttempted++;
  let best: { s: number; x: number; y: number; v: Variant } | null = null;
  let anyFits = false;
  let used: BBox | null = null;
  for (const p of placed) used = used ? bboxUnion(used, p.placement.bbox) : { ...p.placement.bbox };
  for (const v of variants) {
    const ifp = innerFit(v, ctx.settings);
    if (!ifp) continue;
    anyFits = true;
    // a part that fits exactly gives a zero-area inner-fit rectangle, which a
    // boolean difference would drop: widen it by one integer unit and clamp
    // the candidates back afterwards
    const subject: IPaths = [rectPath(ifp.x0 - EPS, ifp.y0 - EPS, ifp.x1 + EPS, ifp.y1 + EPS)];
    const blocked = blockedRegion(ctx, v, placed);
    let feasible: IPaths;
    if (blocked.length === 0) feasible = subject;
    else {
      const tb = performance.now();
      feasible = differencePaths(subject, blocked);
      ctx.stats.booleanMs += performance.now() - tb;
    }
    for (const path of feasible) {
      for (const raw of fromPath(path)) {
        const pt = { x: Math.min(Math.max(raw.x, ifp.x0), ifp.x1), y: Math.min(Math.max(raw.y, ifp.y0), ifp.y1) };
        ctx.stats.candidatesEvaluated++;
        const s = score(objective, pt.x, pt.y, v, used);
        if (!best || s < best.s) best = { s, x: pt.x, y: pt.y, v };
      }
    }
  }
  if (!best) {
    return { placed: null, reason: anyFits ? "no free room left on this sheet at any allowed rotation" : "larger than the usable sheet area at every allowed rotation" };
  }
  const v = best.v;
  const placement: Placement = {
    partId: v.partId,
    instance,
    x: best.x,
    y: best.y,
    rotationDeg: v.rotationDeg,
    mirrored: v.mirrored,
    bbox: { minX: best.x, minY: best.y, maxX: best.x + v.width, maxY: best.y + v.height },
  };
  return { placed: { placement, variant: v }, reason: "" };
}

