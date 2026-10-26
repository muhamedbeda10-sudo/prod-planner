import "server-only";
import { getCockpit, getFloorPeriod, withoutFloor, type CockpitData, type FloorPeriod } from "./kpis";
import { getLvFloorPeriod, getLvPlanning, lvWithoutFloor, type LvFloorPeriod, type LvPlanningData } from "./lvKpis";
import type { CockpitAction } from "@/lib/domain/kpis";
import type { FloorDept } from "@/lib/domain/floorKpis";
import type { LvFloorFilter } from "@/lib/domain/lvKpis";
import { mergeActions, plantPlanningSummary, type PlantPlanningSummary } from "@/lib/domain/plantKpis";

// The whole plant's dashboards — Planning and Production each show both
// lines on one page — by one rule for the pages and the assistant: the shift
// log's figures stripped for an account the Shifts screen is closed to, both
// lines' decisions in one list and the plant's headline from the domain's
// rules. The pages load each line on its own (loadOrNull: a line that fails
// to load leaves the other on screen) with the functions below, so the page
// and the assistant cannot disagree.

/** A page's loader whose failure is logged and shown as that part's error
 *  state (LoadFailed), never a crash of the page. */
export const loadOrNull = <T,>(page: string, what: string, p: Promise<T>): Promise<T | null> =>
  p.catch((e: unknown) => { console.error(`${page}: ${what} could not load`, e); return null; });

/** A line's Planning as an account may see it — without Shifts, the shift log's figures leave here. */
export const trPlanningFor = (tr: CockpitData, floor: boolean) => (floor ? tr : withoutFloor(tr));
export const lvPlanningFor = (lv: LvPlanningData, floor: boolean) => (floor ? lv : lvWithoutFloor(lv));

/** The plant's Planning headline from the two lines as the account sees them. */
export function planningSummary(tr: CockpitData, lv: LvPlanningData): PlantPlanningSummary {
  return plantPlanningSummary({ manpower: tr.manpower.rows, recent: tr.centres.map((c) => c.recent) }, { manpower: lv.manpower.rows, recent: lv.depts });
}

export interface PlanningAll {
  tr: CockpitData;
  lv: LvPlanningData;
  actions: (CockpitAction & { line: "TR" | "LV" })[];
  summary: PlantPlanningSummary;
}

/** Planning for the whole plant. `floor`: whether the account sees Shifts. */
export async function loadPlanningAll(floor: boolean, period: { from?: Date | null; to?: Date | null } = {}, now = new Date()): Promise<PlanningAll> {
  const [trRaw, lvRaw] = await Promise.all([getCockpit(now), getLvPlanning(period, now)]);
  const tr = trPlanningFor(trRaw, floor), lv = lvPlanningFor(lvRaw, floor);
  return { tr, lv, actions: mergeActions(tr.actions, lv.actions), summary: planningSummary(tr, lv) };
}

export interface ProductionAll {
  tr: FloorPeriod;
  lv: LvFloorPeriod;
  actions: (CockpitAction & { line: "TR" | "LV" })[];
}

/** Production for the whole plant over one period — each line's own
 *  department (the names differ per line). The page is behind the Shifts
 *  screen, so nothing is stripped here. */
export async function loadProductionAll(req: { fromISO: string; toISO: string; dept: FloorDept; clamped?: boolean }, lvDept: LvFloorFilter, now = new Date()): Promise<ProductionAll> {
  const [tr, lv] = await Promise.all([getFloorPeriod(req, now), getLvFloorPeriod({ ...req, dept: lvDept }, now)]);
  return { tr, lv, actions: mergeActions(tr.actions, lv.actions) };
}
