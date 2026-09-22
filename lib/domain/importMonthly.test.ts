import { describe, it, expect } from "vitest";
import { parseMonthlyPlan, applyCascade, diffRevisionRow, type DoneMatrix, type MonthlyOrderRow } from "./importMonthly";

// Mirrors the real "Monthly plan.xlsx": title row, header row 2, sub-header row 3
// (component names, no MO), data from row 4, "Total" footer.
const grid: unknown[][] = [
  [46204, "", "", "", "", "", "", "Production Plan Manufacturing", "", "", "", "", "", ""],
  ["S.NO#", "SOI", "URGENT", "Customer", "FG Code", "MO.", "BoM Ref.", "KVA", "Rating \r\nKV", "Type", "PT", "SEC Item", "PLAN \r\nQTY", "OSP", "", "", "Color RAL", "", "Rev_3.0 REMARKS "],
  ["", "", "", "", "", "", "", "", "", "", "", "", "", "Fins", "Tank", "Core", "", "", ""],
  [1, "S01195-17", "Yes", "SEC", "FG-12012", "PF01/MO/35301-001", "12012E13M13", 200, "13.8/0.4|0.23", "-", "-", 908514004, 1, "-", "-", "-", "RAL-7035", 800, ""],
  [2, "S01134-1", "", "SEC", "FG-12003", "PF01/MO/36039-002", "12003E13M12", 100, "33/0.4|0.23", "-", "-", 908514012, 60, "-", "-", "-", "RAL-7035", 700, "urgent batch"],
  [3, "S01134-1", "", "SEC", "FG-12003", "PF01/MO/36039-002", "12003E13M12", 100, "33/0.4|0.23", "-", "-", 908514012, 40, "-", "-", "-", "", "", ""], // duplicate MO
  [4, "S01199-5", "", "SEC", "FG-12011", "", "12011E13M12", 100, "", "", "", "", 11, "", "", "", "", "", ""], // no MO -> skipped silently (not a data row)
  ["", "", "", "", "", "", "", "Total", "", "", "", "", 626, "", "", "", "", "", ""],
];

describe("parseMonthlyPlan", () => {
  const parsed = parseMonthlyPlan(grid);

  it("finds the header row and maps columns by name", () => {
    expect(parsed.headerRow).toBe(2);
    expect(parsed.rows).toHaveLength(2);
  });

  it("parses the master-order fields", () => {
    expect(parsed.rows[0]).toMatchObject({
      mo: "PF01/MO/35301-001",
      soi: "S01195-17",
      urgent: true,
      customer: "SEC",
      fgCode: "FG-12012",
      bom: "12012E13M13",
      kva: "200",
      rating: "13.8/0.4|0.23",
      secItem: "908514004",
      planQty: 1,
    });
    expect(parsed.rows[1].urgent).toBe(false);
    expect(parsed.rows[1].remarks).toBe("urgent batch");
  });

  it('"-" cells become null', () => {
    expect(parsed.rows[0].remarks).toBeNull();
  });

  it("skips the sub-header, blank-MO and Total rows without noise", () => {
    expect(parsed.rows.every((r) => r.mo.startsWith("PF01/MO/"))).toBe(true);
  });

  it("reads the OSP section (Fins ignored, Tank→TN, Core→CF) and TC follows TN", () => {
    // grid header row has "OSP" spanning Fins|Tank|Core on the sub-header row
    const g2 = grid.map((r) => [...r]);
    g2[3] = [...g2[3]];
    g2[3][14] = 5; // Tank OSP for MO/35301-001
    g2[3][15] = 2; // Core OSP
    const parsed2 = parseMonthlyPlan(g2);
    // an outsourced tank brings its top cover with it → TC = TN
    expect(parsed2.rows[0].osp).toEqual({ CF: 2, TC: 5, TN: 5, CB: 0 });
    expect(parsed2.rows[1].osp).toEqual({ CF: 0, TC: 0, TN: 0, CB: 0 }); // "-" cells → 0
  });

  it("flags in-file duplicate MOs and keeps the first", () => {
    expect(parsed.issues.some((i) => i.includes("duplicate MO"))).toBe(true);
    expect(parsed.rows.filter((r) => r.mo === "PF01/MO/36039-002")).toHaveLength(1);
    expect(parsed.rows.find((r) => r.mo === "PF01/MO/36039-002")!.planQty).toBe(60);
  });

  it("errors clearly when there is no header row", () => {
    const bad = parseMonthlyPlan([["nothing"], ["here"]]);
    expect(bad.rows).toHaveLength(0);
    expect(bad.issues[0]).toContain("header row");
  });
});

