import { describe, it, expect } from "vitest";
import { computeCutWorklist, computeWeldWorklist } from "./worklist";
import { makeBomGrouper } from "./bom";
import { utcDate } from "./dates";

const grouper = makeBomGrouper(["A11E11M11", "B11E11M11"]);
const A = "A11E11M11";
const B = "B11E11M11";
const day = utcDate(2026, 7, 6); // dt

describe("computeCutWorklist", () => {
  it("rolls overdue forward and fills capacity from backlog", () => {
    const rows = computeCutWorklist({
      grouper,
      day,
      lead: 2,
      capacity: 27,
      schedule: [
        { bom: A, item: "CF", ovenDate: utcDate(2026, 7, 8), qty: 5 }, // oven = dt+2 -> due
        { bom: A, item: "CF", ovenDate: utcDate(2026, 7, 10), qty: 4 }, // oven = dt+4 -> not due
      ],
      orders: [{ bom: A, item: "CF", targetQty: 20, kva: "1000kva" }],
      handover: [{ dept: "Cut", bom: A, item: "CF", qty: 2, date: utcDate(2026, 7, 5) }], // done before today
    });
    const sched = rows.find((r) => r.type === "Scheduled" && r.item === "CF")!;
    expect(sched.cutDue).toBe(3); // 5 due - 2 done before = 3
    expect(sched.stillDue).toBe(3);
    expect(sched.todayTarget).toBe(3);

    const fill = rows.find((r) => r.type === "Fill-up (unscheduled)" && r.item === "CF")!;
    // pool = target(20) - max(scheduledTotal 9, cutCum 2) = 11 ; need = 27 - 3 = 24
    expect(fill.todayTarget).toBe(11);
  });

  it("overdue schedule (oven in the past) still counts as due today", () => {
    const rows = computeCutWorklist({
      grouper,
      day,
      lead: 2,
      capacity: 27,
      schedule: [{ bom: A, item: "TC", ovenDate: utcDate(2026, 7, 5), qty: 10 }], // oven yesterday
      orders: [{ bom: A, item: "TC", targetQty: 10 }],
      handover: [{ dept: "Cut", bom: A, item: "TC", qty: 3, date: utcDate(2026, 7, 4) }],
    });
    const sched = rows.find((r) => r.type === "Scheduled")!;
    expect(sched.cutDue).toBe(7); // 10 - 3 = 7 rolled forward
    expect(sched.status).toBe("Pending");
  });

  it("caps the today-target at the daily capacity per item", () => {
    const rows = computeCutWorklist({
      grouper,
      day,
      lead: 2,
      capacity: 27,
      schedule: [{ bom: A, item: "CB", ovenDate: utcDate(2026, 7, 7), qty: 40 }],
      orders: [{ bom: A, item: "CB", targetQty: 40 }],
      handover: [],
    });
    const sched = rows.find((r) => r.type === "Scheduled")!;
    expect(sched.stillDue).toBe(40);
    expect(sched.todayTarget).toBe(27); // capped
  });
});

describe("computeWeldWorklist", () => {
  const base = { grouper, day, lead: 1, capacity: 27 };

  it("cut alarm = Partial when cut ready is less than still due", () => {
    const rows = computeWeldWorklist({
      ...base,
      schedule: [{ bom: A, item: "CF", ovenDate: utcDate(2026, 7, 7), qty: 5 }], // oven dt+1 -> due
      orders: [{ bom: A, item: "CF", targetQty: 5 }],
      handover: [{ dept: "Cut", bom: A, item: "CF", qty: 4, date: utcDate(2026, 7, 5) }], // cut yesterday
    });
    const r = rows.find((x) => x.type === "Scheduled")!;
    expect(r.stillDue).toBe(5);
    expect(r.cutReady).toBe(4);
    expect(r.cutAlarm).toBe("Partial - 1 not cut");
    expect(r.todayTarget).toBe(4); // min(still 5, ready 4, room 27)
  });

  it("cut alarm = NOT CUT YET when nothing is cut", () => {
    const rows = computeWeldWorklist({
      ...base,
      schedule: [{ bom: A, item: "TN", ovenDate: utcDate(2026, 7, 7), qty: 3 }],
      orders: [{ bom: A, item: "TN", targetQty: 3 }],
      handover: [],
    });
    const r = rows.find((x) => x.type === "Scheduled")!;
    expect(r.cutAlarm).toBe("NOT CUT YET");
    expect(r.todayTarget).toBe(0);
  });

  it("cut alarm = Cut ready and welds up to capacity when fully cut", () => {
    const rows = computeWeldWorklist({
      ...base,
      schedule: [{ bom: A, item: "TC", ovenDate: utcDate(2026, 7, 7), qty: 5 }],
      orders: [{ bom: A, item: "TC", targetQty: 5 }],
      handover: [{ dept: "Cut", bom: A, item: "TC", qty: 5, date: utcDate(2026, 7, 5) }],
    });
    const r = rows.find((x) => x.type === "Scheduled")!;
    expect(r.cutAlarm).toBe("Cut ready");
    expect(r.todayTarget).toBe(5);
  });

  it("adds a Fill-up (cut done) row for extra cut pieces beyond the schedule", () => {
    const rows = computeWeldWorklist({
      ...base,
      schedule: [], // nothing scheduled
      orders: [{ bom: B, item: "CF", targetQty: 20, kva: "500kva" }],
      handover: [{ dept: "Cut", bom: B, item: "CF", qty: 8, date: utcDate(2026, 7, 5) }],
    });
    const fill = rows.find((r) => r.type === "Fill-up (cut done)")!;
    expect(fill.bom).toBe(B);
    expect(fill.cutReady).toBe(8);
    expect(fill.todayTarget).toBe(8);
  });
});
