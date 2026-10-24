import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// The assistant's tools for the shift roster and the consumables catalogue,
// limits and powder scrap: what each card says, that it runs the tab's own
// action with the fields the tab posts, and how it is undone — against
// stubbed actions.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      consumableItem: { findUnique: fn(), findMany: fn(), findFirst: fn() },
      consumableLimit: { findUnique: fn(), findMany: fn() },
      powderScrap: { findUnique: fn() },
    },
    perms: new Set<string>(),
    roster: fn(),
    snap: { readShiftState: fn(), restoreShiftState: fn() },
    shifts: { saveShiftRoster: fn(), clearShiftDay: fn() },
    catalogue: { saveCatalogueItem: fn(), saveConsumableLimit: fn(), deleteConsumableLimit: fn() },
    powder: { createPowderScrap: fn(), updatePowderScrap: fn(), deletePowderScrap: fn(), restorePowderScrap: fn() },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ hasPerm: (_u: unknown, k: string) => h.perms.has(k) }));
vi.mock("@/lib/server/shifts", () => ({ getShiftRoster: h.roster }));
vi.mock("@/lib/server/rowSnapshots", () => h.snap);
vi.mock("@/app/shifts/actions", () => h.shifts);
vi.mock("@/app/consumables/catalogueActions", () => h.catalogue);
vi.mock("@/app/consumables/powderActions", () => h.powder);
vi.mock("@/lib/server/consumables", () => ({ getCustomDepartments: async () => ["Maintenance"] }));

import type { User } from "@prisma/client";
import type { ToolCtx } from "@/lib/server/ai/tools/types";
import { clearShiftDayTool, getShiftDayTool, planShiftDay, recordShiftDayTool, restoreShiftDayTool } from "@/lib/server/ai/tools/shifts";
import {
  correctPowderScrapTool, deleteConsumableLimitTool, deletePowderScrapTool, recordPowderScrapTool, restorePowderScrapTool, saveCatalogueItemTool, saveConsumableLimitTool,
} from "@/lib/server/ai/tools/catalogue";
import { checkToolInput } from "@/lib/server/ai/tools";

const user = (o: Partial<User> = {}) => ({ id: 1, name: "Sara", isAdmin: false, isOwner: false, ...o }) as User;
const ctxOf = (u: User): ToolCtx => ({ user: u, hidden: new Set(), now: new Date("2026-10-12T08:00:00Z"), todayISO: "2026-10-12", conversationId: 1, automationId: null });
const ctx = ctxOf(user());
const fdOf = (m: ReturnType<typeof vi.fn>, call = 0) => m.mock.calls[call][0] as FormData;
const parsed = <I,>(tool: Parameters<typeof checkToolInput<I>>[0], raw: unknown): I => {
  const c = checkToolInput<I>(tool, raw);
  if (!c.ok) throw new Error(c.error);
  return c.input;
};

// ------------------------------------------------------------------ shifts

const line = (workerId: number, empId: string, name: string, o: Record<string, unknown> = {}) => ({
  workerId, empId, name, jobTitle: null, dept: "Welding", sections: ["WeldingTX"], sectionLabels: ["Welding TX"],
  onVacation: false, present: false, shift: "S9", overtimeH: 0, center: null, note: "", recorded: false, ...o,
});
const roster = (lines = [line(1, "100", "Ahmed"), line(2, "101", "Mohamed"), line(3, "102", "Sayed", { onVacation: true }), line(9, "200", "Ali", { dept: "Cut" })]) => ({
  dateISO: "2026-10-12", lines, totals: null, savedDepts: [], recordedBy: null, capacityMh: {}, shiftHours: { short: 8, long: 11, overtime: 3 },
});
const EMPTY = { rows: [], dayHours: [] };

beforeEach(() => {
  vi.clearAllMocks();
  h.perms.clear();
  for (const group of [h.shifts, h.catalogue, h.powder]) for (const f of Object.values(group)) f.mockResolvedValue({ ok: true });
  h.roster.mockResolvedValue(roster());
  h.snap.readShiftState.mockResolvedValue(EMPTY);
  h.snap.restoreShiftState.mockResolvedValue({ ok: true });
  h.prisma.consumableLimit.findMany.mockResolvedValue([]);
});

