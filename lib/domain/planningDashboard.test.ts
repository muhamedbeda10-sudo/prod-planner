import { describe, it, expect } from "vitest";
import { loadAhead, manpowerPlan, planAdherence } from "./kpis";
import { lvMonthProgress } from "./lvKpis";
import {
  NO_FILTERS, capacityShortH, centreLoadRows, isPartial, pageLineOf, plantTotals, dueByTodayRows, hoursLeftRows, lineDueHours, lvAtRisk, lvMonthRows, lvView, planningFiltersOf, planningUrl,
  relativeChange, stageByDay, trAtRisk, trLinesOf, trView, type LvOrderLine, type PlanLine, type PlanningFilters, type TrViewInput,
} from "./planningDashboard";
import type { WorkCentre } from "./shifts";

const TODAY = "2026-10-26";
const LEADS = { cut: 4, weld: 1 };
const PER: Record<WorkCentre, number> = { Cutting: 1, Bending: 0.5, Fins: 0, Welding: 2, ShotBlast: 0.25, Painting: 0.75 };

/** A plan line with its hours left worked out the loader's way (lineDueHours). */
function line(o: Partial<PlanLine> & Pick<PlanLine, "dayISO" | "bom" | "item" | "owed">, priced = true): PlanLine {
  const done = o.done ?? { cut: 0, weld: 0, finish: 0 };
  const leftH: PlanLine["leftH"] = priced ? {} : null;
  if (leftH) for (const d of lineDueHours({ ...o, done }, PER, LEADS)) leftH[d.centre] = (leftH[d.centre] ?? 0) + d.dueH;
  return { soi: null, mos: [`MO-${o.bom}`], osp: 0, na: 0, held: false, ...o, done, leftH };
}

// a multi-component order (CF and TC of one MO), an outsourced cut, an order on hold, an unpriced line
const LINES: PlanLine[] = [
  line({ dayISO: "2026-10-24", bom: "B1", item: "CF", owed: 4, done: { cut: 4, weld: 2, finish: 1 }, mos: ["MO-1"], soi: "S-1" }),
  line({ dayISO: "2026-10-24", bom: "B1", item: "TC", owed: 4, done: { cut: 4, weld: 4, finish: 4 }, mos: ["MO-1"], soi: "S-1" }),
  line({ dayISO: "2026-10-29", bom: "B2", item: "TN", owed: 6, done: { cut: 6, weld: 0, finish: 0 }, osp: 6, mos: ["MO-2"] }),
  line({ dayISO: "2026-10-28", bom: "B3", item: "CB", owed: 5, held: true, mos: ["MO-3"] }),
  line({ dayISO: "2026-11-03", bom: "B4", item: "CF", owed: 2, mos: ["MO-4"] }, false),
];

const DAYS = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-31"];
const LOAD = [
  // welding is short from the 27th and never catches up
  loadAhead("Welding", DAYS, [{ dayISO: "2026-10-26", dueH: 4 }, { dayISO: "2026-10-28", dueH: 12 }], 3),
  loadAhead("Cutting", DAYS, [{ dayISO: "2026-10-26", dueH: 2 }], 8),
  loadAhead("Fins", DAYS, [], null),
];

const input = (o: Partial<TrViewInput> = {}): TrViewInput => ({
  todayISO: TODAY, lastDayISO: "2026-10-25", leads: LEADS,
  week: { planNo: 42, newest: true, lines: LINES },
  load: LOAD,
  manpower: {
    rows: manpowerPlan([
      { centre: "Welding", requiredH: 400, doneH: 100, present: 2 },
      { centre: "Cutting", requiredH: 100, doneH: 90, present: 3 },
    ], { monthWd: 26, leftWd: 6, hoursPerPersonDay: 8 }),
    leftWd: 6,
  },
  coverage: { days: 2 },
  horizonDays: 10,
  ...o,
});
const F = (o: Partial<PlanningFilters> = {}): PlanningFilters => ({ ...NO_FILTERS, ...o });

