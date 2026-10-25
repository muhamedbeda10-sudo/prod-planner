// From parsed DXF entities to exact 2D primitives (lines, arcs, circles) in
// millimetres, with every entity accounted for: used as cut geometry, used as
// a mark, ignored by layer role, ignored as annotation, or unsupported.

import type { DxfDocument, DxfEntity, DxfInsert } from "./parse";
import type { Point, Seg, SegTag, TaggedSeg } from "../geometry/types";
import { fullCircle, segFromBulge } from "../geometry/arc";
import { DxfFormatError } from "./tokenize";

export type LayerRole = "cut" | "mark" | "ignore";
export type { SegTag, TaggedSeg };

const ROLES: readonly LayerRole[] = ["cut", "mark", "ignore"];

/** Role of a layer from a plain map, immune to prototype keys ("constructor"). */
export function layerRoleOf(roles: Record<string, LayerRole>, layer: string): LayerRole {
  const v = Object.hasOwn(roles, layer) ? roles[layer] : undefined;
  return v !== undefined && ROLES.includes(v) ? v : "cut";
}

/** Limits that keep a hostile file from freezing the analysis. */
export const LIMITS = {
  insertGrid: 10_000, // rows × columns of one INSERT
  insertSide: 1_000,
  segments: 2_000_000, // extracted segments per file
  radiusMm: 1e7,
};

/** Entity types that never cut: text, dimensions, points, hatches… They are
 *  reported, never silently dropped. */
const ANNOTATION_TYPES = new Set(["TEXT", "MTEXT", "DIMENSION", "POINT", "HATCH", "LEADER", "MLEADER", "ATTRIB", "ATTDEF", "VIEWPORT", "IMAGE", "WIPEOUT", "TOLERANCE", "RAY", "XLINE", "SOLID", "TRACE", "3DFACE", "REGION", "BODY", "3DSOLID", "MESH", "SURFACE", "LIGHT", "OLE2FRAME", "OLEFRAME", "SHAPE", "TABLE", "ACAD_PROXY_ENTITY", "POLYLINE_MESH"]);

/** Geometry types we recognise but cannot yet turn into cut geometry. */
const UNSUPPORTED_GEOMETRY = new Set(["ELLIPSE", "SPLINE", "HELIX"]);

export interface EntityAccount {
  type: string;
  layer: string;
  count: number;
}

export interface PrimitiveExtraction {
  segs: TaggedSeg[];
  /** entities on layers the user marked "ignore" */
  ignoredByLayer: EntityAccount[];
  /** annotation entities (text, dimensions…) — never cut */
  annotations: EntityAccount[];
  /** geometry we refuse to approximate (splines, ellipses) and unknown types */
  unsupported: EntityAccount[];
  /** INSERTs expanded, with the block names */
  insertsExpanded: { block: string; count: number }[];
  /** things the geometry says that need a human look */
  warnings: string[];
  /** duplicate full circles / zero-length segments dropped */
  dropped: { zeroLength: number };
  /** 3D content detected: z ≠ 0 or an extrusion off the Z axis */
  nonPlanar: { entities: number; note: string | null };
  /** entities drawn in the −Z object coordinate system (AutoCAD MIRROR) and mapped back to world x */
  mirroredByExtrusion: number;
}

export interface ExtractOptions {
  /** millimetres per drawing unit (must be resolved by the caller) */
  unitFactor: number;
  layerRoles: Record<string, LayerRole>;
  /** segments shorter than this are dropped (mm) */
  zeroLengthTol?: number;
  /** maximum INSERT nesting depth */
  maxInsertDepth?: number;
}

interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const IDENT: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function mul(m: Matrix, n: Matrix): Matrix {
  // apply n first, then m
  return { a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b, c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d, e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f };
}
function apply(m: Matrix, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}
function isUniform(m: Matrix): boolean {
  // columns orthogonal with equal length → rotation × uniform scale (possibly a reflection)
  const l1 = Math.hypot(m.a, m.b);
  const l2 = Math.hypot(m.c, m.d);
  const dot = m.a * m.c + m.b * m.d;
  return Math.abs(l1 - l2) <= 1e-9 * Math.max(1, l1) && Math.abs(dot) <= 1e-9 * Math.max(1, l1 * l2);
}
function scaleOf(m: Matrix): number {
  return Math.hypot(m.a, m.b);
}
function isReflection(m: Matrix): boolean {
  return m.a * m.d - m.b * m.c < 0;
}

function account(list: EntityAccount[], type: string, layer: string) {
  const row = list.find((r) => r.type === type && r.layer === layer);
  if (row) row.count++;
  else list.push({ type, layer, count: 1 });
}