describe("the shift roster", () => {
  it("needs the department's own shift-log permission, and no future day", async () => {
    const input = parsed(recordShiftDayTool, { date: "2026-10-12", dept: "Welding", workers: [{ worker: "101", present: false }] });
    expect(await recordShiftDayTool.describe(input, ctx)).toEqual({ error: expect.stringContaining("Shift log — Welding") });
    h.perms.add("shifts.welding");
    const later = parsed(recordShiftDayTool, { date: "2026-10-13", dept: "Welding", workers: [{ worker: "101", present: false }] });
    expect(await recordShiftDayTool.describe(later, ctx)).toEqual({ error: expect.stringContaining("has not come yet") });
  });

  it("saves the department's day whole: the rest of the not-set workers, single workers on top, vacation absent", async () => {
    h.perms.add("shifts.welding");
    const input = parsed(recordShiftDayTool, { date: "2026-10-12", dept: "Welding", rest: "night", workers: [{ worker: "101", present: false }] });
    const p = await recordShiftDayTool.describe(input, ctx);
    expect(p).toMatchObject({
      title: "Shift roster: Welding 2026-10-12",
      changes: [
        { label: "101 Mohamed", before: "not set", after: "absent" },
        // kept absent by his vacation, not by what was asked: named on the card
        { label: "102 Sayed", before: "not set", after: "absent" },
        { label: "Welding man-hours", before: "0 (0 day shift, 0 night shift, 0 absent, 3 not set)", after: "11 (0 day shift, 1 night shift, 2 absent)" },
      ],
    });
    const summary = (p as { summary: string }).summary;
    expect(summary).toContain("2 worker(s) change, and the 1 not set yet: 1 on the night shift");
    expect(summary).toContain("0 day shift, 1 night shift, 2 absent; 11 man-hours");
    const out = await recordShiftDayTool.execute(input, ctx);
    expect(JSON.parse(String(fdOf(h.shifts.saveShiftRoster).get("lines")))).toEqual([
      { dept: "Welding", workerId: 1, present: true, shift: "S11", overtimeH: 0, center: null, note: "" },
      { dept: "Welding", workerId: 2, present: false, shift: "S9", overtimeH: 0, center: null, note: "" },
      { dept: "Welding", workerId: 3, present: false, shift: "S9", overtimeH: 0, center: null, note: "" },
    ]);
    expect(out.undo).toEqual({ tool: "restore_shift_day", input: { date: "2026-10-12", depts: ["Welding"], state: JSON.stringify(EMPTY) } });
  });

  it("refuses a day that would leave anyone not set — it never guesses absent", async () => {
    h.perms.add("shifts.welding");
    const input = parsed(recordShiftDayTool, { date: "2026-10-12", dept: "Welding", workers: [{ worker: "100", shift: "S11" }] });
    expect(await recordShiftDayTool.describe(input, ctx)).toEqual({ error: expect.stringContaining("2 worker(s) have no record for the day yet (101 Mohamed, 102 Sayed)") });
    expect(h.shifts.saveShiftRoster).not.toHaveBeenCalled();
    // `everyone` reaches only the ones present, so it does not decide them either
    const everyone = parsed(recordShiftDayTool, { date: "2026-10-12", dept: "Welding", everyone: { shift: "S11" } });
    expect(await recordShiftDayTool.describe(everyone, ctx)).toEqual({ error: expect.stringContaining("3 worker(s) have no record") });
  });

  it("a shift named for a worker means he came; the rest on the day shift keep no overtime; vacation is listed, not folded in", () => {
    const lines = roster().lines.filter((l) => l.dept === "Welding") as Parameters<typeof planShiftDay>[0];
    const plan = planShiftDay(lines, { rest: "day", workers: [{ worker: "100", shift: "S11" }] });
    expect(Array.isArray(plan) && plan.map((p) => [p.line.empId, p.after.present, p.after.shift, p.after.overtimeH, p.byRest])).toEqual([
      ["100", true, "S11", 0, false],
      ["101", true, "S9", 0, true],
      // on vacation: kept absent, and shown on the card by name
      ["102", false, "S9", 0, false],
    ]);
  });

  it("`rest` reaches only the workers not set: a recorded one keeps his day, overtime and all", async () => {
    h.perms.add("shifts.welding");
    h.roster.mockResolvedValue(roster([line(1, "100", "Ahmed", { recorded: true, present: true, overtimeH: 3 }), line(2, "101", "Mohamed")]));
    const lines = (await h.roster()).lines as Parameters<typeof planShiftDay>[0];
    const plan = planShiftDay(lines, { rest: "absent" });
    expect(Array.isArray(plan) && plan.map((p) => [p.line.empId, p.after.present, p.after.shift, p.after.overtimeH, p.byRest])).toEqual([
      ["100", true, "S9", 3, false],
      ["101", false, "S9", 0, true],
    ]);
    const input = parsed(recordShiftDayTool, { date: "2026-10-12", dept: "Welding", rest: "absent" });
    expect(typeof recordShiftDayTool.risk === "function" && recordShiftDayTool.risk(input)).toBe("high");
    const p = await recordShiftDayTool.describe(input, ctx);
    expect((p as { summary: string }).summary).toContain("0 worker(s) change, and the 1 not set yet: 1 absent — 1 day shift, 0 night shift, 1 absent; 11 man-hours");
  });

  it("naming a shift for a worker recorded absent puts him on it", () => {
    const lines = [line(1, "100", "Ahmed", { recorded: true })] as Parameters<typeof planShiftDay>[0];
    const plan = planShiftDay(lines, { workers: [{ worker: "100", shift: "S11" }] });
    expect(Array.isArray(plan) && plan[0].after).toMatchObject({ present: true, shift: "S11" });
  });

  it("refuses overtime that would not land on the day shift, rather than dropping it", () => {
    const lines = roster().lines.filter((l) => l.dept === "Welding") as Parameters<typeof planShiftDay>[0];
    expect(planShiftDay(lines, { rest: "night", workers: [{ worker: "100", overtimeH: 3 }] })).toEqual({ error: expect.stringContaining("100 Ahmed would not be on the day shift") });
  });

  it("reads the day as the tab shows it: day, night, absent and not set", async () => {
    h.roster.mockResolvedValue(roster([
      line(1, "100", "Ahmed", { recorded: true, present: true, overtimeH: 3 }),
      line(2, "101", "Mohamed", { recorded: true, present: true, shift: "S11" }),
      line(3, "102", "Sayed", { recorded: true }),
      line(4, "103", "Ali"),
    ]));
    const out = await getShiftDayTool.run({ date: "2026-10-12", depts: ["Welding"] }, ctx);
    const day = JSON.parse((out as { text: string }).text).departments[0];
    expect(day).toMatchObject({ dept: "Welding", workers: 4, dayShift: 1, nightShift: 1, absent: 1, notSet: 1, manHours: 22, overtimeH: 3 });
    expect(day.columns).toEqual(["badge", "name", "sections", "attendance", "overtimeH", "center", "note", "onVacation"]);
    expect(day.rows.map((r: unknown[]) => r[3])).toEqual(["day", "night", "absent", "unset"]);
  });

  it("books a Fabrication worker to the centre named, and refuses a centre outside Fabrication", () => {
    const cut = [line(9, "200", "Ali", { dept: "Cut", recorded: true, present: true, center: "Cutting" })] as Parameters<typeof planShiftDay>[0];
    const plan = planShiftDay(cut, { workers: [{ worker: "200", center: "Bending" }] });
    expect(Array.isArray(plan) && plan[0].after).toMatchObject({ present: true, center: "Bending" });
    const weld = roster().lines.filter((l) => l.dept === "Welding") as Parameters<typeof planShiftDay>[0];
    expect(planShiftDay(weld, { workers: [{ worker: "100", center: "Bending" }] })).toEqual({ error: expect.stringContaining("is not a work centre of Welding") });
  });

  it("rejects overtime on the night shift", () => {
    const lines = roster().lines.filter((l) => l.dept === "Welding") as Parameters<typeof planShiftDay>[0];
    expect(planShiftDay(lines, { everyone: { shift: "S11", overtimeH: 3 } })).toEqual({ error: "Overtime is available to the day shift only (16:00–19:00)." });
  });

  it("finds a worker by badge or exact name, and says when it cannot", () => {
    const lines = roster().lines.filter((l) => l.dept === "Welding") as Parameters<typeof planShiftDay>[0];
    expect(planShiftDay(lines, { workers: [{ worker: "999", present: false }] })).toEqual({ error: expect.stringContaining("not on this department's roster") });
    expect(planShiftDay(lines, { workers: [{ worker: "ahmed", present: false }, { worker: "100", overtimeH: 2 }] })).toEqual({ error: "100 Ahmed is named twice." });
    const twins = [...lines, { ...lines[0], workerId: 4, empId: "103" }];
    expect(planShiftDay(twins, { workers: [{ worker: "Ahmed", present: false }] })).toEqual({ error: expect.stringContaining("use the badge number") });
  });

  it("a day that reads so already, all recorded, is not proposed", async () => {
    h.perms.add("shifts.welding");
    h.roster.mockResolvedValue(roster([line(1, "100", "Ahmed", { recorded: true, present: true, shift: "S11" })]));
    const input = parsed(recordShiftDayTool, { date: "2026-10-12", dept: "Welding", workers: [{ worker: "100", shift: "S11" }] });
    expect(await recordShiftDayTool.describe(input, ctx)).toEqual({ error: "Welding's day 2026-10-12 reads so already." });
  });

  it("clearing a day is undone by putting the rows and the man-hours back as they were", async () => {
    h.perms.add("shifts.welding");
    const state = { rows: [{ dept: "Welding", workerId: 1, present: true, shift: "S9", overtimeH: 0, machineId: null, note: null, recordedBy: "Sara" }], dayHours: [{ dept: "Welding", hours: 9, people: 1, hoursEach: null, source: "roster", recordedBy: null }] };
    h.snap.readShiftState.mockResolvedValue(state);
    const input = parsed(clearShiftDayTool, { date: "2026-10-12", depts: ["Welding", "Welding"] });
    expect(input.depts).toEqual(["Welding"]);
    expect(await clearShiftDayTool.describe(input, ctx)).toMatchObject({ changes: [{ label: "Welding 2026-10-12", before: "1 worker(s) recorded · 9 man-hours", after: "not recorded" }] });
    const out = await clearShiftDayTool.execute(input, ctx);
    expect(Object.fromEntries(fdOf(h.shifts.clearShiftDay).entries())).toEqual({ date: "2026-10-12", depts: "Welding" });
    const undo = parsed(restoreShiftDayTool, out.undo!.input);
    expect(await restoreShiftDayTool.execute(undo, ctx)).toMatchObject({ ok: true });
    expect(h.snap.restoreShiftState).toHaveBeenCalledWith("2026-10-12", ["Welding"], state);
  });

  it("the undo refuses a record that is not whole", () => {
    const bad = JSON.stringify({ rows: [{ dept: "Welding", workerId: "x" }], dayHours: [] });
    expect(checkToolInput(restoreShiftDayTool, { date: "2026-10-12", depts: ["Welding"], state: bad })).toMatchObject({ ok: false });
    const other = JSON.stringify({ rows: [], dayHours: [{ dept: "Cut", hours: 1, people: 1, hoursEach: null, source: "roster", recordedBy: null }] });
    expect(checkToolInput(restoreShiftDayTool, { date: "2026-10-12", depts: ["Welding"], state: other })).toMatchObject({ ok: false });
  });
});

