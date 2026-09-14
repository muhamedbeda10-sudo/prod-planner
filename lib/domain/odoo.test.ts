import { describe, it, expect } from "vitest";
import { blockedItem, EMPTY_ODOO_FILTERS, filterOdooEntries, isDoneStatus, parseOdooDate, parseOdooSheet, statusTone, type OdooEntryView } from "./odoo";

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

describe("filterOdooEntries", () => {
  const row = (over: Partial<OdooEntryView>): OdooEntryView => ({
    id: 1, dateISO: "2026-09-06", soi: "S01035-1", fgCode: "FB-022-14003E11M11", product: "Tank", odooMo: "SF01/MO/06234",
    qty: 5, status: "MO to be close", tone: "muted", done: false, doneAtISO: null, recordedBy: null, source: "manual", fgGuessed: false, notes: [], ...over,
  });
  const rows = [
    row({ id: 1 }),
    row({ id: 2, soi: "S01194-4", fgCode: "FB-051-12005E14M13", product: "Top Cover", odooMo: "SF01/MO/13996-002", status: "Done", notes: [{ id: 1, text: "closed fine", atISO: "2026-09-06T10:00:00Z", by: null, blockedItem: null }] }),
    row({ id: 3, soi: null, product: "Tank", odooMo: "SF01/MO/15890-002", status: "Pending", notes: [{ id: 2, text: "[T-SSS-5MM] would become negative", atISO: "2026-09-06T11:00:00Z", by: null, blockedItem: "T-SSS-5MM" }] }),
    row({ id: 4, odooMo: "", source: "painting", fgGuessed: true }),
  ];
  const ids = (f: Partial<typeof EMPTY_ODOO_FILTERS>) => filterOdooEntries(rows, { ...EMPTY_ODOO_FILTERS, ...f }).map((r) => r.id);
  it("passes everything through with empty filters", () => {
    expect(ids({})).toEqual([1, 2, 3, 4]);
  });
  it("narrows by product, status and notes", () => {
    expect(ids({ product: "Tank" })).toEqual([1, 3, 4]);
    expect(ids({ status: "Done" })).toEqual([2]);
    expect(ids({ notes: "with" })).toEqual([2, 3]);
    expect(ids({ notes: "without" })).toEqual([1, 4]);
  });
  it("finds the rows born from a closing that still need Odoo's MO, or a checked FG-CODE", () => {
    expect(ids({ mo: "missing" })).toEqual([4]);
    expect(ids({ mo: "guessed" })).toEqual([4]);
  });
  it("searches SOI, FG-CODE, MO, product and the notes, any case", () => {
    expect(ids({ q: "s01194" })).toEqual([2]);
    expect(ids({ q: "15890" })).toEqual([3]);
    expect(ids({ q: "fb-051" })).toEqual([2]);
    expect(ids({ q: "t-sss" })).toEqual([3]);
    expect(ids({ q: "06234" })).toEqual([1]);
    expect(ids({ q: "nothing" })).toEqual([]);
  });
});

describe("filterOdooEntries — the day's own counts as filters", () => {
  const row = (over: Partial<OdooEntryView>): OdooEntryView => ({
    id: 1, dateISO: "2026-09-06", soi: "S1", fgCode: "FB-022-X", product: "Tank", odooMo: "SF01/MO/1",
    qty: 5, status: "MO to be close", tone: "muted", done: false, doneAtISO: null, recordedBy: null,
    source: "manual", fgGuessed: false, notes: [], ...over,
  });
  const rows = [
    row({ id: 1 }),
    row({ id: 2, status: "Done", done: true }),
    row({ id: 3, status: "Closed", done: true }),
    row({ id: 4, status: "Blocked" }),
    row({ id: 5, odooMo: "", source: "painting" }),
  ];
  const ids = (f: Partial<typeof EMPTY_ODOO_FILTERS>) => filterOdooEntries(rows, { ...EMPTY_ODOO_FILTERS, ...f }).map((r) => r.id);

  it("shows everything until a closing filter is picked", () => {
    expect(ids({})).toEqual([1, 2, 3, 4, 5]);
  });

  it("'not closed' is every status that is not a closing, not one named status", () => {
    // Blocked and the default both count as open; Done and Closed do not
    expect(ids({ closed: "open" })).toEqual([1, 4, 5]);
  });

  it("'done' takes every closing status, whichever word was used", () => {
    expect(ids({ closed: "done" })).toEqual([2, 3]);
  });

  it("stacks with the other filters rather than replacing them", () => {
    expect(ids({ closed: "open", mo: "missing" })).toEqual([5]);
    expect(ids({ closed: "done", q: "nothing" })).toEqual([]);
  });
});

describe("filterOdooEntries — ready to close: open AND its MO is known", () => {
  const row = (over: Partial<OdooEntryView>): OdooEntryView => ({
    id: 1, dateISO: "2026-09-06", soi: "S1", fgCode: "FB-022-X", product: "Tank", odooMo: "SF01/MO/1",
    qty: 5, status: "MO to be close", tone: "muted", done: false, doneAtISO: null, recordedBy: null,
    source: "manual", fgGuessed: false, notes: [], ...over,
  });
  const rows = [
    row({ id: 1 }),                                               // open, has MO  → ready
    row({ id: 2, status: "Blocked" }),                            // open, has MO  → ready
    row({ id: 3, odooMo: "", source: "painting" }),               // open, no MO
    row({ id: 4, status: "Done", done: true }),                   // closed
    row({ id: 5, status: "Done", done: true, odooMo: "" }),       // closed, no MO
  ];
  const ids = (f: Partial<typeof EMPTY_ODOO_FILTERS>) => filterOdooEntries(rows, { ...EMPTY_ODOO_FILTERS, ...f }).map((r) => r.id);

  it("'has MO' is the exact opposite of 'needs MO'", () => {
    expect(ids({ mo: "has" })).toEqual([1, 2, 4]);
    expect(ids({ mo: "missing" })).toEqual([3, 5]);
  });

  it("together with 'not closed' it is the office's own queue — waiting on Odoo, nothing else", () => {
    expect(ids({ closed: "open", mo: "has" })).toEqual([1, 2]);
  });

  it("leaves out the ones still waiting for their MO, however open they are", () => {
    expect(ids({ closed: "open", mo: "has" })).not.toContain(3);
  });
});
