// One call from file bytes to everything the screen shows: header facts,
// layers, entity accounting, pieces, part types and warnings. Pure; the
// caller decides the unit and the layer roles (and must, for a unitless file).

import { decodeDxfBytes } from "./tokenize";
import { parseDxf, type DxfDocument } from "./parse";
import { extractPrimitives, layerUsage, type LayerRole, type LayerUsage, type PrimitiveExtraction, type TaggedSeg } from "./primitives";
import { buildTopology } from "../geometry/topology";
import { classify, type Classification, type Piece } from "../geometry/classify";
import { dedupePieces, type DedupeResult } from "../geometry/dedupe";
import type { BBox } from "../geometry/types";
import { factorForSelectable, type SelectableUnit } from "./units";

export interface AnalyzeOptions {
  /** required for unitless files; ignored when the file states its unit unless `overrideUnit` */
  unit?: SelectableUnit | null;
  overrideUnit?: boolean;
  layerRoles?: Record<string, LayerRole>;
  /** endpoint snap tolerance in mm (default 0.01) */
  snapTolMm?: number;
  minPartAreaMm2?: number;
  /** sheet thickness, when known — only used for the small-hole warning */
  thicknessMm?: number | null;
}

export interface DxfAnalysis {
  fileName: string;
  bytes: number;
  acadVersion: string | null;
  units: { code: number; name: string; stated: boolean; chosen: SelectableUnit | null; factorToMm: number | null };
  /** true when the file is unitless and no unit was chosen: geometry is NOT available */
  needsUnit: boolean;
  extents: { stated: BBox | null; computed: BBox | null };
  layers: (LayerUsage & { role: LayerRole })[];
  entityCounts: { type: string; count: number }[];
  extraction: Omit<PrimitiveExtraction, "segs"> | null;
  topology: { nodes: number; edges: number; faces: number; openChains: number; duplicatesRemoved: number; splitsApplied: number; maxGapClosed: number; snapTolMm: number } | null;
  classification: Classification | null;
  parts: DedupeResult | null;
  marks: TaggedSeg[];
  warnings: string[];
  timings: { parseMs: number; topologyMs: number; classifyMs: number; totalMs: number };
}

export function analyzeDxf(fileName: string, bytes: Uint8Array, opts: AnalyzeOptions = {}): DxfAnalysis {
  const t0 = performance.now();
  const text = decodeDxfBytes(bytes);
  const doc = parseDxf(text);
  const t1 = performance.now();
  return analyzeDocument(fileName, bytes.length, doc, opts, t1 - t0, t0);
}

