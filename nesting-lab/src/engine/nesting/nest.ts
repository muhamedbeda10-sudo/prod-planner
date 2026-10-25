// The nesting run: expand quantities, try every strategy within the time
// budget, keep the best by (fewest sheets, then highest utilization, then the
// emptiest last sheet so the remnant is the largest), and report everything
// that was tried. Deterministic: the same inputs give the same layout.

import { loopArea, polygonArea, polygonPerimeter } from "../geometry/polygon";
import { bboxUnion } from "../geometry/types";
import { conservativenessMm, makeVariant, NfpCache, type Variant } from "./nfp";
import { newSheetContext, tryPlace, zoneObstacles, type Placed } from "./placer";
import { ENGINE_VERSION, type NestPartInput, type NestResult, type NestSettings, type SheetLayout, type StrategyRun, type StrategySpec, type UnplacedPart } from "./types";

export const DEFAULT_SAGITTA = 0.3;
export const DEFAULT_SIMPLIFY = 0.05;
export const DEFAULT_BUDGET_MS = 30_000;

export const DEFAULT_STRATEGIES: StrategySpec[] = [
  { ordering: "area-desc", objective: "bottom-left" },
  { ordering: "longest-side-desc", objective: "bottom-left" },
  { ordering: "area-desc", objective: "left-bottom" },
  { ordering: "area-desc", objective: "min-bbox" },
  { ordering: "perimeter-desc", objective: "bottom-left" },
  { ordering: "longest-side-desc", objective: "min-bbox" },
];

export interface NestProgress {
  phase: "variants" | "strategy" | "done";
  strategyIndex: number;
  strategyCount: number;
  placed: number;
  total: number;
  sheets: number;
  message: string;
}

export interface NestOptions {
  onProgress?: (p: NestProgress) => void;
  /** monotonic clock for the time budget (tests inject one) */
  now?: () => number;
  runId?: string;
  /** ISO timestamp written into the result; defaults to the wall clock */
  createdAt?: string;
}

interface Instance {
  part: NestPartInput;
  instance: number;
  variants: Variant[];
  area: number;
  longest: number;
  perimeter: number;
}

export function validateSettings(s: NestSettings, parts: NestPartInput[]): string[] {
  const errs: string[] = [];
  if (!(s.sheet.widthMm > 0) || !(s.sheet.heightMm > 0)) errs.push("Sheet width and height must be positive.");
  if (!(s.spacingMm >= 0)) errs.push("Part spacing must be zero or positive.");
  if (!(s.marginMm >= 0)) errs.push("Sheet margin must be zero or positive.");
  if (s.sheet.quantity !== null && !(s.sheet.quantity >= 1)) errs.push("Sheet quantity must be at least 1 (or unlimited).");
  if (s.rotationsDeg.length === 0) errs.push("Allow at least one rotation (0° counts).");
  if (parts.length === 0) errs.push("No parts to nest.");
  const ids = new Set<string>();
  for (const p of parts) {
    if (!(p.quantity >= 1) || !Number.isInteger(p.quantity)) errs.push(`${p.label}: quantity must be a whole number ≥ 1.`);
    if (!p.outer || p.outer.segs.length === 0) errs.push(`${p.label}: has no outer contour.`);
    if (ids.has(p.id)) errs.push(`Part id "${p.id}" is used twice; every part type needs its own id.`);
    ids.add(p.id);
    if (p.outer && p.outer.segs.length > 20_000) errs.push(`${p.label}: outline has ${p.outer.segs.length} segments, above the prototype limit of 20000.`);
  }
  for (const z of s.noGoZones) if (!(z.w > 0) || !(z.h > 0)) errs.push("No-go zones need a positive width and height.");
  const total = parts.reduce((n, p) => n + p.quantity, 0);
  if (total > 5000) errs.push(`${total} parts is above the prototype limit of 5000.`);
  return errs;
}

