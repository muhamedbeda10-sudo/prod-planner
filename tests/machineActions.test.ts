import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "@prisma/client";

// ---- who may schedule what on the shared machines ---------------------------
// The punches, welding partitions and paint lines carry panels beside
// transformer parts. A line on them is scheduled — put on, split, ticked done,
// taken off, moved, started — with the LINE's key: a panel's the LV stage's
// (the punches punch it), a transformer part's the bay's. A write over a whole
// machine or bay (Empty, ⟲ reset, ⚡ plan) acts on the lines the account's
// keys cover and leaves the other line's work where it is. These drive the
// real actions through the REAL guard — the session, then the account's
// ticks — with only the cookie jar, the database and the optimizer's loader
// standing in.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      session: { findUnique: fn() },
      machine: { findUnique: fn() },
      worklistMachine: { findMany: fn(), findUnique: fn(), update: fn(), create: fn(), delete: fn(), deleteMany: fn(), count: fn(), aggregate: fn() },
      manualJob: { findUnique: fn() },
      sheetCutLog: { create: fn() },
      $transaction: fn(),
    },
    getOptimizerInputs: fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "session-token" }) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/machineBoard", () => ({ getOptimizerInputs: h.getOptimizerInputs }));
vi.mock("@/lib/server/machineMaterial", () => ({ getLinesMaterial: vi.fn() }));

import { assignLineMachine, clearMachineQueue, moveLineRank, optimizeMachines, resetMachinePlan, setLineQty, setLineRunning, unassignLineMachine } from "@/app/worklist/machineActions";
import { bayAccess } from "@/lib/server/auth";
import { ACCESS_PERM_KEYS, bayPermKeys, mayScheduleLine } from "@/lib/domain/permissions";
import { BOARD_LINE_REFUSED, boardTakesLine } from "@/lib/domain/machineBoard";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** Signed in as an account holding exactly these keys — no admin, no owner. */
function holding(...keys: string[]) {
  const user = { id: 1, name: "tester", isAdmin: false, isOwner: false, perms: keys.join(","), hiddenTabs: "", active: true };
  h.prisma.session.findUnique.mockResolvedValue({ expiresAt: new Date(Date.now() + 86_400_000), user });
  return user as unknown as User;
}

const NO = { ok: false, error: "You do not have permission for this action — ask the admin." };

/** One line waiting on machine 1 of a bay, as the database holds it. */
function onMachine(bay: string, item: string) {
  const row = { id: 5, dept: bay, bom: "B-1", mo: "MO-1", item, machineId: 1, sheet: "", rank: 1, running: false, qty: null, sheetDone: 0 };
  h.prisma.machine.findUnique.mockResolvedValue({ id: 1, dept: bay, active: true, code: "M1" });
  h.prisma.worklistMachine.findUnique.mockResolvedValue(row);
  h.prisma.worklistMachine.findMany.mockResolvedValue([row]);
}

/** Every single-line action the board offers, on that line. */
function lineActions(bay: string, item: string) {
  const line = { dept: bay, bom: "B-1", mo: "MO-1", item, machineId: "1" };
  return {
    "put on": () => assignLineMachine(form(line)),
    split: () => setLineQty(form({ ...line, qty: "2" })),
    "take off": () => unassignLineMachine(form(line)),
    "next in line": () => moveLineRank(form({ ...line, dir: "top" })),
    start: () => setLineRunning(form({ ...line, running: "true" })),
  };
}

/** Every write the actions made to the machines' rows. */
const writes = () =>
  [h.prisma.worklistMachine.update, h.prisma.worklistMachine.create, h.prisma.worklistMachine.delete, h.prisma.worklistMachine.deleteMany, h.prisma.sheetCutLog.create]
    .reduce((n, f) => n + f.mock.calls.length, 0);

beforeEach(() => {
  vi.resetAllMocks();
  // the array form runs its writes; the callback form gets the client itself
  h.prisma.$transaction.mockImplementation(async (arg: unknown) => (typeof arg === "function" ? arg(h.prisma) : Promise.all(arg as unknown[])));
  for (const f of [h.prisma.worklistMachine.update, h.prisma.worklistMachine.create, h.prisma.worklistMachine.delete, h.prisma.sheetCutLog.create]) f.mockResolvedValue({});
  h.prisma.worklistMachine.deleteMany.mockResolvedValue({ count: 0 });
  h.prisma.worklistMachine.count.mockResolvedValue(0);
  h.prisma.worklistMachine.aggregate.mockResolvedValue({ _max: { rank: 0 } });
});

