import type { BBox, Loop, Seg } from "../geometry/types";

export const ENGINE_VERSION = "nesting-lab/0.1.0 (NFP true-shape, Clipper 6.4.2)";

export interface NestPartInput {
  /** stable id of the part type within this run */
  id: string;
  label: string;
  bom?: string;
  partNo?: string;
  name?: string;
  quantity: number;
  /** lower places first (orders due sooner) */
  priority?: number;
  /** ccw outer contour, mm, any origin */
  outer: Loop;
  /** cw hole contours (exported with the part; the nester uses the outer contour only) */
  holes: Loop[];
  marks?: Seg[];
  /** per-part override of the global rotations */
  allowedRotationsDeg?: number[];
  allowMirror?: boolean;
  /** where it came from — kept on every placement */
  source?: { file: string; pieceIds: string[]; geometryHash: string };
}

export type Objective = "bottom-left" | "left-bottom" | "min-bbox";
export type Ordering = "area-desc" | "longest-side-desc" | "perimeter-desc";

export interface StrategySpec {
  ordering: Ordering;
  objective: Objective;
}

export interface NoGoZone {
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
}

export interface NestSettings {
  sheet: {
    widthMm: number;
    heightMm: number;
    /** sheets in stock; null = unlimited */
    quantity: number | null;
    material: string;
    thicknessMm: number;
    label?: string;
  };
  /** minimum part-to-part distance (mm). This is NOT kerf compensation. */
  spacingMm: number;
  /** minimum part-to-edge distance (mm); also the clearance to no-go zones */
  marginMm: number;
  rotationsDeg: number[];
  allowMirror: boolean;
  noGoZones: NoGoZone[];
  strategies?: StrategySpec[];
  timeBudgetMs?: number;
  /** arc tolerance of the nesting polygons (mm); the polygons circumscribe the arcs */
  sagittaMm?: number;
  /** vertex simplification for the NFP polygons (mm) */
  simplifyTolMm?: number;
  /** stop after this many sheets even if parts remain */
  maxSheets?: number;
}

export interface Placement {
  partId: string;
  /** 0-based instance of the part type */
  instance: number;
  /** where the bbox-min corner of the exact outer contour lands after the
   *  rotation and mirror about the part's own origin (see nesting/placement.ts) */
  x: number;
  y: number;
  rotationDeg: number;
  mirrored: boolean;
  /** bbox on the sheet of the outer contour */
  bbox: BBox;
}

export interface SheetLayout {
  index: number;
  placements: Placement[];
  /** Σ outer-contour areas of placed parts (holes counted as used) */
  grossPartArea: number;
  /** Σ (outer − holes) */
  netPartArea: number;
  /** grossPartArea ÷ sheet area */
  utilization: number;
  /** bbox of all placements — the remnant starts beyond it */
  usedBBox: BBox | null;
}

export interface UnplacedPart {
  partId: string;
  quantity: number;
  reason: string;
}

export interface StrategyRun {
  strategy: StrategySpec;
  sheets: number;
  utilization: number;
  lastSheetUtilization: number;
  ms: number;
  unplaced: number;
}

export interface NestResult {
  runId: string;
  engineVersion: string;
  createdAt: string;
  settings: NestSettings;
  parts: { id: string; label: string; quantity: number; placed: number; grossArea: number; netArea: number; bom?: string; partNo?: string; name?: string; source?: NestPartInput["source"] }[];
  sheets: SheetLayout[];
  unplaced: UnplacedPart[];
  chosenStrategy: StrategySpec;
  strategiesTried: StrategyRun[];
  stats: { nfpComputed: number; nfpCacheHits: number; candidatesEvaluated: number; placementsAttempted: number; nfpMs: number; booleanMs: number };
  timings: { totalMs: number };
  /** things the reader must know about how the numbers were produced */
  notes: string[];
}
