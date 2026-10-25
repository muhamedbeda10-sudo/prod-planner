import { describe, it, expect } from "vitest";
import { boxStats, isChartBlock, parseAiChart, pointsToLabel, type AiChartSpec } from "./aiChart";

const parse = (o: unknown) => parseAiChart(JSON.stringify(o));
/** The spec whose type can be T — bar, line, area and combo share one. */
type SpecOf<T extends string> = AiChartSpec extends infer U ? (U extends { type: infer K } ? (T extends K ? U : never) : never) : never;

/** The spec of a chart that must parse, narrowed to its type. */
function as<T extends AiChartSpec["type"]>(o: unknown, type: T): SpecOf<T> {
  const c = parse(o);
  if ("error" in c) throw new Error(c.error);
  if (c.type !== type) throw new Error(`expected ${type}, got ${c.type}`);
  return c as SpecOf<T>;
}

describe("bars, lines, areas and combos", () => {
  it("reads a bar chart with its series", () => {
    expect(parse({
      type: "bar", title: "Output", unit: "pcs", series: ["Done", "Plan"],
      data: [{ name: "Fabrication", Done: 120, Plan: "150" }, { name: "Welding", Done: 95 }],
    })).toEqual({
      type: "bar", title: "Output", unit: "pcs", stacked: false, horizontal: false, series: ["Done", "Plan"], kinds: { Done: "bar", Plan: "bar" }, targets: [], highlight: [], labels: true, curve: "smooth",
      data: [{ name: "Fabrication", values: { Done: 120, Plan: 150 } }, { name: "Welding", values: { Done: 95, Plan: 0 } }],
    });
  });

  it("finds the series itself when none are listed, and caps them", () => {
    const row = Object.fromEntries([["name", "A"], ...Array.from({ length: 9 }, (_, i) => [`s${i}`, i])]);
    expect(as({ type: "line", data: [row] }, "line").series).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
  });

  it("stacks into shares, draws target lines and picks out what matters", () => {
    const c = as({ type: "area", stacked: "percent", series: ["TR", "LV"], data: [{ name: "W40", TR: 3, LV: 1 }], targets: [{ value: 150, label: "Target" }, { value: "x" }], highlight: ["TR"] }, "area");
    expect(c).toMatchObject({ stacked: "percent", targets: [{ value: 150, label: "Target" }], highlight: ["TR"] });
    // a line never stacks; one series has nothing to stack on
    expect(as({ type: "line", stacked: true, data: [{ name: "a", x: 1, y: 2 }] }, "line").stacked).toBe(false);
    expect(as({ type: "bar", stacked: true, data: [{ name: "a", x: 1 }] }, "bar").stacked).toBe(false);
  });

  it("mixes bars and lines on one scale in a combo — the first a bar unless told", () => {
    expect(as({ type: "combo", series: ["Done", { key: "Plan", kind: "line" }, { key: "Avg", kind: "area" }], data: [{ name: "Sun", Done: 5, Plan: 6, Avg: 4 }] }, "combo").kinds)
      .toEqual({ Done: "bar", Plan: "line", Avg: "area" });
    expect(as({ type: "combo", data: [{ name: "Sun", a: 5, b: 6 }] }, "combo").kinds).toEqual({ a: "bar", b: "line" });
    expect(as({ type: "combo", stacked: "percent", data: [{ name: "Sun", a: 5, b: 6 }] }, "combo").stacked).toBe("normal");
  });
});

describe("parts of a whole", () => {
  it("folds a pie's small slices into Other and drops the empty ones", () => {
    const data = [5, 0, 9, 1, 2, 3, 4, 8].map((v, i) => ({ name: `P${i}`, n: v }));
    const c = as({ type: "pie", series: ["n"], data }, "pie");
    expect(c.data.map((d) => d.name)).toEqual(["P2", "P7", "P0", "P6", "P5", "Other"]);
    expect(c.data.at(-1)!.values.n).toBe(3); // 2 + 1
  });

  it("sizes a treemap's parts, keeps six groups and folds the rest", () => {
    const data = Array.from({ length: 8 }, (_, i) => ({ name: `C${i}`, value: 10 + i, group: `G${i}` }));
    const c = as({ type: "treemap", data }, "treemap");
    expect(c.groups).toHaveLength(7);
    expect(c.groups.at(-1)).toBe("Other");
    expect(c.data[0]).toEqual({ name: "C7", value: 17, group: "G7" });
  });
});

