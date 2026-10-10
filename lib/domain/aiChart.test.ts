import { describe, it, expect } from "vitest";
import { parseAiChart } from "./aiChart";

describe("parseAiChart", () => {
  it("reads a bar chart with its series", () => {
    const c = parseAiChart(JSON.stringify({
      type: "bar", title: "Output", unit: "pcs", series: ["Done", "Plan"],
      data: [{ name: "Fabrication", Done: 120, Plan: "150" }, { name: "Welding", Done: 95 }],
    }));
    expect(c).toEqual({
      type: "bar", title: "Output", unit: "pcs", stacked: false, horizontal: false, series: ["Done", "Plan"],
      data: [{ name: "Fabrication", values: { Done: 120, Plan: 150 } }, { name: "Welding", values: { Done: 95, Plan: 0 } }],
    });
  });
  it("finds the series itself when none are listed, and caps them", () => {
    const row = Object.fromEntries([["name", "A"], ...Array.from({ length: 9 }, (_, i) => [`s${i}`, i])]);
    const c = parseAiChart(JSON.stringify({ type: "line", data: [row] }));
    expect("series" in c && c.series).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
  });
  it("folds a pie's small slices into Other and drops the empty ones", () => {
    const data = [5, 0, 9, 1, 2, 3, 4, 8].map((v, i) => ({ name: `P${i}`, n: v }));
    const c = parseAiChart(JSON.stringify({ type: "pie", series: ["n"], data }));
    if ("error" in c || c.type === "kpi") throw new Error("expected a pie");
    expect(c.data.map((d) => d.name)).toEqual(["P2", "P7", "P0", "P6", "P5", "Other"]);
    expect(c.data.at(-1)!.values.n).toBe(3); // 2 + 1
  });
  it("reads KPI cards and keeps only known tones", () => {
    const c = parseAiChart(JSON.stringify({ type: "kpi", items: [{ label: "Late", value: 12, tone: "bad" }, { label: "Open", value: "85", tone: "pink" }, { label: "" }] }));
    expect(c).toEqual({ type: "kpi", title: "", items: [{ label: "Late", value: "12", note: "", tone: "bad" }, { label: "Open", value: "85", note: "", tone: null }] });
  });
  it("says what is wrong instead of drawing nonsense", () => {
    expect(parseAiChart("{ not json")).toHaveProperty("error");
    expect(parseAiChart(JSON.stringify({ type: "radar", data: [] }))).toHaveProperty("error");
    expect(parseAiChart(JSON.stringify({ type: "bar", data: [{ name: "A" }] }))).toHaveProperty("error");
    expect(parseAiChart("[1,2]")).toHaveProperty("error");
  });
});
