import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ITEMS } from "@/lib/domain/constants";
import type { LogRow } from "@/lib/domain/dailyLogView";
import { orderRowOf, type RegistryOrder } from "@/lib/domain/registryView";
import { dailyLogRows, downtimeRows, lvTraceRows, masterTrackerRows, odooDailyRows, odooLogRows, physicalRows, registryRows, rosterRows } from "@/lib/server/sheets";
import { stockView } from "@/lib/domain/physicalStock";
import type { DowntimeDay } from "@/lib/server/downtime";
import type { LvTraceResult } from "@/lib/server/lvTrace";
import type { MasterTrackerRow } from "@/lib/server/masterTracker";
import type { OdooDashboardView, OdooPageData } from "@/lib/server/odoo";
import type { ShiftRosterData } from "@/lib/server/shifts";

// The sheets the assistant hands out in place of the screens' Export
// buttons (lib/server/sheets.ts): the screen's own columns and headers, read
// off its data.

const tracker = (mo: string, extra: Partial<MasterTrackerRow> = {}): MasterTrackerRow => ({
  mo, bom: `BOM-${mo}`, soi: "SOI-1", customer: "ACME", urgent: false, kva: "1000", rating: null,
  fins: null, crcSize: null, colorRal: null, sfm: null, required: 10, welded: 4, complete: 2, remaining: 8,
  achievement: 0.2, status: "open", hold: { onHold: false, holdNote: null, holdSinceISO: null, holdBy: null },
  priority: false, months: ["October 2026"], pendingQty: null, odooPlanMonth: "October 2026",
  items: Object.fromEntries(ITEMS.map((it) => [it, { cut: 6, weld: 4, paint: 2, shp: 3, delivered: 1, osp: 0, excluded: false, eligible: true, odooTracked: true, odooClosed: 2 }])) as MasterTrackerRow["items"],
  ...extra,
});

describe("masterTrackerRows", () => {
  it("carries every stage per component and the summary columns in the full view", () => {
    const [r] = masterTrackerRows([tracker("A")], []);
    expect(r).toMatchObject({ MO: "A", BOM: "BOM-A", "Plan months": "October 2026", "TN Fab": 6, "TN Weld": 4, "TN Paint": 2, "TN Dlvd": 1, "CF SHB": 3, "TN Odoo closed": 2, Welded: 4, "Complete (painted)": 2, Left: 8, "Achievement %": 20, Status: "open" });
    expect(Object.keys(r).at(-1)).toBe("Status");
  });

  it("narrows to the picked departments and drops the summary under a department filter", () => {
    const [r] = masterTrackerRows([tracker("A")], ["Welding"]);
    expect(r).toHaveProperty("TN Weld", 4);
    expect(r).not.toHaveProperty("TN Fab");
    expect(r).not.toHaveProperty("Left");
  });

  it("leaves a component the order does not make blank, as the table's dash", () => {
    const row = tracker("A");
    row.items.TC = { ...row.items.TC, excluded: true };
    const [r] = masterTrackerRows([row], []);
    expect(r["TC Fab"]).toBe("");
    expect(r["TC Odoo closed"]).toBe("");
  });
});

describe("dailyLogRows", () => {
  const entry = (o: Partial<LogRow> = {}): LogRow => ({ id: 1, date: "2026-10-26", dept: "Welding", bom: "B1", bomRaw: null, mo: "MO/1", item: "TN", qty: 3, source: "worklist", createdBy: "Sara", flags: null, ...o });
  it("finds the SOI from the MO, else the BOM, and says what was corrected and flagged", () => {
    const soi = { byMo: { "MO/1": "S-1" }, byBom: { B2: "S-2" } };
    const [a, b] = dailyLogRows([entry(), entry({ mo: null, bom: "B2", bomRaw: "b 2", flags: ["far above usual", "late entry"] })], soi);
    expect(a).toMatchObject({ Date: "2026-10-26", BOM: "B1", MO: "MO/1", SOI: "S-1", QTY: 3, "Corrected From": "", "Check ⚠": "" });
    expect(b).toMatchObject({ MO: "", SOI: "S-2", "Corrected From": "b 2", "Check ⚠": "far above usual | late entry" });
  });
});

describe("registryRows", () => {
  const order: RegistryOrder = {
    id: 1, updatedAt: new Date("2026-10-02T08:00:00Z"), mo: "MO/1", soi: null, urgent: true, customer: "ACME", product: "USS", fgCode: "FG", bom: "B1", secItem: "SEC", kva: "1000", rating: "11kV",
    planQty: 4, ospEncloser: 1, colorRal: "7035", remarks: null, materialsRemarks: "steel", source: "Oct plan", createdAt: new Date("2026-10-01T08:00:00Z"),
  };
  it("lists the panels' columns for LV and the transformers' for TR", () => {
    expect(registryRows([orderRowOf(order)], "LV")[0]).toEqual({ MO: "MO/1", SOI: "", Urgent: "Yes", Customer: "ACME", Product: "USS", "FG Code": "FG", BoM: "B1", "SEC Item": "SEC", "Planned Qty": 4, "OSP Encloser": 1, Remarks: "", "Materials Remarks": "steel", Source: "Oct plan", Added: "2026-10-01" });
    expect(registryRows([orderRowOf(order)], "TR")[0]).toEqual({ MO: "MO/1", SOI: "", Urgent: "Yes", Customer: "ACME", "FG Code": "FG", BOM: "B1", KVA: "1000", Rating: "11kV", "Plan Qty": 4, "Color RAL": "7035", Remarks: "", Source: "Oct plan", Added: "2026-10-01" });
  });
});