describe("KPI cards", () => {
  it("keep only known tones, and carry a trend and progress", () => {
    expect(parse({ type: "kpi", items: [{ label: "Late", value: 12, tone: "bad", trend: [3, "4", null, 5], progress: "64%" }, { label: "Open", value: "85", tone: "pink" }, { label: "" }] })).toEqual({
      type: "kpi", title: "",
      items: [
        { label: "Late", value: "12", note: "", tone: "bad", trend: [3, 4, 5], progress: 64 },
        { label: "Open", value: "85", note: "", tone: null, trend: [], progress: null },
      ],
    });
  });
});

describe("pareto", () => {
  it("ranks the causes, adds up their running share, and marks the few that make 80%", () => {
    const c = as({ type: "pareto", unit: "tanks", data: [{ name: "Gasket", value: 6 }, { name: "Weld seam", value: 14 }, { name: "Flange", count: 3 }, { name: "Paint", value: 2 }, { name: "None", value: 0 }] }, "pareto");
    expect(c.data.map((d) => [d.name, d.cumulative, d.vital])).toEqual([["Weld seam", 0.56, true], ["Gasket", 0.8, true], ["Flange", 0.92, false], ["Paint", 1, false]]);
    expect(c.vital).toBe(2);
  });
});

describe("histogram", () => {
  it("bins the values on round edges and gives their median and mean", () => {
    const c = as({ type: "histogram", values: [0, 1, 1, 2, 3, 5, 8, 13, "x"], bins: 5 }, "histogram");
    expect(c.n).toBe(8);
    expect(c.median).toBe(2.5);
    expect(c.bins[0].from).toBe(0);
    expect(c.bins.reduce((t, b) => t + b.count, 0)).toBe(8);
    expect(c.bins.every((b) => b.to - b.from === c.bins[0].to - c.bins[0].from)).toBe(true);
  });

  it("widens a bin size too fine for the range", () => {
    expect(as({ type: "histogram", values: [0, 1000], binSize: 0.01 }, "histogram").bins.length).toBeLessThanOrEqual(30);
  });
});

describe("scatter", () => {
  it("keeps three groups and folds the rest into Other — every pair of colours must stay apart", () => {
    const pts = ["A", "A", "B", "C", "D", "E"].map((g, i) => ({ x: i, y: i * 2, group: g, name: `p${i}` }));
    const c = as({ type: "scatter", points: [...pts, { x: "n/a", y: 1 }] }, "scatter");
    expect(c.groups).toEqual(["A", "B", "C", "Other"]);
    expect(c.points).toHaveLength(6);
    expect(c.sized).toBe(false);
  });
});

describe("heatmap, progress, funnel", () => {
  it("reads a grid, a missing cell as zero", () => {
    expect(as({ type: "heatmap", rows: ["Cut", "Weld"], cols: ["Sun", "Mon"], values: [[4, 5], [6]] }, "heatmap").values).toEqual([[4, 5], [6, 0]]);
  });
  it("reads progress against a target, or a percentage when there is none", () => {
    expect(as({ type: "progress", items: [{ label: "Cut", value: 120, target: 150 }, { label: "OTD", value: 92 }, { label: "x" }] }, "progress").items)
      .toEqual([{ label: "Cut", value: 120, target: 150, note: "", tone: null }, { label: "OTD", value: 92, target: null, note: "", tone: null }]);
  });
  it("needs a funnel's stages in order, at least two", () => {
    expect(as({ type: "funnel", data: [{ name: "Cut", value: 40 }, { name: "Welded", value: 32 }] }, "funnel").data).toHaveLength(2);
    expect(parse({ type: "funnel", data: [{ name: "Cut", value: 40 }] })).toHaveProperty("error");
  });
});

describe("waterfall", () => {
  it("floats each step from the running total, a total without a value being that total", () => {
    const c = as({ type: "waterfall", data: [{ name: "Mon", value: 120, total: true }, { name: "New", value: 40 }, { name: "Delivered", value: -35 }, { name: "Fri", total: true }] }, "waterfall");
    expect(c.data.map((d) => [d.name, d.start, d.end])).toEqual([["Mon", 0, 120], ["New", 120, 160], ["Delivered", 160, 125], ["Fri", 0, 125]]);
  });
});

