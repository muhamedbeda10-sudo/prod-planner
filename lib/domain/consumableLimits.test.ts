import { describe, expect, it } from "vitest";
import {
  ALL_DEPARTMENTS, FABRICATION_SECTIONS, FAB_AND_WELD_SECTIONS, checkAgainstLimits, departmentsLabel, describeBreach,
  exceedances, issueUses, parseDepartments, periodWindow, serializeDepartments, splitSheetLimit, standings, windowLabel, windowsOverlapping,
  windowsSpan, type LimitCandidate, type LimitRule, type LimitUse,
} from "./consumableLimits";

const rule = (over: Partial<LimitRule>): LimitRule => ({ id: 1, itemId: 10, departments: ["WeldingTX"], basis: "pool", period: "week", qty: 15, ...over });
const use = (over: Partial<LimitUse>): LimitUse => ({ itemId: 10, department: "WeldingTX", workerId: 1, dayISO: "2026-09-28", qty: 1, ...over });
const cand = (over: Partial<LimitUse> & { workerIds?: number[] }): LimitCandidate => {
  const u = use(over);
  return { itemId: u.itemId, department: u.department, dayISO: u.dayISO, qty: u.qty, workerIds: over.workerIds ?? [u.workerId] };
};

describe("fixed windows", () => {
  it("runs the work week Saturday to Friday", () => {
    // 2026-09-26 is a Saturday, 2026-10-02 a Friday
    expect(periodWindow("week", "2026-09-26")).toEqual({ from: "2026-09-26", to: "2026-10-02" });
    expect(periodWindow("week", "2026-09-28")).toEqual({ from: "2026-09-26", to: "2026-10-02" });
    expect(periodWindow("week", "2026-10-02")).toEqual({ from: "2026-09-26", to: "2026-10-02" });
    expect(periodWindow("week", "2026-10-03")).toEqual({ from: "2026-10-03", to: "2026-10-09" });
  });

  it("takes the calendar month and quarter, and the day itself", () => {
    expect(periodWindow("month", "2026-02-14")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(periodWindow("month", "2026-12-31")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(periodWindow("quarter", "2026-09-28")).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(periodWindow("quarter", "2026-01-01")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(periodWindow("day", "2026-09-28")).toEqual({ from: "2026-09-28", to: "2026-09-28" });
  });

  it("labels and lists the windows over a range", () => {
    expect(windowLabel("week", { from: "2026-09-26", to: "2026-10-02" })).toBe("week of 26 Sep");
    expect(windowLabel("quarter", { from: "2026-07-01", to: "2026-09-30" })).toBe("Q3 2026");
    expect(windowsOverlapping("month", "2026-08-20", "2026-10-05").map((w) => w.from)).toEqual(["2026-08-01", "2026-09-01", "2026-10-01"]);
    expect(windowsSpan([{ period: "day" }, { period: "week" }], "2026-09-28")).toEqual({ from: "2026-09-26", to: "2026-10-02" });
    expect(windowsSpan([], "2026-09-28")).toBeNull();
  });
});

describe("departments", () => {
  it("stores them in a stable order, and '*' for all", () => {
    expect(serializeDepartments(["PaintingLV", "Maintenance", "WeldingTX", "WeldingTX"])).toBe("WeldingTX,PaintingLV,Maintenance");
    expect(serializeDepartments(ALL_DEPARTMENTS)).toBe("*");
    expect(serializeDepartments(["WeldingTX", "*"])).toBe("*");
    expect(parseDepartments("WeldingTX,PaintingLV")).toEqual(["WeldingTX", "PaintingLV"]);
    expect(parseDepartments("*")).toBe(ALL_DEPARTMENTS);
  });

  it("names the sheet's groups", () => {
    expect(departmentsLabel(ALL_DEPARTMENTS)).toBe("All departments");
    expect(departmentsLabel(FABRICATION_SECTIONS)).toBe("All fabrication");
    expect(departmentsLabel(FAB_AND_WELD_SECTIONS)).toBe("All fabrication and welding");
    expect(departmentsLabel(["WeldingTX", "WeldingLV"])).toBe("Welding TX + Welding USS/LV");
    expect(FABRICATION_SECTIONS).toContain("Channels");
    expect(FABRICATION_SECTIONS).not.toContain("WeldingTX");
  });
});

describe("the sheet's split", () => {
  it("splits a number between the departments it names", () => {
    expect(splitSheetLimit(30, ["WeldingLV", "WeldingTX"])).toEqual([{ departments: ["WeldingLV"], qty: 15 }, { departments: ["WeldingTX"], qty: 15 }]);
    expect(splitSheetLimit(200, ["WeldingLV", "WeldingTX", "PaintingTX", "PaintingLV"]).map((r) => r.qty)).toEqual([50, 50, 50, 50]);
    expect(splitSheetLimit(5, ["WeldingLV", "WeldingTX"]).map((r) => r.qty)).toEqual([3, 2]);
  });

  it("keeps a number smaller than the departments as one pool", () => {
    expect(splitSheetLimit(1, ["WeldingLV", "WeldingTX"])).toEqual([{ departments: ["WeldingLV", "WeldingTX"], qty: 1 }]);
  });

  it("keeps groups, 'all' and per-person numbers whole", () => {
    expect(splitSheetLimit(80, ALL_DEPARTMENTS)).toEqual([{ departments: ALL_DEPARTMENTS, qty: 80 }]);
    expect(splitSheetLimit(30, FABRICATION_SECTIONS, { group: true })).toHaveLength(1);
    expect(splitSheetLimit(2, FAB_AND_WELD_SECTIONS, { basis: "person" })).toHaveLength(1);
  });
});

describe("a group hand-out's uses", () => {
  const issue = { itemId: 10, department: "WeldingTX", dayISO: "2026-09-28", qty: 20 };
  it("counts whole against one worker, and in equal shares across a group", () => {
    expect(issueUses({ ...issue, workerId: 7, recipientIds: [] })).toEqual([{ ...issue, workerId: 7 }]);
    const shares = issueUses({ ...issue, qty: 20, workerId: null, recipientIds: [1, 2, 3, 4, 4] });
    expect(shares.map((u) => [u.workerId, u.qty])).toEqual([[1, 5], [2, 5], [3, 5], [4, 5]]);
  });

  it("keeps a group with no workers kept on the shared limits, under no worker", () => {
    expect(issueUses({ ...issue, workerId: null, recipientIds: [] })).toEqual([{ ...issue, workerId: 0 }]);
  });

  it("gives each worker of a group his share on a per-person standing", () => {
    const rules = [rule({ basis: "person", qty: 2 })];
    const uses = issueUses({ ...issue, qty: 30, workerId: null, recipientIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
    const s = standings(rules, uses, "2026-09-28")[0];
    expect(s).toMatchObject({ used: 3 });
    expect(s.over).toHaveLength(10);
  });
});

describe("checking a hand-out", () => {
  it("passes while the window has room, and names the breach once it would not", () => {
    const rules = [rule({})];
    const uses = [use({ qty: 10, dayISO: "2026-09-26" }), use({ qty: 4, dayISO: "2026-09-19" })]; // the second is last week
    expect(checkAgainstLimits(rules, uses, cand({ qty: 5 }))).toEqual([]);
    const b = checkAgainstLimits(rules, uses, cand({ qty: 6 }));
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ used: 10, adding: 6, limit: 15, windowLabel: "week of 26 Sep" });
    expect(describeBreach(b[0])).toBe("Welding TX · a week (week of 26 Sep): 10 already + 6 now = 16 of 15");
  });

  it("only counts the departments a rule covers, and ignores other items", () => {
    const rules = [rule({})];
    const uses = [use({ qty: 14, department: "WeldingLV" }), use({ qty: 14, itemId: 11 })];
    expect(checkAgainstLimits(rules, uses, cand({ qty: 15 }))).toEqual([]);
    expect(checkAgainstLimits(rules, uses, cand({ qty: 99, department: "PaintingTX" }))).toEqual([]); // no rule for that department
  });

  it("counts a pool across all its departments, and 'all' across every department", () => {
    const shared = [rule({ departments: ["WeldingLV", "WeldingTX"], qty: 1, period: "month" })];
    expect(checkAgainstLimits(shared, [use({ department: "WeldingLV", dayISO: "2026-09-02" })], cand({}))).toHaveLength(1);
    const all = [rule({ departments: ALL_DEPARTMENTS, qty: 10 })];
    expect(checkAgainstLimits(all, [use({ department: "Maintenance", qty: 9 })], cand({ department: "Store", qty: 2 }))).toHaveLength(1);
  });

  it("gives each worker his own number on a per-person rule", () => {
    const rules = [rule({ basis: "person", qty: 2, departments: FAB_AND_WELD_SECTIONS })];
    const uses = [use({ workerId: 1, qty: 2 }), use({ workerId: 2, qty: 1 })];
    expect(checkAgainstLimits(rules, uses, cand({ workerId: 2, qty: 1 }))).toEqual([]);
    expect(checkAgainstLimits(rules, uses, cand({ workerId: 1, qty: 1 }))).toHaveLength(1);
  });

  it("multiplies a per-person number by the workers of a group hand-out", () => {
    // 2 a week each: 20 for a department of ten is within, 21 is not
    const rules = [rule({ basis: "person", qty: 2 })];
    const ten = Array.from({ length: 10 }, (_, i) => i + 1);
    expect(checkAgainstLimits(rules, [], cand({ qty: 20, workerIds: ten }))).toEqual([]);
    const b = checkAgainstLimits(rules, [], cand({ qty: 21, workerIds: ten }));
    expect(b[0]).toMatchObject({ used: 0, adding: 21, limit: 20, people: 10 });
    expect(describeBreach(b[0])).toBe("Welding TX, per person × 10 workers · a week (week of 26 Sep): 0 already + 21 now = 21 of 20");
    // what the group's workers already had this week counts; other workers' does not
    const uses = [use({ workerId: 1, qty: 2 }), use({ workerId: 99, qty: 50 })];
    expect(checkAgainstLimits(rules, uses, cand({ qty: 18, workerIds: ten }))).toEqual([]);
    expect(checkAgainstLimits(rules, uses, cand({ qty: 19, workerIds: ten }))).toHaveLength(1);
  });

  it("weighs a group hand-out whole against a shared limit", () => {
    const rules = [rule({ qty: 15 })];
    expect(checkAgainstLimits(rules, [use({ qty: 10 })], cand({ qty: 6, workerIds: [1, 2, 3] }))).toHaveLength(1);
  });

  it("counts a daily limit per day", () => {
    const rules = [rule({ period: "day", qty: 30 })];
    const uses = [use({ qty: 30, dayISO: "2026-09-27" })];
    expect(checkAgainstLimits(rules, uses, cand({ qty: 30, dayISO: "2026-09-28" }))).toEqual([]);
    expect(checkAgainstLimits(rules, [...uses, use({ qty: 1 })], cand({ qty: 30 }))).toHaveLength(1);
  });
});

describe("the alarm board", () => {
  it("stands every rule in its current window", () => {
    const rules = [rule({ id: 1 }), rule({ id: 2, basis: "person", qty: 2, departments: ALL_DEPARTMENTS })];
    const uses = [use({ qty: 12 }), use({ qty: 3, workerId: 7 }), use({ qty: 1, workerId: 8 })];
    const s = standings(rules, uses, "2026-09-28");
    expect(s[0]).toMatchObject({ ruleId: 1, used: 16, limit: 15 });
    expect(s[0].ratio).toBeCloseTo(16 / 15);
    expect(s[1]).toMatchObject({ used: 12, topWorkerId: 1, over: [{ workerId: 1, used: 12 }, { workerId: 7, used: 3 }] });
  });

  it("lists every window of the range that ended over", () => {
    const rules = [rule({})];
    const uses = [use({ qty: 16, dayISO: "2026-09-14" }), use({ qty: 5, dayISO: "2026-09-21" }), use({ qty: 20, dayISO: "2026-09-28" })];
    const ex = exceedances(rules, uses, "2026-09-01", "2026-09-30");
    expect(ex.map((e) => [e.windowLabel, e.used])).toEqual([["week of 26 Sep", 20], ["week of 12 Sep", 16]]);
  });

  it("lists per-person exceedances per worker", () => {
    const rules = [rule({ basis: "person", qty: 2 })];
    const ex = exceedances(rules, [use({ workerId: 3, qty: 3 }), use({ workerId: 4, qty: 2 })], "2026-09-26", "2026-10-02");
    expect(ex).toEqual([expect.objectContaining({ workerId: 3, used: 3, limit: 2 })]);
  });
});
