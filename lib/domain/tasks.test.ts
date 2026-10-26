import { describe, expect, it } from "vitest";
import {
  checklistOf, checklistProgress, cleanChecklist, cleanDueDate, cleanRepeat, describeRepeat, filterTasks, isOverdue, lateBy, monthWeeks, moveTask, movesFor, nextRepeatDay,
  NO_FILTER, shiftMonth, teamLoad, tickItem, workingDaysAfter, type FilterableTask, type RepeatRule, type StatTask, type TaskStatus,
} from "./tasks";

const giver = { giver: true, doer: false };
const doer = { giver: false, doer: true };
const stranger = { giver: false, doer: false };
const both = { giver: true, doer: true };

describe("moveTask", () => {
  it("refuses anyone who is not on the task", () => {
    expect(moveTask("open", "note", stranger)).toHaveProperty("error");
    expect(moveTask("submitted", "approve", stranger)).toHaveProperty("error");
  });

  it("walks the doer's path: start, then mark done for review", () => {
    expect(moveTask("open", "start", doer)).toEqual({ next: "in_progress" });
    expect(moveTask("in_progress", "submit", doer)).toEqual({ next: "submitted" });
    expect(moveTask("open", "submit", doer)).toEqual({ next: "submitted" });
    expect(moveTask("returned", "submit", doer)).toEqual({ next: "submitted" });
  });

  it("lets only the giver approve, return, cancel and reopen", () => {
    expect(moveTask("submitted", "approve", doer)).toHaveProperty("error");
    expect(moveTask("submitted", "return", doer)).toHaveProperty("error");
    expect(moveTask("open", "cancel", doer)).toHaveProperty("error");
    expect(moveTask("submitted", "approve", giver)).toEqual({ next: "done" });
    expect(moveTask("submitted", "return", giver)).toEqual({ next: "returned" });
    expect(moveTask("in_progress", "cancel", giver)).toEqual({ next: "cancelled" });
    expect(moveTask("done", "reopen", giver)).toEqual({ next: "returned" });
    expect(moveTask("cancelled", "reopen", giver)).toEqual({ next: "returned" });
  });

  it("reviews only what was marked done", () => {
    for (const s of ["open", "in_progress", "returned", "done", "cancelled"] as TaskStatus[]) {
      expect(moveTask(s, "approve", giver)).toHaveProperty("error");
      expect(moveTask(s, "return", giver)).toHaveProperty("error");
    }
  });

  it("starts a task when its people first write on it, and leaves the state alone otherwise", () => {
    expect(moveTask("open", "note", doer)).toEqual({ next: "in_progress" });
    expect(moveTask("open", "note", giver)).toEqual({ next: "open" });
    expect(moveTask("submitted", "note", doer)).toEqual({ next: "submitted" });
  });

  it("keeps a closed task closed until it is reopened", () => {
    expect(moveTask("done", "note", doer)).toHaveProperty("error");
    expect(moveTask("cancelled", "submit", doer)).toHaveProperty("error");
    expect(moveTask("done", "cancel", giver)).toHaveProperty("error");
    expect(moveTask("in_progress", "reopen", giver)).toHaveProperty("error");
  });

  it("closes a task someone gave only themselves when they mark it done", () => {
    expect(moveTask("in_progress", "submit", both, { selfOnly: true })).toEqual({ next: "done" });
    expect(moveTask("in_progress", "submit", both)).toEqual({ next: "submitted" });
  });
});

describe("movesFor", () => {
  it("offers the doer start and mark done on a new task", () => {
    expect(movesFor("open", doer)).toEqual(["start", "submit"]);
  });
  it("offers the giver approve, return and cancel on a task waiting for review", () => {
    expect(movesFor("submitted", giver)).toEqual(["approve", "return", "cancel"]);
  });
  it("offers only reopen on a closed task", () => {
    expect(movesFor("done", giver)).toEqual(["reopen"]);
    expect(movesFor("done", doer)).toEqual([]);
  });
});

describe("isOverdue", () => {
  it("counts a task in its people's hands past its day", () => {
    expect(isOverdue("in_progress", "2026-10-12", "2026-10-13")).toBe(true);
    expect(isOverdue("returned", "2026-10-12", "2026-10-13")).toBe(true);
  });
  it("does not count its own day, a task without one, or one out of its people's hands", () => {
    expect(isOverdue("open", "2026-10-13", "2026-10-13")).toBe(false);
    expect(isOverdue("open", null, "2026-10-13")).toBe(false);
    expect(isOverdue("submitted", "2026-10-01", "2026-10-13")).toBe(false);
    expect(isOverdue("done", "2026-10-01", "2026-10-13")).toBe(false);
  });
});

