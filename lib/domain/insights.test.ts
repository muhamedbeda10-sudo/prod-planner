import { describe, it, expect } from "vitest";
import {
  workingDaysInclusive,
  assessDeliveryRisk,
  forecastDept,
  trendInsight,
  bottleneckInsight,
  agingInsight,
  atRiskInsight,
  setBalanceInsight,
  sortInsights,
} from "./insights";

describe("workingDaysInclusive", () => {
  // 2026-07-13 is a Monday; Friday 2026-07-17 is the off day
  it("counts both endpoints and skips Fridays", () => {
    expect(workingDaysInclusive("2026-07-13", "2026-07-13")).toBe(1);
    expect(workingDaysInclusive("2026-07-13", "2026-07-16")).toBe(4); // Mon..Thu
    expect(workingDaysInclusive("2026-07-13", "2026-07-18")).toBe(5); // Fri skipped
  });

  it("skips listed holidays and handles inverted ranges", () => {
    expect(workingDaysInclusive("2026-07-13", "2026-07-16", new Set(["2026-07-14"]))).toBe(3);
    expect(workingDaysInclusive("2026-07-16", "2026-07-13")).toBe(0);
  });
});

describe("assessDeliveryRisk", () => {
  const cap = 27;

  it("returns null without a due date or open qty", () => {
    expect(assessDeliveryRisk({ dueISO: null, dueQty: 10 }, "2026-07-13", cap)).toBeNull();
    expect(assessDeliveryRisk({ dueISO: "2026-07-15", dueQty: 0 }, "2026-07-13", cap)).toBeNull();
  });

  it("flags passed due dates as late", () => {
    expect(assessDeliveryRisk({ dueISO: "2026-07-12", dueQty: 5 }, "2026-07-13", cap)).toBe("late");
  });

  it("flags open qty beyond the capacity window as at-risk", () => {
    // due today: one day of capacity (27)
    expect(assessDeliveryRisk({ dueISO: "2026-07-13", dueQty: 28 }, "2026-07-13", cap)).toBe("at-risk");
    expect(assessDeliveryRisk({ dueISO: "2026-07-13", dueQty: 27 }, "2026-07-13", cap)).toBeNull();
    // due in 2 working days (Mon..Wed = 3 days × 27 = 81)
    expect(assessDeliveryRisk({ dueISO: "2026-07-15", dueQty: 82 }, "2026-07-13", cap)).toBe("at-risk");
    expect(assessDeliveryRisk({ dueISO: "2026-07-15", dueQty: 80 }, "2026-07-13", cap)).toBeNull();
  });
});

describe("forecastDept", () => {
  const base = { dept: "Cut", targetPerItem: 27, workingDays: 6 };
  // week target = 27 × 4 items × 6 days = 648

  it("projects on-track output as good", () => {
    // 3 days elapsed at 110/day → projected 660 ≥ 648
    const ins = forecastDept({ ...base, weekTotal: 330, paceDays: 3 });
    expect(ins?.severity).toBe("good");
    expect(ins?.detail).toContain("648");
  });

  it("flags a projected shortfall with the needed daily rate", () => {
    // 3 days at 80/day → projected 480 of 648 (74%) → critical
    const ins = forecastDept({ ...base, weekTotal: 240, paceDays: 3 });
    expect(ins?.severity).toBe("critical");
    // needed = (648 − 240) / 3 remaining days = 136
    expect(ins?.detail).toContain("136");
  });

  it("returns null before any working day elapsed", () => {
    expect(forecastDept({ ...base, weekTotal: 0, paceDays: 0 })).toBeNull();
  });
});

describe("trendInsight", () => {
  it("stays silent on small fluctuations", () => {
    expect(trendInsight("Cut", [100, 105], [100, 98])).toBeNull();
  });

  it("celebrates acceleration and warns on slowdown", () => {
    expect(trendInsight("Cut", [120, 130], [90, 100])?.severity).toBe("good");
    const down = trendInsight("Cut", [50, 55], [100, 110]);
    expect(down?.severity).toBe("critical"); // −50%
  });
});

describe("bottleneckInsight", () => {
  it("names the stage with the biggest buildup in days of work", () => {
    const ins = bottleneckInsight({ weldWaiting: 300, paintWaiting: 80, targetPerDeptDay: 108 });
    expect(ins?.title).toContain("Welding");
  });

  it("ignores healthy WIP under ~2 days", () => {
    expect(bottleneckInsight({ weldWaiting: 100, paintWaiting: 90, targetPerDeptDay: 108 })).toBeNull();
  });
});

describe("agingInsight", () => {
  it("reports lines stuck beyond the threshold with the oldest one", () => {
    const ins = agingInsight("Welding", "/worklist/welding", [
      { ageDays: 10, available: 5, bom: "B1" },
      { ageDays: 20, available: 3, bom: "B2" },
      { ageDays: 2, available: 9, bom: "B3" },
    ]);
    expect(ins?.severity).toBe("critical"); // oldest ≥ 14
    expect(ins?.detail).toContain("B2");
    expect(ins?.title).toContain("2 lines");
  });

  it("returns null when nothing is stuck", () => {
    expect(agingInsight("Welding", "/w", [{ ageDays: 3, available: 5, bom: "B" }])).toBeNull();
  });
});

describe("atRiskInsight", () => {
  it("lists only deliveries the capacity cannot serve in time", () => {
    const rows = [
      { bom: "B1", mo: "M1", item: "CF", dueISO: "2026-07-13", dueQty: 40 }, // > 27 today
      { bom: "B2", mo: "M2", item: "TC", dueISO: "2026-07-15", dueQty: 10 }, // fine
      { bom: "B3", mo: "M3", item: "TN", dueISO: "2026-07-12", dueQty: 9 }, // late, not "at-risk"
    ];
    const ins = atRiskInsight("Welding", "/worklist/welding", rows, "2026-07-13", 27);
    expect(ins?.title).toContain("1 Welding delivery is");
    expect(ins?.detail).toContain("B1");
    expect(ins?.detail).not.toContain("B3");
  });
});

describe("setBalanceInsight", () => {
  it("names the component starving complete sets", () => {
    const ins = setBalanceInsight("Painting", { CF: 100, TC: 95, TN: 40, CB: 105 });
    expect(ins?.title).toContain("TN");
  });

  it("stays silent when items are balanced", () => {
    expect(setBalanceInsight("Painting", { CF: 100, TC: 95, TN: 90, CB: 105 })).toBeNull();
  });
});

describe("sortInsights", () => {
  it("orders critical → warn → good → info", () => {
    const mk = (severity: "critical" | "warn" | "good" | "info") => ({
      id: severity, severity, icon: "", title: "", detail: "",
    });
    const sorted = sortInsights([mk("info"), mk("good"), mk("critical"), mk("warn")]);
    expect(sorted.map((i) => i.severity)).toEqual(["critical", "warn", "good", "info"]);
  });
});