export function nest(parts: NestPartInput[], settings: NestSettings, opts: NestOptions = {}): NestResult {
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const errs = validateSettings(settings, parts);
  if (errs.length > 0) throw new Error(errs.join(" "));
  const sagitta = settings.sagittaMm ?? DEFAULT_SAGITTA;
  const simplifyTol = settings.simplifyTolMm ?? DEFAULT_SIMPLIFY;
  const variantOpts = { sagittaMm: sagitta, simplifyTolMm: simplifyTol, spacingMm: settings.spacingMm };
  const byId = new Map(parts.map((p) => [p.id, p]));
  const variantMemo = new Map<string, Variant>();
  const variantFor = (partId: string, rotationDeg: number, mirrored: boolean): Variant => {
    const key = `${partId}@${rotationDeg}${mirrored ? "m" : ""}`;
    let v = variantMemo.get(key);
    if (!v) {
      v = makeVariant(partId, byId.get(partId)!.outer, rotationDeg, mirrored, variantOpts);
      variantMemo.set(key, v);
    }
    return v;
  };
  const cache = new NfpCache(variantFor);
  const areas = new Map<string, { gross: number; net: number }>();
  const notes: string[] = [
    "Positions come from a greedy bottom-left-fill over no-fit polygons; the result is a good layout, not a proven optimum.",
    `Nesting polygons circumscribe the true arcs (${sagitta} mm tolerance), are simplified by ${simplifyTol} mm and grown conservatively, so parts are never closer than the spacing but may end up to ${conservativenessMm(variantOpts).toFixed(2)} mm farther apart than needed; the independent verifier checks the exact contours afterwards.`,
    "Part spacing is a geometric clearance between contours. Kerf is NOT compensated here — the machine's program must apply it, once.",
    "Utilization = Σ outer-contour areas of the placed parts ÷ sheet area (holes count as used material).",
  ];
  opts.onProgress?.({ phase: "variants", strategyIndex: 0, strategyCount: 0, placed: 0, total: 0, sheets: 0, message: "Preparing part polygons" });
  // variants per part
  const instances: Instance[] = [];
  const partSummary: NestResult["parts"] = [];
  for (const p of parts) {
    const rots = [...new Set((p.allowedRotationsDeg ?? settings.rotationsDeg).map((r) => ((r % 360) + 360) % 360))].sort((a, b) => a - b);
    const mirrors = (p.allowMirror ?? settings.allowMirror) ? [false, true] : [false];
    const variants: Variant[] = [];
    for (const m of mirrors) for (const r of rots) {
      const v = variantFor(p.id, r, m);
      // a symmetric part gives the same polygon at two rotations: keep one
      if (!variants.some((o) => samePolygon(o.poly, v.poly))) variants.push(v);
    }
    const gross = Math.abs(loopArea(p.outer));
    const net = gross - p.holes.reduce((s, h) => s + Math.abs(loopArea(h)), 0);
    areas.set(p.id, { gross, net });
    const v0 = variants[0];
    const perimeter = polygonPerimeter(v0.poly);
    for (let i = 0; i < p.quantity; i++) instances.push({ part: p, instance: i, variants, area: gross, longest: Math.max(v0.width, v0.height), perimeter });
    partSummary.push({ id: p.id, label: p.label, quantity: p.quantity, placed: 0, grossArea: gross, netArea: net, bom: p.bom, partNo: p.partNo, name: p.name, source: p.source });
  }
  const strategies = settings.strategies && settings.strategies.length > 0 ? settings.strategies : DEFAULT_STRATEGIES;
  const budget = settings.timeBudgetMs ?? DEFAULT_BUDGET_MS;
  const tried: StrategyRun[] = [];
  let best: { sheets: SheetLayout[]; unplaced: UnplacedPart[]; strategy: StrategySpec; util: number; lastUtil: number } | null = null;
  const sheetArea = settings.sheet.widthMm * settings.sheet.heightMm;
  const stats = { candidatesEvaluated: 0, placementsAttempted: 0, booleanMs: 0 };
  const zones = zoneObstacles(settings);
  for (let si = 0; si < strategies.length; si++) {
    const strategy = strategies[si];
    if (si > 0 && now() - t0 > budget) {
      notes.push(`Time budget of ${budget} ms reached after ${si} of ${strategies.length} strategies.`);
      break;
    }
    const ts = now();
    const order = instances.slice().sort((a, b) => {
      const pa = a.part.priority ?? 0;
      const pb = b.part.priority ?? 0;
      if (pa !== pb) return pa - pb;
      const k = strategy.ordering === "area-desc" ? b.area - a.area : strategy.ordering === "longest-side-desc" ? b.longest - a.longest : b.perimeter - a.perimeter;
      if (Math.abs(k) > 1e-9) return k;
      return a.part.id < b.part.id ? -1 : a.part.id > b.part.id ? 1 : a.instance - b.instance;
    });
    const sheets: SheetLayout[] = [];
    const unplaced = new Map<string, { qty: number; reason: string }>();
    let remaining = order;
    let sheetIndex = 0;
    const maxSheets = settings.maxSheets ?? 500;
    while (remaining.length > 0) {
      if (settings.sheet.quantity !== null && sheetIndex >= settings.sheet.quantity) {
        for (const inst of remaining) bump(unplaced, inst.part.id, `sheet stock exhausted (${settings.sheet.quantity} sheets)`);
        break;
      }
      if (sheetIndex >= maxSheets) {
        for (const inst of remaining) bump(unplaced, inst.part.id, `stopped at the ${maxSheets}-sheet limit`);
        break;
      }
      const ctx = newSheetContext(settings, cache, stats, zones);
      const placed: Placed[] = [];
      const next: Instance[] = [];
      const reasons = new Map<Instance, string>();
      let aborted = false;
      for (let k = 0; k < remaining.length; k++) {
        const inst = remaining[k];
        // the first strategy always finishes; later ones stop at the budget
        if (si > 0 && now() - t0 > budget) {
          aborted = true;
          break;
        }
        const r = tryPlace(inst.variants, inst.instance, placed, ctx, strategy.objective);
        if (r.placed) placed.push(r.placed);
        else {
          next.push(inst);
          reasons.set(inst, r.reason);
        }
      }
      if (aborted) {
        notes.push(`Strategy ${strategy.ordering}/${strategy.objective} was stopped by the ${budget} ms time budget and not used.`);
        sheets.length = 0;
        break;
      }
      if (placed.length === 0) {
        // nothing fits an empty sheet: everything left is unplaceable
        for (const inst of next) bump(unplaced, inst.part.id, reasons.get(inst) ?? "does not fit the sheet");
        break;
      }
      sheets.push(layoutOf(sheetIndex, placed, sheetArea, areas));
      sheetIndex++;
      remaining = next;
      opts.onProgress?.({ phase: "strategy", strategyIndex: si, strategyCount: strategies.length, placed: instances.length - remaining.length, total: instances.length, sheets: sheets.length, message: `${strategy.ordering} / ${strategy.objective}: sheet ${sheets.length}` });
    }
    if (sheets.length === 0 && remaining.length > 0 && instances.length > 0 && now() - t0 > budget && si > 0) {
      tried.push({ strategy, sheets: 0, utilization: 0, lastSheetUtilization: 0, ms: now() - ts, unplaced: instances.length });
      break;
    }
    const placedCount = sheets.reduce((n, s) => n + s.placements.length, 0);
    const util = sheets.length ? sheets.reduce((s, x) => s + x.utilization, 0) / sheets.length : 0;
    const lastUtil = sheets.length ? sheets[sheets.length - 1].utilization : 0;
    const unplacedList = [...unplaced.entries()].map(([partId, v]) => ({ partId, quantity: v.qty, reason: v.reason }));
    tried.push({ strategy, sheets: sheets.length, utilization: util, lastSheetUtilization: lastUtil, ms: now() - ts, unplaced: instances.length - placedCount });
    const bestPlaced = best ? instances.length - best.unplaced.reduce((n, u) => n + u.quantity, 0) : -1;
    const better = !best || placedCount > bestPlaced || (placedCount === bestPlaced && (sheets.length < best.sheets.length || (sheets.length === best.sheets.length && lastUtil < best.lastUtil - 1e-9)));
    if (better) best = { sheets, unplaced: unplacedList, strategy, util, lastUtil };
  }
  if (!best) throw new Error("No strategy ran.");
  const summaryById = new Map(partSummary.map((p) => [p.id, p]));
  for (const s of best.sheets) for (const pl of s.placements) {
    const row = summaryById.get(pl.partId);
    if (row) row.placed++;
  }
  return {
    runId: opts.runId ?? makeRunId(),
    engineVersion: ENGINE_VERSION,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    settings,
    parts: partSummary,
    sheets: best.sheets,
    unplaced: best.unplaced,
    chosenStrategy: best.strategy,
    strategiesTried: tried,
    stats: { nfpComputed: cache.computed, nfpCacheHits: cache.hits, candidatesEvaluated: stats.candidatesEvaluated, placementsAttempted: stats.placementsAttempted, nfpMs: Math.round(cache.ms), booleanMs: Math.round(stats.booleanMs) },
    timings: { totalMs: now() - t0 },
    notes,
  };
}