// ------------------------------------------------------------------ catalogue

const item = (o: Record<string, unknown> = {}) => ({ id: 3, code: "C-CON-GLV", name: "Cotton gloves", uom: "PAIR", remark: null, active: true, createdAt: new Date(), updatedAt: new Date(), ...o });
const limit = (o: Record<string, unknown> = {}) => ({ id: 8, itemId: 3, departments: "WeldingTX", basis: "each", period: "month", qty: new Prisma.Decimal(20), createdAt: new Date(), updatedAt: new Date(), ...o });

describe("the consumables catalogue", () => {
  it("adds an item with its first limit, posting the departments as the form does, and is undone by retiring it", async () => {
    h.perms.add("consumables.edit");
    h.prisma.consumableItem.findFirst.mockResolvedValue(null);
    h.catalogue.saveCatalogueItem.mockResolvedValue({ ok: true, id: 51 });
    const input = parsed(saveCatalogueItemTool, { name: "Leather  gloves", code: "c-con-lth", limit: { departments: ["Welding TX", "PaintingLV"], basis: "pool", period: "month", qty: 30 } });
    const p = await saveCatalogueItemTool.describe(input, ctx);
    expect(p).toMatchObject({ title: "Add Leather gloves to the catalogue", changes: [{ after: "C-CON-LTH · PC" }, { label: "Limit on Leather gloves", after: "30 PC a month — Welding TX + USS Painting, shared by the departments" }] });
    const out = await saveCatalogueItemTool.execute(input, ctx);
    const fd = fdOf(h.catalogue.saveCatalogueItem);
    expect(fd.get("name")).toBe("Leather gloves");
    expect(fd.get("withLimit")).toBe("true");
    expect(fd.getAll("departments")).toEqual(["WeldingTX", "PaintingLV"]);
    expect(out.undo).toEqual({ tool: "save_catalogue_item", input: { id: 51, active: false } });
  });

  it("refuses a name another item has, and a department nobody uses", async () => {
    h.perms.add("consumables.edit");
    h.prisma.consumableItem.findFirst.mockResolvedValue({ name: "Cotton gloves" });
    expect(await saveCatalogueItemTool.describe(parsed(saveCatalogueItemTool, { name: "cotton GLOVES" }), ctx)).toEqual({ error: "Cotton gloves is already in the catalogue." });
    h.prisma.consumableItem.findFirst.mockResolvedValue(null);
    const odd = parsed(saveCatalogueItemTool, { name: "Masks", limit: { departments: ["Canteen"], basis: "pool", period: "month", qty: 5 } });
    expect(await saveCatalogueItemTool.describe(odd, ctx)).toEqual({ error: expect.stringContaining("\"Canteen\" is not a worker section") });
  });

  it("changes an item and is undone by the item as it was", async () => {
    h.perms.add("consumables.edit");
    h.prisma.consumableItem.findUnique.mockResolvedValue(item());
    h.prisma.consumableItem.findFirst.mockResolvedValue(null);
    h.catalogue.saveCatalogueItem.mockResolvedValue({ ok: true, id: 3 });
    const input = parsed(saveCatalogueItemTool, { id: 3, uom: "box" });
    expect(saveCatalogueItemTool.risk instanceof Function && saveCatalogueItemTool.risk(input)).toBe("low");
    expect(await saveCatalogueItemTool.describe(input, ctx)).toMatchObject({ changes: [{ label: "Cotton gloves — Unit", before: "PAIR", after: "BOX" }] });
    const out = await saveCatalogueItemTool.execute(input, ctx);
    expect(Object.fromEntries(fdOf(h.catalogue.saveCatalogueItem).entries())).toEqual({ id: "3", name: "Cotton gloves", code: "C-CON-GLV", uom: "BOX", remark: "", active: "true" });
    expect(out.undo).toEqual({ tool: "save_catalogue_item", input: { id: 3, name: "Cotton gloves", code: "C-CON-GLV", uom: "PAIR", remark: null, active: true } });
    expect(checkToolInput(saveCatalogueItemTool, out.undo!.input).ok).toBe(true);
  });

  it("a new limit is undone by removing it; a changed one by the numbers it had", async () => {
    h.perms.add("consumables.edit");
    h.prisma.consumableItem.findMany.mockResolvedValue([item()]);
    h.catalogue.saveConsumableLimit.mockResolvedValue({ ok: true, id: 90 });
    const add = parsed(saveConsumableLimitTool, { item: "c-con-glv", departments: ["*"], basis: "person", period: "quarter", qty: 2 });
    expect(await saveConsumableLimitTool.describe(add, ctx)).toMatchObject({ changes: [{ label: "Limit on Cotton gloves", before: "—", after: "2 PAIR every 3 months — All departments, per worker" }] });
    const out = await saveConsumableLimitTool.execute(add, ctx);
    expect(fdOf(h.catalogue.saveConsumableLimit).get("allDepartments")).toBe("true");
    expect(out.undo).toEqual({ tool: "delete_consumable_limit", input: { id: 90 } });

    h.prisma.consumableLimit.findUnique.mockResolvedValue(limit());
    h.prisma.consumableItem.findUnique.mockResolvedValue(item());
    h.catalogue.saveConsumableLimit.mockResolvedValue({ ok: true, id: 8 });
    const change = parsed(saveConsumableLimitTool, { id: 8, qty: 25 });
    expect(await saveConsumableLimitTool.describe(change, ctx)).toMatchObject({ changes: [{ before: "20 PAIR a month — Welding TX, each department its own", after: "25 PAIR a month — Welding TX, each department its own" }] });
    const out2 = await saveConsumableLimitTool.execute(change, ctx);
    expect(out2.undo).toEqual({ tool: "save_consumable_limit", input: { id: 8, departments: ["WeldingTX"], basis: "each", period: "month", qty: 20 } });
  });

  it("removing a limit is undone by setting it again on its item", async () => {
    h.perms.add("consumables.edit");
    h.prisma.consumableLimit.findUnique.mockResolvedValue({ ...limit(), item: item() });
    const out = await deleteConsumableLimitTool.execute({ id: 8 }, ctx);
    expect(out.undo).toEqual({ tool: "save_consumable_limit", input: { itemId: 3, departments: ["WeldingTX"], basis: "each", period: "month", qty: 20 } });
    expect(checkToolInput(saveConsumableLimitTool, out.undo!.input).ok).toBe(true);
  });
});

