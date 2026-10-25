// DXF R2000 (AC1015) writer. Millimetres are stated ($INSUNITS = 4), arcs stay
// arcs (LWPOLYLINE bulges, CIRCLE), every entity has a handle and the standard
// tables are present so AutoCAD-family readers open the file without repair.

import type { Loop, Point, Seg } from "../geometry/types";
import { bulgeOf } from "../geometry/arc";
import { INSUNITS_MM } from "../dxf/units";

export interface DxfLayerSpec {
  name: string;
  /** ACI colour index 1..255 */
  color: number;
}

export type DxfOutEntity =
  | { kind: "lwpolyline"; layer: string; loop: Loop }
  | { kind: "circle"; layer: string; center: Point; r: number }
  | { kind: "line"; layer: string; a: Point; b: Point }
  | { kind: "text"; layer: string; at: Point; height: number; text: string; rotationDeg?: number };

export interface DxfWriteOptions {
  layers: DxfLayerSpec[];
  extents?: { min: Point; max: Point };
  /** written into the header comment (999) for traceability */
  comment?: string;
}

const fmt = (n: number): string => {
  if (!Number.isFinite(n)) return "0.0";
  const r = Math.round(n * 1e6) / 1e6;
  const s = r.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0");
  return s === "-0.0" ? "0.0" : s;
};

class Handles {
  private next = 0x100;
  take(): string {
    return (this.next++).toString(16).toUpperCase();
  }
  seed(): string {
    return (this.next + 0x100).toString(16).toUpperCase();
  }
}

/** Entities derived from one closed loop: a CIRCLE for a full circle, else a
 *  closed LWPOLYLINE with bulges. */
export function loopEntities(loop: Loop, layer: string): DxfOutEntity[] {
  const s0 = loop.segs[0];
  if (loop.segs.length === 1 && s0.kind === "arc" && s0.full) return [{ kind: "circle", layer, center: s0.center, r: s0.r }];
  return [{ kind: "lwpolyline", layer, loop }];
}

export function segEntities(segs: Seg[], layer: string): DxfOutEntity[] {
  const out: DxfOutEntity[] = [];
  for (const s of segs) {
    if (s.kind === "line") out.push({ kind: "line", layer, a: s.a, b: s.b });
    else if (s.full) out.push({ kind: "circle", layer, center: s.center, r: s.r });
    else out.push({ kind: "lwpolyline", layer, loop: { segs: [s] } });
  }
  return out;
}

