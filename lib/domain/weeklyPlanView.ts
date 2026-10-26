import { FINISHING_LABEL } from "@/lib/domain/constants";
import type { WeeklyPlanCell, WeeklyPlanDay, WeeklyPlanRow } from "@/lib/server/weeklyPlanTracker";

// How the weekly plan's screen reads a plan — the stages it can show, the
// stage a day's achievement is measured at, and the filters — shared with
// the assistant's sheet of the same plan, so the two never disagree.

export const WEEKLY_STAGES = [
  { value: "cut", label: "Fabrication", short: "Fab" },
  { value: "weld", label: "Welding", short: "Weld" },
  { value: "finish", label: FINISHING_LABEL, short: "Paint" },
  { value: "delivered", label: "Delivered", short: "Dlvd" },
] as const;
export type WeeklyStage = (typeof WEEKLY_STAGES)[number]["value"];

/** The stages picked in the filter ("cut,weld"), in pipeline order — all of
 *  them when none is picked. */
export function weeklyStagesOf(stage: string): WeeklyStage[] {
  const sel = new Set(stage.split(",").filter(Boolean));
  const picked = WEEKLY_STAGES.filter((o) => sel.has(o.value));
  return (picked.length > 0 ? picked : [...WEEKLY_STAGES]).map((o) => o.value);
}

/** Achievement is measured at ONE stage — the last one still in view. Filter to
 *  Fabrication and the percentage becomes "how much of this day is fabricated";
 *  pick several and the LAST in pipeline order wins, since a later stage can't
 *  run ahead of an earlier one. Unfiltered it stays at finishing, the final
 *  production stage — delivery lags production and would read as a false zero. */
export const weeklyMetricOf = (stages: readonly WeeklyStage[], filtered: boolean): WeeklyStage =>
  filtered ? stages[stages.length - 1] : "finish";

/** Work a cell actually OWES: the scheduled qty minus what the order marked
 *  N/A, minus what the sheet had already promised earlier this week. Every
 *  percentage and total reads against this — a promise we will not manufacture,
 *  and a promise asked for twice, can neither hurt nor help a day's score. */
export const owedOf = (c: WeeklyPlanCell): number => c.req - c.na - c.over;

/** How much of a row's owed work the stage covers — null when it owes none. */
export function weeklyCoverage(r: WeeklyPlanRow, metric: WeeklyStage): number | null {
  const cells = Object.values(r.items) as WeeklyPlanCell[];
  const owed = cells.reduce((s, c) => s + owedOf(c), 0);
  return owed > 0 ? cells.reduce((s, c) => s + c[metric], 0) / owed : null;
}

export interface WeeklyFilters {
  /** Matched against the project, the SOI and the description. */
  q?: string;
  /** Leave out the rows the measured stage has finished. */
  hideDone?: boolean;
}

/** The days the screen shows under these filters: each day's rows, its
 *  totals over the SAME rows and stage, and its columns — only the components
 *  those rows ask for. A day left with no row drops out. */
export function filterWeeklyDays(days: readonly WeeklyPlanDay[], f: WeeklyFilters, metric: WeeklyStage): WeeklyPlanDay[] {
  const needle = (f.q ?? "").trim().toLowerCase();
  return days
    .map((d) => {
      const rows = d.rows.filter((r) => {
        if (f.hideDone && (weeklyCoverage(r, metric) ?? 0) >= 1) return false;
        if (!needle) return true;
        return [r.bom, r.soi, r.description].some((v) => v?.toLowerCase().includes(needle));
      });
      let req = 0;
      let covered = 0;
      for (const r of rows) {
        for (const c of Object.values(r.items) as WeeklyPlanCell[]) {
          req += owedOf(c);
          covered += c[metric];
        }
      }
      return { ...d, rows, req, covered, items: d.items.filter((it) => rows.some((r) => r.items[it])) };
    })
    .filter((d) => d.rows.length > 0);
}
