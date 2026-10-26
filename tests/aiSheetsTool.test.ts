import { beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

// The assistant's Excel files, made in place of the screens' Export buttons:
// which sheet it builds from which loader, who may have it, the file it
// keeps for the person and the links it hands back.

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    prisma: {
      aiFile: { count: fn(), aggregate: fn(), create: fn(), deleteMany: fn(), findFirst: fn() },
      handoverEntry: { findMany: fn() },
      masterOrder: { findMany: fn(), findUnique: fn() },
    },
    perms: new Set<string>(),
    production: fn(), dashboard: fn(), decisions: fn(), recent: fn(), master: fn(), lv: fn(), weekly: fn(), trace: fn(), lvTrace: fn(), soi: fn(), rows: fn(), roster: fn(), stops: fn(), odooLog: fn(), odooDays: fn(),
    lines: [] as string[],
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ hasPerm: (_u: unknown, k: string) => h.perms.has(k) }));
vi.mock("@/lib/server/line", () => ({
  withLine: (line: string, f: () => unknown) => { h.lines.push(line); return f(); },
  ledgerItemWhere: (line: string) => (line === "LV" ? { item: "LV" } : { item: { not: "LV" } }),
}));
vi.mock("@/lib/server/handover", () => ({ getRecentHandover: h.recent }));
vi.mock("@/lib/server/masterTracker", () => ({ getMasterTracker: h.master }));
vi.mock("@/lib/server/lvTracker", () => ({ getLvTracker: h.lv }));
vi.mock("@/lib/server/weeklyPlanTracker", () => ({ getWeeklyPlanTracker: h.weekly }));
vi.mock("@/lib/server/trace", () => ({ getTrace: h.trace }));
vi.mock("@/lib/server/lvTrace", () => ({ getLvTrace: h.lvTrace }));
vi.mock("@/lib/server/soi", () => ({ getSoiLookup: h.soi }));
vi.mock("@/lib/server/shifts", () => ({ getShiftRoster: h.roster }));
vi.mock("@/lib/server/downtime", () => ({ getDowntimeDay: h.stops }));
vi.mock("@/lib/server/material", () => ({ getMaterialData: vi.fn() }));
vi.mock("@/lib/server/odoo", () => ({ getOdooData: h.odooLog, getOdooDashboard: h.odooDays }));
vi.mock("@/lib/server/physicalStock", () => ({ getPhysicalStock: vi.fn() }));
vi.mock("@/lib/server/powderScrap", () => ({ getPowderReport: vi.fn() }));
vi.mock("@/lib/server/consumables", () => ({ getConsumablesData: vi.fn(), getConsumableEdits: vi.fn(), getConsumablesDashboard: vi.fn(), getConsumablesDecisions: h.decisions }));
vi.mock("@/lib/server/consumableLimits", () => ({ getCatalogue: vi.fn(), getCurrentStandings: vi.fn() }));
vi.mock("@/lib/server/consumableMonthly", () => ({ getMonthlyReport: vi.fn() }));
vi.mock("@/lib/server/ai/reader", () => ({ runAiRows: h.rows }));
vi.mock("@/lib/server/dashboards", () => ({ loadProductionAll: h.production }));
vi.mock("@/lib/server/productionDashboard", () => ({ loadProductionDashboard: h.dashboard }));

import type { User } from "@prisma/client";
import { ITEMS } from "@/lib/domain/constants";
import type { MasterTrackerRow } from "@/lib/server/masterTracker";
import type { ToolCtx } from "@/lib/server/ai/tools/types";
import { MAX_SHEET_ROWS, makeSheetTool } from "@/lib/server/ai/tools/sheets";
import { printableSheet, storeMadeWorkbook } from "@/lib/server/ai/files";
import { checkToolInput, toolsFor } from "@/lib/server/ai/tools";

