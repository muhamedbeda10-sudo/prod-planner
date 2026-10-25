// Build the DXF entities of one nested sheet and of a single part.

import type { NestPartInput, NestResult, SheetLayout } from "../nesting/types";
import { placedGeometry } from "../nesting/placement";
import { transformLoop, transformSeg, loopBBox } from "../geometry/polygon";
import { loopEntities, segEntities, writeDxf, type DxfOutEntity, type DxfLayerSpec } from "./dxfWriter";
import { lineSeg } from "../geometry/arc";

export const SHEET_LAYERS: DxfLayerSpec[] = [
  { name: "SHEET", color: 8 },
  { name: "CUT_INNER", color: 1 },
  { name: "CUT_OUTER", color: 7 },
  { name: "MARK", color: 3 },
  { name: "LABEL", color: 4 },
];

export interface SheetDxfOptions {
  includeSheetOutline?: boolean;
  includeLabels?: boolean;
  includeMarks?: boolean;
}

export function sheetDxf(result: NestResult, sheet: SheetLayout, parts: NestPartInput[], opts: SheetDxfOptions = {}): string {
  const s = result.settings;
  const W = s.sheet.widthMm;
  const H = s.sheet.heightMm;
  const ents: DxfOutEntity[] = [];
  if (opts.includeSheetOutline !== false) {
    ents.push({ kind: "lwpolyline", layer: "SHEET", loop: { segs: [lineSeg({ x: 0, y: 0 }, { x: W, y: 0 }), lineSeg({ x: W, y: 0 }, { x: W, y: H }), lineSeg({ x: W, y: H }, { x: 0, y: H }), lineSeg({ x: 0, y: H }, { x: 0, y: 0 })] } });
  }
  const byId = new Map(parts.map((p) => [p.id, p]));
  for (const pl of sheet.placements) {
    const part = byId.get(pl.partId);
    if (!part) continue;
    const g = placedGeometry(part, pl);
    // inner contours first, then the outer: the order a cutter wants
    for (const h of g.holes) ents.push(...loopEntities(h, "CUT_INNER"));
    ents.push(...loopEntities(g.outer, "CUT_OUTER"));
    if (opts.includeMarks !== false && g.marks.length) ents.push(...segEntities(g.marks, "MARK"));
    if (opts.includeLabels !== false) {
      const b = pl.bbox;
      const size = Math.max(3, Math.min(20, Math.min(b.maxX - b.minX, b.maxY - b.minY) / 6));
      ents.push({ kind: "text", layer: "LABEL", at: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, height: size, text: `${part.label} #${pl.instance + 1}` });
    }
  }
  return writeDxf(ents, {
    layers: SHEET_LAYERS,
    extents: { min: { x: 0, y: 0 }, max: { x: W, y: H } },
    comment: `nesting-lab run ${result.runId} sheet ${sheet.index + 1}/${result.sheets.length} — ${s.sheet.material} ${s.sheet.thicknessMm} mm ${W}x${H} mm — units mm — ${result.engineVersion}`,
  });
}

/** One part on its own, bbox min at the origin, for a part library. */
export function partDxf(part: NestPartInput, comment?: string): string {
  const b = loopBBox(part.outer);
  const t = { rotationDeg: 0, mirror: false, dx: -b.minX, dy: -b.minY };
  const ents: DxfOutEntity[] = [];
  for (const h of part.holes) ents.push(...loopEntities(transformLoop(h, t), "CUT_INNER"));
  ents.push(...loopEntities(transformLoop(part.outer, t), "CUT_OUTER"));
  if (part.marks?.length) ents.push(...segEntities(part.marks.map((m) => transformSeg(m, t)), "MARK"));
  return writeDxf(ents, { layers: SHEET_LAYERS, comment: comment ?? `nesting-lab part ${part.label} — units mm` });
}