describe("the Planning dashboard's address", () => {
  it("reads what it knows and leaves the rest out", () => {
    const f = planningFiltersOf({ scope: "LV", plan: "12", item: "cf", centre: "Welding", q: " B1 ", family: "mb", lvDept: "Bending", from: "2026-10-01", to: "nope", detail: "tr-load:Welding" });
    expect(f).toMatchObject({ scope: "lv", plan: 12, item: "CF", centre: "Welding", q: "B1", family: "MB", lvDept: "Bending", from: "2026-10-01", to: null, detail: "tr-load:Welding" });
    expect(planningFiltersOf({ scope: "x", plan: "-3", item: "ZZ", centre: "Moon", family: "x", from: "2026-02-30", detail: "tr-load:Moon" })).toEqual(NO_FILTERS);
  });

  it("writes the filters back, the panels' own family as panels, so a link opens the same view", () => {
    const f = F({ scope: "tr", plan: 7, centre: "Painting", family: "" });
    expect(planningUrl(f)).toBe("/?scope=tr&plan=7&centre=Painting&family=panels");
    expect(planningFiltersOf(Object.fromEntries(new URLSearchParams(planningUrl(f).slice(2))))).toEqual(f);
    expect(planningUrl(NO_FILTERS)).toBe("/");
    expect(planningUrl(f, { detail: "tr-hours", plan: null })).toBe("/?scope=tr&centre=Painting&family=panels&detail=tr-hours");
  });
});

describe("the line a page shows", () => {
  it("is Planning's own scope, both on a plant dashboard, and none elsewhere", () => {
    expect(pageLineOf({ path: "/", filters: { scope: "lv" } })).toBe("LV");
    expect(pageLineOf({ path: "/", filters: {} })).toBe("both");
    expect(pageLineOf({ path: "/dashboards/production", filters: { scope: "TR" } })).toBe("TR");
    expect(pageLineOf({ path: "/dashboards/production", filters: {} })).toBe("both");
    expect(pageLineOf({ path: "/tracker", filters: {} })).toBeNull();
    expect(pageLineOf(null)).toBeNull();
  });
});

describe("the transformers' plan lines", () => {
  it("owe each centre its stage's hours by the stage's date, the core never painted", () => {
    const due = lineDueHours({ dayISO: "2026-10-30", item: "CF", owed: 2, done: { cut: 1, weld: 0, finish: 0 } }, PER, LEADS);
    expect(due).toEqual([
      { centre: "Cutting", dayISO: "2026-10-26", dueH: 1 },
      { centre: "Bending", dayISO: "2026-10-26", dueH: 0.5 },
      { centre: "Welding", dayISO: "2026-10-29", dueH: 4 },
      { centre: "ShotBlast", dayISO: "2026-10-30", dueH: 0.5 },
    ]);
  });

  it("narrow to a component, or an MO, BOM or SOI", () => {
    expect(trLinesOf(LINES, { item: "CF", q: "" }).map((l) => l.bom)).toEqual(["B1", "B4"]);
    expect(trLinesOf(LINES, { item: null, q: "mo-3" }).map((l) => l.bom)).toEqual(["B3"]);
    expect(trLinesOf(LINES, { item: null, q: "s-1" })).toHaveLength(2);
  });

  it("count the hours left without the line on hold, the outsourced cut or the unpriced line", () => {
    const rows = hoursLeftRows(LINES);
    expect(rows.map((r) => r.line.bom).sort()).toEqual(["B1", "B2", "B4"]);
    // B1's core: 2 to weld (4 h) and 3 to blast (0.75 h); B2: cut outside, 6 to weld (12 h), 6 to finish (6 h)
    expect(rows.find((r) => r.line.bom === "B1")?.hours).toBe(4.8);
    expect(rows.find((r) => r.line.bom === "B2")?.hours).toBe(18);
    expect(rows.find((r) => r.line.bom === "B4")?.hours).toBeNull();
    expect(hoursLeftRows(LINES, "Welding").map((r) => r.hours)).toEqual([12, 4, null]);
  });
});