export function extractPrimitives(doc: DxfDocument, opts: ExtractOptions): PrimitiveExtraction {
  const zeroTol = opts.zeroLengthTol ?? 1e-6;
  const maxDepth = opts.maxInsertDepth ?? 8;
  const out: PrimitiveExtraction = { segs: [], ignoredByLayer: [], annotations: [], unsupported: [], insertsExpanded: [], warnings: [], dropped: { zeroLength: 0 }, nonPlanar: { entities: 0, note: null }, mirroredByExtrusion: 0 };
  const roleOf = (layer: string): LayerRole => layerRoleOf(opts.layerRoles, layer);
  const unit = opts.unitFactor;
  let nonPlanar = 0;
  const nonPlanarTypes = new Set<string>();

  const pushSeg = (seg: Seg, e: DxfEntity, role: "cut" | "mark") => {
    if (!(seg.kind === "arc" && seg.full)) {
      const len = Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y);
      if (len <= zeroTol && seg.kind === "line") {
        out.dropped.zeroLength++;
        return;
      }
    }
    if (seg.kind === "arc" && !(seg.r <= LIMITS.radiusMm)) {
      account(out.unsupported, `${e.type} (radius ${seg.r} mm beyond the ${LIMITS.radiusMm} mm limit)`, e.layer);
      return;
    }
    if (out.segs.length >= LIMITS.segments) throw new DxfFormatError(`The file expands to more than ${LIMITS.segments} segments; it is beyond what this tool handles.`);
    out.segs.push({ ...seg, tag: { layer: e.layer, handle: e.handle, entityType: e.type, entityIndex: e.index, role } });
  };
  const blockStack: string[] = [];

  const visit = (ents: DxfEntity[], mIn: Matrix, depth: number) => {
    for (const e of ents) {
      const role = roleOf(e.layer);
      if (role === "ignore") {
        account(out.ignoredByLayer, e.type, e.layer);
        continue;
      }
      let m = mIn;
      if (e.extrusion && (Math.abs(e.extrusion.x) > 1e-9 || Math.abs(e.extrusion.y) > 1e-9)) {
        nonPlanar++;
        nonPlanarTypes.add(e.type);
        account(out.unsupported, `${e.type} (extrusion not along Z)`, e.layer);
        continue;
      }
      if (e.extrusion && e.extrusion.z < 0 && e.type !== "LINE" && e.type !== "INSERT") {
        // the −Z object coordinate system (AutoCAD's MIRROR): OCS x is −WCS x
        m = mul(mIn, { a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 });
        out.mirroredByExtrusion++;
      }
      switch (e.type) {
        case "LINE": {
          if (Math.abs(e.a.z) > 1e-9 || Math.abs(e.b.z) > 1e-9) {
            nonPlanar++;
            nonPlanarTypes.add(e.type);
          }
          const a = apply(m, { x: e.a.x * unit, y: e.a.y * unit });
          const b = apply(m, { x: e.b.x * unit, y: e.b.y * unit });
          pushSeg({ kind: "line", a, b }, e, role);
          break;
        }
        case "CIRCLE": {
          if (Math.abs(e.center.z) > 1e-9) {
            nonPlanar++;
            nonPlanarTypes.add(e.type);
          }
          if (!isUniform(m)) {
            account(out.unsupported, "CIRCLE (non-uniform block scale)", e.layer);
            break;
          }
          const c = apply(m, { x: e.center.x * unit, y: e.center.y * unit });
          const r = e.r * unit * scaleOf(m);
          if (r <= zeroTol) {
            out.dropped.zeroLength++;
            break;
          }
          pushSeg(fullCircle(c, r), e, role);
          break;
        }
        case "ARC": {
          if (Math.abs(e.center.z) > 1e-9) {
            nonPlanar++;
            nonPlanarTypes.add(e.type);
          }
          if (!isUniform(m)) {
            account(out.unsupported, "ARC (non-uniform block scale)", e.layer);
            break;
          }
          const r = e.r * unit * scaleOf(m);
          const s0 = (e.startDeg * Math.PI) / 180;
          const s1 = (e.endDeg * Math.PI) / 180;
          const c0 = { x: e.center.x * unit, y: e.center.y * unit };
          const a = apply(m, { x: c0.x + e.r * unit * Math.cos(s0), y: c0.y + e.r * unit * Math.sin(s0) });
          const b = apply(m, { x: c0.x + e.r * unit * Math.cos(s1), y: c0.y + e.r * unit * Math.sin(s1) });
          const c = apply(m, c0);
          const ccw = !isReflection(m);
          pushSeg({ kind: "arc", a, b, center: c, r, ccw }, e, role);
          break;
        }
        case "LWPOLYLINE":
        case "POLYLINE": {
          if (e.type === "POLYLINE" && (e.flags & 8) !== 0) {
            account(out.unsupported, "POLYLINE (3D)", e.layer);
            break;
          }
          if (Math.abs(e.elevation) > 1e-9) {
            nonPlanar++;
            nonPlanarTypes.add(e.type);
          }
          const vs = e.vertices;
          if (vs.length < 2) {
            out.dropped.zeroLength++;
            break;
          }
          const n = e.closed ? vs.length : vs.length - 1;
          const reflect = isReflection(m);
          for (let i = 0; i < n; i++) {
            const v0 = vs[i];
            const v1 = vs[(i + 1) % vs.length];
            const p0 = { x: v0.x * unit, y: v0.y * unit };
            const p1 = { x: v1.x * unit, y: v1.y * unit };
            if (Math.abs(v0.bulge) > 1e-12 && !isUniform(m)) {
              account(out.unsupported, `${e.type} bulge (non-uniform block scale)`, e.layer);
              continue;
            }
            // build the arc in drawing space, then transform it (a uniform scale
            // keeps it circular; a reflection flips its direction of travel)
            const seg = segFromBulge(p0, p1, v0.bulge);
            if (seg.kind === "line") pushSeg({ kind: "line", a: apply(m, p0), b: apply(m, p1) }, e, role);
            else pushSeg({ kind: "arc", a: apply(m, seg.a), b: apply(m, seg.b), center: apply(m, seg.center), r: seg.r * scaleOf(m), ccw: reflect ? !seg.ccw : seg.ccw }, e, role);
          }
          break;
        }
        case "INSERT": {
          const ins = e as DxfInsert;
          const block = Object.hasOwn(doc.blocks, ins.blockName) ? doc.blocks[ins.blockName] : undefined;
          if (!block) {
            account(out.unsupported, `INSERT of missing block "${ins.blockName}"`, e.layer);
            break;
          }
          if (depth >= maxDepth) {
            account(out.unsupported, `INSERT nested deeper than ${maxDepth}`, e.layer);
            break;
          }
          if (blockStack.includes(ins.blockName)) {
            account(out.unsupported, `INSERT of block "${ins.blockName}" inside itself`, e.layer);
            break;
          }
          const rows = Math.max(1, Math.floor(ins.rows));
          const cols = Math.max(1, Math.floor(ins.columns));
          if (rows > LIMITS.insertSide || cols > LIMITS.insertSide || rows * cols > LIMITS.insertGrid) {
            account(out.unsupported, `INSERT array ${rows}×${cols} beyond the ${LIMITS.insertGrid}-copy limit`, e.layer);
            break;
          }
          const row = out.insertsExpanded.find((r) => r.block === ins.blockName);
          if (row) row.count++;
          else out.insertsExpanded.push({ block: ins.blockName, count: 1 });
          const rad = (ins.rotationDeg * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          blockStack.push(ins.blockName);
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              // translate(at) · rotate · translate(column/row offset, along the
              // block's own axes) · scale · translate(-base)
              const sc: Matrix = { a: ins.scale.x, b: 0, c: 0, d: ins.scale.y, e: 0, f: 0 };
              const rot: Matrix = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
              const tr: Matrix = { a: 1, b: 0, c: 0, d: 1, e: ins.at.x * unit, f: ins.at.y * unit };
              const cell: Matrix = { a: 1, b: 0, c: 0, d: 1, e: c * ins.colSpacing * unit, f: r * ins.rowSpacing * unit };
              const base: Matrix = { a: 1, b: 0, c: 0, d: 1, e: -block.base.x * unit, f: -block.base.y * unit };
              const local = mul(tr, mul(rot, mul(cell, mul(sc, base))));
              visit(block.entities, mul(m, local), depth + 1);
            }
          }
          blockStack.pop();
          break;
        }
        default: {
          const raw = e.type === "OTHER" ? e.rawType : e.type;
          if (ANNOTATION_TYPES.has(raw)) account(out.annotations, raw, e.layer);
          else if (UNSUPPORTED_GEOMETRY.has(raw)) account(out.unsupported, raw, e.layer);
          else account(out.unsupported, raw, e.layer);
        }
      }
    }
  };
  visit(doc.entities, IDENT, 0);
  out.nonPlanar = { entities: nonPlanar, note: nonPlanar > 0 ? `${nonPlanar} entities carry a Z coordinate, elevation or a tilted extrusion (${[...nonPlanarTypes].join(", ")}); they were projected onto the XY plane.` : null };
  if (out.mirroredByExtrusion > 0) out.warnings.push(`${out.mirroredByExtrusion} entities use the −Z extrusion (a mirrored drawing) and were mapped to world coordinates (x → −x).`);
  for (const w of doc.warnings) out.warnings.push(w);
  return out;
}

/** Every layer that appears on an entity (model space and blocks), with counts
 *  per entity type and whether the LAYER table defines it. */
export interface LayerUsage {
  name: string;
  defined: boolean;
  entities: { type: string; count: number }[];
  total: number;
}

export function layerUsage(doc: DxfDocument): LayerUsage[] {
  const map = new Map<string, Map<string, number>>();
  const add = (ents: DxfEntity[]) => {
    for (const e of ents) {
      const m = map.get(e.layer) ?? new Map<string, number>();
      const raw = e.type === "OTHER" ? e.rawType : e.type;
      m.set(raw, (m.get(raw) ?? 0) + 1);
      map.set(e.layer, m);
    }
  };
  add(doc.entities);
  for (const b of Object.values(doc.blocks)) if (!b.name.startsWith("*")) add(b.entities);
  const defined = new Set(doc.layerTable.map((l) => l.name));
  const out: LayerUsage[] = [];
  for (const [name, m] of map) {
    const entities = [...m.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
    out.push({ name, defined: defined.has(name), entities, total: entities.reduce((s, e) => s + e.count, 0) });
  }
  for (const l of doc.layerTable) if (!map.has(l.name)) out.push({ name: l.name, defined: true, entities: [], total: 0 });
  return out.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}