export function analyzeDocument(fileName: string, byteLength: number, doc: DxfDocument, opts: AnalyzeOptions, parseMs: number, t0 = performance.now()): DxfAnalysis {
  const warnings: string[] = [...doc.warnings];
  const roles = opts.layerRoles ?? {};
  const layers = layerUsage(doc).map((l) => ({ ...l, role: roles[l.name] ?? ("cut" as LayerRole) }));
  for (const l of layers) if (!l.defined && l.total > 0) warnings.push(`Layer "${l.name}" is used by ${l.total} entities but is not defined in the LAYER table (the file came from a converter).`);
  const counts = new Map<string, number>();
  for (const e of doc.entities) {
    const raw = e.type === "OTHER" ? e.rawType : e.type;
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  const entityCounts = [...counts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
  const stated = doc.units.toMm !== null;
  let factor: number | null = null;
  let chosen: SelectableUnit | null = null;
  if (stated && !opts.overrideUnit) factor = doc.units.toMm;
  else if (opts.unit) {
    chosen = opts.unit;
    factor = factorForSelectable(opts.unit);
  }
  if (!stated) warnings.push(`$INSUNITS = ${doc.units.code} (${doc.units.name}): the file does not state its unit. Choose the unit the drawing was made in before using its geometry.`);
  const extStated: BBox | null = doc.extMin && doc.extMax ? { minX: doc.extMin.x, minY: doc.extMin.y, maxX: doc.extMax.x, maxY: doc.extMax.y } : null;
  const base: DxfAnalysis = {
    fileName,
    bytes: byteLength,
    acadVersion: doc.acadVersion,
    units: { code: doc.units.code, name: doc.units.name, stated, chosen, factorToMm: factor },
    needsUnit: factor === null,
    extents: { stated: extStated, computed: null },
    layers,
    entityCounts,
    extraction: null,
    topology: null,
    classification: null,
    parts: null,
    marks: [],
    warnings,
    timings: { parseMs, topologyMs: 0, classifyMs: 0, totalMs: 0 },
  };
  if (factor === null) {
    base.timings.totalMs = performance.now() - t0;
    return base;
  }
  const extraction = extractPrimitives(doc, { unitFactor: factor, layerRoles: roles });
  const { segs, ...rest } = extraction;
  base.extraction = rest;
  for (const u of extraction.unsupported) warnings.push(`${u.count} × ${u.type} on layer "${u.layer}" is not supported as cut geometry and was left out.`);
  for (const a of extraction.annotations) warnings.push(`${a.count} × ${a.type} on layer "${a.layer}" is annotation, not cut geometry.`);
  if (extraction.nonPlanar.note) warnings.push(extraction.nonPlanar.note);
  const cutSegs = segs.filter((s) => s.tag.role === "cut");
  const marks = segs.filter((s) => s.tag.role === "mark");
  const snapTol = opts.snapTolMm ?? 0.01;
  const t2 = performance.now();
  const topo = buildTopology(cutSegs, { snapTol });
  const t3 = performance.now();
  base.topology = { nodes: topo.nodes, edges: topo.edges, faces: topo.faces.length, openChains: topo.open.length, duplicatesRemoved: topo.duplicatesRemoved, splitsApplied: topo.splitsApplied, maxGapClosed: topo.maxGapClosed, snapTolMm: snapTol };
  const cls = classify(topo, marks, { minPartArea: opts.minPartAreaMm2 ?? 100, sliverWidth: 0.5, smallCutoutArea: 1000, reviewArea: 400, sheetTol: 0.5, sagitta: 0.05 });
  base.classification = cls;
  base.extents.computed = cls.overallBBox;
  base.marks = marks;
  warnings.push(...cls.warnings);
  const parts = dedupePieces(cls.pieces, { tol: Math.max(snapTol, 0.02) });
  base.parts = parts;
  const t4 = performance.now();
  if (opts.thicknessMm) {
    let small = 0;
    for (const p of cls.pieces) for (const h of p.holes) {
      const s = h.loop.segs[0];
      if (h.loop.segs.length === 1 && s.kind === "arc" && s.full && 2 * s.r < opts.thicknessMm) small++;
    }
    if (small > 0) warnings.push(`${small} round hole(s) are smaller than the sheet thickness (${opts.thicknessMm} mm) — a laser cannot cut them cleanly; they may be marks.`);
  }
  if (extStated && cls.overallBBox) {
    const c = cls.overallBBox;
    const sx = (extStated.maxX - extStated.minX) * factor;
    const sy = (extStated.maxY - extStated.minY) * factor;
    if (Math.abs(sx - (c.maxX - c.minX)) > 1 || Math.abs(sy - (c.maxY - c.minY)) > 1) warnings.push(`$EXTMAX−$EXTMIN says ${sx.toFixed(1)} × ${sy.toFixed(1)} mm but the cut geometry spans ${(c.maxX - c.minX).toFixed(1)} × ${(c.maxY - c.minY).toFixed(1)} mm.`);
  }
  base.timings = { parseMs, topologyMs: t3 - t2, classifyMs: t4 - t3, totalMs: performance.now() - t0 };
  return base;
}

export function pieceById(a: DxfAnalysis, id: string): Piece | undefined {
  return a.classification?.pieces.find((p) => p.id === id);
}
