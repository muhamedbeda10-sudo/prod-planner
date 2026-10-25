import { describe, expect, it } from "vitest";
import { absenceFindings, cleanWatchOptions, lateFindings, outputFindings, sortFindings, watchReport, WATCH_DEFAULTS } from "./watchdog";

describe("orders heading late", () => {
  const today = "2026-10-26";
  it("reports the late ones, the latest first, urgent when a week late or already past due", () => {
    const f = lateFindings([
      { mo: "MO1", dueISO: "2026-10-30", etaISO: "2026-11-02", late: true, done: false, blockedBy: null },
      { mo: "MO2", dueISO: "2026-10-28", etaISO: "2026-11-10", late: true, done: false, blockedBy: null },
      { mo: "MO3", dueISO: "2026-10-30", etaISO: "2026-10-29", late: false, done: false, blockedBy: null },
      { mo: "MO4", dueISO: "2026-10-20", etaISO: "2026-10-27", late: true, done: false, blockedBy: null },
    ], today, { lateMinDays: 1 });
    expect(f.map((x) => [x.mo, x.severity])).toEqual([["MO2", "critical"], ["MO4", "critical"], ["MO1", "warn"]]);
    expect(f[0].title).toBe("MO2 heads 13 days late");
  });
  it("leaves out the barely late below the owner's threshold", () => {
    expect(lateFindings([{ mo: "MO1", dueISO: "2026-10-30", etaISO: "2026-11-01", late: true, done: false, blockedBy: null }], today, { lateMinDays: 3 })).toEqual([]);
  });
  it("flags an order due soon that cannot be forecast", () => {
    const f = lateFindings([
      { mo: "MO5", dueISO: "2026-11-02", etaISO: null, late: false, done: false, blockedBy: "weld" },
      { mo: "MO6", dueISO: "2026-12-30", etaISO: null, late: false, done: false, blockedBy: "weld" },
    ], today, { lateMinDays: 1 });
    expect(f.map((x) => x.key)).toEqual(["blocked:MO5:weld"]);
  });
});

describe("output under its usual", () => {
  const days = (xs: number[]) => xs.map((hours, i) => ({ dateISO: `2026-10-${String(10 + i).padStart(2, "0")}`, hours }));
  it("flags a day far under the median of the days before", () => {
    const f = outputFindings([{ stage: "weld", label: "Welding", days: days([100, 110, 90, 105, 95, 100, 50]) }], { dropPct: 30 });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ key: "output:weld:2026-10-16", severity: "warn", baseline: 100, latest: 50 });
  });
  it("is quiet on a normal day, a short history or no usual at all", () => {
    expect(outputFindings([{ stage: "cut", label: "Cutting", days: days([100, 110, 90, 95]) }], { dropPct: 30 })).toEqual([]);
    expect(outputFindings([{ stage: "cut", label: "Cutting", days: days([0, 0, 0, 0, 0]) }], { dropPct: 30 })).toEqual([]);
    expect(outputFindings([{ stage: "cut", label: "Cutting", days: days([10, 0]) }], { dropPct: 30 })).toEqual([]);
  });
  it("waits for a last day whose Daily log is not in yet", () => {
    expect(outputFindings([
      { stage: "weld", label: "Welding", days: days([100, 100, 100, 100, 0]) },
      { stage: "cut", label: "Cutting", days: days([80, 80, 80, 80, 0]) },
    ], { dropPct: 30 })).toEqual([]);
  });
  it("is urgent at twice the drop", () => {
    expect(outputFindings([{ stage: "weld", label: "Welding", days: days([100, 100, 100, 100, 20]) }], { dropPct: 30 })[0].severity).toBe("critical");
  });
});

describe("absence", () => {
  it("flags a department's high day above its usual", () => {
    const d = (dateISO: string, absent: number) => ({ dateISO, dept: "Welding", rows: 20, absent });
    const f = absenceFindings([d("2026-10-20", 1), d("2026-10-21", 2), d("2026-10-22", 1), d("2026-10-25", 6), d("2026-10-26", 20)], [], { absencePct: 15, chronicDays: 3, chronicOf: 5, fromISO: "2026-10-22", beforeISO: "2026-10-26" });
    expect(f.map((x) => x.key)).toEqual(["absence:Welding:2026-10-25"]);
    expect(f[0].title).toBe("Welding: 6 of 20 absent on 2026-10-25 (30%)");
  });
  it("is quiet when the day is the department's usual", () => {
    const d = (dateISO: string) => ({ dateISO, dept: "Cut", rows: 10, absent: 3 });
    expect(absenceFindings([d("2026-10-20"), d("2026-10-21"), d("2026-10-22")], [], { absencePct: 15, chronicDays: 3, chronicOf: 5, fromISO: "2026-10-20", beforeISO: "2026-10-26" })).toEqual([]);
  });
  it("says nothing of a department not recorded lately", () => {
    const d = (dateISO: string, absent: number) => ({ dateISO, dept: "Painting", rows: 20, absent });
    expect(absenceFindings([d("2026-10-01", 0), d("2026-10-10", 10)], [], { absencePct: 15, chronicDays: 3, chronicOf: 5, fromISO: "2026-10-22", beforeISO: "2026-10-26" })).toEqual([]);
  });
  it("names a worker absent on most of their recent days", () => {
    const recent = ["25", "22", "21", "20", "19"].map((d, i) => ({ dateISO: `2026-10-${d}`, present: i === 1 }));
    const o = { absencePct: 15, chronicDays: 3, chronicOf: 5, fromISO: "2026-10-22", beforeISO: "2026-10-26" };
    const f = absenceFindings([], [{ id: 9, name: "Ahmed", dept: "Welding", recent }], o);
    expect(f[0]).toMatchObject({ key: "chronic:9:2026-10-25", title: "Ahmed (Welding) absent 4 of their last 5 days" });
    expect(absenceFindings([], [{ id: 9, name: "Ahmed", dept: "Welding", recent: recent.slice(0, 3) }], o)).toEqual([]);
  });
});

describe("settings and the report", () => {
  it("holds each setting to its range", () => {
    expect(cleanWatchOptions({ dropPct: "40" })).toEqual({ ...WATCH_DEFAULTS, dropPct: 40 });
    expect(cleanWatchOptions({ dropPct: 5 })).toHaveProperty("error");
    expect(cleanWatchOptions({ lateMinDays: 0 })).toHaveProperty("error");
    expect(cleanWatchOptions({ chronicDays: 6, chronicOf: 5 })).toHaveProperty("error");
  });
  it("puts the urgent first and writes a calm line on a quiet day", () => {
    const f = sortFindings([
      { key: "a", kind: "absence", severity: "warn", title: "A", detail: "" },
      { key: "b", kind: "late", severity: "critical", title: "B", detail: "" },
    ]);
    expect(f.map((x) => x.key)).toEqual(["b", "a"]);
    expect(watchReport({ todayISO: "2026-10-26", findings: [] })).toContain("Nothing out of the ordinary");
  });
  it("draws the flagged stage's days as a chart with its usual", () => {
    const series = [{ stage: "weld", label: "Welding", days: [100, 100, 100, 100, 20].map((hours, i) => ({ dateISO: `2026-10-1${i}`, hours })) }];
    const report = watchReport({ todayISO: "2026-10-26", findings: outputFindings(series, { dropPct: 30 }), series, summary: "Welding fell." });
    expect(report).toContain("```chart");
    expect(report).toContain('"label":"Usual"');
    expect(report).toContain("Welding fell.");
  });
});
