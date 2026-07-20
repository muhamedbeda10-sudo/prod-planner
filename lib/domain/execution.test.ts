import { describe, it, expect } from "vitest";
import {
  attributeToMos,
  computeExecutionRows,
  computeWeldingQueue,
  computePaintingQueue,
  computeCascade,
  computeCutTranches,
  capTranchesToOrder,
  applyWorklistDateOverrides,
  untouchedWeeklyMos,
  type ExecScheduleRow,
  type ExecEntry,
  type CutTranche,
} from "./execution";
import { utcDate } from "./dates";

const caps = new Map<string, number>([
  ["B1|MO-A|CF", 5],
  ["B1|MO-B|CF", 3],
]);
const moOrder = new Map<string, string[]>([["B1", ["MO-A", "MO-B"]]]);

describe("attributeToMos", () => {
  it("counts MO-tagged entries directly against their MO", () => {
    const out = attributeToMos([{ bom: "B1", mo: "MO-B", item: "CF", qty: 2 }], caps, moOrder);
    expect(out.get("B1|MO-B|CF")).toBe(2);
    expect(out.get("B1|MO-A|CF")).toBeUndefined();
  });

  it("attributes no-MO entries FIFO in plan order, capped per MO", () => {
    const out = attributeToMos([{ bom: "B1", mo: null, item: "CF", qty: 6 }], caps, moOrder);
    expect(out.get("B1|MO-A|CF")).toBe(5); // cap 5
    expect(out.get("B1|MO-B|CF")).toBe(1); // remainder
  });

  it("sends excess beyond all caps to the LAST MO (like AllocateMultiMO)", () => {
    const out = attributeToMos([{ bom: "B1", mo: null, item: "CF", qty: 12 }], caps, moOrder);
    expect(out.get("B1|MO-A|CF")).toBe(5);
    expect(out.get("B1|MO-B|CF")).toBe(7); // 3 cap + 4 excess
  });

  it("mixes direct and FIFO: direct fills reduce the FIFO room", () => {
    const out = attributeToMos(
      [
        { bom: "B1", mo: "MO-A", item: "CF", qty: 4 },
        { bom: "B1", mo: null, item: "CF", qty: 3 },
      ],
      caps,
      moOrder
    );
    expect(out.get("B1|MO-A|CF")).toBe(5); // 4 direct + 1 FIFO (room = 5-4)
    expect(out.get("B1|MO-B|CF")).toBe(2);
  });
});

describe("computeExecutionRows", () => {
  const day = utcDate(2026, 7, 13);
  const schedules: ExecScheduleRow[] = [
    { bom: "B1", mo: "MO-A", description: "1000kva", item: "CF", ovenDate: utcDate(2026, 7, 14), qty: 5 }, // due for weld (lead 1)
    { bom: "B1", mo: "MO-B", description: "1000kva", item: "CF", ovenDate: utcDate(2026, 7, 20), qty: 3 }, // not due yet
  ];

  it("lists only lines with work due, per MO, with plan totals", () => {
    const rows = computeExecutionRows({ schedules, entries: [], day, lead: 1, dept: "Welding" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bom: "B1", mo: "MO-A", item: "CF", dueToDate: 5, totalPlanned: 5, still: 5 });
  });

  it("welding rows expose per-MO cutReady = cut(≤yesterday) − welded", () => {
    const entries: ExecEntry[] = [
      { dept: "Cut", bom: "B1", mo: "MO-A", item: "CF", qty: 4, date: utcDate(2026, 7, 12) },
      { dept: "Welding", bom: "B1", mo: "MO-A", item: "CF", qty: 1, date: utcDate(2026, 7, 13) },
    ];
    const rows = computeExecutionRows({ schedules, entries, day, lead: 1, dept: "Welding" });
    expect(rows[0].doneToDate).toBe(1);
    expect(rows[0].doneToday).toBe(1);
    expect(rows[0].still).toBe(4);
    expect(rows[0].cutReady).toBe(3); // 4 cut yesterday − 1 welded
  });

  it("legacy no-MO output reduces the right MO via FIFO", () => {
    const entries: ExecEntry[] = [
      { dept: "Cut", bom: "B1", mo: null, item: "CF", qty: 2, date: utcDate(2026, 7, 12) },
    ];
    const rows = computeExecutionRows({ schedules, entries, day, lead: 2, dept: "Cut" });
    const a = rows.find((r) => r.mo === "MO-A")!;
    expect(a.doneToDate).toBe(2);
    expect(a.still).toBe(3);
  });
});