describe("a line on the shared machines is scheduled with the line's key, never the bay's", () => {
  it.each([
    ["Cut", "lv.punching", "cut.edit"], // the fabrication bay's punches punch it
    ["Welding", "lv.welding", "welding.edit"],
    ["Painting", "lv.painting", "painting.edit"],
  ])("a panel on the %s bay: every action with %s, none with %s", async (bay, lvKey, bayKey) => {
    onMachine(bay, "PNL");
    holding(bayKey);
    for (const [name, act] of Object.entries(lineActions(bay, "PNL"))) expect(await act(), name).toEqual(NO);
    expect(writes()).toBe(0);
    holding(lvKey);
    for (const [name, act] of Object.entries(lineActions(bay, "PNL"))) expect(await act(), name).toEqual({ ok: true });
    expect(writes()).toBeGreaterThan(0);
  });

  it("a transformer part stays the bay's — the LV key schedules none of it", async () => {
    onMachine("Welding", "CF");
    holding("lv.welding");
    for (const [name, act] of Object.entries(lineActions("Welding", "CF"))) expect(await act(), name).toEqual(NO);
    expect(writes()).toBe(0);
    holding("welding.edit");
    for (const [name, act] of Object.entries(lineActions("Welding", "CF"))) expect(await act(), name).toEqual({ ok: true });
  });

  it("the fabrication machines take sheet jobs: a transformer part is refused even with the bay's key, an open job goes on", async () => {
    onMachine("Cut", "CF");
    holding("cut.edit");
    expect(await assignLineMachine(form({ dept: "Cut", bom: "B-1", mo: "MO-1", item: "CF", machineId: "1" }))).toEqual({ ok: false, error: BOARD_LINE_REFUSED });
    expect(writes()).toBe(0);
    const job = { dept: "Cut", bom: "MANUAL", mo: "MANUAL-7", item: "JOB", machineId: "1" };
    h.prisma.worklistMachine.findMany.mockResolvedValue([]);
    h.prisma.manualJob.findUnique.mockResolvedValueOnce({ dept: "Cut", doneAt: new Date() });
    expect(await assignLineMachine(form(job))).toEqual({ ok: false, error: expect.stringContaining("finished") });
    h.prisma.manualJob.findUnique.mockResolvedValueOnce({ dept: "Welding", doneAt: null });
    expect(await assignLineMachine(form(job))).toEqual({ ok: false, error: expect.stringContaining("gone") });
    h.prisma.manualJob.findUnique.mockResolvedValueOnce({ dept: "Cut", doneAt: null });
    expect(await assignLineMachine(form({ ...job, qty: "3" }))).toEqual({ ok: true });
    expect(h.prisma.worklistMachine.create).toHaveBeenCalledWith({ data: expect.objectContaining({ bom: "MANUAL", mo: "MANUAL-7", item: "JOB", qty: 3 }) });
  });

  it("a sheet job's share on a machine may be part of a sheet; a plan line's pieces stay whole", async () => {
    onMachine("Cut", "CF");
    holding("cut.edit");
    const job = { dept: "Cut", bom: "MANUAL", mo: "MANUAL-7", item: "JOB", machineId: "1" };
    h.prisma.worklistMachine.findMany.mockResolvedValue([]);
    h.prisma.manualJob.findUnique.mockResolvedValue({ dept: "Cut", doneAt: null });
    expect(await assignLineMachine(form({ ...job, qty: "1.5" }))).toEqual({ ok: true });
    expect(h.prisma.worklistMachine.create).toHaveBeenCalledWith({ data: expect.objectContaining({ mo: "MANUAL-7", qty: 1.5 }) });
    expect(await assignLineMachine(form({ ...job, qty: "0.125" }))).toEqual({ ok: false, error: expect.stringContaining("two decimals at most") });
    onMachine("Welding", "CF");
    holding("welding.edit");
    expect(await assignLineMachine(form({ dept: "Welding", bom: "B-1", mo: "MO-1", item: "CF", machineId: "1", qty: "1.5" }))).toEqual({ ok: false, error: expect.stringContaining("whole number") });
  });

  it("a panel on shot blast, which takes none, is no one's — not even an admin's", async () => {
    onMachine("ShotBlast", "PNL");
    const admin = { id: 1, name: "admin", isAdmin: true, isOwner: false, perms: ACCESS_PERM_KEYS.join(","), hiddenTabs: "", active: true };
    h.prisma.session.findUnique.mockResolvedValue({ expiresAt: new Date(Date.now() + 86_400_000), user: admin });
    expect(await assignLineMachine(form({ dept: "ShotBlast", bom: "B-1", mo: "MO-1", item: "PNL", machineId: "1" }))).toEqual(NO);
  });

  it("the screen offers exactly what the guard lets through", async () => {
    for (const bay of ["Cut", "Welding", "Painting"]) {
      for (const key of Object.values(bayPermKeys(bay))) {
        const user = holding(key!);
        for (const item of ["CF", "PNL"]) {
          onMachine(bay, item);
          const done = await assignLineMachine(form({ dept: bay, bom: "B-1", mo: "MO-1", item, machineId: "1" }));
          expect(done.ok, `${bay}, holding ${key}, a ${item}`).toBe(mayScheduleLine(bayAccess(user, bay), item) && boardTakesLine(bay, "B-1", item));
        }
      }
    }
  });
});