describe("the transformers' view", () => {
  const v = trView(input(), F(), { floor: true });

  it("sums its tiles from the rows its details show", () => {
    const due = dueByTodayRows(v.lines, "finish", TODAY, LEADS);
    expect(v.finish).toMatchObject({ due: due.reduce((s, r) => s + r.owed, 0), done: due.reduce((s, r) => s + r.done, 0) });
    expect(v.finish).toEqual(planAdherence(LINES, TODAY, LEADS).find((a) => a.stage === "finish"));
    expect(v.hoursLeft.total).toBe(hoursLeftRows(v.lines).reduce((s, r) => s + (r.hours ?? 0), 0));
    expect(v.hoursLeft.unpriced).toBe(1);
    expect(v.capacity.shortH).toBe(v.capacity.rows.reduce((s, r) => s + (r.measured ? r.shortH : 0), 0));
    expect(v.capacity.shortH).toBe(capacityShortH(LOAD));
  });

  it("keeps the line on hold on the plan — in the adherence and listed on hold — and out of the hours", () => {
    expect(v.atRisk.find((r) => r.bom === "B3")).toMatchObject({ status: "on-hold", stage: "Fabrication", hoursLeft: expect.any(Number) });
    const note = (label: string) => v.quality.find((q) => q.label === label);
    expect(note("On hold")?.value).toBe("1 line, 5 pcs — on the plan, out of the load");
    expect(note("Outsourced (OSP)")?.value).toBe("6 pcs — counted made, no hours here");
    expect(note("Capacity not measured")).toEqual({ label: "Capacity not measured", value: "Fin folding", tone: "warn" });
    expect(isPartial(v.quality)).toBe(true);
  });

  it("reads a centre as not measured, never as covered, and people only for those who see Shifts", () => {
    expect(v.capacity.unmeasured).toEqual(["Fins"]);
    expect(v.people.toAdd).toBe(5);
    expect(trView(input(), F(), { floor: false }).people.toAdd).toBeNull();
  });

  it("is comparable with a week ago only on the newest plan, nothing narrowed", () => {
    expect(v.comparable).toBe(true);
    expect(trView(input(), F({ item: "CF" }), { floor: true }).comparable).toBe(false);
    expect(trView(input({ week: { planNo: 41, newest: false, lines: LINES } }), F(), { floor: true }).comparable).toBe(false);
  });

  it("narrows the hours, the load and the people to a centre", () => {
    const w = trView(input(), F({ centre: "Welding" }), { floor: true });
    expect(w.hoursLeft.total).toBe(16);
    expect(w.capacity.rows.map((r) => r.centre)).toEqual(["Welding"]);
    expect(w.people.rows.map((r) => r.centre)).toEqual(["Welding"]);
    expect(w.atRisk.every((r) => r.stage === "Welding")).toBe(true);
  });
});

describe("the lines at risk", () => {
  it("lists the late, then those a short centre will make late, then those on hold — none where the centre has room", () => {
    const rows = trAtRisk(LINES, LOAD, TODAY, LEADS, { planNo: 42, horizonDays: 10 });
    expect(rows.map((r) => [r.bom, r.item, r.status, r.stage])).toEqual([
      ["B1", "Core Frame", "late", "Welding"],
      ["B2", "Tank", "at-risk", "Welding"],
      ["B3", "Cable Box", "on-hold", "Fabrication"],
    ]);
    const b2 = rows.find((r) => r.bom === "B2")!;
    expect(b2).toMatchObject({ mo: "MO-2", stageDueISO: "2026-10-28", required: 6, done: 0, remaining: 6, hoursLeft: 18 });
    expect(b2.reason).toContain("not caught up in the next 10 working days");
    expect(b2.href).toBe("/trace?bom=B2&plan=42&view=weekly&line=TR");
    // B4 owes its cut on the 30th and the laser has room: not at risk, unpriced or not
    expect(rows.some((r) => r.bom === "B4")).toBe(false);
  });

  it("holds a line against a short centre only where it still owes that centre work", () => {
    // fin folding short from the 26th: the core has no fins, so its cut is not at risk for it
    const fins = [loadAhead("Fins", DAYS, [{ dayISO: "2026-10-26", dueH: 9 }], 1)];
    const core = line({ dayISO: "2026-10-31", bom: "B9", item: "CF", owed: 2 });
    expect(core.leftH?.Fins).toBeUndefined();
    expect(trAtRisk([core], fins, TODAY, LEADS, { horizonDays: 10 })).toEqual([]);
    expect(trAtRisk([core], fins, TODAY, LEADS, { centre: "Fins", horizonDays: 10 })).toEqual([]);
    // the core's finishing is its shot blast: never a painting line
    const lateCore = line({ dayISO: "2026-10-20", bom: "B8", item: "CF", owed: 2, done: { cut: 2, weld: 2, finish: 0 } });
    const v = trView(input({ week: { planNo: 42, newest: true, lines: [lateCore] } }), F({ centre: "Painting" }), { floor: true });
    expect(v.late).toEqual([]);
    expect(v.atRisk).toEqual([]);
    expect(trView(input({ week: { planNo: 42, newest: true, lines: [lateCore] } }), F({ centre: "ShotBlast" }), { floor: true }).late).toHaveLength(1);
  });

  it("names no risk where the centre has room before the stage's date", () => {
    const easy = [loadAhead("Welding", DAYS, [{ dayISO: "2026-10-28", dueH: 4 }], 8)];
    expect(trAtRisk(LINES, easy, TODAY, LEADS, { horizonDays: 10 }).some((r) => r.status === "at-risk")).toBe(false);
  });
});

