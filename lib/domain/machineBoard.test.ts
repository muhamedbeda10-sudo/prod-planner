import { describe, expect, it } from "vitest";
import { buildMachineBoard, lineKey, loadTone, urgencyOrder, type BoardLine, type BoardMachine } from "./machineBoard";

const m = (id: number, over: Partial<BoardMachine> = {}): BoardMachine => ({ id, code: `B4-${id}`, name: `Laser ${id}`, center: "Cutting", hoursPerDay: 9, active: true, ...over });
const l = (bom: string, item: string, remaining: number, hours: number | null, deliveryISO: string | null = "2026-09-12", mo = "MO-1"): BoardLine => ({
  key: lineKey(bom, mo, item), bom, mo, item, description: "", remaining, hours, deliveryISO,
});

describe("buildMachineBoard", () => {
  const machines = [m(1), m(2, { hoursPerDay: null }), m(3, { active: false })];
  const lines = [
    l("A", "TN", 10, 6),
    l("B", "TC", 4, 1.5, "2026-09-11"),
    l("C", "CF", 3, null, null),
    l("D", "CB", 0, 2), // finished — off the board
    l("E", "TN", 5, 3, "2026-09-15"),
  ];
  const assignments = [
    { key: lineKey("B", "MO-1", "TC"), machineId: 1, rank: 2 },
    { key: lineKey("A", "MO-1", "TN"), machineId: 1, rank: 1, running: true },
    { key: lineKey("C", "MO-1", "CF"), machineId: 2, rank: 1, running: true },
    { key: lineKey("D", "MO-1", "CB"), machineId: 1, rank: 0 },
  ];

  it("queues each machine in rank order and prices the queue", () => {
    const b = buildMachineBoard(machines, lines, assignments, { downtimeH: { 1: 2 }, crewH: { 1: 23 } });
    const c1 = b.cards.find((c) => c.machine.id === 1)!;
    expect(c1.queue.map((q) => [q.bom, q.rank, q.running])).toEqual([["A", 1, true], ["B", 2, false]]);
    expect(c1.now?.bom).toBe("A");
    expect(c1.running.map((q) => q.bom)).toEqual(["A"]);
    expect(c1.waiting.map((q) => q.bom)).toEqual(["B"]);
    expect(c1.pcs).toBe(14);
    expect(c1.hours).toBe(7.5);
    expect(c1.availableH).toBe(7); // 9 − 2 down
    expect(c1.load).toBe(1.07);
    expect(c1.days).toBe(1.1);
    expect(c1.crewH).toBe(23);
  });

  it("leaves the load unknown on a machine with no hours figure, and counts unpriced pieces", () => {
    const b = buildMachineBoard(machines, lines, assignments);
    const c2 = b.cards.find((c) => c.machine.id === 2)!;
    expect(c2.availableH).toBeNull();
    expect(c2.load).toBeNull();
    expect(c2.unpricedPcs).toBe(3);
    expect(b.totalAvailableH).toBeNull();
  });

  it("hides a retired machine with nothing on it and lists the rest as unassigned, urgent first", () => {
    const b = buildMachineBoard(machines, lines, assignments);
    expect(b.cards.map((c) => c.machine.id)).toEqual([1, 2]);
    expect(b.unassigned.map((u) => u.bom)).toEqual(["E"]);
  });

  it("puts every running line first, whatever its rank, and the waiting ones after", () => {
    const b = buildMachineBoard([m(1)], lines, [
      { key: lineKey("A", "MO-1", "TN"), machineId: 1, rank: 3 },
      { key: lineKey("B", "MO-1", "TC"), machineId: 1, rank: 1, running: true },
      { key: lineKey("E", "MO-1", "TN"), machineId: 1, rank: 2, running: true },
    ]);
    const c = b.cards[0];
    expect(c.queue.map((q) => q.bom)).toEqual(["B", "E", "A"]);
    expect(c.running).toHaveLength(2);
    expect(c.waiting.map((q) => q.bom)).toEqual(["A"]);
    expect(c.now?.bom).toBe("B");
  });

  it("merges two tranches of one line into one board line", () => {
    const b = buildMachineBoard([m(1)], [l("A", "TN", 3, 2, "2026-09-12"), l("A", "TN", 2, 1, "2026-09-10")], [{ key: lineKey("A", "MO-1", "TN"), machineId: 1, rank: 1 }]);
    expect(b.cards[0].queue).toHaveLength(1);
    expect(b.cards[0].queue[0].remaining).toBe(5);
    expect(b.cards[0].queue[0].hours).toBe(3);
    expect(b.cards[0].queue[0].deliveryISO).toBe("2026-09-10");
  });

  it("sums the day's available hours when every active machine has a figure", () => {
    const b = buildMachineBoard([m(1), m(2, { hoursPerDay: 8 }), m(3, { active: false, hoursPerDay: null })], lines, []);
    expect(b.totalAvailableH).toBe(17);
    expect(b.cards).toHaveLength(2);
  });
});

describe("urgencyOrder", () => {
  it("puts the earliest delivery first and date-less lines last", () => {
    const rows = [l("B", "TN", 1, 1, null), l("A", "TN", 1, 1, "2026-09-12"), l("C", "TN", 1, 1, "2026-09-11")].sort(urgencyOrder);
    expect(rows.map((r) => r.bom)).toEqual(["C", "A", "B"]);
  });
});

describe("loadTone", () => {
  it("is fine to a day, amber past it, red past a day and a half", () => {
    expect(loadTone(0.8)).toBe("ok");
    expect(loadTone(1)).toBe("ok");
    expect(loadTone(1.3)).toBe("warn");
    expect(loadTone(2)).toBe("bad");
    expect(loadTone(null)).toBeNull();
  });
});
