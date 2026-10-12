import { describe, expect, it } from "vitest";
import { optimizePlan, type OptLine, type OptMachine, type OptStep } from "./optimizePlan";

const m = (id: number, center: string, availableH: number): OptMachine => ({ id, code: `M${id}`, center, availableH });
/** A one-step line, priced as a whole batch — the module works per piece. */
const cut = (key: string, pieces: number, hours: number, dueDay: number | null = null, extra: Partial<OptLine> = {}): OptLine => ({
  key,
  pieces,
  route: [{ center: "Cutting", hoursPerPiece: pieces > 0 ? hours / pieces : 0 }],
  dueDay,
  ...extra,
});
/** One step of a route, priced as a whole batch. */
const step = (center: string, hours: number, pieces: number, over: Partial<OptStep> = {}): OptStep => ({
  center,
  hoursPerPiece: pieces > 0 ? hours / pieces : 0,
  ...over,
});

describe("optimizePlan", () => {
  it("plans the earliest-due line first, whatever order it arrives in", () => {
    const r = optimizePlan([m(1, "Cutting", 10), m(2, "Cutting", 5)], [cut("late", 4, 10, 5), cut("soon", 4, 10, 1)]);
    expect(r.placements.filter((p) => p.key === "soon").every((p) => p.startDay === 0)).toBe(true);
    expect(r.placements.filter((p) => p.key === "late").every((p) => p.startDay > 0)).toBe(true);
    expect(r.late).toEqual([]);
    expect(r.linesPlaced).toBe(2);
  });

  it("gives a short job to the machine that finishes it soonest, whole", () => {
    const r = optimizePlan([m(1, "Cutting", 10), m(2, "Cutting", 5)], [cut("small", 4, 4, 1)]);
    expect(r.placements).toHaveLength(1);
    expect(r.placements[0]).toMatchObject({ machineId: 1, pieces: 4, endDay: 0.4 });
  });

  it("walks the route in order — nothing is bent before it is cut", () => {
    const r = optimizePlan(
      [m(1, "Cutting", 10), m(2, "Bending", 10), m(3, "Fins", 10)],
      [{ key: "TN", pieces: 10, dueDay: 9, route: [step("Cutting", 20, 10), step("Bending", 10, 10), step("Fins", 10, 10)] }]
    );
    const at = (c: string) => r.placements.find((p) => p.center === c)!;
    expect(at("Cutting")).toMatchObject({ machineId: 1, startDay: 0, endDay: 2 });
    expect(at("Bending")).toMatchObject({ machineId: 2, startDay: 2, endDay: 3 });
    expect(at("Fins")).toMatchObject({ machineId: 3, startDay: 3, endDay: 4 });
    expect(r.spanDays).toBe(4);
  });

  it("splits a long batch over parallel machines so it finishes sooner", () => {
    const r = optimizePlan([m(1, "Cutting", 10), m(2, "Cutting", 10)], [cut("big", 20, 40, 2)]);
    expect(r.placements).toHaveLength(2);
    expect(r.placements.map((p) => p.pieces).sort((a, b) => a - b)).toEqual([10, 10]);
    expect(r.placements.every((p) => p.endDay === 2)).toBe(true); // 40 h over 20 h/day
    expect(r.machinesUsed).toBe(2);
  });

  it("keeps a small batch whole rather than slicing it for nothing", () => {
    const r = optimizePlan([m(1, "Cutting", 10), m(2, "Cutting", 10)], [cut("tiny", 3, 0.4, 1)]);
    expect(r.placements).toHaveLength(1);
    expect(r.placements[0].pieces).toBe(3);
  });

  it("plans around what is already running on a machine", () => {
    const r = optimizePlan(
      [m(1, "Cutting", 10), m(2, "Cutting", 10)],
      [cut("next", 5, 10, 3)],
      [{ key: "running", center: "Cutting", machineId: 1, pieces: 5, hours: 30 }]
    );
    expect(r.placements[0].machineId).toBe(2); // machine 1 is busy for three days
    expect(r.placements[0].endDay).toBe(1);
  });

  it("does not re-place a step that is already running, and starts the next step after it", () => {
    const r = optimizePlan(
      [m(1, "Cutting", 10), m(2, "Bending", 10)],
      [{ key: "TN", pieces: 10, dueDay: 5, route: [step("Cutting", 0, 10, { pieces: 0 }), step("Bending", 10, 10)] }],
      [{ key: "TN", center: "Cutting", machineId: 1, pieces: 10, hours: 20 }]
    );
    expect(r.placements.map((p) => p.center)).toEqual(["Bending"]);
    expect(r.placements[0]).toMatchObject({ startDay: 2, endDay: 3 });
  });

  it("plans the pieces of a step that the running work does not cover", () => {
    const r = optimizePlan(
      [m(1, "Cutting", 10), m(2, "Cutting", 10)],
      [{ key: "TN", pieces: 12, dueDay: 5, route: [step("Cutting", 3, 7, { pieces: 7 })] }],
      [{ key: "TN", center: "Cutting", machineId: 1, pieces: 5, hours: 5 }]
    );
    expect(r.placements).toHaveLength(1);
    expect(r.placements[0]).toMatchObject({ machineId: 2, pieces: 7 });
  });

  it("says which lines land late and by how much, worst first", () => {
    const r = optimizePlan([m(1, "Cutting", 10)], [cut("a", 10, 30, 1), cut("b", 10, 10, 2)]);
    expect(r.late.map((x) => [x.key, x.byDays])).toEqual([["a", 2], ["b", 2]]);
    expect(r.spanDays).toBe(4);
  });

  it("reports a centre with no machine instead of dropping the work", () => {
    const r = optimizePlan(
      [m(1, "Cutting", 10)],
      [{ key: "CF", pieces: 4, dueDay: 2, route: [step("Cutting", 4, 4), step("Bending", 2, 4)] }]
    );
    expect(r.skipped).toEqual([{ key: "CF", center: "Bending", reason: "no machine" }]);
    expect(r.placements).toHaveLength(1);
  });

  it("ranks each machine's queue in the order it will run, and counts unpriced lines", () => {
    const r = optimizePlan([m(1, "Cutting", 10)], [cut("first", 2, 5, 1), cut("second", 2, 5, 2), cut("free", 2, 0, 3)]);
    const ranks = r.placements.filter((p) => p.machineId === 1).sort((a, b) => a.rank - b.rank).map((p) => p.key);
    expect(ranks).toEqual(["first", "second", "free"]);
    expect(r.unpriced).toBe(1);
  });

  it("puts a dateless line behind every dated one, and a flagged order first among equals", () => {
    const r = optimizePlan([m(1, "Cutting", 10)], [cut("none", 1, 5, null), cut("plain", 1, 5, 2), cut("urgent", 1, 5, 2, { urgent: true })]);
    const order = r.placements.sort((a, b) => a.rank - b.rank).map((p) => p.key);
    expect(order).toEqual(["urgent", "plain", "none"]);
  });

  it("gives the work to the machine that is really faster at that item", () => {
    // both have the same hours a day; the planner has measured machine 2 at
    // twice the speed for this item, so it should take the batch
    const r = optimizePlan(
      [m(1, "Cutting", 10), m(2, "Cutting", 10)],
      [{ key: "TC", pieces: 4, dueDay: 1, route: [{ center: "Cutting", hoursPerPiece: 1, perMachine: { 2: 0.5 } }] }]
    );
    expect(r.placements).toHaveLength(1);
    expect(r.placements[0]).toMatchObject({ machineId: 2, pieces: 4, endDay: 0.2 });
  });

  it("splits between machines of different speeds so both finish together", () => {
    const r = optimizePlan(
      [m(1, "Cutting", 10), m(2, "Cutting", 10)],
      [{ key: "TC", pieces: 30, dueDay: 2, route: [{ center: "Cutting", hoursPerPiece: 1, perMachine: { 2: 0.5 } }] }]
    );
    // 10 pieces a day on one, 20 on the other → 30 pieces clear in a day
    expect(r.placements.every((p) => p.endDay === 1)).toBe(true);
    const by = Object.fromEntries(r.placements.map((p) => [p.machineId, p.pieces]));
    expect(by).toEqual({ 1: 10, 2: 20 });
  });

  it("ignores a machine nobody gave hours to", () => {
    const r = optimizePlan([m(1, "Cutting", 0), m(2, "Cutting", 8)], [cut("a", 4, 8, 1)]);
    expect(r.placements.map((p) => p.machineId)).toEqual([2]);
  });
});

