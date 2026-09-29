import { describe, expect, it } from "vitest";
import {
  ALL_DEPARTMENTS, FABRICATION_SECTIONS, FAB_AND_WELD_SECTIONS, checkAgainstLimits, departmentsLabel, describeBreach, expandPerWorker,
  exceedances, isLimitPeriod, issueUses, parseDepartments, periodWindow, serializeDepartments, splitSheetLimit, standings, windowLabel, windowsOverlapping,
  windowsSpan, type LimitCandidate, type LimitRule, type LimitUse,
} from "./consumableLimits";

const rule = (over: Partial<LimitRule>): LimitRule => ({ id: 1, itemId: 10, departments: ["WeldingTX"], basis: "pool", period: "month", qty: 15, ...over });
const use = (over: Partial<LimitUse>): LimitUse => ({ itemId: 10, department: "WeldingTX", workerId: 1, dayISO: "2026-09-28", qty: 1, ...over });
const cand = ({ workerIds, ...over }: Partial<LimitUse> & { workerIds?: number[] }): LimitCandidate => {
  const { workerId, ...rest } = { itemId: 10, department: "WeldingTX", workerId: 1, dayISO: "2026-09-28", qty: 1, ...over };
  return { ...rest, workerIds: workerIds ?? [workerId] };
};