describe("parseMonthlyPlan — the spec columns are NOT imported", () => {
  // Fins, Colour RAL and CRC Size appear on some sheets and not others, and
  // where they appear the plant does not keep them current. They belong to the
  // planner, who types them on the tracker, so the import must not read them
  // at all — otherwise a re-import blanks or overwrites what he wrote.
  const spec: unknown[][] = [
    ["title"],
    ["SOI", "MO.", "BoM Ref.", "KVA", "Fins", "Color RAL", "CRC Size", "PLAN \r\nQTY", "Welding", "", "", "", ""],
    ["", "", "", "", "", "", "", "", "Fins", "Core", "Top  Cover", "Tank", "Cable Box"],
    ["S1", "PF01/MO/1", "B1E11M11", 1000, "YES", "RAL-7035", 900, 12, 7, 6, 5, 4, 3],
  ];
  const rows = parseMonthlyPlan(spec).rows;

  it("reads the row around them without carrying a single one", () => {
    expect(rows[0]).toMatchObject({ kva: "1000", planQty: 12 });
    for (const k of ["fins", "colorRal", "crcSize", "sfm"]) {
      expect(rows[0]).not.toHaveProperty(k);
    }
  });

  it("still reads the Welding group's progress, Fins column and all", () => {
    expect(rows[0].done.weld).toEqual({ CF: 6, TC: 5, TN: 4, CB: 3 });
  });
});

describe("parseMonthlyPlan — progress sections (setup balances)", () => {
  // header groups merged like the real sheet: section name then blanks, components on the sub-row
  const grid: unknown[][] = [
    ["title"],
    ["SOI", "MO.", "BoM Ref.", "PLAN \r\nQTY", "Laser Cutting", "", "", "", "", "", "Welding", "", "", "", "", "", "", "Paint", "", "", "", "", ""],
    ["", "", "", "", "Core", "Top  Cover", "Tank", "Cable Box", "Mono  Box", "Arrester Bracket", "Fins", "Core", "Top  Cover", "Tank", "Cable Box", "Mono Box", "Arrester Bracket", "Core", "Top  Cover", "Tank", "Cable Box", "Mono Box", "Arrester Bracket"],
    ["S1", "PF01/MO/1", "B1E11M11", 10, 8, 7, 6, 5, 99, 99, 99, 4, 3, 2, 1, 99, 99, 2, 1, 0, 0, 99, 99],
  ];
  const row = parseMonthlyPlan(grid).rows[0];

  it("maps Core→CF, Top Cover→TC, Tank→TN, Cable Box→CB and ignores secondary parts", () => {
    expect(row.done.cut).toEqual({ CF: 8, TC: 7, TN: 6, CB: 5 });
    expect(row.done.weld).toEqual({ CF: 4, TC: 3, TN: 2, CB: 1 });
    expect(row.done.paint).toEqual({ CF: 2, TC: 1, TN: 0, CB: 0 });
  });
});

