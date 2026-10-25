import type { DxfAnalysis } from "../engine/dxf/analyze";
import type { LayerRole } from "../engine/dxf/primitives";
import type { SelectableUnit } from "../engine/dxf/units";
import type { FileNameHints } from "../engine/dxf/fileName";
import type { NestPartInput, NestResult, NestSettings, StrategySpec } from "../engine/nesting/types";
import type { NestProgress } from "../engine/nesting/nest";
import type { VerifyReport } from "../engine/nesting/verify";
import { fileShort, partsFromAnalysis, type PartOverride, type SkippedPart } from "../engine/parts";
import { sheetLabel } from "../engine/nesting/types";
export { fileShort };

export const IDLE_RUN: RunState = { status: "idle", progress: null, result: null, verification: null, error: null, startedAt: 0, parts: [] };

export interface RunState {
  status: "idle" | "running" | "done" | "error";
  progress: NestProgress | null;
  result: NestResult | null;
  verification: VerifyReport | null;
  error: string | null;
  startedAt: number;
  /** the parts the run was started with (the rows may change afterwards) */
  parts: NestPartInput[];
}

export interface LoadedFile {
  id: string;
  name: string;
  bytes: Uint8Array;
  unit: SelectableUnit | null;
  layerRoles: Record<string, LayerRole>;
  thicknessMm: number | null;
  bom: string;
  hints: FileNameHints;
  analysis: DxfAnalysis | null;
  error: string | null;
}

export interface PartRow {
  /** `${fileId}:${groupIndex}` */
  key: string;
  include: boolean;
  qty: number;
  bom: string;
  partNo: string;
  name: string;
  priority: number;
}

export interface SettingsForm {
  sheetPreset: string;
  widthMm: number;
  heightMm: number;
  unlimited: boolean;
  quantity: number;
  material: string;
  thicknessMm: number;
  spacingMm: number;
  marginMm: number;
  rotations: number[];
  allowMirror: boolean;
  noGoZones: { x: number; y: number; w: number; h: number; label: string }[];
  strategies: StrategySpec[];
  timeBudgetS: number;
  sagittaMm: number;
  simplifyTolMm: number;
}

export function toSettings(f: SettingsForm): NestSettings {
  return {
    sheet: { widthMm: f.widthMm, heightMm: f.heightMm, quantity: f.unlimited ? null : f.quantity, material: f.material, thicknessMm: f.thicknessMm, label: sheetLabel(f.widthMm, f.heightMm) },
    spacingMm: f.spacingMm,
    marginMm: f.marginMm,
    rotationsDeg: f.rotations,
    allowMirror: f.allowMirror,
    noGoZones: f.noGoZones.map((z) => ({ ...z })),
    strategies: f.strategies.length ? f.strategies : undefined,
    timeBudgetMs: f.timeBudgetS * 1000,
    sagittaMm: f.sagittaMm,
    simplifyTolMm: f.simplifyTolMm,
  };
}

export function partKey(fileId: string, groupIndex: number): string {
  return `${fileId}:${groupIndex}`;
}

/** The default row for a part type: included when it is a top-level piece, with the count found. */
export function defaultRow(fileId: string, groupIndex: number, depth: number, found: number): PartRow {
  return { key: partKey(fileId, groupIndex), include: depth === 0, qty: found, bom: "", partNo: "", name: "", priority: 0 };
}

/** The nesting inputs from every analysed file and the rows the person edited —
 *  through the same builder the CLI uses. */
export function buildParts(files: LoadedFile[], rows: Record<string, PartRow>): { parts: NestPartInput[]; skipped: SkippedPart[] } {
  const parts: NestPartInput[] = [];
  const skipped: SkippedPart[] = [];
  files.forEach((f, fi) => {
    if (!f.analysis) return;
    const overrides: Record<number, PartOverride> = {};
    (f.analysis.parts?.groups ?? []).forEach((_g, gi) => {
      const row = rows[partKey(f.id, gi)];
      if (row) overrides[gi] = { include: row.include, quantity: row.qty, partNo: row.partNo, name: row.name || undefined, bom: row.bom, priority: row.priority };
    });
    const built = partsFromAnalysis(f.analysis, { idPrefix: fileShort(fi), overrides, bom: f.bom || undefined });
    parts.push(...built.parts);
    skipped.push(...built.skipped);
  });
  return { parts, skipped };
}
