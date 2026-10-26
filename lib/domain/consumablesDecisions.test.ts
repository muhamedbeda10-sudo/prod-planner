import { describe, expect, it } from "vitest";
import {
  buildConsumablesDecisions, consumablesActions, filterParams, headcountText, itemKeyOf, limitBasisText, readDecisionFilters, ruleInScope, suggestCatalogueItem,
  NO_FILTERS, type DecisionCatalogueItem, type DecisionFilters, type DecisionInput, type DecisionIssue,
} from "./consumablesDecisions";
import { headcountResolver, headcountSource, issueUses, type LimitRule } from "./consumableLimits";

const catalogue: DecisionCatalogueItem[] = [
  { id: 1, code: "C-GLV", name: "Cotton Gloves", uom: "PAIR", active: true },
  { id: 2, code: "C-THN", name: "Thinner", uom: "L", active: true },
  { id: 3, code: "C-HLM", name: "Safety Helmet", uom: "PC", active: true },
];

let nextId = 1;
const issue = (over: Partial<DecisionIssue>): DecisionIssue => ({
  id: nextId++, dayISO: "2026-10-10", hour: 9, item: "Cotton Gloves", itemId: 1, qty: 1, department: "WeldingTX",
  recipient: { kind: "worker", name: "Sayed", empId: "1203" }, overLimit: false, overLimitReason: null, recordedBy: "store", ...over,
});
const rule = (over: Partial<LimitRule>): LimitRule => ({ id: 1, itemId: 1, departments: ["WeldingTX"], basis: "pool", period: "month", qty: 10, ...over });

/** The uses the limits count, from the same hand-outs (catalogue ones only), as the server loads them. */
function usesOf(issues: readonly DecisionIssue[]) {
  return issues.filter((i) => i.itemId !== null).flatMap((i) => issueUses({ itemId: i.itemId!, department: i.department, dayISO: i.dayISO, qty: i.qty, workerId: null, recipientIds: [] }));
}

function input(issues: DecisionIssue[], over: Partial<DecisionInput> = {}): DecisionInput {
  const headcount = new Map([["WeldingTX", 12], ["PaintingTX", 5]]);
  return {
    fromISO: "2026-10-01", toISO: "2026-10-26", todayISO: "2026-10-26",
    issues, previous: [], catalogue, rules: [], uses: usesOf(issues),
    headcountOf: () => headcount, headcountSourceOf: () => ({ kind: "live" }), seen: [...new Set(issues.map((i) => i.department))],
    ...over,
  };
}

describe("the filters in the address", () => {
  it("reads what it knows and drops the rest", () => {
    expect(readDecisionFilters({ dept: "WeldingTX", item: "c12", link: "linked", status: "over" })).toEqual({ department: "WeldingTX", item: "c12", link: "linked", status: "over" });
    expect(readDecisionFilters({ item: "12", link: "maybe", status: "bad" })).toEqual(NO_FILTERS);
    // a typed item is folded the way its key is
    expect(readDecisionFilters({ item: "t:Cotton  GLOVES" }).item).toBe(itemKeyOf(null, "cotton gloves"));
  });

  it("writes them back in the same words", () => {
    const f: DecisionFilters = { department: "Store", item: "t:rags", link: "unlinked", status: "none" };
    expect(readDecisionFilters(Object.fromEntries(filterParams(f)))).toEqual(f);
  });

  it("keeps the limits that fall in scope", () => {
    expect(ruleInScope(NO_FILTERS, 1, ["WeldingTX"])).toBe(true);
    expect(ruleInScope({ ...NO_FILTERS, department: "PaintingTX" }, 1, ["WeldingTX"])).toBe(false);
    expect(ruleInScope({ ...NO_FILTERS, department: "PaintingTX" }, 1, "*")).toBe(true);
    expect(ruleInScope({ ...NO_FILTERS, item: "c2" }, 1, "*")).toBe(false);
    // a typed item has no limit at all
    expect(ruleInScope({ ...NO_FILTERS, link: "unlinked" }, 1, "*")).toBe(false);
  });
});

