import { describe, expect, it } from "vitest";
import { filterWeeklyDays, owedOf, weeklyCoverage, weeklyMetricOf, weeklyPlanRows, weeklyStagesOf, type WeeklyPlanCell, type WeeklyPlanDay, type WeeklyPlanRow } from "./weeklyPlanView";

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
    // measured at fabrication every row is finished, so none is left
    expect(filterWeeklyDays(days, { hideDone: true }, "cut")).toHaveLength(0);
  });
});

describe("weeklyPlanRows", () => {
  const day = (rows: WeeklyPlanDay["rows"]): WeeklyPlanDay => ({ iso: "2026-10-27", label: "Tue 27/10", isToday: false, isPast: false, req: 0, covered: 0, items: ["TN"], rows });
  const cell = { req: 5, na: 1, osp: 0, over: 0, cut: 4, weld: 3, finish: 2, delivered: 0, mos: ["A"] };
  it("is a row per day, project and component, with a column per stage in view", () => {
    const rows = weeklyPlanRows([day([{ bom: "B1", soi: null, description: null, urgent: false, req: 4, items: { TN: cell } }])], ["cut", "finish"]);
    expect(rows).toEqual([{ "Delivery date": "2026-10-27", Project: "B1", SOI: "", Component: "TN", Required: 5, "N/A (not manufactured)": 1, "Already promised earlier": 0, OSP: 0, Fab: 4, Paint: 2 }]);
  });

  it("carries Odoo's closings when the plan was read with them — a figure, or Not tracked", () => {
    const days = (odoo: number | null) => [day([{ bom: "B1", soi: null, description: null, urgent: false, req: 4, items: { TN: { ...cell, odoo } } }])];
    expect(weeklyPlanRows(days(3), ["finish"])[0]["Odoo closed"]).toBe(3);
    expect(weeklyPlanRows(days(null), ["finish"])[0]["Odoo closed"]).toBe("Not tracked");
  });
});