describe("gantt", () => {
  it("runs a whole day to the next midnight, keeps times as written, and spans the tasks", () => {
    const c = as({
      type: "gantt",
      tasks: [
        { row: "L2", label: "MO 1 TC", start: "2026-10-12", end: "2026-10-13", group: "TR" },
        { row: "L1", start: "2026-10-12T08:00", end: "2026-10-12T14:30" },
        { row: "L1", start: "2026-10-14", end: "2026-10-13" },
        { row: "", start: "2026-10-12" },
      ],
    }, "gantt");
    expect(c.rows).toEqual(["L2", "L1"]);
    expect(c.tasks[0]).toMatchObject({ start: Date.parse("2026-10-12T00:00:00Z"), end: Date.parse("2026-10-14T00:00:00Z"), startText: "2026-10-12" });
    expect(c.tasks[1]).toMatchObject({ start: Date.parse("2026-10-12T08:00:00Z"), endText: "2026-10-12 14:30" });
    expect(c).toMatchObject({ withTime: true, groups: ["TR"], from: Date.parse("2026-10-12T00:00:00Z"), to: Date.parse("2026-10-14T00:00:00Z") });
  });
});

describe("dumbbell and radar", () => {
  it("needs two series for before and after", () => {
    expect(as({ type: "dumbbell", series: ["Due", "Forecast"], data: [{ name: "MO 1", Due: 2, Forecast: 5 }] }, "dumbbell").data).toEqual([{ name: "MO 1", a: 2, b: 5 }]);
    expect(parse({ type: "dumbbell", data: [{ name: "MO 1", Due: 2 }] })).toHaveProperty("error");
  });
  it("draws at most three shapes on three measures or more", () => {
    const data = ["Availability", "Speed", "Quality"].map((m) => ({ name: m, L1: 90, L2: 80, L3: 70, L4: 60 }));
    expect(as({ type: "radar", data }, "radar").series).toEqual(["L1", "L2", "L3"]);
    expect(parse({ type: "radar", data: data.slice(0, 2) })).toHaveProperty("error");
  });
});

describe("other names for the forms", () => {
  it("reads a column, a donut, a step line and a stacked bar as the form that does the job", () => {
    expect(parse({ type: "Column", data: [{ name: "A", n: 1 }] })).toMatchObject({ type: "bar" });
    expect(parse({ type: "donut", series: ["n"], data: [{ name: "A", n: 1 }] })).toMatchObject({ type: "pie" });
    expect(parse({ type: "step", data: [{ name: "A", n: 1 }] })).toMatchObject({ type: "line", curve: "step" });
    expect(parse({ type: "line", curve: "linear", labels: false, data: [{ name: "A", n: 1 }] })).toMatchObject({ curve: "linear", labels: false });
    expect(parse({ type: "stackedbar", data: [{ name: "A", x: 1, y: 2 }] })).toMatchObject({ type: "bar", stacked: "normal" });
    expect(parse({ type: "bullet", items: [{ label: "Cut", value: 1, target: 2 }] })).toMatchObject({ type: "progress" });
    expect(parse({ type: "slope", series: ["a", "b"], data: [{ name: "x", a: 1, b: 2 }] })).toMatchObject({ type: "dumbbell" });
  });
});

describe("gauge", () => {
  it("reads one dial from the chart itself, its end a percentage when no target is given", () => {
    expect(as({ type: "gauge", title: "OEE", value: 82, unit: "%" }, "gauge").items).toEqual([{ label: "", value: 82, min: 0, max: 100, target: null, note: "", tone: null }]);
  });
  it("leaves room past the target, and keeps a max that was given", () => {
    const c = as({ type: "gauge", items: [{ label: "Welding", value: 120, target: 150 }, { label: "Cut", value: 40, max: 60, tone: "warn" }, { label: "Bad", value: 1, min: 5, max: 5 }] }, "gauge");
    expect(c.items.map((i) => [i.label, i.max, i.target])).toEqual([["Welding", 200, 150], ["Cut", 60, null]]);
  });
  it("draws more dials than a row holds as progress bars, as a gauge once was", () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ label: `C${i}`, value: i, target: 10 }));
    expect(parse({ type: "gauge", items })).toMatchObject({ type: "progress" });
    expect(parse({ type: "gauge", items: [{ value: 1 }, { value: 2 }] })).toEqual({ error: expect.stringContaining("label") });
  });
});