describe("a hand-out counts once", () => {
  it("whether it went to one worker or to a whole department", () => {
    const d = buildConsumablesDecisions(input([
      issue({ qty: 24, recipient: { kind: "group", label: "Whole Welding TX (12)", count: 12 } }),
      issue({ qty: 2 }),
    ]), NO_FILTERS);
    expect(d.kpis.handOuts).toBe(2);
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0]).toMatchObject({ handOuts: 2, qty: 26 });
    expect(d.rows[0].issueIds).toHaveLength(2);
  });

  it("and the details add up to the cards and the trend", () => {
    const d = buildConsumablesDecisions(input([
      issue({ dayISO: "2026-10-02" }), issue({ dayISO: "2026-10-02", department: "PaintingTX" }), issue({ dayISO: "2026-10-20", itemId: null, item: "Rags" }),
    ]), NO_FILTERS);
    expect(d.rows.reduce((n, r) => n + r.handOuts, 0)).toBe(d.kpis.handOuts);
    expect(d.trend.buckets.reduce((n, b) => n + b.issues, 0)).toBe(d.kpis.handOuts);
    expect(d.kpis).toMatchObject({ handOuts: 3, items: 2, departments: 2, linked: 2 });
    expect(d.kpis.linkedShare).toBeCloseTo(2 / 3);
  });
});

describe("items never mix", () => {
  it("keeps a typed name apart from the catalogue item it reads like, and suggests it", () => {
    const d = buildConsumablesDecisions(input([issue({}), issue({ itemId: null, item: "cotton  gloves" })]), NO_FILTERS);
    expect(d.rows.map((r) => r.itemKey).sort()).toEqual(["c1", itemKeyOf(null, "cotton gloves")].sort());
    const typed = d.rows.find((r) => r.itemId === null)!;
    expect(typed.status).toBe("none");
    expect(typed.limit).toBeNull();
    expect(typed.uom).toBeNull();
    expect(typed.suggestion).toMatchObject({ id: 1, match: "same" });
    expect(d.quality).toMatchObject({ total: 2, unlinked: 1, typedItems: 1, suggested: 1 });
  });

  it("gives a quantity only for one item picked — never across units", () => {
    const issues = [issue({ qty: 4 }), issue({ itemId: 2, item: "Thinner", qty: 3 })];
    expect(buildConsumablesDecisions(input(issues), NO_FILTERS).kpis.quantity).toBeNull();
    expect(buildConsumablesDecisions(input(issues), { ...NO_FILTERS, item: "c2" }).kpis.quantity).toEqual({ qty: 3, uom: "L" });
    expect(buildConsumablesDecisions(input(issues), NO_FILTERS).units).toEqual(["L", "PAIR"]);
  });

  it("suggests by words only when most of them match", () => {
    expect(suggestCatalogueItem("Gloves cotton white", catalogue)).toMatchObject({ id: 1, match: "similar" });
    expect(suggestCatalogueItem("Grinding disc", catalogue)).toBeNull();
    expect(suggestCatalogueItem("C-THN", catalogue)).toMatchObject({ id: 2, match: "same" });
    // a retired item is not offered
    expect(suggestCatalogueItem("Thinner", catalogue.map((c) => ({ ...c, active: c.id !== 2 })))).toBeNull();
  });
});