describe("downtimeRows", () => {
  it("counts a stop still open up to now, and says so", () => {
    const data: DowntimeDay = {
      dateISO: "2026-10-26", machines: [],
      rows: [{ id: 1, machineId: 1, machineCode: "L1", machineName: "Laser 1", dept: "Cut", centre: null, hours: 0, reasonCode: "breakdown", reason: null, recordedBy: "Ali", startTime: "08:00", endTime: null, isOpen: true, dateISO: "2026-10-26", endDateISO: null }],
    };
    // 10:30 in Cairo
    const [r] = downtimeRows(data, new Date("2026-10-26T07:30:00Z"));
    expect(r).toMatchObject({ Status: "Open", Machine: "L1", From: "08:00", To: "", Hours: 2.5, "Hours on selected day": 2.5, By: "Ali" });
  });
});

describe("rosterRows", () => {
  it("reads a day's saved attendance — the shift, its hours and overtime, or not set", () => {
    const base = { workerId: 1, empId: "100", name: "Omar", jobTitle: null, dept: "Welding" as const, sections: [], sectionLabels: ["Tanks"], onVacation: false, overtimeH: 2, center: null, note: "" };
    const data = {
      dateISO: "2026-10-26", shiftHours: undefined,
      lines: [{ ...base, present: true, shift: "S9" }, { ...base, empId: "101", present: false, shift: "S9", recorded: false }],
    } as unknown as ShiftRosterData;
    const [day, unset] = rosterRows(data);
    expect(day).toMatchObject({ Badge: "100", Attendance: "Day", "Overtime h": 2, Section: "Tanks" });
    expect(typeof day.Hours).toBe("number");
    expect(unset).toMatchObject({ Badge: "101", Attendance: "Not set", Time: "", Hours: "", "Overtime h": "" });
  });
});

describe("odooLogRows and odooDailyRows", () => {
  it("keeps the office sheet's headers and the notes oldest first", () => {
    const entry = {
      dateISO: "2026-10-26", soi: null, fgCode: "FG1", product: "TN", odooMo: "WH/MO/1", qty: 2, status: "Done", doneAtISO: "2026-10-26T09:15:00.000Z", source: "painting",
      notes: [{ atISO: "2026-10-26T10:00:00.000Z", text: "second" }, { atISO: "2026-10-26T09:00:00.000Z", text: "first" }],
    } as unknown as OdooPageData["entries"][number];
    expect(odooLogRows([entry])[0]).toEqual({ Date: "2026-10-26", "SOI#": "", "FG-CODE": "FG1", Product: "TN", "MO#": "WH/MO/1", QTY: 2, Status: "Done", "Done at": "2026-10-26 09:15", Source: "Painting", Notes: "2026-10-26 09:00: first | 2026-10-26 10:00: second" });
  });
  it("lists only the days with something logged or closed, a column per series", () => {
    const d = {
      basis: "closed", series: ["TN", "CF"],
      days: [
        { dateISO: "2026-10-25", rows: 0, loggedRows: 0, doneRows: 0, qty: 0, loggedQty: 0, doneQty: 0, bySeries: { TN: 0, CF: 0 } },
        { dateISO: "2026-10-26", rows: 2, loggedRows: 1, doneRows: 2, qty: 5, loggedQty: 1, doneQty: 5, bySeries: { TN: 3, CF: 2 } },
      ],
    } as unknown as OdooDashboardView;
    expect(odooDailyRows(d)).toEqual([{ Day: "2026-10-26", "TN (closed)": 3, "CF (closed)": 2, "Total closed": 5, "Rows closed": 2, "Logged qty": 1, "Logged rows": 1, "Closed qty": 5, "Closed rows": 2 }]);
  });
});

describe("lvTraceRows", () => {
  it("is the timeline, a row each", () => {
    const t = { timeline: [{ dateISO: "2026-10-26", mo: null, stage: "Punch", qty: 4, by: null, source: "worklist", note: null }] } as unknown as LvTraceResult;
    expect(lvTraceRows(t)).toEqual([{ Date: "2026-10-26", MO: "", Stage: "Punch", Qty: 4, By: "", Source: "worklist", Note: "" }]);
  });
});

describe("physicalRows", () => {
  const item = (code: string, odoo: number) => ({ ...stockView({ code, name: `${code} sheet`, uom: "PC", physical: odoo, odoo }), id: 1, note: null, updatedBy: null, updatedAtISO: "" });
  it("adds the open orders' need and Odoo after it only when given", () => {
    const items = [item("C1", 25), item("C2", 5)];
    expect(physicalRows(items)[0]).not.toHaveProperty("Open Orders Need (sheets)");
    const need = {
      byCode: { C1: { need: 40, after: -15, status: "short" as const, estimated: false, orders: 2, jobCount: 2, jobs: [] }, C2: { need: 3, after: null, status: "not_comparable" as const, estimated: false, orders: 1, jobCount: 1, jobs: [] } },
      missing: [{ code: "C9", material: "Steel", thicknessMm: 5, sheetSize: "1220*2440", sheets: 12 }],
      unpriced: { noNesting: 0, uncoded: 0 },
    };
    const rows = physicalRows([...items, item("C3", 1)], need);
    expect(rows[0]).toMatchObject({ "SF01 Stock In Odoo": 25, "Open Orders Need (sheets)": 40, "Odoo After Need": -15 });
    expect(rows[1]).toMatchObject({ "Open Orders Need (sheets)": 3, "Odoo After Need": "n/a (other unit)" });
    expect(rows[2]).toMatchObject({ "Open Orders Need (sheets)": "", "Odoo After Need": "" });
    expect(rows[3]).toMatchObject({ "Product Code": "C9", "Open Orders Need (sheets)": 12, Status: "Not on the table" });
  });
});
