import { describe, expect, it } from "vitest";
import { buildMachineBoard, clearWords, lineKey, loadTone, urgencyOrder, type BoardLine, type BoardMachine } from "./machineBoard";

const m = (id: number, over: Partial<BoardMachine> = {}): BoardMachine => ({ id, code: `B4-${id}`, name: `Laser ${id}`, center: "Cutting", hoursPerDay: 9, active: true, ...over });
const l = (bom: string, item: string, remaining: number, hours: number | null, deliveryISO: string | null = "2026-09-12", mo = "MO-1"): BoardLine => ({
  key: lineKey(bom, mo, item), bom, mo, item, description: "", remaining, hours, deliveryISO,
  route: [{ center: "Cutting", hours }],
});
/** A line that owes work at several centres — a tank is cut, bent, then finned. */
const routed = (bom: string, item: string, remaining: number, steps: [string, number][], deliveryISO: string | null = "2026-09-12", mo = "MO-1"): BoardLine => ({
  key: lineKey(bom, mo, item), bom, mo, item, description: "", remaining,
  hours: steps.reduce((s, [, h]) => s + h, 0), deliveryISO,
  route: steps.map(([center, hours]) => ({ center, hours })),
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

  it("splits a line over machines by the pieces given, the rest waiting unassigned", () => {
    const b = buildMachineBoard([m(1), m(2)], [l("A", "TN", 20, 10, "2026-09-12")], [
      { key: lineKey("A", "MO-1", "TN"), machineId: 1, rank: 1, running: true, qty: 12 },
      { key: lineKey("A", "MO-1", "TN"), machineId: 2, rank: 1, qty: 5 },
    ]);
    const [c1, c2] = b.cards;
    expect(c1.queue.map((q) => [q.remaining, q.hours, q.split, q.lineRemaining])).toEqual([[12, 6, true, 20]]);
    expect(c2.queue.map((q) => [q.remaining, q.hours, q.split])).toEqual([[5, 2.5, true]]);
    expect(b.unassigned).toHaveLength(1);
    expect(b.unassigned[0]).toMatchObject({ bom: "A", remaining: 3, hours: 1.5, lineRemaining: 20, partial: true });
    expect(b.totalHours).toBe(8.5);
  });

  it("gives a share with no quantity whatever the fixed shares leave, and drops one that gets nothing", () => {
    const b = buildMachineBoard([m(1), m(2), m(3, { active: true })], [l("A", "TN", 20, 10)], [
      { key: lineKey("A", "MO-1", "TN"), machineId: 1, rank: 1 },
      { key: lineKey("A", "MO-1", "TN"), machineId: 2, rank: 1, qty: 15 },
      { key: lineKey("A", "MO-1", "TN"), machineId: 3, rank: 1, qty: 50 }, // more than the line: capped to what is left
    ]);
    const by = Object.fromEntries(b.cards.map((c) => [c.machine.id, c.queue.map((q) => q.remaining)]));
    expect(by).toEqual({ 1: [], 2: [15], 3: [5] });
    expect(b.unassigned).toEqual([]);
    expect(b.cards.find((c) => c.machine.id === 2)!.queue[0].split).toBe(true);
  });

  it("marks a whole line on one machine as not split", () => {
    const b = buildMachineBoard([m(1)], [l("A", "TN", 20, 10)], [{ key: lineKey("A", "MO-1", "TN"), machineId: 1, rank: 1, qty: 20 }]);
    expect(b.cards[0].queue[0]).toMatchObject({ remaining: 20, split: false, lineRemaining: 20 });
    expect(b.unassigned).toEqual([]);
  });

  it("queues a line at every centre of its route, and asks for the ones still missing", () => {
    const shop = [m(1, { center: "Cutting" }), m(2, { center: "Bending" }), m(3, { center: "Fins" })];
    const tank = routed("A", "TN", 10, [["Cutting", 6], ["Bending", 3], ["Fins", 4]]);
    const b = buildMachineBoard(shop, [tank], [
      { key: lineKey("A", "MO-1", "TN"), machineId: 1, rank: 1, running: true },
      { key: lineKey("A", "MO-1", "TN"), machineId: 2, rank: 1 },
    ]);
    // the SAME ten pieces are owed to cutting and to bending — not six and four
    expect(b.cards[0].queue[0]).toMatchObject({ remaining: 10, hours: 6, center: "Cutting", split: false, stepNo: 1, stepCount: 3 });
    expect(b.cards[1].queue[0]).toMatchObject({ remaining: 10, hours: 3, center: "Bending", stepNo: 2 });
    expect(b.cards[2].queue).toEqual([]);
    expect(b.unassigned).toHaveLength(1);
    expect(b.unassigned[0]).toMatchObject({ center: "Fins", remaining: 10, hours: 4, partial: false, stepNo: 3 });
    expect(b.totalHours).toBe(9);
  });

  it("splits the pieces of ONE centre without touching the others", () => {
    const shop = [m(1, { center: "Cutting" }), m(2, { center: "Cutting" }), m(3, { center: "Bending" })];
    const b = buildMachineBoard(shop, [routed("A", "CF", 10, [["Cutting", 10], ["Bending", 5]])], [
      { key: lineKey("A", "MO-1", "CF"), machineId: 1, rank: 1, qty: 6 },
      { key: lineKey("A", "MO-1", "CF"), machineId: 2, rank: 1 },
      { key: lineKey("A", "MO-1", "CF"), machineId: 3, rank: 1 },
    ]);
    expect(b.cards.map((c) => c.queue.map((q) => [q.center, q.remaining, q.hours]))).toEqual([
      [["Cutting", 6, 6]], [["Cutting", 4, 4]], [["Bending", 10, 5]],
    ]);
    expect(b.unassigned).toEqual([]);
  });

  it("lists what a centre still lacks even when the line runs elsewhere on its route", () => {
    const shop = [m(1, { center: "Cutting" }), m(2, { center: "Bending" })];
    const b = buildMachineBoard(shop, [routed("A", "CB", 8, [["Cutting", 8], ["Bending", 4]])], [
      { key: lineKey("A", "MO-1", "CB"), machineId: 1, rank: 1, qty: 5 },
    ]);
    expect(b.unassigned.map((u) => [u.center, u.remaining, u.partial])).toEqual([["Cutting", 3, true], ["Bending", 8, false]]);
  });

  it("prices a machine off the route as the step it stands in for", () => {
    const shop = [m(1, { center: "Cutting" }), m(2, { center: "Tubes" })];
    const b = buildMachineBoard(shop, [routed("A", "TC", 4, [["Cutting", 8]])], [
      { key: lineKey("A", "MO-1", "TC"), machineId: 2, rank: 1 },
    ]);
    // the tube laser is doing that line's cutting — same hours, and cutting is
    // no longer asking for it
    expect(b.cards[1].queue[0]).toMatchObject({ center: "Tubes", step: "Cutting", hours: 8, remaining: 4 });
    expect(b.unassigned).toEqual([]);
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

describe("clearWords", () => {
  it("answers in hours while the queue is under a day, in days once it is more", () => {
    expect(clearWords(6, 9)).toBe("6 h");
    expect(clearWords(9, 9)).toBe("1 day");
    expect(clearWords(23, 9)).toBe("2.6 days");
    expect(clearWords(4.25, null)).toBe("4.3 h"); // no hours a day set — the hours are all it can say
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