describe("against the limits", () => {
  it("says no limit — not within — where none covers the department", () => {
    const d = buildConsumablesDecisions(input([issue({ department: "PaintingTX" })], { rules: [rule({})] }), NO_FILTERS);
    expect(d.rows[0].status).toBe("none");
    expect(d.kpis.uncovered).toEqual({ handOuts: 1, items: 1 });
  });

  it("counts a monthly limit in the month of the period's end, up to that day", () => {
    const issues = [issue({ dayISO: "2026-09-30", qty: 50 }), issue({ dayISO: "2026-10-05", qty: 6 }), issue({ dayISO: "2026-10-20", qty: 5 })];
    // the period ends on the 10th: the 20th is not counted yet
    const d = buildConsumablesDecisions(input(issues, { fromISO: "2026-09-25", toISO: "2026-10-10", rules: [rule({})] }), NO_FILTERS);
    expect(d.rows[0].limit).toMatchObject({ windowLabel: "Oct 2026", used: 6, limit: 10, left: 4, status: "within", toDate: true });
    expect(d.endsToday).toBe(false);
  });

  it("counts a limit of several months over its window so far, and marks it over", () => {
    const july = issue({ dayISO: "2026-07-15", qty: 1 });
    const sept = issue({ dayISO: "2026-09-02", qty: 1 });
    // the July hand-out is outside the period but inside the quarter
    const d = buildConsumablesDecisions(input([sept], { fromISO: "2026-09-01", toISO: "2026-09-30", uses: usesOf([july, sept]), rules: [rule({ period: "quarter", qty: 1 })] }), NO_FILTERS);
    expect(d.rows[0].handOuts).toBe(1);
    expect(d.rows[0].limit).toMatchObject({ windowLabel: "Q3 2026", used: 2, limit: 1, status: "over", toDate: false });
    expect(d.quality.pastWindows).toBe(true);
  });

  it("times a per-worker limit by the headcount of the window's month, and says whose", () => {
    const rows = [{ month: "2026-09", department: "WeldingTX", workers: 4 }];
    const live = new Map([["WeldingTX", 12]]);
    const issues = [issue({ dayISO: "2026-09-10", qty: 7 })];
    const d = buildConsumablesDecisions(input(issues, {
      fromISO: "2026-09-01", toISO: "2026-09-30", rules: [rule({ basis: "person", qty: 2 })],
      headcountOf: headcountResolver(rows, live, "2026-10"),
      headcountSourceOf: (m) => headcountSource(rows.map((r) => r.month), m, "2026-10"),
    }), NO_FILTERS);
    expect(d.rows[0].limit).toMatchObject({ limit: 8, used: 7, status: "near", perWorker: { qty: 2, workers: 4 }, headcount: { kind: "recorded", month: "2026-09" } });
    expect(limitBasisText(d.rows[0].limit!, "PAIR")).toBe("2 PAIR per worker × 4 workers");
    // the strip names the headcount the figures were counted with
    expect(d.quality.headcount).toEqual([{ kind: "recorded", month: "2026-09" }]);
  });

  it("counts a shared limit with every department it covers", () => {
    const issues = [issue({ qty: 6 }), issue({ department: "WeldingLV", qty: 5 })];
    const d = buildConsumablesDecisions(input(issues, { rules: [rule({ departments: ["WeldingTX", "WeldingLV"] })] }), NO_FILTERS);
    expect(d.rows.every((r) => r.limit?.used === 11 && r.limit.shared && r.status === "over")).toBe(true);
  });

  it("reads a limit of nothing with something used as the fullest of all", () => {
    const d = buildConsumablesDecisions(input([issue({ qty: 1 }), issue({ itemId: 2, item: "Thinner", qty: 50 })], { rules: [rule({ qty: 0 }), rule({ id: 2, itemId: 2, qty: 10 })] }), NO_FILTERS);
    expect(d.rows.map((r) => r.itemKey)).toEqual(["c1", "c2"]);
    expect(d.rows[0].status).toBe("over");
  });

  it("weighs every limit that covers the row, the worst first", () => {
    const d = buildConsumablesDecisions(input([issue({ qty: 6 })], { rules: [rule({ id: 1, qty: 100 }), rule({ id: 2, departments: "*", qty: 5 })] }), NO_FILTERS);
    expect(d.rows[0].limits.map((l) => l.sourceId)).toEqual([2, 1]);
    expect(d.rows[0].status).toBe("over");
  });

  it("keeps the flag set when it was saved apart from the standing", () => {
    const d = buildConsumablesDecisions(input([
      issue({ qty: 12, overLimit: true, overLimitReason: "new crew" }), issue({ qty: 1 }),
    ], { rules: [rule({ qty: 100 })] }), NO_FILTERS);
    // flagged at the time, within the limit as it is set now
    expect(d.rows[0]).toMatchObject({ recordedOver: 1, lastReason: "new crew", status: "within" });
    expect(d.recordedOverCount).toBe(1);
  });

  it("filters the rows by their standing", () => {
    const issues = [issue({ qty: 20 }), issue({ itemId: 2, item: "Thinner" })];
    const d = buildConsumablesDecisions(input(issues, { rules: [rule({})] }), { ...NO_FILTERS, status: "over" });
    expect(d.rows.map((r) => r.itemKey)).toEqual(["c1"]);
    expect(d.kpis.handOuts).toBe(1);
  });
});

