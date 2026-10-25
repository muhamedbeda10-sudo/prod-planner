// Read an exported sheet DXF back with the same parser the uploads go through
// and prove that every placed part is there with its exact size.

import { parseDxf } from "../dxf/parse";
import { extractPrimitives } from "../dxf/primitives";
import { buildTopology } from "../geometry/topology";
import { classify } from "../geometry/classify";
import { loopArea, loopBBox, loopPerimeter } from "../geometry/polygon";
import { placedGeometry } from "../nesting/placement";
import type { NestPartInput, NestResult, SheetLayout } from "../nesting/types";

export interface RoundTripReport {
  ok: boolean;
  unitsStated: boolean;
  insunits: number;
  acadVersion: string | null;
  entityCounts: { type: string; count: number }[];
  piecesExpected: number;
  piecesFound: number;
  matched: number;
  maxAreaDeltaMm2: number;
  maxBBoxDeltaMm: number;
  maxPerimeterDeltaMm: number;
  holesExpected: number;
  holesFound: number;
  mismatches: string[];
}

export function verifyDxfRoundTrip(dxfText: string, result: NestResult, sheet: SheetLayout, parts: NestPartInput[]): RoundTripReport {
  const doc = parseDxf(dxfText);
  const counts = new Map<string, number>();
  for (const e of doc.entities) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const mismatches: string[] = [];
  const unitsStated = doc.units.toMm !== null;
  if (!unitsStated) mismatches.push("The exported file does not state its unit.");
  const factor = doc.units.toMm ?? 1;
  const prim = extractPrimitives(doc, { unitFactor: factor, layerRoles: { SHEET: "ignore", LABEL: "ignore", MARK: "mark" } });
  for (const u of prim.unsupported) mismatches.push(`Unsupported entity in the export: ${u.count} × ${u.type}.`);
  const topo = buildTopology(prim.segs.filter((s) => s.tag.role === "cut"), { snapTol: 0.001 });
  const cls = classify(topo, [], { minPartArea: 0, sliverWidth: 0, smallCutoutArea: 0, reviewArea: 0, sheetTol: 0.5, sagitta: 0.05 });
  const byId = new Map(parts.map((p) => [p.id, p]));
  const pieces = cls.pieces.filter((p) => p.depth === 0).slice();
  let matched = 0;
  let maxArea = 0;
  let maxBox = 0;
  let maxPer = 0;
  let holesExpected = 0;
  let holesFound = 0;
  const used = new Set<string>();
  for (const pl of sheet.placements) {
    const part = byId.get(pl.partId);
    if (!part) continue;
    const loop = placedGeometry(part, pl).outer;
    const b = loopBBox(loop);
    const area = Math.abs(loopArea(loop));
    const per = loopPerimeter(loop);
    holesExpected += part.holes.length;
    let best: { piece: (typeof pieces)[number]; dBox: number } | null = null;
    for (const pc of pieces) {
      if (used.has(pc.id)) continue;
      const pb = pc.bbox;
      const dBox = Math.max(Math.abs(pb.minX - b.minX), Math.abs(pb.minY - b.minY), Math.abs(pb.maxX - b.maxX), Math.abs(pb.maxY - b.maxY));
      if (dBox < 0.01 && (!best || dBox < best.dBox)) best = { piece: pc, dBox };
    }
    if (!best) {
      mismatches.push(`${part.label} #${pl.instance + 1} not found at ${b.minX.toFixed(2)},${b.minY.toFixed(2)} (${(b.maxX - b.minX).toFixed(2)}×${(b.maxY - b.minY).toFixed(2)} mm).`);
      continue;
    }
    used.add(best.piece.id);
    matched++;
    const dA = Math.abs(best.piece.outer.area - area);
    const dP = Math.abs(best.piece.outer.perimeter - per);
    maxArea = Math.max(maxArea, dA);
    maxBox = Math.max(maxBox, best.dBox);
    maxPer = Math.max(maxPer, dP);
    holesFound += best.piece.holes.length;
    if (dA > 1e-3 * Math.max(1, area) * 1e-3) mismatches.push(`${part.label} #${pl.instance + 1}: area ${area.toFixed(3)} → ${best.piece.outer.area.toFixed(3)} mm² after re-reading.`);
    if (dP > 1e-3) mismatches.push(`${part.label} #${pl.instance + 1}: perimeter ${per.toFixed(3)} → ${best.piece.outer.perimeter.toFixed(3)} mm after re-reading.`);
    if (best.piece.holes.length !== part.holes.length) mismatches.push(`${part.label} #${pl.instance + 1}: ${part.holes.length} holes exported, ${best.piece.holes.length} read back.`);
  }
  if (pieces.length !== sheet.placements.length) mismatches.push(`${sheet.placements.length} parts were exported but ${pieces.length} closed outer contours were read back${pieces.length > sheet.placements.length ? " (touching parts merge when spacing is 0)" : ""}.`);
  return {
    ok: mismatches.length === 0,
    unitsStated,
    insunits: doc.units.code,
    acadVersion: doc.acadVersion,
    entityCounts: [...counts.entries()].map(([type, count]) => ({ type, count })),
    piecesExpected: sheet.placements.length,
    piecesFound: pieces.length,
    matched,
    maxAreaDeltaMm2: maxArea,
    maxBBoxDeltaMm: maxBox,
    maxPerimeterDeltaMm: maxPer,
    holesExpected,
    holesFound,
    mismatches,
  };
}