const user = (o: Partial<User> = {}) => ({ id: 7, name: "Sara", isAdmin: false, ...o }) as User;
const ctxOf = (o: Partial<ToolCtx> = {}): ToolCtx => ({ user: user(), hidden: new Set(), now: new Date("2026-10-26T08:00:00Z"), todayISO: "2026-10-26", conversationId: 3, automationId: null, ...o });

const tracker = (mo: string, months: string[]): MasterTrackerRow => ({
  mo, bom: `BOM-${mo}`, soi: null, customer: null, urgent: false, kva: "1000", rating: null, fins: null, crcSize: null, colorRal: null, sfm: null,
  required: 10, welded: 0, complete: 0, remaining: 10, achievement: 0, status: "open", hold: { onHold: false, holdNote: null, holdSinceISO: null, holdBy: null },
  priority: false, months, pendingQty: null,
  items: Object.fromEntries(ITEMS.map((it) => [it, { cut: 1, weld: 0, paint: 0, shp: 0, delivered: 0, osp: 0, excluded: false, eligible: true }])) as MasterTrackerRow["items"],
});

/** The workbook the last call kept, as its first sheet's rows. */
function keptSheet() {
  const data = h.prisma.aiFile.create.mock.calls.at(-1)![0].data;
  const wb = XLSX.read(data.data, { type: "array" });
  return { data, sheet: wb.SheetNames[0], rows: XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]]) };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.perms.clear();
  h.lines.length = 0;
  h.prisma.aiFile.count.mockResolvedValue(0);
  h.prisma.aiFile.aggregate.mockResolvedValue({ _sum: { size: 0 } });
  h.prisma.aiFile.deleteMany.mockResolvedValue({ count: 0 });
  h.prisma.aiFile.create.mockResolvedValue({ id: 42 });
  h.master.mockResolvedValue([tracker("A", ["October 2026"]), tracker("B", ["September 2026"])]);
  h.recent.mockResolvedValue([]);
});

