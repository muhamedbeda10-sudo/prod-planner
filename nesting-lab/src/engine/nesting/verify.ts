// Independent check of a layout against the exact part contours. Shares no
// code with the NFP core: plain segment arithmetic from geometry/polygon.ts on
// polygons that circumscribe every arc (so a pass here implies the true shapes
// pass too). Tolerances are explicit and reported.

import { discretizeLoop, loopArea, loopPerimeter, pointInPolygon, polygonBoundaryDistance, polygonsOverlap } from "../geometry/polygon";
import type { BBox, Loop, Polygon } from "../geometry/types";
import { bboxOverlaps } from "../geometry/types";
import { placedGeometry } from "./placement";
import type { NestPartInput, NestResult } from "./types";

export interface Violation {
  sheet: number;
  kind: "overlap" | "spacing" | "out-of-bounds" | "no-go-zone" | "quantity" | "geometry";
  message: string;
  a?: { partId: string; instance: number };
  b?: { partId: string; instance: number };
  measured?: number;
  required?: number;
}

export interface VerifyReport {
  ok: boolean;
  violations: Violation[];
  tolerances: { sagittaMm: number; distanceTolMm: number; areaRelTol: number };
  stats: { pairsChecked: number; minClearanceMm: number | null; minEdgeDistanceMm: number | null; placementsChecked: number };
}

export interface VerifyOptions {
  /** arc tolerance of the check polygons (mm) — they circumscribe the arcs */
  sagittaMm?: number;
  /** slack on distances (mm), covers the integer rounding of the nester */
  distanceTolMm?: number;
}