describe("fixed windows", () => {
  it("has nothing shorter than a month", () => {
    expect(isLimitPeriod("week")).toBe(false);
    expect(isLimitPeriod("day")).toBe(false);
  });

  it("takes the calendar month, and runs of months from January", () => {
    expect(periodWindow("month", "2026-02-14")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(periodWindow("month", "2026-12-31")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(periodWindow("quarter", "2026-09-28")).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(periodWindow("quarter", "2026-01-01")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
  });

  it("labels and lists the windows over a range", () => {
    expect(windowLabel("month", { from: "2026-09-01", to: "2026-09-30" })).toBe("Sep 2026");
    expect(windowLabel("quarter", { from: "2026-07-01", to: "2026-09-30" })).toBe("Q3 2026");
    expect(windowsOverlapping("month", "2026-08-20", "2026-10-05").map((w) => w.from)).toEqual(["2026-08-01", "2026-09-01", "2026-10-01"]);
    expect(windowsSpan([{ period: "month" }, { period: "quarter" }], "2026-09-28")).toEqual({ from: "2026-07-01", to: "2026-09-30" });
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
    const uses = [use({ qty: 10, dayISO: "2026-09-02" }), use({ qty: 4, dayISO: "2026-08-31" })]; // the second is last month
    expect(checkAgainstLimits(rules, uses, cand({ qty: 5 }))).toEqual([]);
    const b = checkAgainstLimits(rules, uses, cand({ qty: 6 }));
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ used: 10, adding: 6, limit: 15, windowLabel: "Sep 2026" });
    expect(describeBreach(b[0])).toBe("Welding TX · a month (Sep 2026): 10 already + 6 now = 16 of 15");
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
    expect(describeBreach(b[0])).toBe("Welding TX, per person × 10 workers · a month (Sep 2026): 0 already + 21 now = 21 of 20");
    // what the group's workers already had this week counts; other workers' does not
    const uses = [use({ workerId: 1, qty: 2 }), use({ workerId: 99, qty: 50 })];
    expect(checkAgainstLimits(rules, uses, cand({ qty: 18, workerIds: ten }))).toEqual([]);
    expect(checkAgainstLimits(rules, uses, cand({ qty: 19, workerIds: ten }))).toHaveLength(1);
  });

  it("weighs a group hand-out whole against a shared limit", () => {
    const rules = [rule({ qty: 15 })];
    expect(checkAgainstLimits(rules, [use({ qty: 10 })], cand({ qty: 6, workerIds: [1, 2, 3] }))).toHaveLength(1);
  });

  it("counts a week's draw whole — a week's stock taken in one go is within a weekly limit", () => {
    // the store draws the week at once: 90 on Monday against 90 a week is fine, the next one is over
    const rules = [rule({ qty: 90 })];
    expect(checkAgainstLimits(rules, [], cand({ qty: 90, dayISO: "2026-09-28" }))).toEqual([]);
    expect(checkAgainstLimits(rules, [use({ qty: 90, dayISO: "2026-09-28" })], cand({ qty: 1, dayISO: "2026-09-29" }))).toHaveLength(1);
    // a new week starts again on Saturday
    expect(checkAgainstLimits(rules, [use({ qty: 90, dayISO: "2026-09-28" })], cand({ qty: 90, dayISO: "2026-10-03" }))).toEqual([]);
  });

  it("has no daily period any more", () => {
    expect(isLimitPeriod("day")).toBe(false);
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
    const uses = [use({ qty: 16, dayISO: "2026-07-14" }), use({ qty: 5, dayISO: "2026-08-21" }), use({ qty: 20, dayISO: "2026-09-28" })];
    const ex = exceedances(rules, uses, "2026-07-01", "2026-09-30");
    expect(ex.map((e) => [e.windowLabel, e.used])).toEqual([["Sep 2026", 20], ["Jul 2026", 16]]);
  });

  it("lists per-person exceedances per worker", () => {
    const rules = [rule({ basis: "person", qty: 2 })];
    const ex = exceedances(rules, [use({ workerId: 3, qty: 3 }), use({ workerId: 4, qty: 2 })], "2026-09-26", "2026-10-02");
    expect(ex).toEqual([expect.objectContaining({ workerId: 3, used: 3, limit: 2 })]);
  });
});

describe("per-worker and each-department limits become each department's own", () => {
  const rule = (over: Partial<LimitRule>): LimitRule => ({ id: 7, itemId: 3, departments: ["WeldingTX", "PaintingTX"], basis: "person", period: "month", qty: 2, ...over });
  const workers = new Map([["WeldingTX", 12], ["PaintingTX", 5]]);

  it("turns a per-worker number into the department's: the number × its workers", () => {
    const out = expandPerWorker([rule({})], workers);
    expect(out.map((r) => [r.departments, r.basis, r.qty, r.sourceId, r.perWorker])).toEqual([
      [["WeldingTX"], "pool", 24, 7, { qty: 2, workers: 12 }],
      [["PaintingTX"], "pool", 10, 7, { qty: 2, workers: 5 }],
    ]);
    expect(out[0].label).toBe("Welding TX (2 per worker × 12 workers)");
    expect(new Set(out.map((r) => r.id)).size).toBe(2);
    expect(out.every((r) => r.id < 0)).toBe(true);
  });

  it("counts a department with no one on the list as one worker, and says so", () => {
    const [m] = expandPerWorker([rule({ departments: ["Maintenance"] })], workers);
    expect(m.qty).toBe(2);
    expect(m.label).toMatch(/no one on the workers list/);
  });

  it("gives every department picked the whole number for 'each'", () => {
    const out = expandPerWorker([rule({ basis: "each", qty: 15 })], workers);
    expect(out.map((r) => [r.departments, r.qty, r.basis])).toEqual([[["WeldingTX"], 15, "pool"], [["PaintingTX"], 15, "pool"]]);
  });

  it("covers the staffed sections and the typed departments seen for 'every department'", () => {
    const out = expandPerWorker([rule({ departments: ALL_DEPARTMENTS })], workers, ["Store"]);
    expect(out.map((r) => r.departments[0])).toEqual(["WeldingTX", "PaintingTX", "Store"]);
  });

  it("leaves a shared number as it is, and a breach reads in the department's words", () => {
    const pool = rule({ basis: "pool" });
    expect(expandPerWorker([pool], workers)).toEqual([pool]);
    const [w] = expandPerWorker([rule({})], workers);
    const uses = [{ itemId: 3, department: "WeldingTX", workerId: 0, dayISO: "2026-09-28", qty: 20 }];
    const b = checkAgainstLimits([w], uses, { itemId: 3, department: "WeldingTX", dayISO: "2026-09-29", qty: 5, workerIds: [] });
    expect(b).toHaveLength(1);
    expect(describeBreach(b[0])).toMatch(/^Welding TX \(2 per worker × 12 workers\) · a month \(Sep 2026\): 20 already \+ 5 now = 25 of 24/);
  });
});

describe("periods of several months", () => {
  it("runs from January in steps of the period", () => {
    expect(periodWindow("bimonth", "2026-09-28")).toEqual({ from: "2026-09-01", to: "2026-10-31" });
    expect(periodWindow("fourmonth", "2026-09-28")).toEqual({ from: "2026-09-01", to: "2026-12-31" });
    expect(periodWindow("halfyear", "2026-09-28")).toEqual({ from: "2026-07-01", to: "2026-12-31" });
    expect(periodWindow("year", "2026-09-28")).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(periodWindow("quarter", "2026-09-28")).toEqual({ from: "2026-07-01", to: "2026-09-30" });
  });
  it("names the window", () => {
    expect(windowLabel("halfyear", periodWindow("halfyear", "2026-09-28"))).toBe("Jul–Dec 2026");
    expect(windowLabel("year", periodWindow("year", "2026-09-28"))).toBe("2026");
    expect(windowLabel("quarter", periodWindow("quarter", "2026-09-28"))).toBe("Q3 2026");
  });
});