describe("computeCascade — unscheduled backlog under the scheduled work", () => {
  const day = utcDate(2026, 7, 13);
  const orders = [
    { bom: "B1", mo: "MO-A", description: "1000kva", item: "CF", targetQty: 10 },
    { bom: "B1", mo: "MO-B", description: "1000kva", item: "CF", targetQty: 4 }, // never scheduled
  ];
  const schedules: ExecScheduleRow[] = [
    { bom: "B1", mo: "MO-A", description: "1000kva", item: "CF", ovenDate: utcDate(2026, 7, 14), qty: 6 },
  ];

  it("pool = target − scheduled; pure-backlog MOs appear with scheduled 0", () => {
    const rows = computeCascade({ orders, schedules, entries: [], day, dept: "Cut" });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ mo: "MO-A", target: 10, scheduled: 6, available: 4 });
    expect(rows[1]).toMatchObject({ mo: "MO-B", target: 4, scheduled: 0, available: 4 });
  });

  it("output beyond the schedule eats the pool; fully-covered lines disappear", () => {
    const entries: ExecEntry[] = [
      { dept: "Cut", bom: "B1", mo: "MO-A", item: "CF", qty: 8, date: day }, // 6 sched + 2 extra
      { dept: "Cut", bom: "B1", mo: "MO-B", item: "CF", qty: 4, date: day }, // consumes all backlog
    ];
    const rows = computeCascade({ orders, schedules, entries, day, dept: "Cut" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mo: "MO-A", done: 8, available: 2 }); // 10 − max(6,8)
  });

  it("keeps the OLD promised date on lines the new plan did not reschedule", () => {
    const rows = computeCascade({
      orders: [{ bom: "B9", mo: "MO-Z", item: "CF", targetQty: 10 }],
      schedules: [], // not on this week's schedule at all
      entries: [{ dept: "Cut", bom: "B9", mo: "MO-Z", item: "CF", qty: 3, date: utcDate(2026, 7, 6) }],
      day,
      dept: "Cut",
      allSchedules: [
        { planNo: 27, bom: "B9", mo: "MO-Z", item: "CF", ovenDate: utcDate(2026, 7, 5), qty: 2 }, // fully cut → closed
        { planNo: 27, bom: "B9", mo: "MO-Z", item: "CF", ovenDate: utcDate(2026, 7, 7), qty: 8 }, // still open
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].deliveryISO).toBe("2026-07-07"); // the old promise survives the new import
  });

  it("fully-scheduled lines never show in the cascade", () => {
    const rows = computeCascade({
      orders: [{ bom: "B2", mo: "MO-C", item: "TN", targetQty: 5 }],
      schedules: [{ bom: "B2", mo: "MO-C", item: "TN", ovenDate: day, qty: 5 }],
      entries: [],
      day,
      dept: "Cut",
    });
    expect(rows).toHaveLength(0);
  });
});

describe("untouchedWeeklyMos — unscheduled + no remark = not this week", () => {
  const planOrders = [
    { mo: "MO-A", remark: null }, // scheduled below — stays
    { mo: "MO-B", remark: "BALANCE 5" }, // remark keeps it in play
    { mo: "MO-C", remark: null }, // untouched — excluded
    { mo: "MO-C", remark: "" }, // second item row, still blank
    { mo: "MO-D", remark: null }, // one row blank…
    { mo: "MO-D", remark: "urgent" }, // …but another row has a remark — stays
  ];
  const schedules = [{ mo: "MO-A" }];

  it("excludes ONLY MOs with no schedule and no remark on any row", () => {
    const out = untouchedWeeklyMos(planOrders, schedules);
    expect([...out]).toEqual(["MO-C"]);
  });

  it("whitespace-only remarks count as blank", () => {
    const out = untouchedWeeklyMos([{ mo: "MO-X", remark: "   " }], []);
    expect(out.has("MO-X")).toBe(true);
  });
});

