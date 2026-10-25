// From an analysis (pieces grouped into part types) to nesting inputs. The ONE
// builder behind the UI, the CLI and the sample runner, so they all make the
// same parts from the same file and apply the same skip rules.

import type { DxfAnalysis } from "./dxf/analyze";
import type { NestPartInput } from "./nesting/types";
import { geometryHash } from "./geometry/hash";
import { bboxHeight, bboxWidth } from "./geometry/types";

export interface PartOverride {
  include?: boolean;
  quantity?: number;
  partNo?: string;
  name?: string;
  bom?: string;
  priority?: number;
}

export interface PartSelection {
  /** prefix for the ids ("F1" → "F1-T3"); default none ("T3") */
  idPrefix?: string;
  /** per part-type overrides, keyed by group index */
  overrides?: Record<number, PartOverride>;
  /** leave out groups the classifier flagged for review (irregular/small) */
  excludeFlagged?: boolean;
  /** BOM for every part that has none of its own */
  bom?: string;
}

export interface SkippedPart {
  id: string;
  reason: string;
}

export function partIdOf(prefix: string | undefined, groupIndex: number): string {
  return `${prefix ? `${prefix}-` : ""}T${groupIndex + 1}`;
}

/** The short tag of the n-th file loaded ("F1", "F2"…). */
export function fileShort(index: number): string {
  return `F${index + 1}`;
}

export function partsFromAnalysis(a: DxfAnalysis, sel: PartSelection = {}): { parts: NestPartInput[]; skipped: SkippedPart[] } {
  const parts: NestPartInput[] = [];
  const skipped: SkippedPart[] = [];
  const groups = a.parts?.groups ?? [];
  groups.forEach((g, i) => {
    const id = partIdOf(sel.idPrefix, i);
    const rep = g.representative;
    const o = sel.overrides?.[i] ?? {};
    const include = o.include ?? rep.depth === 0;
    if (!include) {
      skipped.push({ id, reason: o.include === false ? "left out" : `nested inside another piece's cut-out (depth ${rep.depth})` });
      return;
    }
    if (sel.excludeFlagged && rep.review.length > 0) {
      skipped.push({ id, reason: rep.review.join("; ") });
      return;
    }
    const qty = Math.round(o.quantity ?? g.instances.length);
    if (!(qty >= 1)) {
      skipped.push({ id, reason: "quantity 0" });
      return;
    }
    const partNo = o.partNo?.trim() || undefined;
    parts.push({
      id,
      label: partNo ?? id,
      bom: o.bom?.trim() || sel.bom || undefined,
      partNo,
      name: o.name?.trim() || `${bboxWidth(rep.bbox).toFixed(1)}×${bboxHeight(rep.bbox).toFixed(1)}${rep.holes.length ? `, ${rep.holes.length} holes` : ""}`,
      quantity: qty,
      priority: o.priority ?? 0,
      outer: rep.outer.loop,
      holes: rep.holes.map((h) => h.loop),
      marks: rep.marks,
      source: { file: a.fileName, pieceIds: g.instances.map((x) => x.pieceId), geometryHash: geometryHash(rep.outer.loop, rep.holes.map((h) => h.loop)) },
    });
  });
  return { parts, skipped };
}