describe("cleanDueDate", () => {
  it("takes a real day and refuses the rest", () => {
    expect(cleanDueDate("2026-10-20")).toBe("2026-10-20");
    expect(cleanDueDate(" 2026-10-20 ")).toBe("2026-10-20");
    expect(cleanDueDate("2026-02-30")).toBeNull();
    expect(cleanDueDate("20/10/2026")).toBeNull();
    expect(cleanDueDate("")).toBeNull();
  });
});

const friday = (holidays: string[] = []) => (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay() === 5 || holidays.includes(iso);

describe("checklists", () => {
  it("cleans lines into steps — unticked, ids kept or made, refusing too much", () => {
    expect(cleanChecklist("Sweep\n\n  Wipe   the  bench \nPhoto")).toEqual([
      { id: "s1", text: "Sweep", done: false, by: null, at: null },
      { id: "s2", text: "Wipe the bench", done: false, by: null, at: null },
      { id: "s3", text: "Photo", done: false, by: null, at: null },
    ]);
    // a tick is never taken from what is sent; a repeated id gets a new one
    expect(cleanChecklist([{ id: "a", text: "One", done: true, by: "Sara", at: "x" }, { id: "a", text: "Two" }])).toEqual([
      { id: "a", text: "One", done: false, by: null, at: null },
      { id: "s1", text: "Two", done: false, by: null, at: null },
    ]);
    expect(cleanChecklist(Array.from({ length: 31 }, (_, i) => `Step ${i}`))).toEqual({ error: "At most 30 checklist steps." });
    expect(cleanChecklist(["x".repeat(201)])).toMatchObject({ error: expect.stringContaining("200") });
  });

  it("never gives a new step the id of one the task had", () => {
    // s3 was removed; the new step must not take it (and its tick)
    expect((cleanChecklist([{ id: "s1", text: "A" }, { id: "s2", text: "B" }, { text: "D" }], { taken: ["s1", "s2", "s3"] }) as { id: string }[]).map((x) => x.id))
      .toEqual(["s1", "s2", "s4"]);
  });

  it("reads a stored checklist back, keeping only ticks that read", () => {
    expect(checklistOf("not a list")).toEqual([]);
    expect(checklistOf([
      { id: "s1", text: "A", done: true, by: "Sara", at: "2026-10-26T08:00:00Z" },
      { id: "s2", text: "B", done: true, by: { evil: 1 }, at: "not a date" },
      { text: "no id" },
      "junk",
    ])).toEqual([
      { id: "s1", text: "A", done: true, by: "Sara", at: "2026-10-26T08:00:00Z" },
      { id: "s2", text: "B", done: true, by: null, at: null },
    ]);
  });

  it("ticks a step with who and when, and unticks it", () => {
    const items = cleanChecklist("A\nB") as ReturnType<typeof checklistOf>;
    const ticked = tickItem(items, "s2", true, "Omar", "2026-10-26T08:00:00Z");
    expect(ticked).toEqual([items[0], { id: "s2", text: "B", done: true, by: "Omar", at: "2026-10-26T08:00:00Z" }]);
    expect(checklistProgress(ticked as typeof items)).toEqual({ done: 1, total: 2 });
    expect(tickItem(ticked as typeof items, "s2", false, "Omar", "t")).toEqual(items);
    expect(tickItem(items, "zz", true, "Omar", "t")).toEqual({ error: "That step is not on the checklist any more." });
  });
});

describe("repeating tasks", () => {
  it("cleans a rule, saying what is missing", () => {
    expect(cleanRepeat({ every: "week", weekdays: [3, 0, 3, 9], dueDays: 1 })).toEqual({ every: "week", weekdays: [0, 3], monthDay: null, dueDays: 1 });
    expect(cleanRepeat({ every: "week", weekdays: [] })).toEqual({ error: "Choose the days of the week it comes on." });
    expect(cleanRepeat({ every: "month", monthDay: 32 })).toMatchObject({ error: expect.stringContaining("1–31") });
    expect(cleanRepeat({ every: "hour" })).toMatchObject({ error: expect.any(String) });
    expect(cleanRepeat({ every: "day", dueDays: 31 })).toMatchObject({ error: expect.any(String) });
  });

  it("says how it repeats", () => {
    expect(describeRepeat({ every: "day", weekdays: [], monthDay: null, dueDays: 0 })).toBe("Each working day — due the same day");
    expect(describeRepeat({ every: "week", weekdays: [0, 2], monthDay: null, dueDays: 2 })).toBe("Each Sun, Tue — due in 2 working days");
    expect(describeRepeat({ every: "month", monthDay: 22, weekdays: [], dueDays: 1 })).toBe("Each month on the 22nd — due in 1 working day");
  });

  it("finds the next day it is given — never a day off, a short month's last day for the 31st", () => {
    const off = friday(["2026-11-01"]);
    const daily: RepeatRule = { every: "day", weekdays: [], monthDay: null, dueDays: 0 };
    expect(nextRepeatDay(daily, "2026-10-30", off)).toBe("2026-10-31"); // Friday → Saturday
    const weekly: RepeatRule = { every: "week", weekdays: [0], monthDay: null, dueDays: 0 };
    expect(nextRepeatDay(weekly, "2026-10-26", off)).toBe("2026-11-02"); // Sunday 1 Nov a holiday → Monday
    const monthly: RepeatRule = { every: "month", weekdays: [], monthDay: 31, dueDays: 0 };
    expect(nextRepeatDay(monthly, "2026-11-02", off)).toBe("2026-11-30");
    expect(nextRepeatDay({ ...monthly, monthDay: 1 }, "2026-12-02", off)).toBe("2027-01-02"); // 1 Jan 2027 is a Friday
  });

  it("counts working days to the due day", () => {
    expect(workingDaysAfter("2026-10-29", 1, friday())).toBe("2026-10-31");
    expect(workingDaysAfter("2026-10-29", 0, friday())).toBe("2026-10-29");
    expect(workingDaysAfter("2026-10-30", 0, friday())).toBe("2026-10-31");
  });
});

describe("late and escalated", () => {
  it("is late by so many days only while in its people's hands", () => {
    expect(lateBy("open", "2026-10-20", "2026-10-22", 2)).toBe(true);
    expect(lateBy("open", "2026-10-21", "2026-10-22", 2)).toBe(false);
    expect(lateBy("submitted", "2026-10-01", "2026-10-22", 2)).toBe(false);
    expect(lateBy("open", null, "2026-10-22", 2)).toBe(false);
  });
});

describe("the views", () => {
  const t = (o: Partial<FilterableTask>): FilterableTask => ({
    id: 1, title: "Clean bay 2", status: "open", priority: "normal", dueDate: null, mo: null, overdue: false, createdById: 7, createdByName: "Sara", assignees: [{ id: 9, name: "Omar" }], ...o,
  });
  const list = [
    t({ id: 1 }),
    t({ id: 2, title: "Paint jig", priority: "urgent", dueDate: "2026-10-26", mo: "SF01/MO/5" }),
    t({ id: 3, title: "Order bolts", dueDate: "2026-10-20", overdue: true, assignees: [{ id: 4, name: "Ali" }] }),
    t({ id: 4, title: "Fix fan", dueDate: "2026-11-01" }),
  ];
  const ids = (f: Partial<typeof NO_FILTER>) => filterTasks(list, { ...NO_FILTER, ...f }, "2026-10-26").map((x) => x.id);

  it("filters by words, priority, person and due day", () => {
    expect(ids({})).toEqual([1, 2, 3, 4]);
    expect(ids({ q: "mo/5" })).toEqual([2]);
    expect(ids({ q: "#3" })).toEqual([3]);
    expect(ids({ q: "ali" })).toEqual([3]);
    expect(ids({ priority: "urgent" })).toEqual([2]);
    expect(ids({ person: 4 })).toEqual([3]);
    expect(ids({ person: 7 })).toEqual([1, 2, 3, 4]);
    expect(ids({ due: "late" })).toEqual([3]);
    expect(ids({ due: "today" })).toEqual([2]);
    expect(ids({ due: "week" })).toEqual([2, 4]);
    expect(ids({ due: "none" })).toEqual([1]);
  });

  it("lays a month out in weeks, Sunday first", () => {
    const weeks = monthWeeks("2026-10");
    expect(weeks[0]).toEqual([null, null, null, null, "2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(weeks.at(-1)).toEqual(["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"]);
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });
});

describe("the team's load", () => {
  const s = (o: Partial<StatTask>): StatTask => ({ status: "open", dueDate: null, createdAt: "2026-10-20T08:00:00Z", submittedAt: null, closedAt: null, assignees: [{ id: 9, name: "Omar" }], ...o });
  it("counts each person's open, late and due work, and their last 30 days", () => {
    const rows = teamLoad([
      s({}),
      s({ dueDate: "2026-10-22" }), // late
      s({ status: "in_progress", dueDate: "2026-10-28" }), // due this week
      s({ status: "submitted" }),
      s({ status: "done", dueDate: "2026-10-23", submittedAt: "2026-10-22T10:00:00Z", closedAt: "2026-10-23T10:00:00Z" }), // on time, 3 days
      s({ status: "done", dueDate: "2026-10-21", submittedAt: "2026-10-24T10:00:00Z", closedAt: "2026-10-25T08:00:00Z" }), // late
      s({ status: "done", closedAt: "2026-08-01T10:00:00Z" }), // too old
      s({ assignees: [{ id: 4, name: "Ali" }] }),
    ], "2026-10-26");
    expect(rows[0]).toEqual({ id: 9, name: "Omar", open: 3, late: 1, dueThisWeek: 1, waiting: 1, done30: 2, onTimePct: 50, avgDays: 4 });
    expect(rows[1]).toMatchObject({ id: 4, open: 1, late: 0, done30: 0, onTimePct: null, avgDays: null });
  });
});
