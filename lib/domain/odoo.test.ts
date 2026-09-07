import { describe, it, expect } from "vitest";
import { blockedItem, isDoneStatus, parseOdooDate, parseOdooSheet, statusTone } from "./odoo";

const HEADER = ["Date", "SOI#", "FG-CODE", "Product", "MO#", "QTY", "Status", "Reason"];

describe("parseOdooDate", () => {
  it("reads an Excel serial as a UTC day", () => {
    expect(parseOdooDate(46182)?.toISOString()).toBe("2026-06-09T00:00:00.000Z");
  });
  it("reads ISO, m/d/yyyy and d-m-yyyy strings", () => {
    expect(parseOdooDate("2026-09-07")?.toISOString().slice(0, 10)).toBe("2026-09-07");
    expect(parseOdooDate("9/7/2026")?.toISOString().slice(0, 10)).toBe("2026-09-07");
    expect(parseOdooDate("07-09-2026")?.toISOString().slice(0, 10)).toBe("2026-09-07");
  });
  it("rejects blanks and junk", () => {
    expect(parseOdooDate(null)).toBeNull();
    expect(parseOdooDate("")).toBeNull();
    expect(parseOdooDate("soon")).toBeNull();
  });
});

describe("parseOdooSheet", () => {
  it("reads the office's sheet — the first seven columns, never Reason", () => {
    const grid = [
      HEADER,
      [46182, "s01035-1", "fb-022-14003E11M11", "Tank", "sf01/mo/06234", 5, "MO to be close", "[X] would become negative"],
      [46182, null, "FB-051-12011E12M12", "Top Cover", "SF01/MO/19966", "3", "", "Done"],
    ];
    const { rows, issues } = parseOdooSheet(grid);
    expect(issues).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      rowNum: 2, soi: "S01035-1", fgCode: "FB-022-14003E11M11", product: "Tank", odooMo: "SF01/MO/06234", qty: 5, status: "MO to be close",
    });
    expect(rows[0].date?.toISOString().slice(0, 10)).toBe("2026-06-09");
    expect(rows[1]).toMatchObject({ soi: null, qty: 3, status: "MO to be close" });
    expect("reason" in rows[0]).toBe(false);
  });

  it("finds the columns by header text, whatever their order", () => {
    const grid = [
      ["MO#", "QTY", "FG-CODE", "Product", "Status", "Date", "SOI#"],
      ["SF01/MO/1", 2, "FB-1", "Tank", "Closed", "2026-09-07", "S01"],
    ];
    const { rows, issues } = parseOdooSheet(grid);
    expect(issues).toEqual([]);
    expect(rows[0]).toMatchObject({ odooMo: "SF01/MO/1", qty: 2, fgCode: "FB-1", status: "Closed", soi: "S01" });
    expect(rows[0].date?.toISOString().slice(0, 10)).toBe("2026-09-07");
  });

  it("reads a headerless sheet positionally in the sheet's order", () => {
    const grid = [["2026-09-07", "S01", "FB-1", "Tank", "SF01/MO/1", 4, "MO to be close", "Done"]];
    const { rows, headerRow } = parseOdooSheet(grid);
    expect(headerRow).toBe(0);
    expect(rows[0]).toMatchObject({ odooMo: "SF01/MO/1", qty: 4, fgCode: "FB-1" });
  });

  it("leaves the date null when the cell is blank, so the tab's day can fill it", () => {
    const grid = [HEADER, [null, "S01", "FB-1", "Tank", "SF01/MO/1", 1, "MO to be close"]];
    const { rows, issues } = parseOdooSheet(grid);
    expect(issues).toEqual([]);
    expect(rows[0].date).toBeNull();
  });

  it("skips bad rows with a reason and ignores blank lines", () => {
    const grid = [
      HEADER,
      [46182, "S01", "", "Tank", "SF01/MO/1", 1, ""],
      [46182, "S01", "FB-1", "Tank", "", 1, ""],
      [46182, "S01", "FB-1", "Tank", "SF01/MO/2", "many", ""],
      ["soon", "S01", "FB-1", "Tank", "SF01/MO/3", 1, ""],
      [null, null, null, null, null, null, null, null],
      [46182, "S01", "FB-1", "Tank", "SF01/MO/4", 1, ""],
    ];
    const { rows, issues } = parseOdooSheet(grid);
    expect(rows.map((r) => r.odooMo)).toEqual(["SF01/MO/4"]);
    expect(issues).toHaveLength(4);
    expect(issues[0]).toMatch(/Row 2: no FG-CODE/);
    expect(issues[3]).toMatch(/Row 5 .*date "soon"/);
  });

  it("names the missing column when the header is not the sheet's", () => {
    const { rows, issues } = parseOdooSheet([["Date", "FG-CODE", "Product", "MO#", "Status"], [1, "a", "b", "c", "d"]]);
    expect(rows).toEqual([]);
    expect(issues[0]).toMatch(/"qty"/);
  });
});

describe("status and notes helpers", () => {
  it("colours a status by what it means", () => {
    expect(statusTone("Done")).toBe("ok");
    expect(statusTone(" closed ")).toBe("ok");
    expect(statusTone("Pending")).toBe("warn");
    expect(statusTone("Blocked")).toBe("bad");
    expect(statusTone("Cancelled")).toBe("bad");
    expect(statusTone("MO to be close")).toBe("muted");
    expect(statusTone(null)).toBe("muted");
    expect(isDoneStatus("done")).toBe(true);
    expect(isDoneStatus("MO to be close")).toBe(false);
  });

  it("pulls Odoo's bracketed item out of a note", () => {
    expect(blockedItem("[T-SSS-5MM] SS- Sheet 5mm would become negative")).toBe("T-SSS-5MM");
    expect(blockedItem("Done")).toBeNull();
  });
});