describe("boxplot", () => {
  it("gives each group its quartiles, whiskers within 1.5 boxes and the strays beyond", () => {
    const c = as({ type: "boxplot", data: [{ name: "L1", values: [1, 2, 3, 4, 5, 6, 7, 8, 100] }, { name: "", values: [1] }, { name: "L2", values: [] }] }, "boxplot");
    expect(c.data).toHaveLength(1);
    expect(c.data[0]).toMatchObject({ n: 9, min: 1, q1: 3, median: 5, q3: 7, max: 100, lo: 1, hi: 8, outliers: [100] });
    expect(parse({ type: "boxplot", data: [{ name: "L1", values: [] }] })).toHaveProperty("error");
  });
  it("reads quartiles between values, and keeps the farthest strays", () => {
    expect(boxStats("x", [4, 1, 3, 2])).toMatchObject({ q1: 1.75, median: 2.5, q3: 3.25, mean: 2.5 });
    const b = boxStats("y", [-100, 1, 2, 3, 4, 5, 6, 7, 8, 50, 100])!;
    expect(b.lo).toBe(1);
    expect(b.outliers).toEqual([-100, 100, 50]);
  });
});

describe("sankey", () => {
  it("adds up repeated links and drops loops, self links and empty ones", () => {
    const c = as({
      type: "sankey",
      links: [
        { from: "Cut", to: "Weld", value: 30 }, { from: "Cut", to: "Weld", value: 10 }, { from: "Weld", to: "Paint", value: 35 },
        { from: "Paint", to: "Cut", value: 5 }, { from: "Paint", to: "Paint", value: 2 }, { from: "Weld", to: "Scrap", value: 0 },
      ],
    }, "sankey");
    expect(c.nodes).toEqual(["Cut", "Weld", "Paint"]);
    expect(c.links).toEqual([{ source: 0, target: 1, value: 40 }, { source: 1, target: 2, value: 35 }]);
    expect(c.columns).toBe(3);
    expect(parse({ type: "sankey", links: [{ from: "a", to: "a", value: 1 }] })).toHaveProperty("error");
  });
});