describe("a centre's row of the load", () => {
  it("lists what the lines owe it by its stage's date, the horizon's share apart, nothing on hold", () => {
    const rows = centreLoadRows(LINES, "Welding", LEADS, "2026-10-28");
    expect(rows.map((r) => [r.line.bom, r.dueISO, r.hours, r.inHorizon])).toEqual([["B1", "2026-10-23", 4, true], ["B2", "2026-10-28", 12, true]]);
    expect(centreLoadRows(LINES, "Welding", LEADS, "2026-10-27").map((r) => r.inHorizon)).toEqual([true, false]);
  });
});

describe("the plant's figures", () => {
  it("add the hours and the people of the two lines, and say nothing where neither can", () => {
    const tr = { people: { rows: [{ leftH: 10.25 }, { leftH: 5 }], toAdd: 2 } };
    const lv = { people: { rows: [{ leftH: 4 }], toAdd: null } };
    expect(plantTotals(tr, lv)).toEqual({ hoursLeft: { TR: 15.3, LV: 4, total: 19.3 }, toAdd: { TR: 2, LV: null, total: 2 } });
    expect(plantTotals({ people: { rows: [], toAdd: null } }, lv).toAdd.total).toBeNull();
  });
});

describe("planned against achieved by day", () => {
  it("keeps each stage apart and gives today a slot of its own", () => {
    const days = stageByDay(LINES.slice(0, 3), TODAY);
    expect(days.map((d) => d.dayISO)).toEqual(["2026-10-24", TODAY, "2026-10-29"]);
    expect(days[0]).toMatchObject({ owed: 8, cut: 8, weld: 6, finish: 5, isToday: false });
    expect(days[1]).toMatchObject({ owed: 0, isToday: true });
    expect(stageByDay([], TODAY)).toEqual([]);
  });
});

describe("against a week ago", () => {
  it("reads the change as a share of the earlier reading — none without a base", () => {
    expect(relativeChange(12, 10)).toBeCloseTo(0.2);
    expect(relativeChange(0.5, 0.8)).toBeCloseTo(-0.375);
    expect(relativeChange(3, 0)).toBeNull();
    expect(relativeChange(3, null)).toBeNull();
    expect(relativeChange(null, 4)).toBeNull();
  });
});

