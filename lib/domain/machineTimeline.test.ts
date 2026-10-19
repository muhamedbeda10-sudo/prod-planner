import { describe, expect, it } from "vitest";
import { buildTimeline, dayOffsetOf } from "./machineTimeline";
import type { MachineCard, MachineQueueLine } from "./machineBoard";

const DAYS = ["2026-09-10", "2026-09-11", "2026-09-13", "2026-09-14", "2026-09-15"]; // the 12th is a Friday

const q = (bom: string, hours: number | null, over: Partial<MachineQueueLine> = {}): MachineQueueLine => ({
  key: `${bom}|MO-1|TN`, bom, mo: "MO-1", item: "TN", description: "", remaining: 4, hours,
  deliveryISO: null, route: [{ center: "Cutting", hours }],
  rank: 1, running: false, lineRemaining: 4, split: false, center: "Cutting", step: "Cutting", stepNo: 1, stepCount: 1, sheet: "", sheetDone: 0,
  ...over,
});

const card = (id: number, availableH: number | null, queue: MachineQueueLine[]): MachineCard => ({
  machine: { id, code: `M${id}`, name: `Machine ${id}`, center: "Cutting", hoursPerDay: availableH, active: true },
  queue,
  running: queue.filter((x) => x.running),
  waiting: queue.filter((x) => !x.running),
  now: queue.find((x) => x.running) ?? null,
  pcs: queue.reduce((s, x) => s + x.remaining, 0),
  hours: queue.reduce((s, x) => s + (x.hours ?? 0), 0),
  unpricedPcs: 0, downtimeH: 0, crewH: 0, crew: [],
  availableH,
  load: null,
  days: null,
});

describe("dayOffsetOf", () => {
  it("finds the working day, puts an overdue date at today, and gives up beyond the picture", () => {
    expect(dayOffsetOf("2026-09-13", DAYS)).toBe(2);
    expect(dayOffsetOf("2026-09-01", DAYS)).toBe(0); // already past — due now
    // a Friday inside the picture: due by Thursday, the last working day before it
    expect(dayOffsetOf("2026-09-12", DAYS)).toBe(1);
    expect(dayOffsetOf("2026-10-01", DAYS)).toBeNull(); // past the horizon
    expect(dayOffsetOf(null, DAYS)).toBeNull();
  });
});

describe("buildTimeline", () => {
  it("lays the queue end to end, each block as long as the machine needs", () => {
    const t = buildTimeline([card(1, 10, [q("A", 15, { running: true }), q("B", 5), q("C", 10)])], DAYS);
    expect(t.rows[0].blocks.map((b) => [b.bom, b.startDay, b.endDay])).toEqual([
      ["A", 0, 1.5],
      ["B", 1.5, 2],
      ["C", 2, 3],
    ]);
    expect(t.rows[0].totalDays).toBe(3);
    expect(t.spanDays).toBe(3);
  });

  it("marks the block that lands after the day its stage is due", () => {
    const t = buildTimeline(
      [card(1, 10, [q("A", 25, { dueISO: "2026-09-11" }), q("B", 5, { dueISO: "2026-09-15" })])],
      DAYS
    );
    const [a, b] = t.rows[0].blocks;
    expect(a).toMatchObject({ endDay: 2.5, dueDay: 1, late: true });
    expect(b).toMatchObject({ endDay: 3, dueDay: 4, late: false });
    expect(t.lateCount).toBe(1);
  });

  it("is not late while the work still finishes during the day it was promised", () => {
    // due on day 1, and the machine is still on it at 1.5 — that is within
    // the promised day, so it is on time; a whisker past its end is not
    const ok = buildTimeline([card(1, 10, [q("A", 15, { dueISO: "2026-09-11" })])], DAYS);
    expect(ok.rows[0].blocks[0]).toMatchObject({ endDay: 1.5, dueDay: 1, late: false });
    const bad = buildTimeline([card(1, 10, [q("A", 21, { dueISO: "2026-09-11" })])], DAYS);
    expect(bad.rows[0].blocks[0]).toMatchObject({ endDay: 2.1, late: true });
  });

  it("falls back to the delivery date when the stage has no date of its own", () => {
    const t = buildTimeline([card(1, 10, [q("A", 5, { deliveryISO: "2026-09-13" })])], DAYS);
    expect(t.rows[0].blocks[0].dueDay).toBe(2);
  });

  it("counts what starts past the horizon instead of drawing it", () => {
    const t = buildTimeline([card(1, 10, [q("A", 20), q("B", 10), q("C", 10)])], DAYS, 2);
    expect(t.rows[0].blocks.map((b) => b.bom)).toEqual(["A"]); // B starts on day 2, past the horizon
    expect(t.rows[0].beyond).toBe(2);
    expect(t.rows[0].totalDays).toBe(4); // the whole queue is still counted
  });

  it("gives a line with no standard time no length, and says so", () => {
    const t = buildTimeline([card(1, 10, [q("A", null), q("B", 10)])], DAYS);
    expect(t.rows[0].blocks[0]).toMatchObject({ startDay: 0, endDay: 0, unpriced: true });
    expect(t.rows[0].blocks[1]).toMatchObject({ startDay: 0, endDay: 1 });
  });

  it("draws nothing in time for a machine with no hours a day", () => {
    const t = buildTimeline([card(1, null, [q("A", 10)])], DAYS);
    expect(t.rows[0].blocks[0]).toMatchObject({ startDay: 0, endDay: 0 });
    expect(t.rows[0].availableH).toBeNull();
  });

  it("keeps an idle machine on the picture with an empty track", () => {
    const t = buildTimeline([card(1, 10, []), card(2, 10, [q("A", 10)])], DAYS);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0].blocks).toEqual([]);
    expect(t.rows[0].totalDays).toBe(0);
  });
});
