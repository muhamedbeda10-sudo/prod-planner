import { describe, it, expect } from "vitest";
import { computeDailyReport, type ReportOrderRow, type ReportLogRow } from "./report";
import { makeBomGrouper } from "./bom";
import { utcDate } from "./dates";

const grouper = makeBomGrouper(["A11E11M11"]);
const day = utcDate(2026, 7, 8);

describe("computeDailyReport — department output", () => {
  it("complete sets = MIN across items; efficiency and balance match the formulas", () => {
    const logs: ReportLogRow[] = [
      { date: day, dept: "Cut", bom: "A11E11M11", item: "CF", qty: 13, planNo: 27 },
      { date: day, dept: "Cut", bom: "A11E11M11", item: "TC", qty: 13, planNo: 27 },
      { date: day, dept: "Cut", bom: "A11E11M11", item: "TN", qty: 15, planNo: 27 },
      { date: day, dept: "Cut", bom: "A11E11M11", item: "CB", qty: 9, planNo: 27 },
    ];
    const rep = computeDailyReport([], logs, day, 27, grouper);
    const cut = rep.deptOutputs.find((d) => d.dept === "Cut")!;
    expect(cut.total).toBe(50);
    expect(cut.sets).toBe(9); // MIN(13,13,15,9)
    expect(cut.efficiency).toBeCloseTo(50 / (4 * 27), 6);
    expect(cut.balance).toBeCloseTo((9 * 4) / 50, 6); // 0.72
  });

  it("balance is null when a department produced nothing", () => {
    const rep = computeDailyReport([], [], day, 27, grouper);
    expect(rep.deptOutputs.every((d) => d.balance === null && d.total === 0)).toBe(true);
  });

  it("project worked today with no plan data is flagged No plan data", () => {
    const logs: ReportLogRow[] = [
      { date: day, dept: "Cut", bom: "ZZZE11M11", item: "CF", qty: 4, planNo: 27 },
    ];
    const rep = computeDailyReport([], logs, day, 27, grouper);
    expect(rep.projects[0].status).toBe("No plan data");
    expect(rep.projects[0].required).toBeNull();
  });

  it("completion cumulates each item's FINAL stage: paint for TC/TN/CB, weld for the core CF", () => {
    const orders: ReportOrderRow[] = (["CF", "TC", "TN", "CB"] as const).map((item) => ({
      planNo: 27, bom: "A11E11M11", mo: "MO1", description: "1000kva", item, requiredQty: 5, targetQty: 5,
    }));
    const logs: ReportLogRow[] = [
      { date: utcDate(2026, 7, 7), dept: "Welding", bom: "A11E11M11", item: "CF", qty: 5, planNo: 27 }, // core done at welding
      { date: utcDate(2026, 7, 7), dept: "Painting", bom: "A11E11M11", item: "TC", qty: 5, planNo: 27 },
      { date: utcDate(2026, 7, 7), dept: "Painting", bom: "A11E11M11", item: "TN", qty: 5, planNo: 27 },
      { date: day, dept: "Painting", bom: "A11E11M11", item: "CB", qty: 5, planNo: 27 }, // today closes it
    ];
    const rep = computeDailyReport(orders, logs, day, 27, grouper);
    const proj = rep.projects.find((p) => p.dept === "Painting")!;
    expect(proj.required).toBe(5);
    expect(proj.completed).toBe(5); // CF welded + TC/TN/CB painted
    expect(proj.status).toBe("Closed");
  });

  it("the core (CF) never being painted does NOT block completion", () => {
    const orders: ReportOrderRow[] = (["CF", "TC", "TN", "CB"] as const).map((item) => ({
      planNo: 27, bom: "A11E11M11", mo: "MO1", description: "1000kva", item, requiredQty: 5, targetQty: 5,
    }));
    // CF only welded (never painted); the other three fully painted
    const logs: ReportLogRow[] = [
      { date: day, dept: "Welding", bom: "A11E11M11", item: "CF", qty: 5, planNo: 27 },
      { date: day, dept: "Painting", bom: "A11E11M11", item: "TC", qty: 5, planNo: 27 },
      { date: day, dept: "Painting", bom: "A11E11M11", item: "TN", qty: 5, planNo: 27 },
      { date: day, dept: "Painting", bom: "A11E11M11", item: "CB", qty: 5, planNo: 27 },
    ];
    const rep = computeDailyReport(orders, logs, day, 27, grouper);
    const proj = rep.projects.find((p) => p.dept === "Painting")!;
    expect(proj.completed).toBe(5);
    expect(proj.status).toBe("Closed");
    // painting dept balance ignores CF: 3 painted items, 15 pcs, sets 5 → (5*3)/15 = 1
    const paint = rep.deptOutputs.find((d) => d.dept === "Painting")!;
    expect(paint.sets).toBe(5);
    expect(paint.balance).toBeCloseTo(1, 6);
  });

  it("welding alone does NOT close a project — completion follows Painting", () => {
    const orders: ReportOrderRow[] = (["CF", "TC", "TN", "CB"] as const).map((item) => ({
      planNo: 27, bom: "A11E11M11", mo: "MO1", description: "1000kva", item, requiredQty: 5, targetQty: 5,
    }));
    const logs: ReportLogRow[] = (["CF", "TC", "TN", "CB"] as const).map((item) => ({
      date: day, dept: "Welding" as const, bom: "A11E11M11", item, qty: 5, planNo: 27,
    }));
    const rep = computeDailyReport(orders, logs, day, 27, grouper);
    const proj = rep.projects.find((p) => p.dept === "Welding")!;
    expect(proj.completed).toBe(0); // fully welded, nothing painted
    expect(proj.status).toBe("In progress");
  });
});
