import { describe, it, expect } from "vitest";
import { parseMonthlyPlan, applyCascade, type DoneMatrix } from "./importMonthly";

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
      colorRal: "RAL-7035",
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
