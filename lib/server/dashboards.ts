import "server-only";
import { getCockpit, getFloorPeriod, withoutFloor, type CockpitData, type FloorPeriod } from "./kpis";
import { getLvFloorPeriod, getLvPlanning, lvWithoutFloor, type LvFloorPeriod, type LvPlanningData } from "./lvKpis";
import type { CockpitAction } from "@/lib/domain/kpis";
import type { FloorDept } from "@/lib/domain/floorKpis";
import type { LvFloorFilter } from "@/lib/domain/lvKpis";
import { mergeActions, plantPlanningSummary, type PlantPlanningSummary } from "@/lib/domain/plantKpis";

// The whole plant's dashboards, assembled once for the pages and the
// assistant: both lines' loaders in parallel, the shift log's figures
// stripped for an account the Shifts screen is closed to, both lines'
// decisions in one list and the plant's headline from the domain's rules.
// The page and the tool render the same object, so they cannot disagree.

export interface PlanningAll {
  tr: CockpitData;
  lv: LvPlanningData;
  actions: (CockpitAction & { line: "TR" | "LV" })[];
  summary: PlantPlanningSummary;
}

/** Planning for the whole plant. `floor`: whether the account sees Shifts —
 *  without it the shift log's figures leave on the server. */
export async function loadPlanningAll(floor: boolean, period: { from?: Date | null; to?: Date | null } = {}, now = new Date()): Promise<PlanningAll> {
  const [trRaw, lvRaw] = await Promise.all([getCockpit(now), getLvPlanning(period, now)]);
  const tr = floor ? trRaw : withoutFloor(trRaw);
  const lv = floor ? lvRaw : lvWithoutFloor(lvRaw);
  return {
    tr, lv,
    actions: mergeActions(tr.actions, lv.actions),
    summary: plantPlanningSummary({ manpower: tr.manpower.rows, recent: tr.centres.map((c) => c.recent) }, { manpower: lv.manpower.rows, recent: lv.depts }),
  };
}

export interface ProductionAll {
  tr: FloorPeriod;
  lv: LvFloorPeriod;
  actions: (CockpitAction & { line: "TR" | "LV" })[];
}

/** Production for the whole plant over one period — the department asked for
 *  read on each line that has it (the names differ per line). The page is
 *  behind the Shifts screen, so nothing is stripped here. */
export async function loadProductionAll(req: { fromISO: string; toISO: string; dept: FloorDept; clamped?: boolean }, lvDept: LvFloorFilter, now = new Date()): Promise<ProductionAll> {
  const [tr, lv] = await Promise.all([getFloorPeriod(req, now), getLvFloorPeriod({ ...req, dept: lvDept }, now)]);
  return { tr, lv, actions: mergeActions(tr.actions, lv.actions) };
}