export function writeDxf(entities: DxfOutEntity[], opts: DxfWriteOptions): string {
  const h = new Handles();
  const L: string[] = [];
  const p = (code: number, value: string | number) => {
    L.push(String(code), typeof value === "number" ? fmt(value) : value);
  };
  const pi = (code: number, value: number) => L.push(String(code), String(value));
  // compute extents when not given
  let ext = opts.extents;
  if (!ext) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const add = (q: Point) => {
      minX = Math.min(minX, q.x);
      minY = Math.min(minY, q.y);
      maxX = Math.max(maxX, q.x);
      maxY = Math.max(maxY, q.y);
    };
    for (const e of entities) {
      if (e.kind === "lwpolyline") for (const s of e.loop.segs) {
        add(s.a);
        add(s.b);
      }
      else if (e.kind === "circle") {
        add({ x: e.center.x - e.r, y: e.center.y - e.r });
        add({ x: e.center.x + e.r, y: e.center.y + e.r });
      } else if (e.kind === "line") {
        add(e.a);
        add(e.b);
      } else add(e.at);
    }
    ext = Number.isFinite(minX) ? { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } } : { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
  }
  if (opts.comment) p(999, opts.comment.replace(/[\r\n]+/g, " "));
  // ---- HEADER ----
  p(0, "SECTION");
  p(2, "HEADER");
  p(9, "$ACADVER");
  p(1, "AC1015");
  p(9, "$HANDSEED");
  p(5, "FFFF");
  p(9, "$INSUNITS");
  pi(70, INSUNITS_MM);
  p(9, "$MEASUREMENT");
  pi(70, 1);
  p(9, "$LUNITS");
  pi(70, 2);
  p(9, "$EXTMIN");
  p(10, ext.min.x);
  p(20, ext.min.y);
  p(30, 0);
  p(9, "$EXTMAX");
  p(10, ext.max.x);
  p(20, ext.max.y);
  p(30, 0);
  p(9, "$LIMMIN");
  p(10, 0);
  p(20, 0);
  p(9, "$LIMMAX");
  p(10, ext.max.x);
  p(20, ext.max.y);
  p(9, "$CLAYER");
  p(8, "0");
  p(9, "$DIMSCALE");
  p(40, 1);
  p(9, "$LTSCALE");
  p(40, 1);
  p(9, "$PDMODE");
  pi(70, 0);
  p(0, "ENDSEC");
  // ---- CLASSES ----
  p(0, "SECTION");
  p(2, "CLASSES");
  p(0, "ENDSEC");
  // ---- TABLES ----
  p(0, "SECTION");
  p(2, "TABLES");
  const table = (name: string, count: number, body: () => void) => {
    p(0, "TABLE");
    p(2, name);
    p(5, h.take());
    p(330, "0");
    p(100, "AcDbSymbolTable");
    pi(70, count);
    body();
    p(0, "ENDTAB");
  };
  table("VPORT", 1, () => {
    p(0, "VPORT");
    p(5, h.take());
    p(330, "0");
    p(100, "AcDbSymbolTableRecord");
    p(100, "AcDbViewportTableRecord");
    p(2, "*Active");
    pi(70, 0);
    p(10, 0);
    p(20, 0);
    p(11, 1);
    p(21, 1);
    p(12, (ext.min.x + ext.max.x) / 2);
    p(22, (ext.min.y + ext.max.y) / 2);
    p(13, 0);
    p(23, 0);
    p(14, 10);
    p(24, 10);
    p(15, 10);
    p(25, 10);
    p(16, 0);
    p(26, 0);
    p(36, 1);
    p(17, 0);
    p(27, 0);
    p(37, 0);
    p(40, Math.max(ext.max.y - ext.min.y, 1) * 1.1);
    p(41, 1.5);
    p(42, 50);
    p(43, 0);
    p(44, 0);
    p(50, 0);
    p(51, 0);
    pi(71, 0);
    pi(72, 100);
    pi(73, 1);
    pi(74, 3);
    pi(75, 0);
    pi(76, 0);
    pi(77, 0);
    pi(78, 0);
    pi(281, 0);
    pi(65, 1);
    p(110, 0);
    p(120, 0);
    p(130, 0);
    p(111, 1);
    p(121, 0);
    p(131, 0);
    p(112, 0);
    p(122, 1);
    p(132, 0);
    pi(79, 0);
    p(146, 0);
  });
  table("LTYPE", 3, () => {
    for (const name of ["ByBlock", "ByLayer", "Continuous"]) {
      p(0, "LTYPE");
      p(5, h.take());
      p(330, "0");
      p(100, "AcDbSymbolTableRecord");
      p(100, "AcDbLinetypeTableRecord");
      p(2, name);
      pi(70, 0);
      p(3, name === "Continuous" ? "Solid line" : "");
      pi(72, 65);
      pi(73, 0);
      p(40, 0);
    }
  });
  const layerNames = ["0", ...opts.layers.map((l) => l.name).filter((n) => n !== "0")];
  table("LAYER", layerNames.length, () => {
    for (const name of layerNames) {
      const spec = opts.layers.find((l) => l.name === name);
      p(0, "LAYER");
      p(5, h.take());
      p(330, "0");
      p(100, "AcDbSymbolTableRecord");
      p(100, "AcDbLayerTableRecord");
      p(2, name);
      pi(70, 0);
      pi(62, spec?.color ?? 7);
      p(6, "Continuous");
      pi(370, -3);
      p(390, "F");
    }
  });
  table("STYLE", 1, () => {
    p(0, "STYLE");
    p(5, h.take());
    p(330, "0");
    p(100, "AcDbSymbolTableRecord");
    p(100, "AcDbTextStyleTableRecord");
    p(2, "Standard");
    pi(70, 0);
    p(40, 0);
    p(41, 1);
    p(50, 0);
    pi(71, 0);
    p(42, 2.5);
    p(3, "txt");
    p(4, "");
  });
  table("VIEW", 0, () => {});
  table("UCS", 0, () => {});
  table("APPID", 1, () => {
    p(0, "APPID");
    p(5, h.take());
    p(330, "0");
    p(100, "AcDbSymbolTableRecord");
    p(100, "AcDbRegAppTableRecord");
    p(2, "ACAD");
    pi(70, 0);
  });
  table("DIMSTYLE", 0, () => {
    // the table record subclass differs for DIMSTYLE; an empty table is valid
  });
  const msHandle = h.take();
  const psHandle = h.take();
  table("BLOCK_RECORD", 2, () => {
    for (const [name, hh] of [["*Model_Space", msHandle], ["*Paper_Space", psHandle]] as const) {
      p(0, "BLOCK_RECORD");
      p(5, hh);
      p(330, "0");
      p(100, "AcDbSymbolTableRecord");
      p(100, "AcDbBlockTableRecord");
      p(2, name);
    }
  });
  p(0, "ENDSEC");
  // ---- BLOCKS ----
  p(0, "SECTION");
  p(2, "BLOCKS");
  for (const [name, owner] of [["*Model_Space", msHandle], ["*Paper_Space", psHandle]] as const) {
    p(0, "BLOCK");
    p(5, h.take());
    p(330, owner);
    p(100, "AcDbEntity");
    p(8, "0");
    p(100, "AcDbBlockBegin");
    p(2, name);
    pi(70, 0);
    p(10, 0);
    p(20, 0);
    p(30, 0);
    p(3, name);
    p(1, "");
    p(0, "ENDBLK");
    p(5, h.take());
    p(330, owner);
    p(100, "AcDbEntity");
    p(8, "0");
    p(100, "AcDbBlockEnd");
  }
  p(0, "ENDSEC");
  // ---- ENTITIES ----
  p(0, "SECTION");
  p(2, "ENTITIES");
  const common = (type: string, layer: string) => {
    p(0, type);
    p(5, h.take());
    p(330, msHandle);
    p(100, "AcDbEntity");
    p(8, layer);
  };
  for (const e of entities) {
    switch (e.kind) {
      case "lwpolyline": {
        const segs = e.loop.segs;
        if (segs.length === 0) break;
        // closed when the last segment ends where the first starts
        const first = segs[0].a;
        const last = segs[segs.length - 1].b;
        const closed = Math.hypot(first.x - last.x, first.y - last.y) < 1e-9;
        common("LWPOLYLINE", e.layer);
        p(100, "AcDbPolyline");
        pi(90, closed ? segs.length : segs.length + 1);
        pi(70, closed ? 1 : 0);
        p(43, 0);
        for (const s of segs) {
          p(10, s.a.x);
          p(20, s.a.y);
          if (s.kind === "arc") p(42, bulgeOf(s));
        }
        if (!closed) {
          p(10, last.x);
          p(20, last.y);
        }
        break;
      }
      case "circle":
        common("CIRCLE", e.layer);
        p(100, "AcDbCircle");
        p(10, e.center.x);
        p(20, e.center.y);
        p(30, 0);
        p(40, e.r);
        break;
      case "line":
        common("LINE", e.layer);
        p(100, "AcDbLine");
        p(10, e.a.x);
        p(20, e.a.y);
        p(30, 0);
        p(11, e.b.x);
        p(21, e.b.y);
        p(31, 0);
        break;
      case "text":
        common("TEXT", e.layer);
        p(100, "AcDbText");
        p(10, e.at.x);
        p(20, e.at.y);
        p(30, 0);
        p(40, e.height);
        p(1, e.text.replace(/[\r\n]+/g, " ").slice(0, 255));
        if (e.rotationDeg) p(50, e.rotationDeg);
        pi(72, 1); // centre-justified
        p(11, e.at.x);
        p(21, e.at.y);
        p(31, 0);
        p(100, "AcDbText");
        pi(73, 2); // vertical: middle
        break;
    }
  }
  p(0, "ENDSEC");
  // ---- OBJECTS ----
  p(0, "SECTION");
  p(2, "OBJECTS");
  const rootDict = h.take();
  const groupDict = h.take();
  p(0, "DICTIONARY");
  p(5, rootDict);
  p(330, "0");
  p(100, "AcDbDictionary");
  pi(281, 1);
  p(3, "ACAD_GROUP");
  p(350, groupDict);
  p(0, "DICTIONARY");
  p(5, groupDict);
  p(330, rootDict);
  p(100, "AcDbDictionary");
  pi(281, 1);
  p(0, "ENDSEC");
  p(0, "EOF");
  // handle seed must exceed every handle used
  const seed = h.seed();
  const text = L.join("\r\n") + "\r\n";
  return text.replace("$HANDSEED\r\n5\r\nFFFF", `$HANDSEED\r\n5\r\n${seed}`);
}