// ------------------------------------------------------------------ powder scrap

const scrap = (o: Record<string, unknown> = {}) => ({
  id: 9, day: new Date("2026-10-11T00:00:00Z"), department: "PaintingTX", kg: new Prisma.Decimal(12.5), notes: null, recordedById: 1,
  recordedBy: "Sara", deletedAt: null, updatedAt: new Date("2026-10-11T09:00:00Z"), ...o,
});

describe("powder scrap", () => {
  it("records a weighing by the view's own rules; only an admin's can be undone from the chat", async () => {
    h.perms.add("consumables.edit");
    h.powder.createPowderScrap.mockResolvedValue({ ok: true, id: 41 });
    const future = parsed(recordPowderScrapTool, { day: "2026-10-13", department: "PaintingTX", kg: 4 });
    expect(await recordPowderScrapTool.describe(future, ctx)).toEqual({ error: "The day cannot be in the future." });
    const input = parsed(recordPowderScrapTool, { day: "2026-10-11", department: "PaintingLV", kg: 4.25, notes: "filter change" });
    expect(await recordPowderScrapTool.describe(input, ctx)).toMatchObject({ changes: [{ after: "4.25 kg · USS Painting · 11/10/2026 · “filter change”" }] });
    expect((await recordPowderScrapTool.execute(input, ctx)).undo).toBeUndefined();
    expect((await recordPowderScrapTool.execute(input, ctxOf(user({ isAdmin: true })))).undo).toEqual({ tool: "delete_powder_scrap", input: { id: 41 } });
  });

  it("a correction is its recorder's or an admin's, and is undone by the weighing as it was", async () => {
    h.prisma.powderScrap.findUnique.mockResolvedValue(scrap({ recordedById: 2 }));
    h.perms.add("consumables.edit");
    const input = parsed(correctPowderScrapTool, { id: 9, kg: 10 });
    expect(await correctPowderScrapTool.describe(input, ctx)).toEqual({ error: expect.stringContaining("Only the person who recorded") });
    h.prisma.powderScrap.findUnique.mockResolvedValue(scrap());
    const out = await correctPowderScrapTool.execute(input, ctx);
    expect(Object.fromEntries(fdOf(h.powder.updatePowderScrap).entries())).toEqual({ id: "9", version: "2026-10-11T09:00:00.000Z", day: "2026-10-11", department: "PaintingTX", kg: "10", notes: "" });
    expect(out.undo).toEqual({ tool: "correct_powder_scrap", input: { id: 9, day: "2026-10-11", department: "PaintingTX", kg: 12.5, notes: null } });
  });

  it("taking a weighing off is the admin's, and is undone by bringing it back", async () => {
    h.prisma.powderScrap.findUnique.mockResolvedValue(scrap());
    expect(await deletePowderScrapTool.describe({ id: 9 }, ctx)).toEqual({ error: expect.stringContaining("admin's") });
    const admin = ctxOf(user({ isAdmin: true }));
    const out = await deletePowderScrapTool.execute({ id: 9 }, admin);
    expect(out.undo).toEqual({ tool: "restore_powder_scrap", input: { id: 9 } });
    h.prisma.powderScrap.findUnique.mockResolvedValue(scrap({ deletedAt: new Date(), updatedAt: new Date("2026-10-12T07:00:00Z") }));
    expect(await restorePowderScrapTool.execute({ id: 9 }, admin)).toMatchObject({ ok: true });
    expect(Object.fromEntries(fdOf(h.powder.restorePowderScrap).entries())).toEqual({ id: "9", version: "2026-10-12T07:00:00.000Z" });
  });
});