describe("make_excel", () => {
  it("builds the Plan Tracker's own sheet under its filters, keeps it on the person's chat, and hands back the links", async () => {
    const r = await makeSheetTool.run({ sheet: "plan_tracker", filters: { month: "October 2026" } }, ctxOf());
    expect(r.ok).toBe(true);
    const j = JSON.parse(r.text);
    expect(j).toMatchObject({ file: "plan-tracker.xlsx", rows: 1, download: "/api/ai/files/42", print: "/ai/print/42" });
    expect(j.note).toContain("[Download plan-tracker.xlsx](/api/ai/files/42)");
    expect(r.links).toEqual([{ label: "Download plan-tracker.xlsx", href: "/api/ai/files/42" }, { label: "Print it", href: "/ai/print/42" }]);
    expect(h.lines).toEqual(["TR"]);
    const kept = keptSheet();
    expect(kept.data).toMatchObject({ userId: 7, conversationId: 3, name: "plan-tracker.xlsx", kind: "excel", tokens: null });
    expect(kept.sheet).toBe("Plan Tracker");
    expect(kept.rows.map((x) => x.MO)).toEqual(["A"]);
    expect(kept.rows[0]).toHaveProperty("TN Fab", 1);
  });

  it("names the departments it was narrowed to, in pipeline order", async () => {
    const r = await makeSheetTool.run({ sheet: "plan_tracker", filters: { deptStage: "Painting,Cut" } }, ctxOf());
    expect(JSON.parse(r.text).file).toBe("plan-tracker-cut-painting.xlsx");
    expect(Object.keys(keptSheet().rows[0])).toEqual(expect.arrayContaining(["TN Fab", "TN Paint"]));
    expect(Object.keys(keptSheet().rows[0])).not.toContain("TN Weld");
  });

  it("refuses a screen closed to the person, and the admin's sheets to anyone else", async () => {
    expect(await makeSheetTool.run({ sheet: "plan_tracker" }, ctxOf({ hidden: new Set(["tracker"]) }))).toEqual({ ok: false, text: expect.stringContaining("not opened") });
    expect(await makeSheetTool.run({ sheet: "orders_registry" }, ctxOf())).toEqual({ ok: false, text: expect.stringContaining("admin") });
    expect(h.prisma.aiFile.create).not.toHaveBeenCalled();
  });

  it("makes no file when nothing matches", async () => {
    const r = await makeSheetTool.run({ sheet: "plan_tracker", filters: { q: "nothing like it" } }, ctxOf());
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.text)).toMatchObject({ rows: 0 });
    expect(h.prisma.aiFile.create).not.toHaveBeenCalled();
  });

  it("is made only in a chat the person is in, and checks the files an hour before it reads anything", async () => {
    expect(await makeSheetTool.run({ sheet: "plan_tracker" }, ctxOf({ conversationId: null }))).toEqual({ ok: false, text: expect.stringContaining("only in a chat") });
    h.prisma.aiFile.count.mockResolvedValue(30);
    h.master.mockClear();
    expect(await makeSheetTool.run({ sheet: "plan_tracker" }, ctxOf())).toEqual({ ok: false, text: expect.stringContaining("in an hour") });
    expect(h.master).not.toHaveBeenCalled();
  });

  it("reads the Daily log of the period on the line, with the data guard's checks and the filters", async () => {
    h.soi.mockResolvedValue({ byMo: {}, byBom: { B1: "S-1" } });
    const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
    h.prisma.handoverEntry.findMany.mockResolvedValue([
      { id: 1, date: at("2026-10-26"), dept: "Welding", bom: "B1", bomRaw: null, mo: null, item: "TN", qty: 2, source: "worklist", createdBy: "Ali", createdAt: new Date("2026-10-26T08:00:00Z") },
      { id: 2, date: at("2026-10-25"), dept: "Cut", bom: "B2", bomRaw: null, mo: null, item: "TN", qty: 1, source: "worklist", createdBy: "Ali", createdAt: new Date("2026-10-25T08:00:00Z") },
    ]);
    const r = await makeSheetTool.run({ sheet: "daily_log", line: "LV", dept: "Welding" }, ctxOf());
    expect(h.prisma.handoverEntry.findMany.mock.calls[0][0].where).toEqual({ item: "LV", date: { gte: at("2026-10-24"), lte: at("2026-10-26") } });
    // the data guard reads the history the screen loads, on the same line
    expect(h.recent).toHaveBeenCalledWith(2000);
    expect(h.lines).toEqual(["LV"]);
    expect(JSON.parse(r.text)).toMatchObject({ file: "daily-log-lv-2026-10-24_to_2026-10-26.xlsx", rows: 1 });
    expect(keptSheet().rows[0]).toMatchObject({ BOM: "B1", SOI: "S-1", QTY: 2 });
  });

  it("traces an order on its own line, whatever line the chat is on", async () => {
    h.prisma.masterOrder.findUnique.mockResolvedValue({ line: "LV" });
    h.lvTrace.mockResolvedValue({ exists: true, key: "MO/9", timeline: [{ dateISO: "2026-10-26", mo: "MO/9", stage: "Punch", qty: 4, by: null, source: "worklist", note: null }] });
    const r = await makeSheetTool.run({ sheet: "trace", mo: "MO/9" }, ctxOf({ line: "TR" }));
    expect(JSON.parse(r.text)).toMatchObject({ file: "trace-MO-9.xlsx", rows: 1 });
    expect(h.trace).not.toHaveBeenCalled();
    h.lvTrace.mockResolvedValue({ exists: false, key: "MO/9", timeline: [] });
    expect(await makeSheetTool.run({ sheet: "trace", mo: "MO/9" }, ctxOf())).toEqual({ ok: false, text: expect.stringContaining("No LV panel order") });
  });

  it("makes the Production dashboard's item card a sheet, both lines over the period, every department", async () => {
    const plan = { required: 30, done: { cut: 25, weld: 20, finish: 15 }, left: 15, share: 0.5 };
    h.production.mockResolvedValue({
      tr: { fromISO: "2026-10-01", toISO: "2026-10-26", byType: { monthLabel: "October 2026", groups: [{ item: "Tank", total: { item: "Tank", type: "All types", made: { cut: 10, weld: 8, finish: 5 }, plan }, types: [{ item: "Tank", type: "630 kVA", made: { cut: 10, weld: 8, finish: 5 }, plan }] }] } },
      lv: { byType: { monthLabel: "October 2026", groups: [{ item: "LV panels", total: { item: "LV panels", type: "All types", made: { Punching: 4, Bending: 0, Welding: 0, Painting: 0 }, plan: null }, types: [{ item: "LV panels", type: "USS", made: { Punching: 4, Bending: 0, Welding: 0, Painting: 0 }, plan: null }] }] } },
    });
    const r = await makeSheetTool.run({ sheet: "output_by_type", from: "2026-10-01" }, ctxOf());
    expect(r.ok).toBe(true);
    expect(h.production).toHaveBeenCalledWith(expect.objectContaining({ fromISO: "2026-10-01", toISO: "2026-10-26", dept: "all" }), "all", expect.any(Date));
    const kept = keptSheet();
    expect(kept.data.name).toBe("output-by-type-2026-10-01_2026-10-26.xlsx");
    expect(kept.rows[0]).toMatchObject({ Line: "Transformers", Item: "Tank", Type: "630 kVA", "Made — Welded": 8, Planned: 30, Left: 15, "Done %": 50 });
    expect(kept.rows[1]).toMatchObject({ Line: "LV Panels", Type: "USS", "Made — Punched": 4 });
    // the shift log's screen closes it, as it closes the dashboard
    const closed = await makeSheetTool.run({ sheet: "output_by_type" }, ctxOf({ hidden: new Set(["shifts"]) }));
    expect(closed.ok).toBe(false);
  });

  it("makes the Production dashboard's department table a sheet, its total row the tiles", async () => {
    const { productionView } = await import("@/lib/domain/productionDashboard");
    h.dashboard.mockImplementation(async (req) => ({
      req, failed: [],
      view: productionView(req, [{
        line: "LV", trackingSinceISO: "2026-10-01", lastRecordISO: "2026-10-24",
        days: [{ line: "LV", dept: "Bending", unit: "Bending", dateISO: "2026-10-24", workedH: 16, earnedH: 20, people: 2, overtimeH: 0, rows: 2, absent: 0, absentH: 0, day: { people: 2, hours: 16, overtimeH: 0 }, night: { people: 0, hours: 0, overtimeH: 0 }, machineH: 0, downtimeH: 0, stops: {}, notSet: 1 }],
        volume: [{ line: "LV", dateISO: "2026-10-24", stage: "Bending", depts: ["Bending"], component: "LV panels", qty: 6, priced: true }],
      }], null, { todayISO: "2026-10-26", holidays: new Set() }),
    }));
    const r = await makeSheetTool.run({ sheet: "production", line: "LV", from: "2026-10-20" }, ctxOf());
    expect(r.ok).toBe(true);
    expect(h.dashboard).toHaveBeenCalledWith(expect.objectContaining({ scope: "LV", fromISO: "2026-10-20", toISO: "2026-10-26" }), expect.any(Date));
    const kept = keptSheet();
    expect(kept.data.name).toBe("production-2026-10-20_2026-10-26.xlsx");
    expect(kept.rows[0]).toMatchObject({ Line: "LV", Department: "Bending", "Booked h": 16, "Earned std-h": 20, "Efficiency %": 125, Output: 6, Unit: "panels" });
    expect(kept.rows[1]).toMatchObject({ Department: "Total", "Booked h": 16, "Earned std-h": 20 });
    await makeSheetTool.run({ sheet: "production_days", line: "LV", from: "2026-10-20" }, ctxOf());
    expect(keptSheet().rows[0]).toMatchObject({ Day: "2026-10-24", Unit: "Bending", "Not set": 1 });
    // the shift log's screen closes it, as it closes the dashboard
    expect((await makeSheetTool.run({ sheet: "production" }, ctxOf({ hidden: new Set(["shifts"]) }))).ok).toBe(false);
  });

  it("puts a query's rows on a sheet — numbers as numbers — within the screens the person sees and the row limit", async () => {
    h.rows.mockResolvedValue({ ok: true, truncated: false, rows: [{ mo: "A", qty: 3, done: true, extra: { a: 1 }, note: null }] });
    const r = await makeSheetTool.run({ sheet: "query", sql: `SELECT * FROM "MasterOrder"`, name: "My/odd:name" }, ctxOf());
    expect(JSON.parse(r.text).file).toBe("My-odd-name.xlsx");
    expect(h.rows).toHaveBeenCalledWith(`SELECT * FROM "MasterOrder"`, MAX_SHEET_ROWS);
    expect(keptSheet().rows[0]).toEqual({ mo: "A", qty: 3, done: "yes", extra: "{\"a\":1}", note: "" });
    h.rows.mockResolvedValue({ ok: true, truncated: true, rows: [] });
    expect(await makeSheetTool.run({ sheet: "query", sql: "SELECT 1" }, ctxOf())).toEqual({ ok: false, text: expect.stringContaining("narrow it") });
    expect(await makeSheetTool.run({ sheet: "query", sql: `SELECT * FROM "ShiftEntry"` }, ctxOf({ hidden: new Set(["shifts"]) }))).toEqual({ ok: false, text: expect.stringContaining("not opened") });
  });

  it("keeps only the saved attendance of the section asked for", async () => {
    const line = (empId: string, dept: string) => ({ workerId: 1, empId, name: "W", jobTitle: null, dept, sections: [], sectionLabels: [], onVacation: false, present: true, shift: "S9", overtimeH: 0, center: null, note: "" });
    h.roster.mockResolvedValue({ dateISO: "2026-10-26", lines: [line("1", "Welding"), line("2", "LvPunching")] });
    const r = await makeSheetTool.run({ sheet: "shift_attendance", section: "line:TR" }, ctxOf());
    expect(JSON.parse(r.text)).toMatchObject({ rows: 1, file: "attendance-2026-10-26.xlsx" });
    expect(await makeSheetTool.run({ sheet: "shift_attendance", day: "2026-10-30" }, ctxOf())).toEqual({ ok: false, text: expect.stringContaining("not come") });
    expect(await makeSheetTool.run({ sheet: "shift_attendance", section: "nowhere" }, ctxOf())).toEqual({ ok: false, text: expect.stringContaining("not a section") });
  });

  it("checks what it is asked for before it reads anything", () => {
    expect(checkToolInput(makeSheetTool, { sheet: "query" })).toEqual({ ok: false, error: expect.stringContaining("SELECT") });
    expect(checkToolInput(makeSheetTool, { sheet: "trace" })).toEqual({ ok: false, error: expect.stringContaining("MO") });
    expect(checkToolInput(makeSheetTool, { sheet: "daily_log", from: "2026-10-26", to: "2026-10-20" })).toEqual({ ok: false, error: expect.stringContaining("after") });
    expect(checkToolInput(makeSheetTool, { sheet: "daily_log", from: "2026-02-30" })).toEqual({ ok: false, error: expect.stringContaining("YYYY-MM-DD") });
    // an input the sheet does not take is refused, never quietly dropped
    expect(checkToolInput(makeSheetTool, { sheet: "plan_tracker", q: "BOM-A" })).toEqual({ ok: false, error: expect.stringContaining("plan_tracker does not take q") });
    expect(checkToolInput(makeSheetTool, { sheet: "physical_stock", from: "2026-10-01" })).toEqual({ ok: false, error: expect.stringContaining("nothing but its name") });
    expect(checkToolInput(makeSheetTool, { sheet: "weekly_plan", stages: "cut,paint" })).toEqual({ ok: false, error: expect.stringContaining("Stages") });
    expect(checkToolInput(makeSheetTool, { sheet: "nothing" })).toMatchObject({ ok: false });
    expect(checkToolInput(makeSheetTool, { sheet: "plan_tracker", line: "LV" })).toMatchObject({ ok: true });
  });

  it("is offered in a chat, even with the changes paused, and never unattended", () => {
    expect(toolsFor(user(), { hidden: new Set(), actionsPaused: true }).map((t) => t.name)).toContain("make_excel");
    expect(toolsFor(user(), { hidden: new Set(), actionsPaused: false, unattended: true }).map((t) => t.name)).not.toContain("make_excel");
  });

  it("takes a whole Daily log period or none — never one cut short", async () => {
    h.soi.mockResolvedValue({ byMo: {}, byBom: {} });
    const e = { id: 1, date: new Date("2026-10-26T00:00:00Z"), dept: "Cut", bom: "B", bomRaw: null, mo: null, item: "TN", qty: 1, source: "worklist", createdBy: null, createdAt: new Date("2026-10-26T08:00:00Z") };
    h.prisma.handoverEntry.findMany.mockResolvedValue(Array.from({ length: MAX_SHEET_ROWS + 1 }, () => e));
    expect(await makeSheetTool.run({ sheet: "daily_log", from: "2025-01-01", dept: "Cut" }, ctxOf())).toEqual({ ok: false, text: expect.stringContaining("shorter period") });
    expect(h.prisma.aiFile.create).not.toHaveBeenCalled();
  });

  it("reads a period given by its first day alone as running to today, and refuses one not yet begun", async () => {
    h.odooLog.mockResolvedValue({ entries: [] });
    await makeSheetTool.run({ sheet: "odoo_log", from: "2026-10-01" }, ctxOf());
    expect(h.odooLog).toHaveBeenCalledWith({ kind: "range", from: "2026-10-01", to: "2026-10-26" });
    h.odooDays.mockResolvedValue({ basis: "closed", series: [], days: [] });
    await makeSheetTool.run({ sheet: "odoo_daily", from: "2026-09-01" }, ctxOf());
    expect(h.odooDays.mock.calls[0][0]).toMatchObject({ fromISO: "2026-09-01", toISO: expect.any(String) });
    // the period alone — no comparison is read for the sheet
    expect(h.odooDays.mock.calls[0].slice(2)).toEqual([null, "none"]);
    expect(checkToolInput(makeSheetTool, { sheet: "odoo_log", to: "2026-10-20" })).toEqual({ ok: false, error: expect.stringContaining("first day") });
    expect(await makeSheetTool.run({ sheet: "consumables_log", from: "2026-11-02" }, ctxOf())).toEqual({ ok: false, text: expect.stringContaining("not started") });
  });
});