describe("⏫ ▲ ▼ move a line among the account's own lines — the other line's keep their places", () => {
  // the punch's waiting queue: transformer parts and panels, interleaved
  const queue = [
    { id: 1, item: "CF" },
    { id: 2, item: "PNL" },
    { id: 3, item: "TC" },
    { id: 4, item: "PNL" },
  ].map((r, i) => ({ ...r, dept: "Cut", bom: "B-1", mo: `MO-${r.id}`, machineId: 1, sheet: "", rank: i + 1, running: false, qty: null, sheetDone: 0 }));

  /** Move row `id`, and the queue's order (row ids) as the move wrote it. */
  async function move(id: number, dir: "top" | "up" | "down") {
    const row = queue.find((r) => r.id === id)!;
    h.prisma.worklistMachine.findUnique.mockResolvedValue(row);
    h.prisma.worklistMachine.findMany.mockResolvedValue(queue);
    expect(await moveLineRank(form({ dept: "Cut", bom: row.bom, mo: row.mo, item: row.item, machineId: "1", dir }))).toEqual({ ok: true });
    const ranks: [number, number][] = h.prisma.worklistMachine.update.mock.calls.map(([a]) => [a.where.id, a.data.rank]);
    return ranks.sort((x, y) => x[1] - y[1]).map(([rowId]) => rowId);
  }

  it("the transformers' planner reorders the parts; the panels keep the 2nd and 4th places", async () => {
    holding("cut.edit");
    expect(await move(3, "top")).toEqual([3, 2, 1, 4]);
  });

  it("the panel clerk reorders the panels; the parts keep the 1st and 3rd places", async () => {
    holding("lv.punching");
    expect(await move(4, "up")).toEqual([1, 4, 3, 2]);
  });

  it("holding both lines' keys, a move passes any line, as before", async () => {
    holding("cut.edit", "lv.punching");
    expect(await move(3, "top")).toEqual([3, 1, 2, 4]);
  });

  it("a move with none of the account's own lines to pass changes nothing", async () => {
    holding("cut.edit");
    expect(await move(1, "up")).toEqual([]);
    expect(await move(3, "down")).toEqual([]);
  });
});