function samePolygon(a: { x: number; y: number }[], b: { x: number; y: number }[], tol = 1e-6): boolean {
  if (a.length !== b.length) return false;
  if (Math.abs(polygonArea(a) - polygonArea(b)) > tol * Math.max(1, Math.abs(polygonArea(a)))) return false;
  const n = a.length;
  outer: for (let off = 0; off < n; off++) {
    for (let i = 0; i < n; i++) {
      const p = a[i];
      const q = b[(i + off) % n];
      if (Math.abs(p.x - q.x) > tol || Math.abs(p.y - q.y) > tol) continue outer;
    }
    return true;
  }
  return false;
}

function bump(map: Map<string, { qty: number; reason: string }>, id: string, reason: string) {
  const cur = map.get(id);
  if (cur) cur.qty++;
  else map.set(id, { qty: 1, reason });
}

function layoutOf(index: number, placed: Placed[], sheetArea: number, areas: Map<string, { gross: number; net: number }>): SheetLayout {
  let gross = 0;
  let net = 0;
  let bb: SheetLayout["usedBBox"] = null;
  for (const p of placed) {
    const a = areas.get(p.placement.partId)!;
    gross += a.gross;
    net += a.net;
    bb = bb ? bboxUnion(bb, p.placement.bbox) : { ...p.placement.bbox };
  }
  return { index, placements: placed.map((p) => p.placement), grossPartArea: gross, netPartArea: net, utilization: gross / sheetArea, usedBBox: bb };
}

function makeRunId(): string {
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 1e9).toString(36);
  return `nest-${t}-${r}`;
}