describe("the panels' orders", () => {
  const st = (required: number, punch: number, bend: number, weld: number, paint: number) => ({ required, punch, bend, weld, paint, delivered: 0 });
  const rate = { fg: "FG-1", description: null, kind: "USS", cutH: 1, bendH: 1, weldH: 2, shbH: 0, paintH: 1, totalH: 5 };
  const o = (x: Partial<LvOrderLine> & Pick<LvOrderLine, "mo" | "state">): LvOrderLine => ({ bom: `BOM-${x.mo}`, soi: null, product: "USS 1000", urgent: false, held: false, open: true, inMonth: true, rate, ...x });
  const ORDERS = [
    o({ mo: "L1", state: st(10, 10, 6, 4, 2) }),
    o({ mo: "L2", state: st(5, 0, 0, 0, 0), urgent: true, inMonth: false }),
    o({ mo: "L3", state: st(4, 4, 4, 4, 4) }),
    o({ mo: "L4", state: st(6, 2, 0, 0, 0), held: true }),
    // closed short on ODOO: on the month's figures, owes nothing more
    o({ mo: "L5", state: st(3, 3, 3, 1, 1), open: false }),
    // carried over from last month: on the month once, with what it brought
    o({ mo: "L6", state: st(8, 8, 8, 8, 5), rate: null }),
  ];

  it("list the urgent first, then the short, then those on hold — never a closed one, nor one already painted", () => {
    const rows = lvAtRisk(ORDERS);
    expect(rows.map((r) => [r.mo, r.status, r.stage])).toEqual([["L2", "urgent", "Punching"], ["L1", "short", "Bending"], ["L6", "short", "Painting"], ["L4", "on-hold", "Punching"]]);
    expect(rows[0].reason).toBe("Urgent · Not punched yet · not on this month's plan");
    expect(rows.find((r) => r.mo === "L1")).toMatchObject({ required: 10, done: 2, remaining: 8, stageDueISO: null, hoursLeft: 4 + 6 * 2 + 8 * 1 });
    expect(rows.find((r) => r.mo === "L6")?.hoursLeft).toBeNull();
    expect(lvAtRisk(ORDERS, { dept: "WeldingLV" })).toEqual([]);
    expect(lvAtRisk(ORDERS, { dept: "Bending" }).map((r) => r.mo)).toEqual(["L1"]);
  });

  it("sum the month's figures the way the month's progress counts them", () => {
    const rows = lvMonthRows(ORDERS);
    const month = lvMonthProgress(ORDERS.filter((x) => x.inMonth), "Oct-26", { monthWd: 26, leftWd: 6 });
    expect(rows.map((r) => r.order.mo).sort()).toEqual(["L1", "L3", "L4", "L5", "L6"]);
    expect(rows.reduce((s, r) => s + r.required, 0)).toBe(month.panels);
    expect(rows.reduce((s, r) => s + r.painted, 0)).toBe(month.complete);
    expect(rows.reduce((s, r) => s + r.remaining, 0)).toBe(month.remaining);
  });

  it("say what the panels' figures rest on, and narrow the people to a department", () => {
    const rows = manpowerPlan([{ centre: "Bending" as const, requiredH: 60, doneH: 10, present: 0.5 }, { centre: "WeldingLV" as const, requiredH: 40, doneH: 40, present: 2 }], { monthWd: 26, leftWd: 5, hoursPerPersonDay: 8 });
    const v = lvView({ todayISO: TODAY, lastDayISO: null, orders: ORDERS, manpower: { rows, coverage: { orders: 6, priced: 5 } }, month: { leftWd: 5 }, wip: { heldOrders: 1 } }, F({ lvDept: "Bending" }), { floor: true });
    expect(v.people.rows.map((r) => r.centre)).toEqual(["Bending"]);
    expect(v.people.toAdd).toBe(1);
    expect(v.quality).toEqual([
      { label: "Delivery dates", value: "none on the panels' plan — judged on an even pace through the month" },
      { label: "Std times", value: "5 of 6 month orders priced", tone: "warn" },
      { label: "On hold", value: "1 order — out of the queues" },
      { label: "Last shift day", value: "none lately — people present not measured", tone: "warn" },
    ]);
    // one family's plan: who comes is the whole floor's, so no gap is read against it
    const mb = lvView({ todayISO: TODAY, lastDayISO: TODAY, orders: ORDERS, manpower: { rows, coverage: { orders: 6, priced: 5 } }, month: { leftWd: 5 }, wip: { heldOrders: 0 } }, F({ family: "MB" }), { floor: true });
    expect(mb.quality).toContainEqual({ label: "People present", value: "the whole floor's, not one family's — no gap read" });
  });
});