describe("optimizePlan and the machines' rules", () => {
  it("puts a line only on the machines its rules allow", () => {
    const line = { key: "thick", pieces: 4, dueDay: 2, route: [step("Cutting", 4, 4, { allowed: [2] })] };
    const r = optimizePlan([m(1, "Cutting", 10), m(2, "Cutting", 5)], [line]);
    expect(r.placements.map((p) => p.machineId)).toEqual([2]);
  });

  it("leaves a line no machine's rules allow, saying so apart from a centre with no machine", () => {
    const r = optimizePlan(
      [m(1, "Cutting", 10)],
      [
        { key: "ruled", pieces: 4, dueDay: 2, route: [step("Cutting", 4, 4, { allowed: [] })] },
        { key: "bent", pieces: 4, dueDay: 2, route: [step("Bending", 4, 4)] },
      ]
    );
    expect(r.placements).toEqual([]);
    expect([...r.skipped].sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: "bent", center: "Bending", reason: "no machine" },
      { key: "ruled", center: "Cutting", reason: "not allowed" },
    ]);
  });

  it("gives the preferred machine the work unless another could start it over half a day sooner", () => {
    // both free: the preferred one takes it although the other is faster
    const free = optimizePlan([m(1, "Cutting", 10), m(2, "Cutting", 5)], [cut("p", 2, 1, 3, { route: [step("Cutting", 1, 2, { preferred: [2] })] })]);
    expect(free.placements.map((p) => p.machineId)).toEqual([2]);
    // the preferred one busy for two days: the free one takes it
    const busy = optimizePlan(
      [m(1, "Cutting", 10), m(2, "Cutting", 5)],
      [cut("p", 2, 1, 3, { route: [step("Cutting", 1, 2, { preferred: [2] })] })],
      [{ key: "running", center: "Cutting", machineId: 2, pieces: 1, hours: 10 }]
    );
    expect(busy.placements.map((p) => p.machineId)).toEqual([1]);
  });

  it("splits only over the machines the rules allow", () => {
    const big = { key: "big", pieces: 30, dueDay: 9, route: [step("Cutting", 60, 30, { allowed: [1, 3] })] };
    const r = optimizePlan([m(1, "Cutting", 10), m(2, "Cutting", 10), m(3, "Cutting", 10)], [big]);
    expect(new Set(r.placements.map((p) => p.machineId))).toEqual(new Set([1, 3]));
  });
});