export function verifyLayout(parts: NestPartInput[], result: NestResult, opts: VerifyOptions = {}): VerifyReport {
  const sagitta = opts.sagittaMm ?? 0.01;
  const tol = opts.distanceTolMm ?? 0.02;
  const areaRelTol = 1e-6;
  const violations: Violation[] = [];
  const s = result.settings;
  const byId = new Map(parts.map((p) => [p.id, p]));
  let pairs = 0;
  let minClear: number | null = null;
  let minEdge: number | null = null;
  let placementsChecked = 0;
  // quantities
  const placedCount = new Map<string, number>();
  for (const sh of result.sheets) for (const pl of sh.placements) placedCount.set(pl.partId, (placedCount.get(pl.partId) ?? 0) + 1);
  for (const p of parts) {
    const placed = placedCount.get(p.id) ?? 0;
    const un = result.unplaced.filter((u) => u.partId === p.id).reduce((n, u) => n + u.quantity, 0);
    if (placed + un !== p.quantity) violations.push({ sheet: -1, kind: "quantity", message: `${p.label}: ${p.quantity} requested, ${placed} placed + ${un} unplaced = ${placed + un}.` });
  }
  for (const [id] of placedCount) if (!byId.has(id)) violations.push({ sheet: -1, kind: "quantity", message: `Placement refers to unknown part "${id}".` });
  // per sheet
  const W = s.sheet.widthMm;
  const H = s.sheet.heightMm;
  for (const sh of result.sheets) {
    const polys: { poly: Polygon; bbox: BBox; id: string; instance: number }[] = [];
    const seen = new Set<string>();
    for (const pl of sh.placements) {
      const part = byId.get(pl.partId);
      if (!part) continue;
      const key = `${pl.partId}#${pl.instance}`;
      if (seen.has(key)) violations.push({ sheet: sh.index, kind: "quantity", message: `${part.label} instance ${pl.instance} appears twice on sheet ${sh.index + 1}.` });
      seen.add(key);
      const loop: Loop = placedGeometry(part, pl).outer;
      placementsChecked++;
      // geometry preserved?
      const a0 = Math.abs(loopArea(part.outer));
      const a1 = Math.abs(loopArea(loop));
      const p0 = loopPerimeter(part.outer);
      const p1 = loopPerimeter(loop);
      if (Math.abs(a0 - a1) > areaRelTol * Math.max(1, a0) || Math.abs(p0 - p1) > 1e-6 * Math.max(1, p0)) {
        violations.push({ sheet: sh.index, kind: "geometry", message: `${part.label} #${pl.instance + 1}: placed contour differs from the source (area ${a0.toFixed(3)} → ${a1.toFixed(3)}, perimeter ${p0.toFixed(3)} → ${p1.toFixed(3)}).`, a: { partId: pl.partId, instance: pl.instance } });
      }
      const poly = discretizeLoop(loop, sagitta, true);
      let bbox: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const q of poly) bbox = { minX: Math.min(bbox.minX, q.x), minY: Math.min(bbox.minY, q.y), maxX: Math.max(bbox.maxX, q.x), maxY: Math.max(bbox.maxY, q.y) };
      // in bounds (the sheet is convex: vertices inside ⇒ polygon inside)
      const m = s.marginMm;
      const edge = Math.min(bbox.minX, bbox.minY, W - bbox.maxX, H - bbox.maxY);
      if (minEdge === null || edge < minEdge) minEdge = edge;
      if (bbox.minX < m - tol || bbox.minY < m - tol || bbox.maxX > W - m + tol || bbox.maxY > H - m + tol) {
        violations.push({ sheet: sh.index, kind: "out-of-bounds", message: `${part.label} #${pl.instance + 1} is ${edge.toFixed(3)} mm from the sheet edge; ${m} mm required.`, a: { partId: pl.partId, instance: pl.instance }, measured: edge, required: m });
      }
      // no-go zones
      for (const z of s.noGoZones) {
        const rect: Polygon = [
          { x: z.x, y: z.y },
          { x: z.x + z.w, y: z.y },
          { x: z.x + z.w, y: z.y + z.h },
          { x: z.x, y: z.y + z.h },
        ];
        if (!bboxOverlaps(bbox, { minX: z.x, minY: z.y, maxX: z.x + z.w, maxY: z.y + z.h }, m + tol)) continue;
        if (polygonsOverlap(poly, rect)) violations.push({ sheet: sh.index, kind: "no-go-zone", message: `${part.label} #${pl.instance + 1} overlaps no-go zone ${z.label ?? ""}.`, a: { partId: pl.partId, instance: pl.instance } });
        else {
          const d = polygonBoundaryDistance(poly, rect);
          if (d < m - tol) violations.push({ sheet: sh.index, kind: "no-go-zone", message: `${part.label} #${pl.instance + 1} is ${d.toFixed(3)} mm from no-go zone ${z.label ?? ""}; ${m} mm required.`, a: { partId: pl.partId, instance: pl.instance }, measured: d, required: m });
        }
      }
      polys.push({ poly, bbox, id: pl.partId, instance: pl.instance });
    }
    // pairwise
    for (let i = 0; i < polys.length; i++) {
      for (let j = i + 1; j < polys.length; j++) {
        const A = polys[i];
        const B = polys[j];
        // look a little beyond the spacing so the reported minimum clearance is real
        if (!bboxOverlaps(A.bbox, B.bbox, s.spacingMm + 2)) continue;
        pairs++;
        const la = byId.get(A.id)?.label ?? A.id;
        const lb = byId.get(B.id)?.label ?? B.id;
        if (polygonsOverlap(A.poly, B.poly)) {
          violations.push({ sheet: sh.index, kind: "overlap", message: `${la} #${A.instance + 1} overlaps ${lb} #${B.instance + 1}.`, a: { partId: A.id, instance: A.instance }, b: { partId: B.id, instance: B.instance }, measured: 0, required: s.spacingMm });
          continue;
        }
        const d = polygonBoundaryDistance(A.poly, B.poly);
        // containment without boundary crossing (one inside the other) is an overlap too
        if (d > 0 && (pointInPolygon(A.poly[0], B.poly) || pointInPolygon(B.poly[0], A.poly))) {
          violations.push({ sheet: sh.index, kind: "overlap", message: `${la} #${A.instance + 1} lies inside ${lb} #${B.instance + 1}.`, a: { partId: A.id, instance: A.instance }, b: { partId: B.id, instance: B.instance } });
          continue;
        }
        if (minClear === null || d < minClear) minClear = d;
        if (d < s.spacingMm - tol) violations.push({ sheet: sh.index, kind: "spacing", message: `${la} #${A.instance + 1} and ${lb} #${B.instance + 1} are ${d.toFixed(3)} mm apart; ${s.spacingMm} mm required.`, a: { partId: A.id, instance: A.instance }, b: { partId: B.id, instance: B.instance }, measured: d, required: s.spacingMm });
      }
    }
  }
  return { ok: violations.length === 0, violations, tolerances: { sagittaMm: sagitta, distanceTolMm: tol, areaRelTol }, stats: { pairsChecked: pairs, minClearanceMm: minClear, minEdgeDistanceMm: minEdge, placementsChecked } };
}