describe("applyCascade — later stages imply earlier ones (setup sheet only)", () => {
  it("raises upstream to at least the downstream done qty", () => {
    const done: DoneMatrix = {
      cut: { CF: 0, TC: 5, TN: 2, CB: 0 },
      weld: { CF: 3, TC: 0, TN: 4, CB: 0 },
      paint: { CF: 6, TC: 2, TN: 0, CB: 0 },
    };
    const eff = applyCascade(done, 10);
    expect(eff.paint.CF).toBe(6);
    expect(eff.weld.CF).toBe(6); // raised by paint
    expect(eff.cut.CF).toBe(6); // raised by weld
    expect(eff.cut.TC).toBe(5); // own value wins when larger
    expect(eff.weld.TC).toBe(2); // raised by paint only
    expect(eff.weld.TN).toBe(4);
    expect(eff.cut.TN).toBe(4);
  });

  it("caps everything at the plan qty", () => {
    const done: DoneMatrix = {
      cut: { CF: 99, TC: 0, TN: 0, CB: 0 },
      weld: { CF: 0, TC: 0, TN: 0, CB: 0 },
      paint: { CF: 50, TC: 0, TN: 0, CB: 0 },
    };
    const eff = applyCascade(done, 20);
    expect(eff.cut.CF).toBe(20);
    expect(eff.weld.CF).toBe(20);
    expect(eff.paint.CF).toBe(20);
  });
});

describe("diffRevisionRow — the qty follows the sheet both ways", () => {
  const base = {
    soi: "S01",
    urgent: false,
    customer: "SEC",
    fgCode: "FG-1",
    bom: "B1",
    kva: "100",
    rating: "33/0.4",
    secItem: "9085",
    planQty: 10,
    remarks: null,
    product: null,
    ospEncloser: 0,
    materialsRemarks: null,
    ospCF: 0,
    ospTC: 0,
    ospTN: 0,
    ospCB: 0,
  };
  const row = (over: Partial<MonthlyOrderRow>): MonthlyOrderRow => ({
    rowNum: 4,
    mo: "MO-1",
    soi: "S01",
    urgent: false,
    customer: "SEC",
    fgCode: "FG-1",
    bom: "B1",
    kva: "100",
    rating: "33/0.4",
    secItem: "9085",
    planQty: 10,
    remarks: null,
    product: null,
    ospEncloser: 0,
    materialsRemarks: null,
    done: { cut: { CF: 0, TC: 0, TN: 0, CB: 0 }, weld: { CF: 0, TC: 0, TN: 0, CB: 0 }, paint: { CF: 0, TC: 0, TN: 0, CB: 0 } },
    osp: { CF: 0, TC: 0, TN: 0, CB: 0 },
    ...over,
  });

  it("an unchanged row produces no diff", () => {
    const d = diffRevisionRow(row({}), base);
    expect(d.changes).toHaveLength(0);
    expect(d.qtyReduction).toBeNull();
    expect(d.planQty).toBe(10);
  });

  it("a RAISED qty is applied like any other change", () => {
    const d = diffRevisionRow(row({ planQty: 14 }), base);
    expect(d.changes).toEqual([{ mo: "MO-1", field: "Qty", from: "10", to: "14" }]);
    expect(d.qtyReduction).toBeNull();
    expect(d.planQty).toBe(14);
  });

  it("a LOWERED qty is applied too, and called out as a reduction", () => {
    const d = diffRevisionRow(row({ planQty: 6 }), base);
    expect(d.changes).toEqual([{ mo: "MO-1", field: "Qty", from: "10", to: "6" }]);
    expect(d.qtyReduction).toEqual({ mo: "MO-1", from: 10, to: 6 });
    expect(d.planQty).toBe(6);
  });

  it("other field changes ride along with a qty drop", () => {
    const d = diffRevisionRow(row({ planQty: 6, urgent: true }), base);
    expect(d.changes).toEqual([{ mo: "MO-1", field: "Qty", from: "10", to: "6" }, { mo: "MO-1", field: "Urgent", from: "No", to: "Yes" }]);
    expect(d.qtyReduction).toEqual({ mo: "MO-1", from: 10, to: 6 });
    expect(d.planQty).toBe(6);
  });
});

