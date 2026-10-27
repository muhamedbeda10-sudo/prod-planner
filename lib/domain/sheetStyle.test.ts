import { describe, expect, it } from "vitest";
import { MARK_COLORS, SHEET_THEMES, columnLetter, markFormula, numberFormatOf, stylePlan, type StylePlan } from "./sheetStyle";

const rows = [
  { MO: "A", Year: 2026, Qty: 12000, Rate: 0.125, Status: "Late" },
  { MO: "B", Year: 2026, Qty: 3, Rate: 0.5, Status: "" },
];

const ok = (r: StylePlan | { error: string }): StylePlan => {
  if ("error" in r) throw new Error(r.error);
  return r;
};

describe("numberFormatOf", () => {
  it("gives decimals as the values carry them (up to 3), thousands from 10,000 on, and nothing to whole numbers that read as they are", () => {
    expect(numberFormatOf("Qty", [12000, 3, ""])).toBe("#,##0");
    expect(numberFormatOf("Qty", [12, 3])).toBeNull();
    expect(numberFormatOf("Rate", [0.125, 0.5])).toBe("0.000");
    expect(numberFormatOf("Kg", [12500.5, 1.25])).toBe("#,##0.00");
    expect(numberFormatOf("Kg", [1 / 3])).toBe("0.000");
    expect(numberFormatOf("Rate", [1e-7])).toBe("0.000");
    // a heading naming a thing and a quantity is a quantity
    expect([numberFormatOf("Plan qty", [12000]), numberFormatOf("Number of sheets", [12000]), numberFormatOf("MO qty", [12000])]).toEqual(["#,##0", "#,##0", "#,##0"]);
  });

  it("never groups a column that names things, and leaves a column with text alone", () => {
    expect(numberFormatOf("Badge no", [12345])).toBeNull();
    expect(numberFormatOf("MO", [123456])).toBeNull();
    expect(numberFormatOf("Plan", [20261])).toBeNull();
    expect(numberFormatOf("Qty", [1, "n/a"])).toBeNull();
    expect(numberFormatOf("Qty", ["", null])).toBeNull();
  });
});

describe("stylePlan", () => {
  it("is the house style when nothing is asked: green, banded, the columns' own formats", () => {
    const p = ok(stylePlan(rows));
    expect(p).toMatchObject({ title: null, subtitle: null, theme: SHEET_THEMES.green, banded: true, highlight: [], freezeColumns: 0 });
    expect([...p.formats]).toEqual([[3, "#,##0"], [4, "0.000"]]);
  });

  it("reads the columns by their headings, case and spaces aside, and puts the asked-for format over the column's own", () => {
    const p = ok(stylePlan(rows, {
      title: "Late orders", subtitle: "October", theme: "blue", banded: false,
      formats: [{ column: " rate ", format: "percent" }],
      highlight: [{ column: "status", when: "eq", text: " Late ", color: "red", row: true }, { column: "Qty", when: "between", value: 10, value2: 5, text: "ignored", color: "amber" }],
      colorScale: [{ column: "Rate", better: "lower" }], dataBars: ["qty", "Qty"], bold: ["MO"], freezeColumns: 9,
    }));
    expect(p.formats.get(4)).toBe("0.0%");
    expect(p).toMatchObject({ title: "Late orders", subtitle: "October", theme: SHEET_THEMES.blue, banded: false, dataBars: [3], bold: [1], freezeColumns: 3 });
    expect(p.highlight).toEqual([
      { column: 5, when: "eq", text: "Late", color: MARK_COLORS.red, row: true },
      { column: 3, when: "between", value: 10, value2: 5, color: MARK_COLORS.amber, row: false },
    ]);
    expect(p.colorScale).toEqual([{ column: 4, better: "lower" }]);
  });

  it("keeps a column of numbers numbers, whatever its Total row's label", () => {
    const p = ok(stylePlan([{ T: 2.5, Qty: 4 }, { T: 3, Qty: 1 }, { T: "Total", Qty: 5 }]));
    expect([...p.numeric]).toEqual([1, 2]);
    expect(p.formats.get(1)).toBe("0.0");
  });

  it("keeps a subtitle only under a title", () => {
    expect(ok(stylePlan(rows, { subtitle: "alone" })).subtitle).toBeNull();
  });

  it("refuses a column the sheet does not have, naming the ones it has, and a rule without what it compares with", () => {
    expect(stylePlan(rows, { bold: ["Weight"], dataBars: ["Kg"] })).toEqual({ error: expect.stringMatching(/no column "Kg", "Weight" — its columns are: MO, Year, Qty, Rate, Status/) });
    expect(stylePlan(rows, { highlight: [{ column: "Qty", when: "gt", text: "many", color: "red" }] })).toEqual({ error: expect.stringContaining("needs a number") });
    expect(stylePlan(rows, { highlight: [{ column: "Qty", when: "eq", color: "red" }] })).toEqual({ error: expect.stringContaining("a number (value) or a text (text)") });
    expect(stylePlan(rows, { highlight: [{ column: "Qty", when: "between", value: 1, color: "red" }] })).toEqual({ error: expect.stringContaining("value2") });
    expect(stylePlan(rows, { highlight: [{ column: "Status", when: "contains", color: "red" }] })).toEqual({ error: expect.stringContaining("needs a text") });
  });
});

describe("markFormula", () => {
  it("tests numbers only as numbers, texts trimmed and quoted, the ends of a range either way round", () => {
    const f = (when: StylePlan["highlight"][number]["when"], value?: number | string, value2?: number) =>
      markFormula(typeof value === "string" ? { when, text: value } : { when, value, value2 }, "$C5");
    expect(f("gt", 10)).toBe("AND(ISNUMBER($C5),$C5>10)");
    expect(f("lte", -1.5)).toBe("AND(ISNUMBER($C5),$C5<=-1.5)");
    expect(f("between", 10, 5)).toBe("AND(ISNUMBER($C5),$C5>=5,$C5<=10)");
    expect(f("eq", 'Say "hi"')).toBe('TRIM($C5)="Say ""hi"""');
    // a number matches the figure and its text alike
    expect(f("eq", 100)).toBe('OR($C5=100,TRIM($C5)="100")');
    // an empty cell is not "not equal"
    expect(f("ne", 3)).toBe('AND(LEN(TRIM($C5))>0,$C5<>3,TRIM($C5)<>"3")');
    expect(f("ne", "3")).toBe('AND(LEN(TRIM($C5))>0,TRIM($C5)<>"3")');
    expect(f("contains", "late")).toBe('ISNUMBER(SEARCH("late",$C5))');
    // SEARCH's wildcards are looked for as they are
    expect(f("contains", "2*3?~")).toBe('ISNUMBER(SEARCH("2~*3~?~~",$C5))');
    expect(f("blank")).toBe("LEN(TRIM($C5))=0");
    expect(f("notBlank")).toBe("LEN(TRIM($C5))>0");
  });
});

describe("columnLetter", () => {
  it("names columns as Excel does", () => {
    expect([1, 26, 27, 52, 703].map(columnLetter)).toEqual(["A", "Z", "AA", "AZ", "AAA"]);
  });
});