describe("calendar", () => {
  it("lays the days out as their months, weeks Saturday to Friday", () => {
    const c = as({ type: "calendar", days: [{ date: "2026-10-01", value: 4 }, { date: "2026-10-01", value: 1 }, { date: "2026-11-02", value: 7 }, { date: "bad", value: 1 }] }, "calendar");
    expect(c.months.map((m) => m.label)).toEqual(["October 2026", "November 2026"]);
    // 1 October 2026 is a Thursday: the sixth column of a Saturday week
    expect(c.months[0].weeks[0].slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(c.months[0].weeks[0].findIndex((d) => d?.day === 1)).toBe(5);
    expect(c.months[0].weeks[0][5]).toEqual({ date: "2026-10-01", day: 1, value: 5 });
    expect(c.months[0].weeks[0][6]?.value).toBeNull();
    expect(c).toMatchObject({ max: 7, total: 12, days: 2 });
    expect(c.months.every((m) => m.weeks.every((w) => w.length === 7))).toBe(true);
  });
  it("drops days that are not on the calendar, and keeps the latest six months", () => {
    const c = as({ type: "calendar", days: [{ date: "2026-02-30", value: 900 }, { date: "2026-02-10", value: 5 }] }, "calendar");
    expect(c).toMatchObject({ days: 1, total: 5, max: 5 });
    const far = as({ type: "calendar", days: [{ date: "2016-01-05", value: 1 }, { date: "2026-04-30", value: 2 }, { date: "2026-05-03", value: 3 }, { date: "2026-10-01", value: 4 }] }, "calendar");
    expect(far.months.map((m) => m.key)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(far.days).toBe(2);
  });
  it("runs across the new year", () => {
    const c = as({ type: "calendar", days: [{ date: "2026-12-30", value: 1 }, { date: "2027-01-02", value: 2 }] }, "calendar");
    expect(c.months.map((m) => m.label)).toEqual(["December 2026", "January 2027"]);
    // 1 January 2027 is a Friday: the last column
    expect(c.months[1].weeks[0].findIndex((d) => d?.day === 1)).toBe(6);
  });
});

describe("control", () => {
  it("puts the limits three sigmas from the mean (by the moving range) and flags what falls outside", () => {
    const values = [10, 11, 10, 11, 10, 11, 10, 11, 10, 30];
    const c = as({ type: "control", data: values.map((v, i) => ({ name: `D${i + 1}`, value: v })) }, "control");
    expect(c.center).toBe(12.4);
    expect(c.data.filter((d) => d.out).map((d) => d.name)).toEqual(["D10"]);
    expect(c.ucl).toBeCloseTo(12.4 + 3 * (28 / 9 / 1.128), 3);
    expect(c.given).toBe(false);
    // a count never goes below zero, nor does its lower limit
    expect(as({ type: "control", values: [1, 5, 1, 5, 1] }, "control").lcl).toBe(0);
  });
  it("keeps limits that were given, and reads bare values", () => {
    const c = as({ type: "control", values: [5, 6, 9], ucl: 8, lcl: 4 }, "control");
    expect(c).toMatchObject({ ucl: 8, lcl: 4, given: true });
    expect(c.data.map((d) => [d.name, d.out])).toEqual([["1", false], ["2", false], ["3", true]]);
    // one limit given is not the limits given; rows may be named by their date
    expect(as({ type: "control", ucl: 8, data: [{ date: "2026-10-01", value: 2 }, { date: "2026-10-02", value: 3 }] }, "control")).toMatchObject({ given: false, ucl: 8 });
    expect(parse({ type: "control", values: [5] })).toHaveProperty("error");
  });
});

describe("values on the marks", () => {
  it("labels every point with room, a held level only where it starts and ends", () => {
    expect([...pointsToLabel([1, 5, 5, 5, 2], true)]).toEqual([0, 1, 3, 4]);
  });
  it("labels the ends and the extremes without room", () => {
    expect([...pointsToLabel([3, 9, 4, 1, 5], false)].sort()).toEqual([0, 1, 3, 4]);
    expect(pointsToLabel([], true).size).toBe(0);
  });
});

describe("what is not a chart", () => {
  it("says what is wrong instead of drawing nonsense", () => {
    expect(parseAiChart("{ not json")).toHaveProperty("error");
    expect(parse({ type: "spiral", data: [] })).toHaveProperty("error");
    expect(parse({ type: "bar", data: [{ name: "A" }] })).toHaveProperty("error");
    expect(parseAiChart("[1,2]")).toHaveProperty("error");
  });
});

describe("isChartBlock", () => {
  const kpi = JSON.stringify({ type: "kpi", items: [{ label: "Late", value: "26" }] });
  it("draws a chart block — and a chart's JSON however the fence was labelled", () => {
    expect(isChartBlock("chart", "{ broken")).toBe(true);
    expect(isChartBlock("json", kpi)).toBe(true);
    expect(isChartBlock("Chart", kpi)).toBe(true);
    expect(isChartBlock("kpi", kpi)).toBe(true);
    expect(isChartBlock("", kpi)).toBe(true);
    expect(isChartBlock("json", JSON.stringify({ type: "donut", data: [{ name: "A", n: 1 }] }))).toBe(true);
    expect(isChartBlock("gauge", JSON.stringify({ type: "gauge", value: 3 }))).toBe(true);
  });
  it("leaves other code as code", () => {
    expect(isChartBlock("json", JSON.stringify({ type: "user", id: 1 }))).toBe(false);
    expect(isChartBlock("sql", kpi)).toBe(false);
    expect(isChartBlock("json", "{ broken")).toBe(false);
    // a type that is an everyday word draws only with something to draw
    expect(isChartBlock("json", JSON.stringify({ type: "control", name: "Valve", enabled: true }))).toBe(false);
    expect(isChartBlock("", JSON.stringify({ type: "step", id: 3 }))).toBe(false);
  });
});