describe("a whole machine or bay — Empty, ⟲ reset, ⚡ plan — the lines the account's keys cover", () => {
  it.each([
    [["cut.edit"], { item: { not: "PNL" } }],
    [["lv.punching"], { item: "PNL" }],
    [["cut.edit", "lv.punching"], {}],
  ])("Empty, holding %j, takes %j off the punch", async (keys, only) => {
    holding(...keys);
    expect(await clearMachineQueue(form({ dept: "Cut", machineId: "1" }))).toEqual({ ok: true });
    expect(h.prisma.worklistMachine.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { dept: "Cut", machineId: 1, ...only } });
  });

  it("refuses an account that schedules neither line on the bay", async () => {
    holding("welding.edit", "lv.welding");
    expect(await clearMachineQueue(form({ dept: "Cut", machineId: "1" }))).toEqual(NO);
    expect(await resetMachinePlan(form({ dept: "Cut" }))).toEqual(NO);
    expect(await optimizeMachines(form({ dept: "Cut" }))).toEqual(NO);
    expect(h.prisma.worklistMachine.deleteMany).not.toHaveBeenCalled();
    expect(h.getOptimizerInputs).not.toHaveBeenCalled();
  });

  it("⟲ clears the account's own line and says the other line's stayed", async () => {
    holding("cut.edit");
    h.prisma.worklistMachine.deleteMany.mockResolvedValue({ count: 5 });
    h.prisma.worklistMachine.count.mockResolvedValue(3);
    const res = await resetMachinePlan(form({ dept: "Cut" }));
    expect(h.prisma.worklistMachine.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { dept: "Cut", item: { not: "PNL" } } });
    expect(h.prisma.worklistMachine.count).toHaveBeenCalledExactlyOnceWith({ where: { dept: "Cut", item: "PNL" } });
    expect(res).toEqual({ ok: true, summary: "Cleared — 5 transformer line(s) taken off the machines. The panel lines stay where they are." });
  });

  it("⟲ with nothing of the account's own says so", async () => {
    holding("lv.punching");
    h.prisma.worklistMachine.count.mockResolvedValue(2);
    expect(await resetMachinePlan(form({ dept: "Cut" }))).toEqual({ ok: true, summary: "No panel line was on a machine. The transformer lines stay where they are." });
  });

  it("⟲ holding both lines' keys clears everything and reads as it always did", async () => {
    holding("cut.edit", "lv.punching");
    h.prisma.worklistMachine.deleteMany.mockResolvedValue({ count: 8 });
    const res = await resetMachinePlan(form({ dept: "Cut" }));
    expect(h.prisma.worklistMachine.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { dept: "Cut" } });
    expect(h.prisma.worklistMachine.count).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, summary: "Cleared — 8 line(s) taken off the machines." });
  });

  // one punch, nothing running on it, a panel batch waiting at rank 7 — and
  // one transformer part for the plan to place
  function onPunch() {
    h.getOptimizerInputs.mockResolvedValue({
      machines: [{ id: 1, code: "P1", center: "Cutting", availableH: 8 }],
      lines: [{ key: "B-1|MO-1|CF", pieces: 4, route: [{ center: "Cutting", hoursPerPiece: 0.5 }], dueDay: 2 }],
      pins: [],
    });
    h.prisma.worklistMachine.findMany.mockImplementation(async ({ where }: { where: { running: boolean } }) => (where.running ? [] : [{ machineId: 1, rank: 7 }]));
  }

  it("⚡ plans only the account's own line, behind the other line's waiting work", async () => {
    holding("cut.edit");
    onPunch();
    const res = await optimizeMachines(form({ dept: "Cut" }));
    const mayPlan: (item: string) => boolean = h.getOptimizerInputs.mock.calls[0][2];
    expect([mayPlan("CF"), mayPlan("JOB"), mayPlan("PNL")]).toEqual([true, true, false]);
    expect(h.prisma.worklistMachine.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: expect.objectContaining({ dept: "Cut", running: false, item: { not: "PNL" } }) });
    expect(h.prisma.worklistMachine.create).toHaveBeenCalledExactlyOnceWith({ data: expect.objectContaining({ dept: "Cut", bom: "B-1", mo: "MO-1", item: "CF", machineId: 1, rank: 8 }) });
    expect(res.ok).toBe(true);
    expect(res.summary).toContain("Planned: 1 transformer line(s) over 1 machine");
    expect(res.summary).toContain("The panel lines kept their places — these queue behind them.");
  });

  it("⚡ holding both lines' keys plans every line, as before", async () => {
    holding("cut.edit", "lv.punching");
    onPunch();
    const res = await optimizeMachines(form({ dept: "Cut" }));
    const mayPlan: (item: string) => boolean = h.getOptimizerInputs.mock.calls[0][2];
    expect([mayPlan("CF"), mayPlan("PNL")]).toEqual([true, true]);
    expect(h.prisma.worklistMachine.deleteMany.mock.calls[0][0].where).not.toHaveProperty("item");
    expect(h.prisma.worklistMachine.create).toHaveBeenCalledExactlyOnceWith({ data: expect.objectContaining({ machineId: 1, rank: 1 }) });
    expect(res.summary).toContain("Planned: 1 line(s) over 1 machine");
    expect(res.summary).not.toContain("kept their places");
  });
});