describe("the Consumables dashboard's sheet", () => {
  it("reads the screen's own address — the period and the filters — and writes its detail table", async () => {
    const limit = { ruleId: 1, sourceId: 1, basis: "pool", period: "month", qty: 10, perWorker: null, departmentsLabel: "Welding TX", shared: false,
      window: { from: "2026-10-01", to: "2026-10-31" }, windowLabel: "Oct 2026", toDate: true, limit: 10, used: 12, left: 0, over: 2, ratio: 1.2, status: "over", headcount: null };
    h.decisions.mockResolvedValue({ rows: [
      { key: "c1|WeldingTX", itemKey: "c1", itemId: 1, item: "Cotton Gloves", code: "C-GLV", uom: "PAIR", department: "WeldingTX", departmentLabel: "Welding TX", qty: 12, handOuts: 3, lastDayISO: "2026-10-20",
        recordedOver: 1, lastReason: "new crew", status: "over", limits: [limit], suggestion: null, issues: [], logIds: [] },
      { key: "t:rags|Store", itemKey: "t:rags", itemId: null, item: "Rags", code: null, uom: null, department: "Store", departmentLabel: "Store", qty: 4, handOuts: 1, lastDayISO: "2026-10-02",
        recordedOver: 0, lastReason: null, status: "none", limits: [], suggestion: { id: 9, name: "Cleaning Cloth", code: null, match: "similar" }, issues: [], logIds: [] },
    ] });
    const r = await makeSheetTool.run({ sheet: "consumables_dashboard", address: "from=2026-10-01&to=2026-10-20&dept=WeldingTX&status=over&junk=1" }, ctxOf());
    expect(r.ok).toBe(true);
    expect(h.decisions).toHaveBeenCalledWith("2026-10-01", "2026-10-20", "2026-10-26", { department: "WeldingTX", item: null, link: null, status: "over" });
    const kept = keptSheet();
    expect(kept.sheet).toBe("By item and department");
    expect(kept.rows[0]).toMatchObject({ Item: "Cotton Gloves", UOM: "PAIR", "Used in window": 12, Left: 0, Over: 2, Status: "Over the limit", "Recorded reason": "new crew", Catalogue: "linked" });
    expect(kept.rows[1]).toMatchObject({ Item: "Rags", Status: "No limit", Catalogue: "not linked", "Suggested item (review)": "Cleaning Cloth — similar name" });
    // no limit is no number — never a zero
    expect(kept.rows[1].Limit ?? "").toBe("");
  });

  it("takes nothing but the address", () => {
    expect(checkToolInput(makeSheetTool, { sheet: "consumables_dashboard", from: "2026-10-01" })).toEqual({ ok: false, error: expect.stringContaining("takes address") });
  });
});