describe("computeWeldingQueue — the welding screen is ONLY what was cut", () => {
  const day = utcDate(2026, 7, 13);
  const schedules = [
    { planNo: 28, bom: "B1", mo: "MO-A", description: "1000kva", item: "CF", ovenDate: utcDate(2026, 7, 20), qty: 5 },
  ];

  it("a piece cut TODAY is available to weld today (no D-1 rule, no schedule gating)", () => {
    // oven date is far in the future — schedule would say "not due"; the queue doesn't care
    const entries = [
      { planNo: 28, dept: "Cut", bom: "B1", mo: "MO-A", item: "CF", qty: 4, date: day }, // cut TODAY
    ];
    const rows = computeWeldingQueue({ schedules, entries, day });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bom: "B1", mo: "MO-A", item: "CF", cutToDate: 4, weldedToDate: 0, available: 4 });
  });

  it("welding consumes the queue; fully-welded lines disappear (unless welded today)", () => {
    const entries = [
      { planNo: 28, dept: "Cut", bom: "B1", mo: "MO-A", item: "CF", qty: 4, date: utcDate(2026, 7, 12) },
      { planNo: 28, dept: "Welding", bom: "B1", mo: "MO-A", item: "CF", qty: 4, date: day },
    ];
    const rows = computeWeldingQueue({ schedules, entries, day });
    expect(rows).toHaveLength(1); // still shown because welded today
    expect(rows[0].available).toBe(0);
    expect(rows[0].weldedToday).toBe(4);
    // the next day it is gone
    const tomorrow = computeWeldingQueue({ schedules, entries, day: utcDate(2026, 7, 14) });
    expect(tomorrow).toHaveLength(0);
  });

  it("WIP from an OLD plan stays in the queue until welded (progress is global)", () => {
    const entries = [
      { planNo: 27, dept: "Cut", bom: "OLD1E11M11", mo: "MO-X", item: "TN", qty: 3, date: utcDate(2026, 7, 6) },
    ];
    const scheds = [
      { planNo: 27, bom: "OLD1E11M11", mo: "MO-X", item: "TN", ovenDate: utcDate(2026, 7, 7), qty: 3 },
      ...schedules,
    ];
    const rows = computeWeldingQueue({ schedules: scheds, entries, day });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bom: "OLD1E11M11", available: 3 });
  });

  it("the SAME MO worked under different plans is ONE queue line (global per MO)", () => {
    const entries = [
      { planNo: 0, dept: "Cut", bom: "B1", mo: "MO-A", item: "CF", qty: 3, date: utcDate(2026, 7, 1) }, // setup
      { planNo: 28, dept: "Cut", bom: "B1", mo: "MO-A", item: "CF", qty: 2, date: day }, // this week
      { planNo: 28, dept: "Welding", bom: "B1", mo: "MO-A", item: "CF", qty: 1, date: day },
    ];
    const rows = computeWeldingQueue({ schedules, entries, day });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bom: "B1", mo: "MO-A", cutToDate: 5, weldedToDate: 1, available: 4 });
  });

  it("painting queue chains off WELDING output (Cut → Welding → Painting)", () => {
    // TN is a painted component (CF is paint-exempt, so it never reaches paint)
    const scheds = [{ planNo: 28, bom: "B1", mo: "MO-A", description: "1000kva", item: "TN", ovenDate: utcDate(2026, 7, 20), qty: 5 }];
    const entries = [
      { planNo: 28, dept: "Cut", bom: "B1", mo: "MO-A", item: "TN", qty: 5, date: utcDate(2026, 7, 12) },
      { planNo: 28, dept: "Welding", bom: "B1", mo: "MO-A", item: "TN", qty: 3, date: day },
      { planNo: 28, dept: "Painting", bom: "B1", mo: "MO-A", item: "TN", qty: 1, date: day },
    ];
    // welding queue: cut 5 − welded 3 = 2 available
    const weldQ = computeWeldingQueue({ schedules: scheds, entries, day });
    expect(weldQ[0].available).toBe(2);
    // painting queue: welded 3 − painted 1 = 2 available (welded TODAY counts immediately)
    const paintQ = computePaintingQueue({ schedules: scheds, entries, day });
    expect(paintQ).toHaveLength(1);
    expect(paintQ[0]).toMatchObject({ bom: "B1", mo: "MO-A", item: "TN", cutToDate: 3, weldedToDate: 1, available: 2 });
  });

  it("the paint-exempt core (CF) NEVER enters the painting queue", () => {
    const entries = [
      { planNo: 28, dept: "Cut", bom: "B1", mo: "MO-A", item: "CF", qty: 5, date: utcDate(2026, 7, 12) },
      { planNo: 28, dept: "Welding", bom: "B1", mo: "MO-A", item: "CF", qty: 5, date: day },
    ];
    expect(computePaintingQueue({ schedules, entries, day })).toHaveLength(0);
  });

  it("carries the next open delivery date; weld due = D−1, paint due = D", () => {
    const weldEntries = [
      { planNo: 28, dept: "Cut", bom: "B1", mo: "MO-A", item: "CF", qty: 4, date: day },
    ];
    const weldQ = computeWeldingQueue({ schedules, entries: weldEntries, day }); // delivery 20/07
    expect(weldQ[0].deliveryISO).toBe("2026-07-20");
    expect(weldQ[0].dueISO).toBe("2026-07-19"); // one day before delivery
    // painting: use a painted item (TN)
    const paintScheds = [{ planNo: 28, bom: "B1", mo: "MO-A", description: "1000kva", item: "TN", ovenDate: utcDate(2026, 7, 20), qty: 5 }];
    const paintQ = computePaintingQueue({
      schedules: paintScheds,
      entries: [
        { planNo: 28, dept: "Cut", bom: "B1", mo: "MO-A", item: "TN", qty: 4, date: day },
        { planNo: 28, dept: "Welding", bom: "B1", mo: "MO-A", item: "TN", qty: 2, date: day },
      ],
      day,
    });
    expect(paintQ[0].deliveryISO).toBe("2026-07-20");
    expect(paintQ[0].dueISO).toBe("2026-07-20"); // painting due the delivery day itself
  });

  it("this dept's own output consumes delivery tranches FIFO — the date advances", () => {
    const scheds = [
      { planNo: 28, bom: "B1", mo: "MO-A", item: "CF", ovenDate: utcDate(2026, 7, 15), qty: 2 },
      { planNo: 28, bom: "B1", mo: "MO-A", item: "CF", ovenDate: utcDate(2026, 7, 22), qty: 3 },
    ];
    const entries = [
      { planNo: 28, dept: "Cut", bom: "B1", mo: "MO-A", item: "CF", qty: 5, date: utcDate(2026, 7, 12) },
      { planNo: 28, dept: "Welding", bom: "B1", mo: "MO-A", item: "CF", qty: 2, date: day }, // first tranche fully welded
    ];
    const rows = computeWeldingQueue({ schedules: scheds, entries, day });
    expect(rows[0].deliveryISO).toBe("2026-07-22"); // 15/07 tranche done → next open delivery
  });

  it("a NEWER plan's schedule supersedes the old dates for the same MO", () => {
    const scheds = [
      { planNo: 28, bom: "B1", mo: "MO-A", item: "CF", ovenDate: utcDate(2026, 7, 8), qty: 10 }, // old promise (missed)
      { planNo: 29, bom: "B1", mo: "MO-A", item: "CF", ovenDate: utcDate(2026, 7, 16), qty: 6 }, // re-promised remainder
    ];
    const entries = [
      { planNo: 28, dept: "Cut", bom: "B1", mo: "MO-A", item: "CF", qty: 10, date: utcDate(2026, 7, 6) },
      { planNo: 28, dept: "Welding", bom: "B1", mo: "MO-A", item: "CF", qty: 4, date: utcDate(2026, 7, 7) },
    ];
    const rows = computeWeldingQueue({ schedules: scheds, entries, day });
    expect(rows[0].deliveryISO).toBe("2026-07-16"); // NOT the missed 08/07 — the new promise wins
    expect(rows[0].dueISO).toBe("2026-07-15");
    // output credited to the old promise (≤10) does not consume the new tranche:
    // 12 welded = 10 old + 2 new → the 16/07 tranche is still open
    const more = [...entries, { planNo: 29, dept: "Welding", bom: "B1", mo: "MO-A", item: "CF", qty: 8, date: day }];
    const rows2 = computeWeldingQueue({
      schedules: scheds,
      entries: [...more, { planNo: 29, dept: "Cut", bom: "B1", mo: "MO-A", item: "CF", qty: 6, date: day }],
      day,
    });
    expect(rows2[0].deliveryISO).toBe("2026-07-16");
  });

  it("the OSP share never reaches the dept queues (in-house cap)", () => {
    const entries = [
      { planNo: 28, dept: "Cut", bom: "B1", mo: "MO-A", item: "TN", qty: 5, date: day },
      { planNo: 28, dept: "Cut", bom: "B1", mo: "MO-B", item: "TN", qty: 5, date: day },
    ];
    const inhouseCap = new Map([
      ["B1|MO-A|TN", 0], // fully outsourced — line disappears
      ["B1|MO-B|TN", 3], // partial: 5 planned, 2 outsourced → only 3 in-house
    ]);
    const rows = computeWeldingQueue({ schedules, entries, day, inhouseCap });
    expect(rows.find((r) => r.mo === "MO-A")).toBeUndefined();
    expect(rows.find((r) => r.mo === "MO-B")!.available).toBe(3);
  });

  it("cut on unknown/legacy codes (no plan lines) still reaches the queue at BOM level", () => {
    const entries = [
      { planNo: 27, dept: "Cut", bom: "US05-134M12", mo: null, item: "CB", qty: 4, date: utcDate(2026, 7, 9) },
    ];
    const rows = computeWeldingQueue({ schedules, entries, day });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bom: "US05-134M12", mo: "", item: "CB", available: 4 });
  });
});

