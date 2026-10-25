// Structural DXF parser: HEADER variables, the LAYER table, BLOCK definitions
// and ENTITIES. Entities we cut from are typed; everything else is recorded
// by name so the analysis can say exactly what it saw and did not use.

import { tokenizeDxf, type Pair } from "./tokenize";
import { unitInfo, type UnitInfo } from "./units";

export interface DxfVertex {
  x: number;
  y: number;
  bulge: number;
}

interface EntityBase {
  type: string;
  layer: string;
  handle: string | null;
  /** index of the entity in the ENTITIES section (or within its block) */
  index: number;
  /** owner block name; null when in model space */
  block: string | null;
  /** extrusion (210/220/230) when present — anything but +Z needs care */
  extrusion: { x: number; y: number; z: number } | null;
  elevation: number;
}

export interface DxfLine extends EntityBase {
  type: "LINE";
  a: { x: number; y: number; z: number };
  b: { x: number; y: number; z: number };
}
export interface DxfLwPolyline extends EntityBase {
  type: "LWPOLYLINE";
  vertices: DxfVertex[];
  closed: boolean;
  constantWidth: number;
}
export interface DxfPolyline extends EntityBase {
  type: "POLYLINE";
  vertices: DxfVertex[];
  closed: boolean;
  /** 70 flags: 8 = 3D polyline, 16 = polygon mesh, 64 = polyface mesh */
  flags: number;
}
export interface DxfCircle extends EntityBase {
  type: "CIRCLE";
  center: { x: number; y: number; z: number };
  r: number;
}
export interface DxfArc extends EntityBase {
  type: "ARC";
  center: { x: number; y: number; z: number };
  r: number;
  startDeg: number;
  endDeg: number;
}
export interface DxfInsert extends EntityBase {
  type: "INSERT";
  blockName: string;
  at: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  rotationDeg: number;
  columns: number;
  rows: number;
  colSpacing: number;
  rowSpacing: number;
}
export interface DxfEllipse extends EntityBase {
  type: "ELLIPSE";
  center: { x: number; y: number; z: number };
  majorAxis: { x: number; y: number; z: number };
  ratio: number;
  startParam: number;
  endParam: number;
}
export interface DxfSpline extends EntityBase {
  type: "SPLINE";
  degree: number;
  controlPoints: { x: number; y: number; z: number }[];
  fitPoints: { x: number; y: number; z: number }[];
  knots: number[];
  closed: boolean;
}
export interface DxfText extends EntityBase {
  type: "TEXT" | "MTEXT";
  text: string;
  at: { x: number; y: number; z: number };
  height: number;
}
export interface DxfPoint extends EntityBase {
  type: "POINT";
  at: { x: number; y: number; z: number };
}
export interface DxfOther extends EntityBase {
  type: "OTHER";
  /** the DXF entity type as written in the file */
  rawType: string;
  other: true;
}

export type DxfEntity = DxfLine | DxfLwPolyline | DxfPolyline | DxfCircle | DxfArc | DxfInsert | DxfEllipse | DxfSpline | DxfText | DxfPoint | DxfOther;

export interface DxfLayerDef {
  name: string;
  color: number | null;
  frozen: boolean;
  off: boolean;
}

export interface DxfBlockDef {
  name: string;
  base: { x: number; y: number; z: number };
  entities: DxfEntity[];
}

export interface DxfDocument {
  acadVersion: string | null;
  units: UnitInfo;
  header: Record<string, (string | number)[]>;
  extMin: { x: number; y: number; z: number } | null;
  extMax: { x: number; y: number; z: number } | null;
  layerTable: DxfLayerDef[];
  blocks: Record<string, DxfBlockDef>;
  entities: DxfEntity[];
  /** group codes we skipped inside entities, by entity type — for the report */
  warnings: string[];
}

let warnedWidths = false;

const num = (v: string): number => {
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : NaN;
};

