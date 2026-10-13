import { describe, expect, it } from "vitest";
import { cleanDueDate, isOverdue, moveTask, movesFor, type TaskStatus } from "./tasks";

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