describe("the comparison", () => {
  const prev = [{ itemId: 1, item: "Cotton Gloves", department: "WeldingTX", dayISO: "2026-09-10", hour: 9 }];

  it("is the period before under the same filters", () => {
    const d = buildConsumablesDecisions(input([issue({}), issue({})], { previous: prev }), NO_FILTERS);
    expect(d.kpis).toMatchObject({ previousHandOuts: 1, change: 100, noComparison: null });
    expect(buildConsumablesDecisions(input([issue({})], { previous: prev }), { ...NO_FILTERS, department: "PaintingTX" }).kpis.change).toBeNull();
  });

  it("is not shown when the log does not cover the period before, nor under a limit status", () => {
    expect(buildConsumablesDecisions(input([issue({})], { previous: null }), NO_FILTERS).kpis).toMatchObject({ previousHandOuts: null, change: null });
    expect(buildConsumablesDecisions(input([issue({})], { previous: prev }), { ...NO_FILTERS, status: "within" }).kpis.previousHandOuts).toBeNull();
    expect(buildConsumablesDecisions(input([issue({})], { previous: null }), NO_FILTERS).trend.buckets.every((b) => b.prev === null)).toBe(true);
  });

  it("reads N/A over a period before with nothing in it", () => {
    const d = buildConsumablesDecisions(input([issue({})], { previous: [] }), NO_FILTERS);
    expect(d.kpis).toMatchObject({ previousHandOuts: 0, change: null });
    expect(d.kpis.noComparison).toMatch(/Nothing was handed out/);
  });

  it("goes by hours for one day, and by weeks for a long period", () => {
    const one = buildConsumablesDecisions(input([issue({ dayISO: "2026-10-26", hour: 20 })], { fromISO: "2026-10-26" }), NO_FILTERS);
    expect(one.trend.unit).toBe("hour");
    expect(one.trend.buckets.at(-1)!.label).toBe("20:00");
    const long = buildConsumablesDecisions(input([issue({ dayISO: "2026-08-01" })], { fromISO: "2026-07-01" }), NO_FILTERS);
    expect(long.trend.unit).toBe("week");
    expect(long.trend.buckets.reduce((n, b) => n + b.issues, 0)).toBe(1);
  });
});

describe("whose headcount", () => {
  it("names the month a per-worker limit was counted with", () => {
    const months = ["2026-07", "2026-09"];
    expect(headcountSource(months, "2026-10", "2026-10")).toEqual({ kind: "live" });
    expect(headcountSource(months, "2026-09", "2026-10")).toEqual({ kind: "recorded", month: "2026-09" });
    expect(headcountSource(months, "2026-08", "2026-10")).toEqual({ kind: "carried", month: "2026-07" });
    expect(headcountSource(months, "2026-06", "2026-10")).toEqual({ kind: "fallback" });
    expect(headcountText({ kind: "recorded", month: "2026-09" })).toBe("the headcount recorded for 2026-09");
  });
});

describe("what needs a decision", () => {
  const href = (set: Record<string, string | null>, hash = "") => `?${new URLSearchParams(Object.entries(set).filter((e): e is [string, string] => e[1] !== null))}${hash ? `#${hash}` : ""}`;
  const noPowder = { scope: "painting" as const, kg: 0, weighings: 0, sections: [] };
  const alarm = { item: "Cotton Gloves", departmentsLabel: "Welding TX", windowLabel: "Oct 2026", used: 12, limit: 10, uom: "PAIR" };

  it("puts the limits over now first, then what no limit counts — and says what needs no one apart", () => {
    const d = buildConsumablesDecisions(input([issue({}), issue({ itemId: null, item: "cotton gloves" }), issue({ department: "PaintingTX" })], { rules: [rule({})] }), NO_FILTERS);
    const { actions, notes } = consumablesActions(d, { overNow: [alarm], closedOver: [], closedSpan: "Jul 26 – Sep 26" }, noPowder, "this month", href);
    expect(actions.map((a) => a.tone)).toEqual(["bad", "warn", "warn"]);
    expect(actions[0].text).toMatch(/^Now: Cotton Gloves · Welding TX — 12 of 10 PAIR \(Oct 2026\), 2 over$/);
    expect(actions[1]).toMatchObject({ href: "?link=unlinked#detail" });
    expect(actions[1].text).toMatch(/1 with a catalogue item suggested to review/);
    expect(actions[2]).toMatchObject({ href: "?link=linked&status=none#detail" });
    // no flag is not proof, and no scrap is not 0% waste
    expect(notes).toEqual(expect.arrayContaining([expect.stringMatching(/does not show the limits were kept/), "No powder scrap recorded this month.", expect.stringMatching(/No finished window/)]));
  });

  it("names the rows over at a past period's end, and the scrap as weighed", () => {
    const d = buildConsumablesDecisions(input([issue({ qty: 20, overLimit: true, overLimitReason: "audit" })], { toISO: "2026-10-20", rules: [rule({})] }), NO_FILTERS);
    const { actions, notes } = consumablesActions(d, null, { scope: "painting", kg: 2.5, weighings: 1, sections: [{ label: "Transformer Painting", kg: 2.5 }] }, "this month", href);
    expect(actions[0]).toMatchObject({ tone: "bad", text: expect.stringContaining("could not load") });
    expect(actions.some((a) => a.href === "?status=over#detail")).toBe(true);
    expect(actions.at(-1)!.text).toContain("“audit”");
    expect(notes[0]).toContain("2.5 kg recorded");
    expect(notes[0]).toContain("not a waste rate");
  });
});
