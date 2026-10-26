import "server-only";
import { getCockpit, getFloorPeriod, withoutFloor, type CockpitData, type FloorPeriod } from "./kpis";
import { getLvFloorPeriod, getLvPlanning, lvWithoutFloor, type LvFloorPeriod, type LvPlanningData } from "./lvKpis";
import type { CockpitAction } from "@/lib/domain/kpis";
import type { FloorDept } from "@/lib/domain/floorKpis";
import type { LvFloorFilter } from "@/lib/domain/lvKpis";
import { mergeActions, plantPlanningSummary, type PlantPlanningSummary } from "@/lib/domain/plantKpis";

// The whole plant's dashboards — Planning and Production each show both
// lines on one page — assembled by one rule for the pages and the assistant:
// the shift log's figures stripped for an account the Shifts screen is
// closed to, both lines' decisions in one list and the plant's headline from
// the domain's rules. The pages load each line on its own (a line that fails
// to load leaves the other on screen) and assemble with the same functions
// the assistant's loaders use, so the two cannot disagree.

export interface PlanningAll {
  tr: CockpitData;
  lv: LvPlanningData;
  actions: (CockpitAction & { line: "TR" | "LV" })[];
  summary: PlantPlanningSummary;
}

/** The plant's Planning from the two lines' own loaders. `floor`: whether the
 *  account sees Shifts — without it the shift log's figures leave here. */
export function assemblePlanning(trRaw: CockpitData, lvRaw: LvPlanningData, floor: boolean): PlanningAll {
  const tr = floor ? trRaw : withoutFloor(trRaw);
  const lv = floor ? lvRaw : lvWithoutFloor(lvRaw);
  return {
    tr, lv,
    actions: mergeActions(tr.actions, lv.actions),
    summary: plantPlanningSummary({ manpower: tr.manpower.rows, recent: tr.centres.map((c) => c.recent) }, { manpower: lv.manpower.rows, recent: lv.depts }),
  };
}

/** Planning for the whole plant. */
export async function loadPlanningAll(floor: boolean, period: { from?: Date | null; to?: Date | null } = {}, now = new Date()): Promise<PlanningAll> {
  const [tr, lv] = await Promise.all([getCockpit(now), getLvPlanning(period, now)]);
  return assemblePlanning(tr, lv, floor);
}

export interface ProductionAll {
  tr: FloorPeriod;
  lv: LvFloorPeriod;
  actions: (CockpitAction & { line: "TR" | "LV" })[];
}

/** The plant's Production from the two lines' periods. The page is behind
 *  the Shifts screen, so nothing is stripped here. */
export function assembleProduction(tr: FloorPeriod, lv: LvFloorPeriod): ProductionAll {
  return { tr, lv, actions: mergeActions(tr.actions, lv.actions) };
}

/** Production for the whole plant over one period — each line's own
 *  department (the names differ per line). */
export async function loadProductionAll(req: { fromISO: string; toISO: string; dept: FloorDept; clamped?: boolean }, lvDept: LvFloorFilter, now = new Date()): Promise<ProductionAll> {
  const [tr, lv] = await Promise.all([getFloorPeriod(req, now), getLvFloorPeriod({ ...req, dept: lvDept }, now)]);
  return assembleProduction(tr, lv);
}
