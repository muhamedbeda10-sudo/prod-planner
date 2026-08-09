import { describe, it, expect } from "vitest";
import { parseWeeklyPlan } from "./importPlan";

// Build a 30-col row; cells is a map of 0-based index -> value.
function row(cells: Record<number, unknown>): unknown[] {
  const r = new Array(30).fill(null);
  for (const [k, v] of Object.entries(cells)) r[Number(k)] = v;
  return r;
}
// grid index 5=day0 CF, 6=day0 TC, 7=day0 TN, 8=day0 CB, 9=day1 CF ...
const dayCell = (day: number, item: number) => 5 + 4 * day + item;

describe("parseWeeklyPlan", () => {
  const grid: unknown[][] = [];
  grid[5] = row({
    0: "12011E13M12", 1: "S001", 2: "MO1", 3: "1000kva", 4: 6,
    [dayCell(0, 0)]: 3, [dayCell(1, 0)]: 2, // CF grid = 5
    [dayCell(0, 1)]: 1, // TC grid = 1
    29: "2 TN & TC BALANCE FROM WEEK-24",
  });
  grid[6] = row({
    // A empty -> BOM carried down; MO2 required 4, no balance remark
    2: "MO2", 4: 4, [dayCell(0, 3)]: 4, // CB grid = 4
  });
  grid[7] = row({
    0: "99001E11M11", 2: "MO3", 4: 2, 29: "5 CF BALANCE FROM WEEK-24", // 5 > required 2 -> double count
  });

  const parsed = parseWeeklyPlan(grid);
  const find = (mo: string, item: string) => parsed.orders.find((o) => o.mo === mo && o.item === item)!;

  it("emits one order row per MO x item", () => {
    expect(parsed.orders).toHaveLength(3 * 4);
    expect(parsed.orderRowCount).toBe(3);
  });

  it("carries the merged BOM value down to rows with an empty A", () => {
    expect(find("MO2", "CF").bom).toBe("12011E13M12");
  });

  it("DATES-ONLY role: targetQty = the scheduled grid sum, remarks are never parsed", () => {
    // MO1 carries a BALANCE remark — it must be IGNORED
    expect(find("MO1", "CF").targetQty).toBe(5); // grid 3 + 2
    expect(find("MO1", "TC").targetQty).toBe(1); // grid 1 only (no +balance)
    expect(find("MO1", "TN").targetQty).toBe(0); // nothing scheduled
    expect(find("MO1", "CF").plannerBalance).toBeNull();
    expect(find("MO1", "TC").plannerBalance).toBeNull();
  });

  it("plannerBalance is always null and unscheduled items get target 0", () => {
    for (const it of ["CF", "TC", "TN"]) {
      expect(find("MO2", it).targetQty).toBe(0);
      expect(find("MO2", it).plannerBalance).toBeNull();
    }
    expect(find("MO2", "CB").targetQty).toBe(4); // the only scheduled cell
  });

  it("creates schedule rows only for non-zero grid cells, dated by day offset", () => {
    const mo1 = parsed.schedules.filter((s) => s.mo === "MO1");
    expect(mo1).toHaveLength(3); // CF day0, CF day1, TC day0
    expect(mo1.find((s) => s.item === "CF" && s.dayOffset === 1)!.qty).toBe(2);
    expect(parsed.schedules.filter((s) => s.mo === "MO2")).toHaveLength(1); // CB day0
  });

  it("no balance-related warnings — remarks are reference-only now", () => {
    expect(parsed.warnings.find((w) => w.kind === "double-count")).toBeUndefined();
  });
});

/* The planners' own workbooks are not all identical: some carry an EXTRA
   description column, which pushes the whole day grid one column right. Read
   at the classic fixed offsets, such a sheet turns the total-qty column into
   "day 1 needs N core frames", shifts every component one place (a day's CF
   count lands under TC…), and drops the last day's CB entirely — all while
   looking perfectly plausible on screen. The grid is located from the sheet's
   own CF/TC/TN/CB header instead. */
describe("parseWeeklyPlan — grid located from the header, not assumed", () => {
  const ITEMS4 = ["CF", "TC", "TN", "CB"];
  /** Build a sheet whose grid starts at `gridFirst` (0-based). */
  const sheet = (gridFirst: number, cells: Record<string, number>) => {
    const width = gridFirst + 24 + 2;
    const blank = () => new Array(width).fill(null);
    const g: unknown[][] = [];
    for (let i = 0; i < 6; i++) g[i] = blank();
    // the header row (sheet row 4) spells the four components per day
    for (let d = 0; d < 6; d++) for (let k = 0; k < 4; k++) g[3][gridFirst + 4 * d + k] = ITEMS4[k];
    const r = blank();
    r[0] = "B-1"; r[1] = "S1"; r[2] = "MO-1"; r[gridFirst - 2] = "1000kva"; r[gridFirst - 1] = 10; // total qty
    for (const [key, v] of Object.entries(cells)) {
      const [d, item] = key.split("|");
      r[gridFirst + 4 * Number(d) + ITEMS4.indexOf(item)] = v;
    }
    r[gridFirst + 24] = "some remark";
    g[5] = r;
    return g;
  };
  // the same promises, expressed in both layouts
  const PROMISES = { "2|CF": 2, "3|CF": 3, "3|TC": 2, "4|TC": 5, "5|CB": 8 };
  const dump = (grid: unknown[][]) => {
    const p = parseWeeklyPlan(grid);
    const out: Record<string, number> = {};
    for (const s of p.schedules) out[`${s.dayOffset}|${s.item}`] = s.qty;
    return { out, p };
  };

  it("reads the classic layout exactly as before", () => {
    const { out, p } = dump(sheet(5, PROMISES));
    expect(out).toEqual(PROMISES);
    expect(p.layout.gridFirst).toBe(5);
    expect(p.warnings.find((w) => w.kind === "layout")).toBeUndefined(); // nothing unusual to say
  });

  it("reads a sheet with an extra description column identically", () => {
    const { out, p } = dump(sheet(6, PROMISES));
    expect(out).toEqual(PROMISES); // NOT shifted: no phantom day-0 CF, no lost CB
    expect(p.layout.gridFirst).toBe(6);
    expect(p.layout.req).toBe(5); // the total-qty column is never mistaken for a promise
    expect(p.warnings.find((w) => w.kind === "layout")?.message).toContain("column G");
  });

  it("keeps the last day's CB — the column a fixed layout would eat as REMARKS", () => {
    const { out } = dump(sheet(6, { "5|CB": 8 }));
    expect(out["5|CB"]).toBe(8);
  });

  it("falls back to the classic layout when there is no readable header", () => {
    const g = sheet(5, PROMISES);
    g[3] = new Array(31).fill(null); // header wiped
    const p = parseWeeklyPlan(g);
    expect(p.layout.detected).toBe(false);
    expect(p.layout.gridFirst).toBe(5);
    expect(p.schedules.length).toBe(Object.keys(PROMISES).length);
  });

  it("ignores a stray CF label that is not a real grid", () => {
    const g = sheet(5, PROMISES);
    g[2] = new Array(31).fill(null);
    g[2][0] = "CF"; // a note in the corner, not a header
    expect(parseWeeklyPlan(g).layout.gridFirst).toBe(5);
  });
});