describe("parseMonthlyPlan — the LV panels' sheet", () => {
  // the September 2026 sub-station plan, as the planner sends it
  const grid: unknown[][] = [
    ["SN", "SOI", "URGENT", "Customer", "Product", "FG Code", "MO", "BoM", "SEC Item", "Planned Qty", "OSP Encloser", "Remarks", "Materials Remarks"],
    [null, null, null, null, null, null, null, null, null, null, null, "Rev_1.0", null],
    [1, "S01286-1", "Yes", "PRI", "LSS", "FG-LSC-AHS-MUN-AD-AA", "SF01/MO/15867", "FG-LSC-AHS-MUN-AD-AA", "-", 3, "-", null, null],
    [2, "S00253-1", "Yes", "SEC", "USS", "FG-US-D5-13-MB", "SF01/MO/12746-002", "FG-US-D5-13-MB", "908567018", 8, 7, null, "*OSP Panels to be used* & one unit in-house."],
    [6, "S00653-1", null, "PRI", "USS", "FG-SUSA-8569114", "SF01/MO/11714", "FG-SUSA-8569114", "908569114", 27, "-", "Shifted to Sep Plan", "MCCB"],
    ["Total", null, null, null, null, null, null, null, null, 279, 7, null, null],
  ];

  it("reads every row off the header names, the Total footer excluded", () => {
    const { rows, issues } = parseMonthlyPlan(grid, "LV");
    expect(rows.map((r) => r.mo)).toEqual(["SF01/MO/15867", "SF01/MO/12746-002", "SF01/MO/11714"]);
    expect(issues).toEqual([]);
  });

  it("carries the panel's own columns: the product, the enclosures bought outside, the parts remarks", () => {
    const [lss, uss, third] = parseMonthlyPlan(grid, "LV").rows;
    expect(lss).toMatchObject({ product: "LSS", planQty: 3, ospEncloser: 0, secItem: null, urgent: true, customer: "PRI" });
    expect(uss).toMatchObject({ product: "USS", planQty: 8, ospEncloser: 7, secItem: "908567018", materialsRemarks: "*OSP Panels to be used* & one unit in-house." });
    expect(third).toMatchObject({ remarks: "Shifted to Sep Plan", materialsRemarks: "MCCB", urgent: false });
  });

  it("does not ask an LV sheet for cutting, welding and painting sections", () => {
    expect(parseMonthlyPlan(grid, "LV").issues).toEqual([]);
    expect(parseMonthlyPlan(grid, "TR").issues.some((m) => m.startsWith("Progress sections"))).toBe(true);
  });

  it("leaves a transformer sheet's rows with no product", () => {
    const tr: unknown[][] = [
      ["SOI", "URGENT", "Customer", "FG Code", "MO", "BoM Ref.", "KVA", "Rating", "SEC Item", "Plan Qty", "Remarks"],
      ["S1", "", "SEC", "FG", "PF01/MO/1", "14003E11M11", "1000", "11/0.4", "9085", 4, ""],
    ];
    expect(parseMonthlyPlan(tr, "TR").rows[0]).toMatchObject({ product: null, ospEncloser: 0, materialsRemarks: null, kva: "1000" });
  });

  it("reports a revision's changes to the panel's own columns", () => {
    const [, uss] = parseMonthlyPlan(grid, "LV").rows; // the USS row: 8 panels, 7 enclosures outside
    const d = diffRevisionRow(uss, { ...uss, ospCF: 0, ospTC: 0, ospTN: 0, ospCB: 0, product: "LSS", ospEncloser: 0, materialsRemarks: null });
    expect(d.changes.map((c) => c.field)).toEqual(["Product", "OSP Encloser", "Materials Remarks"]);
  });
});