describe("the workbook kept, and its printout", () => {
  it("names repeated sheets apart, and keeps the file on the person's chat", async () => {
    const plan = { name: "Plan", rows: [{ a: 1 }] };
    expect(await storeMadeWorkbook({ user: user(), conversationId: 3 }, "x", [plan, plan, plan, { name: "a/b:c", rows: [{ a: 1 }] }])).toMatchObject({ ok: true, file: { name: "x.xlsx" } });
    const wb = XLSX.read(h.prisma.aiFile.create.mock.calls[0][0].data.data, { type: "array" });
    expect(wb.SheetNames).toEqual(["Plan", "Plan 2", "Plan 3", "a b c"]);
    expect(h.prisma.aiFile.create.mock.calls[0][0].data).toMatchObject({ userId: 7, conversationId: 3, kind: "excel", size: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("prints the header and the first rows of the person's own sheet, counting the rest", async () => {
    const ws = XLSX.utils.json_to_sheet(Array.from({ length: 5 }, (_, i) => ({ MO: `M${i}`, Qty: i })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Orders");
    const data = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    h.prisma.aiFile.findFirst.mockResolvedValue({ name: "orders.xlsx", kind: "excel", data, createdAt: new Date("2026-10-26T08:00:00Z") });
    const p = await printableSheet(7, 42, 2);
    expect(h.prisma.aiFile.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 42, userId: 7 } }));
    expect(p).toMatchObject({ name: "orders.xlsx", sheet: "Orders", header: ["MO", "Qty"], rows: [["M0", "0"], ["M1", "1"]], total: 5 });
    h.prisma.aiFile.findFirst.mockResolvedValue({ name: "p.png", kind: "image", data, createdAt: new Date() });
    expect(await printableSheet(7, 43, 2)).toBeNull();
    h.prisma.aiFile.findFirst.mockResolvedValue(null);
    expect(await printableSheet(8, 42, 2)).toBeNull();
  });
});
