import { FINISHING_LABEL, type Item } from "@/lib/domain/constants";

// How the weekly plan's screen reads a plan — the stages it can show, the
// stage a day's achievement is measured at, and the filters — shared with
// the assistant's sheet of the same plan, so the two never disagree. The
// plan's shapes are here too; lib/server/weeklyPlanTracker.ts fills them.

export interface WeeklyPlanCell {
  req: number; // pcs this delivery day asks for (as scheduled — N/A pcs included)
  // pcs of `req` marked N/A on the order (excludedItems) — the plan asked for
  // them but they will NOT be manufactured. Shown, never counted as work owed.
  na: number;
  osp: number; // pcs of this day's promise covered by outsourcing (made outside)
  // pcs of `req` the sheet had ALREADY promised earlier this plan — the order
  // does not need them twice. Shown struck through, never counted as work owed.
  over: number;
  cut: number; // every figure below is capped at `req - na`
  weld: number;
  finish: number; // Painting, or SHOT BLAST for the core — plus outsourced qty
  delivered: number;
  // closed in Odoo: the day's orders' Done rows of the ODOO log born from their
  // own closings, waterfalled and capped like the stages — null when none of
  // them is planned from ODOO_EXACT_FROM on (not counted), undefined when the
  // view did not read Odoo (the Cut worklist's, the KPIs')
  odoo?: number | null;
  // what `odoo` is measured against: the promise of the counted orders alone
  // (less than the cell's when it also owes for orders planned before then)
  odooOf?: number;
  // the orders that owe this component TODAY and can actually receive output
  // (N/A ones left out) — recording a quantity on the cell distributes over them
  mos: string[];
}
export interface WeeklyPlanRow {
  bom: string;
  soi: string | null;
  description: string | null;
  urgent: boolean; // any of the day's orders for this project is flagged urgent
  req: number; // the day's promise to MANUFACTURE across every component (N/A excluded)
  items: Partial<Record<Item, WeeklyPlanCell>>; // ONLY what the day asks for
}
export interface WeeklyPlanDay {
  iso: string;
  label: string; // "Sat 11/07"
  isToday: boolean;
  isPast: boolean; // the delivery date has passed — it should be finished
  req: number;
  covered: number; // pcs of `req` whose final stage is done
  items: Item[]; // the components THIS day asks for, in pipeline order
  rows: WeeklyPlanRow[];
}
export interface WeeklyPlanTracker {
  planNo: number | null; // null = there are no weekly plans yet
  planNos: number[]; // newest first — what the picker offers
  days: WeeklyPlanDay[];
  req: number;
  covered: number;
}

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

const STAGE_SHORT = Object.fromEntries(WEEKLY_STAGES.map((o) => [o.value, o.short])) as Record<WeeklyStage, string>;

/** A weekly plan as a sheet, as the screen lists it: a row per delivery day,
 *  project and component, with a column per stage in view. */
export function weeklyPlanRows(days: readonly WeeklyPlanDay[], stages: readonly WeeklyStage[]): Record<string, string | number>[] {
  return days.flatMap((d) =>
    d.rows.flatMap((r) =>
      (Object.keys(r.items) as Item[]).map((it) => {
        const c = r.items[it]!;
        return {
          "Delivery date": d.iso, Project: r.bom, SOI: r.soi ?? "", Component: it,
          Required: c.req,
          // pcs scheduled but NOT to be manufactured (order marked N/A) and
          // pcs covered by outsourcing — the sheet must read like the screen
          "N/A (not manufactured)": c.na,
          "Already promised earlier": c.over,
          OSP: c.osp,
          ...Object.fromEntries(stages.map((s) => [STAGE_SHORT[s], c[s]])),
          // closed in Odoo, as the screen's Odoo column — when the plan was read with it
          ...(c.odoo !== undefined ? { "Odoo closed": c.odoo ?? "Not tracked" } : {}),
        };
      }),
    ),
  );
}