describe("computeCutTranches — due today / overdue-with-date / future hidden", () => {
  const day = utcDate(2026, 7, 13); // today
  const lead = 2;
  const schedules: ExecScheduleRow[] = [
    // delivery 13/07 -> cut-due 11/07 (PASSED) — overdue if not done
    { bom: "B1", mo: "MO-A", description: "1000kva", item: "CF", ovenDate: utcDate(2026, 7, 13), qty: 3 },
    // delivery 15/07 -> cut-due 13/07 (TODAY) — due now
    { bom: "B1", mo: "MO-A", description: "1000kva", item: "CF", ovenDate: utcDate(2026, 7, 15), qty: 4 },
    // delivery 18/07 -> cut-due 16/07 (future) — hidden until its day
    { bom: "B1", mo: "MO-A", description: "1000kva", item: "CF", ovenDate: utcDate(2026, 7, 18), qty: 5 },
  ];

  it("splits: passed date -> overdue (with the original delivery date), today -> due now, future hidden", () => {
    const { dueNow, overdue } = computeCutTranches({ schedules, entries: [], day, lead });
    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toMatchObject({ deliveryISO: "2026-07-13", qty: 3, remaining: 3 });
    expect(dueNow).toHaveLength(1);
    expect(dueNow[0]).toMatchObject({ deliveryISO: "2026-07-15", qty: 4, remaining: 4 });
  });

  it("global done consumes the EARLIEST tranche first (overdue clears before due-now)", () => {
    const entries: ExecEntry[] = [
      { dept: "Cut", bom: "B1", mo: "MO-A", item: "CF", qty: 5, date: utcDate(2026, 7, 12) },
    ];
    const { dueNow, overdue } = computeCutTranches({ schedules, entries, day, lead });
    expect(overdue).toHaveLength(0); // 3 consumed the overdue tranche fully
    expect(dueNow).toHaveLength(1);
    expect(dueNow[0].remaining).toBe(2); // 4 − remaining 2 credit
  });

  it("setup/no-MO output counts too (FIFO attribution then FIFO by date)", () => {
    const entries: ExecEntry[] = [
      { dept: "Cut", bom: "B1", mo: null, item: "CF", qty: 12, date: utcDate(2026, 7, 1) },
    ];
    const { dueNow, overdue } = computeCutTranches({ schedules, entries, day, lead });
    expect(overdue).toHaveLength(0);
    expect(dueNow).toHaveLength(0); // 3+4 consumed; remaining 5 credit eats the future tranche
  });

  it("re-importing with NEW dates re-buckets everything (new schedule, same engine)", () => {
    // the overdue 13/07 tranche got re-planned to 16/07 in the new weekly plan
    const rescheduled: ExecScheduleRow[] = [
      { bom: "B1", mo: "MO-A", description: "1000kva", item: "CF", ovenDate: utcDate(2026, 7, 16), qty: 3 },
    ];
    const { dueNow, overdue } = computeCutTranches({ schedules: rescheduled, entries: [], day, lead });
    expect(overdue).toHaveLength(0); // no longer overdue — it has a fresh date
    expect(dueNow).toHaveLength(0); // cut-due 14/07 is tomorrow
  });

  it("a line scheduled in an OLD week stays on the worklist under its promised date", () => {
    // plan 27 promised 08/07 — the current plan (28) never rescheduled the line
    const scheds = [
      { planNo: 27, bom: "OLD1", mo: "MO-Z", item: "TN", ovenDate: utcDate(2026, 7, 8), qty: 4 },
      { planNo: 28, bom: "B1", mo: "MO-A", item: "CF", ovenDate: utcDate(2026, 7, 15), qty: 2 },
    ];
    const { dueNow, overdue } = computeCutTranches({ schedules: scheds, entries: [], day, lead });
    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toMatchObject({ bom: "OLD1", mo: "MO-Z", deliveryISO: "2026-07-08", remaining: 4 });
    expect(dueNow).toHaveLength(1); // the current week's own line is unaffected
    expect(dueNow[0]).toMatchObject({ bom: "B1", deliveryISO: "2026-07-15" });
  });

  it("a NEWER plan's dates supersede the old promise for the same line", () => {
    const scheds = [
      { planNo: 27, bom: "B1", mo: "MO-A", item: "CF", ovenDate: utcDate(2026, 7, 8), qty: 10 }, // missed promise
      { planNo: 28, bom: "B1", mo: "MO-A", item: "CF", ovenDate: utcDate(2026, 7, 15), qty: 6 }, // re-promised remainder
    ];
    const entries: ExecEntry[] = [
      { dept: "Cut", bom: "B1", mo: "MO-A", item: "CF", qty: 4, date: utcDate(2026, 7, 7) },
    ];
    const { dueNow, overdue } = computeCutTranches({ schedules: scheds, entries, day, lead });
    expect(overdue).toHaveLength(0); // the missed 08/07 promise is superseded
    // output credited to the old promise (≤10) does not consume the new tranche
    expect(dueNow).toHaveLength(1);
    expect(dueNow[0]).toMatchObject({ deliveryISO: "2026-07-15", remaining: 6 });
  });

  it("output beyond the superseded promise consumes the new tranches FIFO", () => {
    const scheds = [
      { planNo: 27, bom: "B1", mo: "MO-A", item: "CF", ovenDate: utcDate(2026, 7, 8), qty: 5 },
      { planNo: 28, bom: "B1", mo: "MO-A", item: "CF", ovenDate: utcDate(2026, 7, 15), qty: 6 },
    ];
    const entries: ExecEntry[] = [
      { dept: "Cut", bom: "B1", mo: "MO-A", item: "CF", qty: 9, date: utcDate(2026, 7, 12) }, // 5 old + 4 new
    ];
    const { dueNow } = computeCutTranches({ schedules: scheds, entries, day, lead });
    expect(dueNow).toHaveLength(1);
    expect(dueNow[0].remaining).toBe(2); // 6 − (9 − 5 superseded)
  });
});