function readSections(pairs: Pair[]): Map<string, Pair[]> {
  const out = new Map<string, Pair[]>();
  let i = 0;
  while (i < pairs.length) {
    const p = pairs[i];
    if (p.code === 0 && p.value === "SECTION") {
      const name = pairs[i + 1]?.code === 2 ? pairs[i + 1].value : `?${i}`;
      let j = i + 2;
      const body: Pair[] = [];
      while (j < pairs.length && !(pairs[j].code === 0 && pairs[j].value === "ENDSEC")) {
        body.push(pairs[j]);
        j++;
      }
      out.set(name, body);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

function parseHeader(body: Pair[]): Record<string, (string | number)[]> {
  // null prototype: a variable named "constructor" must not hit Object.prototype
  const h: Record<string, (string | number)[]> = Object.create(null);
  let i = 0;
  while (i < body.length) {
    if (body[i].code === 9) {
      const name = body[i].value;
      const vals: (string | number)[] = [];
      i++;
      while (i < body.length && body[i].code !== 9) {
        const v = body[i].value;
        const n = Number(v);
        vals.push(body[i].code === 1 || body[i].code === 2 || body[i].code === 3 || body[i].code === 8 || !Number.isFinite(n) ? v : n);
        i++;
      }
      h[name] = vals;
    } else i++;
  }
  return h;
}

function parseLayerTable(body: Pair[]): DxfLayerDef[] {
  const out: DxfLayerDef[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i].code === 0 && body[i].value === "LAYER") {
      const def: DxfLayerDef = { name: "", color: null, frozen: false, off: false };
      i++;
      while (i < body.length && body[i].code !== 0) {
        const p = body[i];
        if (p.code === 2) def.name = p.value;
        else if (p.code === 62) {
          const c = num(p.value);
          def.color = Math.abs(c);
          def.off = c < 0;
        } else if (p.code === 70) def.frozen = (num(p.value) & 1) === 1;
        i++;
      }
      if (def.name) out.push(def);
      continue;
    }
    i++;
  }
  return out;
}

/** Split an entity list body into entity pair-groups (each starting at a code 0). */
function* entityGroups(body: Pair[]): Generator<Pair[]> {
  let cur: Pair[] | null = null;
  for (const p of body) {
    if (p.code === 0) {
      if (cur) yield cur;
      cur = [p];
    } else if (cur) cur.push(p);
  }
  if (cur) yield cur;
}

function parseEntityGroup(g: Pair[], index: number, block: string | null, warnings: string[]): DxfEntity {
  const type = g[0].value;
  const base: EntityBase = { type, layer: "0", handle: null, index, block, extrusion: null, elevation: 0 };
  const get = (code: number): string | undefined => g.find((p) => p.code === code)?.value;
  const getN = (code: number, dflt = 0): number => {
    const v = get(code);
    return v === undefined ? dflt : num(v);
  };
  for (const p of g) {
    if (p.code === 8) base.layer = p.value;
    else if (p.code === 5) base.handle = p.value;
  }
  if (get(210) !== undefined || get(220) !== undefined || get(230) !== undefined) {
    base.extrusion = { x: getN(210, 0), y: getN(220, 0), z: getN(230, 1) };
  }
  switch (type) {
    case "LINE":
      return { ...base, type, a: { x: getN(10), y: getN(20), z: getN(30) }, b: { x: getN(11), y: getN(21), z: getN(31) } };
    case "CIRCLE":
      return { ...base, type, center: { x: getN(10), y: getN(20), z: getN(30) }, r: getN(40) };
    case "ARC":
      return { ...base, type, center: { x: getN(10), y: getN(20), z: getN(30) }, r: getN(40), startDeg: getN(50), endDeg: getN(51) };
    case "LWPOLYLINE": {
      const vertices: DxfVertex[] = [];
      let flags = 0;
      let constantWidth = 0;
      let elevation = 0;
      for (const p of g) {
        if (p.code === 10) vertices.push({ x: num(p.value), y: 0, bulge: 0 });
        else if (p.code === 20 && vertices.length) vertices[vertices.length - 1].y = num(p.value);
        else if (p.code === 42 && vertices.length) vertices[vertices.length - 1].bulge = num(p.value);
        else if (p.code === 70) flags = num(p.value);
        else if (p.code === 43) constantWidth = num(p.value);
        else if (p.code === 38) elevation = num(p.value);
        else if (p.code === 40 || p.code === 41) {
          // per-vertex start/end widths: ignored for cutting geometry, noted once
          if (!warnedWidths) {
            warnedWidths = true;
            warnings.push("LWPOLYLINE vertex widths (40/41) were ignored");
          }
        }
      }
      const declared = getN(90, vertices.length);
      if (declared !== vertices.length) warnings.push(`LWPOLYLINE ${base.handle ?? `#${index}`}: declares ${declared} vertices but has ${vertices.length}`);
      return { ...base, type, vertices, closed: (flags & 1) === 1, constantWidth, elevation };
    }
    case "INSERT":
      return {
        ...base,
        type,
        blockName: get(2) ?? "",
        at: { x: getN(10), y: getN(20), z: getN(30) },
        scale: { x: getN(41, 1), y: getN(42, 1), z: getN(43, 1) },
        rotationDeg: getN(50, 0),
        columns: getN(70, 1) || 1,
        rows: getN(71, 1) || 1,
        colSpacing: getN(44, 0),
        rowSpacing: getN(45, 0),
      };
    case "ELLIPSE":
      return { ...base, type, center: { x: getN(10), y: getN(20), z: getN(30) }, majorAxis: { x: getN(11), y: getN(21), z: getN(31) }, ratio: getN(40, 1), startParam: getN(41, 0), endParam: getN(42, Math.PI * 2) };
    case "SPLINE": {
      const controlPoints: { x: number; y: number; z: number }[] = [];
      const fitPoints: { x: number; y: number; z: number }[] = [];
      const knots: number[] = [];
      for (const p of g) {
        if (p.code === 10) controlPoints.push({ x: num(p.value), y: 0, z: 0 });
        else if (p.code === 20 && controlPoints.length) controlPoints[controlPoints.length - 1].y = num(p.value);
        else if (p.code === 30 && controlPoints.length) controlPoints[controlPoints.length - 1].z = num(p.value);
        else if (p.code === 11) fitPoints.push({ x: num(p.value), y: 0, z: 0 });
        else if (p.code === 21 && fitPoints.length) fitPoints[fitPoints.length - 1].y = num(p.value);
        else if (p.code === 40) knots.push(num(p.value));
      }
      return { ...base, type, degree: getN(71, 3), controlPoints, fitPoints, knots, closed: (getN(70, 0) & 1) === 1 };
    }
    case "TEXT":
    case "MTEXT": {
      const text = g
        .filter((p) => p.code === 1 || p.code === 3)
        .map((p) => p.value)
        .join("");
      return { ...base, type, text, at: { x: getN(10), y: getN(20), z: getN(30) }, height: getN(40, 0) };
    }
    case "POINT":
      return { ...base, type, at: { x: getN(10), y: getN(20), z: getN(30) } };
    default:
      return { ...base, type: "OTHER", rawType: type, other: true };
  }
}

/** POLYLINE + VERTEX… + SEQEND — the pre-R14 polyline. Only 2D polylines are
 *  turned into geometry; meshes are kept as "other" with their flags. */
function parsePolylineChain(groups: Pair[][], start: number, block: string | null): { entity: DxfEntity; next: number } {
  const g = groups[start];
  const base: EntityBase = { type: "POLYLINE", layer: "0", handle: null, index: start, block, extrusion: null, elevation: 0 };
  let flags = 0;
  for (const p of g) {
    if (p.code === 8) base.layer = p.value;
    else if (p.code === 5) base.handle = p.value;
    else if (p.code === 70) flags = num(p.value);
    else if (p.code === 30) base.elevation = num(p.value);
  }
  const vertices: DxfVertex[] = [];
  let i = start + 1;
  while (i < groups.length && groups[i][0].value === "VERTEX") {
    const v: DxfVertex = { x: 0, y: 0, bulge: 0 };
    let vflags = 0;
    for (const p of groups[i]) {
      if (p.code === 10) v.x = num(p.value);
      else if (p.code === 20) v.y = num(p.value);
      else if (p.code === 42) v.bulge = num(p.value);
      else if (p.code === 70) vflags = num(p.value);
    }
    // skip spline-frame control points (16) and mesh vertices (64)
    if ((vflags & 16) === 0 || (vflags & 8) !== 0) vertices.push(v);
    i++;
  }
  if (i < groups.length && groups[i][0].value === "SEQEND") i++;
  const isMesh = (flags & 16) !== 0 || (flags & 64) !== 0;
  if (isMesh) return { entity: { ...base, type: "OTHER", rawType: "POLYLINE_MESH", other: true }, next: i };
  const ent: DxfPolyline = { ...base, type: "POLYLINE", vertices, closed: (flags & 1) === 1, flags };
  return { entity: ent, next: i };
}

function parseEntityList(body: Pair[], block: string | null, warnings: string[]): DxfEntity[] {
  const groups = [...entityGroups(body)];
  const out: DxfEntity[] = [];
  let i = 0;
  while (i < groups.length) {
    const type = groups[i][0].value;
    if (type === "POLYLINE") {
      const { entity, next } = parsePolylineChain(groups, i, block);
      out.push(entity);
      i = next;
      continue;
    }
    if (type === "VERTEX" || type === "SEQEND") {
      i++;
      continue;
    }
    out.push(parseEntityGroup(groups[i], i, block, warnings));
    i++;
  }
  return out;
}

function parseBlocks(body: Pair[], warnings: string[]): Record<string, DxfBlockDef> {
  const blocks: Record<string, DxfBlockDef> = Object.create(null);
  const groups = [...entityGroups(body)];
  let i = 0;
  while (i < groups.length) {
    if (groups[i][0].value === "BLOCK") {
      const def: DxfBlockDef = { name: "", base: { x: 0, y: 0, z: 0 }, entities: [] };
      for (const p of groups[i]) {
        if (p.code === 2) def.name = p.value;
        else if (p.code === 10) def.base.x = num(p.value);
        else if (p.code === 20) def.base.y = num(p.value);
        else if (p.code === 30) def.base.z = num(p.value);
      }
      let j = i + 1;
      const entBody: Pair[] = [];
      while (j < groups.length && groups[j][0].value !== "ENDBLK") {
        for (const pair of groups[j]) entBody.push(pair);
        j++;
      }
      def.entities = parseEntityList(entBody, def.name, warnings);
      blocks[def.name] = def;
      i = j + 1;
      continue;
    }
    i++;
  }
  return blocks;
}

export function parseDxf(text: string): DxfDocument {
  warnedWidths = false;
  const pairs = tokenizeDxf(text);
  const sections = readSections(pairs);
  const warnings: string[] = [];
  const header = parseHeader(sections.get("HEADER") ?? []);
  const ver = header["$ACADVER"]?.[0];
  const insunits = header["$INSUNITS"]?.[0];
  const pt = (name: string) => {
    const v = header[name];
    if (!v || v.length < 2) return null;
    return { x: Number(v[0]), y: Number(v[1]), z: Number(v[2] ?? 0) };
  };
  const doc: DxfDocument = {
    acadVersion: typeof ver === "string" ? ver : null,
    units: unitInfo(typeof insunits === "number" ? insunits : insunits === undefined ? null : Number(insunits)),
    header,
    extMin: pt("$EXTMIN"),
    extMax: pt("$EXTMAX"),
    layerTable: parseLayerTable(sections.get("TABLES") ?? []),
    blocks: parseBlocks(sections.get("BLOCKS") ?? [], warnings),
    entities: parseEntityList(sections.get("ENTITIES") ?? [], null, warnings),
    warnings,
  };
  if (!sections.has("ENTITIES")) warnings.push("The file has no ENTITIES section.");
  return doc;
}
