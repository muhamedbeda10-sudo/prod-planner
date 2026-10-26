import { describe, expect, it } from "vitest";
import { filterWeeklyDays, owedOf, weeklyCoverage, weeklyMetricOf, weeklyStagesOf } from "./weeklyPlanView";
import type { WeeklyPlanCell, WeeklyPlanDay, WeeklyPlanRow } from "@/lib/server/weeklyPlanTracker";

const cell = (o: Partial<WeeklyPlanCell> = {}): WeeklyPlanCell => ({ req: 10, na: 0, osp: 0, over: 0, cut: 10, weld: 6, finish: 4, delivered: 0, mos: ["A"], ...o });
const row = (bom: string, items: WeeklyPlanRow["items"], o: Partial<WeeklyPlanRow> = {}): WeeklyPlanRow => ({ bom, soi: null, description: null, urgent: false, req: 0, items, ...o });
const day = (iso: string, rows: WeeklyPlanRow[]): WeeklyPlanDay => ({ iso, label: iso, isToday: false, isPast: false, req: 0, covered: 0, items: ["TN", "CF"], rows });

describe("the weekly plan's stages", () => {
  it("are the picked ones in pipeline order, or every one", () => {
    expect(weeklyStagesOf("finish,cut")).toEqual(["cut", "finish"]);
    expect(weeklyStagesOf("")).toEqual(["cut", "weld", "finish", "delivered"]);
  });
  it("measure at the last stage in view when filtered, else at finishing", () => {
    expect(weeklyMetricOf(["cut", "weld"], true)).toBe("weld");
    expect(weeklyMetricOf(["cut", "weld", "finish", "delivered"], false)).toBe("finish");
  });
  it("count as owed what is neither N/A nor promised twice", () => {
    expect(owedOf(cell({ na: 2, over: 3 }))).toBe(5);
    expect(weeklyCoverage(row("B", { TN: cell({ req: 4, finish: 4 }) }), "finish")).toBe(1);
    expect(weeklyCoverage(row("B", { TN: cell({ req: 2, na: 2 }) }), "finish")).toBeNull();
  });
});

describe("filterWeeklyDays", () => {
  const days = [
    day("2026-10-27", [row("B1", { TN: cell() }, { soi: "S-9" }), row("B2", { CF: cell({ finish: 10 }) })]),
    day("2026-10-28", [row("B3", { TN: cell({ finish: 10 }) })]),
  ];
  it("searches the project, the SOI and the description, and drops a day left empty", () => {
    const shown = filterWeeklyDays(days, { q: "s-9" }, "finish");
    expect(shown.map((d) => d.iso)).toEqual(["2026-10-27"]);
    expect(shown[0].rows.map((r) => r.bom)).toEqual(["B1"]);
    // a day's columns follow the rows that survived
    expect(shown[0].items).toEqual(["TN"]);
  });
  it("hides the rows the measured stage finished, and totals the day over what is left", () => {
    const shown = filterWeeklyDays(days, { hideDone: true }, "finish");
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ req: 10, covered: 4 });
    // measured at fabrication, nothing is left to hide — every row is cut
    expect(filterWeeklyDays(days, { hideDone: true }, "cut")).toHaveLength(0);
  });
});