describe("capTranchesToOrder — a promise never exceeds the order's open qty", () => {
  const t = (over: Partial<CutTranche>): CutTranche => ({
    bom: "B1", mo: "MO-A", description: "", item: "CF",
    deliveryISO: "2026-07-05", cutDueISO: "2026-07-01",
    qty: 3, remaining: 3, deptDone: 0, orderQty: null,
    ...over,
  });

  it("silently drops phantom work: order 1 fully cut, promise of 3 disappears", () => {
    // the reported real-world case: weekly plan promised 3, registry order is 1 (done)
    const { dueNow, overdue } = capTranchesToOrder({
      dueNow: [],
      overdue: [t({ qty: 3, remaining: 2, deptDone: 1, orderQty: 1 })],
    });
    expect(overdue).toHaveLength(0);
    expect(dueNow).toHaveLength(0);
  });

  it("allocates the order's open qty to the EARLIEST promises first", () => {
    const rows = capTranchesToOrder({
      overdue: [t({ deliveryISO: "2026-07-05", remaining: 3, deptDone: 1, orderQty: 5 })],
      dueNow: [t({ deliveryISO: "2026-07-15", remaining: 3, deptDone: 1, orderQty: 5 })],
    });
    // open = 5 − 1 = 4 → earliest keeps its 3, the later one is trimmed to 1
    expect(rows.overdue[0].remaining).toBe(3);
    expect(rows.dueNow[0].remaining).toBe(1);
  });

  it("lines with an unknown order (not in the registry) are left as promised", () => {
    const rows = capTranchesToOrder({ dueNow: [t({ remaining: 3, orderQty: null })], overdue: [] });
    expect(rows.dueNow[0].remaining).toBe(3);
  });
});

describe("applyWorklistDateOverrides — admin re-dates, revert restores", () => {
  const day = utcDate(2026, 7, 13);
  const lead = 2;
  const t = (over: Partial<CutTranche>): CutTranche => ({
    bom: "B1", mo: "MO-A", description: "", item: "CF",
    deliveryISO: "2026-07-10", cutDueISO: "2026-07-08",
    qty: 3, remaining: 3, deptDone: 0, orderQty: 3,
    ...over,
  });
  const undatedRow = {
    bom: "B2", mo: "MO-B", description: "", item: "TN" as const,
    target: 5, scheduled: 0, done: 1, available: 4, deliveryISO: null,
  };

  it("no overrides → everything stays where it was", () => {
    const out = applyWorklistDateOverrides({
      dueNow: [], overdue: [t({})], undated: [undatedRow], overrides: [], day, lead,
    });
    expect(out.overdue).toHaveLength(1);
    expect(out.overdue[0].overrideOrigISO).toBeUndefined();
    expect(out.undated).toHaveLength(1);
    expect(out.postponed).toHaveLength(0);
  });

  it("re-dates a dated row to the future → postponed, carrying the original", () => {
    const out = applyWorklistDateOverrides({
      dueNow: [], overdue: [t({})], undated: [], day, lead,
      overrides: [{ bom: "B1", mo: "MO-A", item: "CF", origISO: "2026-07-10", newISO: "2026-07-20" }],
    });
    expect(out.overdue).toHaveLength(0);
    expect(out.postponed).toHaveLength(1);
    expect(out.postponed[0]).toMatchObject({
      deliveryISO: "2026-07-20", cutDueISO: "2026-07-18", overrideOrigISO: "2026-07-10",
    });
  });

  it("re-dating to today's cut-due lands in dueNow; to a passed date lands in overdue", () => {
    const out = applyWorklistDateOverrides({
      dueNow: [], overdue: [t({})], undated: [], day, lead,
      overrides: [{ bom: "B1", mo: "MO-A", item: "CF", origISO: "2026-07-10", newISO: "2026-07-15" }],
    });
    expect(out.dueNow).toHaveLength(1); // 15/07 − 2 = 13/07 = today
  });

  it("gives a DATE-LESS line a date (origISO '') — revert key says 'was date-less'", () => {
    const out = applyWorklistDateOverrides({
      dueNow: [], overdue: [], undated: [undatedRow], day, lead,
      overrides: [{ bom: "B2", mo: "MO-B", item: "TN", origISO: "", newISO: "2026-07-15" }],
    });
    expect(out.undated).toHaveLength(0);
    expect(out.dueNow).toHaveLength(1);
    expect(out.dueNow[0]).toMatchObject({
      qty: 4, remaining: 4, deptDone: 1, orderQty: 5, overrideOrigISO: "",
    });
  });

  it("stale overrides (date no longer in the plan) are ignored", () => {
    const out = applyWorklistDateOverrides({
      dueNow: [], overdue: [t({})], undated: [], day, lead,
      overrides: [{ bom: "B1", mo: "MO-A", item: "CF", origISO: "2026-07-01", newISO: "2026-07-20" }],
    });
    expect(out.overdue).toHaveLength(1);
    expect(out.overdue[0].overrideOrigISO).toBeUndefined();
  });
});
