import "server-only";
import { ITEMS, deptLabel, isPaintExempt, type Item } from "@/lib/domain/constants";
import { BASIS_EXPORT, PERIOD_LABEL } from "@/lib/domain/consumableLimits";
import { MONTH_STATUS_LABEL } from "@/lib/domain/consumableMonthly";
import { ROW_STATUS_LABEL, headcountText, limitBasisText, type DecisionRow } from "@/lib/domain/consumablesDecisions";
import type { ItemStat } from "@/lib/domain/consumablesStats";
import type { LogRow } from "@/lib/domain/dailyLogView";
import { downtimeLabel, stopDurationLabel } from "@/lib/domain/downtime";
import { liveStopHours } from "@/lib/domain/downtimePeriods";
import { holdLabel } from "@/lib/domain/hold";
import type { ProductLine } from "@/lib/domain/lines";
import { round3 } from "@/lib/domain/material";
import { STATUS_LABEL } from "@/lib/domain/physicalStock";
import { normCode, type needByStock } from "@/lib/domain/materialCoverage";
import type { OrderRow } from "@/lib/domain/registryView";
import { ATTENDANCE_LABEL, ATTENDANCE_TIME, DEFAULT_SHIFT_HOURS, WORK_CENTRE_LABEL, rosterDeptName, rosterLineReading } from "@/lib/domain/shifts";
import { soiOf } from "@/lib/domain/soi";
import { WORKER_DEPT_LABEL } from "@/lib/domain/tanks";
import { trackerOdooTotal } from "@/lib/domain/trackerOdoo";
import { TRACKER_STAGE_ORDER } from "@/lib/domain/trackerSummary";
import type { CatalogueItemDTO, LimitStandingView } from "./consumableLimits";
import type { MonthlyReportView } from "./consumableMonthly";
import type { ConsumableEditView, ConsumablesPageData } from "./consumables";
import type { DowntimeDay } from "./downtime";
import type { LvTraceResult } from "./lvTrace";
import type { LvTrackerRow } from "./lvTracker";
import type { MasterTrackerRow } from "./masterTracker";
import type { MaterialPageData } from "./material";
import { RATE_SOURCE_LABEL, WEIGHT_SOURCE_LABEL, type DetailRow } from "@/lib/domain/materialDashboard";
import type { OdooDashboardView, OdooPageData } from "./odoo";
import type { PhysicalStockData } from "./physicalStock";
import type { PowderView } from "./powderScrap";
import type { ShiftRosterData } from "./shifts";
import type { SoiLookup } from "./soi";
import type { TraceResult } from "./trace";

// The spreadsheets the app hands out, one per screen that used to carry an
// Export button — the same columns, in the same order, with the screen's own
// headers, so a file still drops straight back into the workbook the office
// keeps. The assistant builds them now (lib/server/ai/tools/sheets.ts); each
// function here turns a screen's loaded data into the sheet's rows. (The
// weekly plan's, which the Floor still exports itself, is in
// lib/domain/weeklyPlanView.ts.)

export type SheetRow = Record<string, string | number>;

/** The ODOO close-out log, with the office sheet's own headers. */
export function odooLogRows(entries: OdooPageData["entries"]): SheetRow[] {
  return entries.map((e) => ({
    Date: e.dateISO,
    "SOI#": e.soi ?? "",
    "FG-CODE": e.fgCode,
    Product: e.product,
    "MO#": e.odooMo,
    QTY: e.qty,
    Status: e.status,
    "Done at": e.doneAtISO ? e.doneAtISO.slice(0, 16).replace("T", " ") : "",
    Source: e.source === "painting" ? "Painting" : e.source === "shotblast" ? "Shot Blast" : e.source === "import" ? "Import" : "",
    Notes: [...e.notes].reverse().map((n) => `${n.atISO.slice(0, 16).replace("T", " ")}: ${n.text}`).join(" | "),
  }));
}

/** The material sheet: its own column names in its order, then the tab's
 *  additions — the panels' sheet and the transformers' differ. */
export function materialRows(lines: MaterialPageData["lines"], line: ProductLine): SheetRow[] {
  if (line === "LV") {
    return lines.map((l) => ({
      MO: l.mo,
      Product: l.partName,
      "Sec Item": l.materialCode,
      "Planned qty": l.units,
      BOM: l.bom,
      Material: l.material,
      Thickness: l.thicknessMm,
      "Sheet Size": l.sheetSize,
      "No. of Sheets In BOM For One Unit": l.sheetsPerUnit,
      "Sheets Qty as Per Bom": l.forJob,
      Produced: l.producedUsed ?? "",
      "Actually Consumed Sheets Qty as per Nesting": l.forProduced ?? "",
      "Remaining units": l.remainingUnits ?? "",
      REMARKS: l.note ?? "",
      // after the sheet's own columns: the monthly plans the order is in (the screen's Plan month)
      "Plan month": l.planMonths.join(", "),
    }));
  }
  return lines.map((l) => ({
    "MTR Request #": l.mtr,
    SOI: l.soi,
    MO: l.mo,
    "BOM Ref": l.bom,
    "Quantity of Units": l.units,
    "Part Code": l.partCode,
    "Part Name": l.partName,
    "Material Code": l.materialCode,
    Material: l.material,
    "Thickness (mm)": l.thicknessMm,
    "Sheet Size": l.sheetSize,
    "Weight(Kg)": l.weightKg ?? "",
    "BOM Qty for one Unit": l.sheetsPerUnit,
    "No. of Pieces in Actual Nesting for one Unit": l.actualPerUnit === null ? "" : Number(l.actualPerUnit.toFixed(4)),
    "BOM Pieces for Job": l.forJob,
    "No. of Pieces in Actual Nesting for Job": l.sheetsUsed ?? "",
    "Average Utilization": l.utilization ?? "",
    "Actual Weight (Kg)": l.actualWeightKg ?? "",
    Difference: l.difference ?? "",
    Notes: l.note ?? "",
    "Plan month": l.planMonths.join(", "),
  }));
}

/** The store's count against Odoo's, with the store's own headers and the gap
 *  — and, given, the sheets the open orders still need and Odoo after them. */
export function physicalRows(items: PhysicalStockData["items"], need?: ReturnType<typeof needByStock> | null): SheetRow[] {
  const needCols = (code: string): SheetRow => {
    const n = need?.byCode[normCode(code)];
    // a code held in kilos has a need but no after figure — said, never left blank as "nothing needed"
    return need ? { "Open Orders Need (sheets)": n?.need ?? "", "Odoo After Need": n ? (n.after ?? "n/a (other unit)") : "" } : {};
  };
  const rows: SheetRow[] = items.map((i) => ({
    "Product Code": i.code,
    "Product Name": i.name,
    "Physically Stock Internal Store": i.physical,
    UOM: i.uom,
    "SF01 Stock In Odoo": i.odoo,
    ...needCols(i.code),
    Difference: i.diff,
    Family: i.group,
    Status: STATUS_LABEL[i.status],
    Note: i.note ?? "",
  }));
  // the codes the open orders need that the table does not carry, after it
  for (const m of need?.missing ?? []) {
    rows.push({ "Product Code": m.code, "Product Name": `${m.thicknessMm} mm ${m.material} ${m.sheetSize}`.trim(), "Physically Stock Internal Store": "", UOM: "", "SF01 Stock In Odoo": "", "Open Orders Need (sheets)": m.sheets, "Odoo After Need": "", Difference: "", Family: "", Status: "Not on the table", Note: "" });
  }
  return rows;
}

/** A month of powder scrap: a "Month" row per section and both together, then
 *  a "Weighing" row per entry. */
export function powderRows(r: PowderView, month: string): SheetRow[] {
  const rate = (x: { rate: number | null }) => (x.rate === null ? "" : `${Math.round(x.rate * 1000) / 10}%`);
  return [
    ...[...r.departments, { label: "Both sections", ...r.total }].map((d) => ({
      Kind: "Month", Month: month, Day: "", Section: d.label, "Drawn (kg)": d.withdrawn, "Scrap (kg)": d.scrap, "Net used (kg)": d.net, "Scrap rate": rate(d), Notes: "", "Recorded by": "",
    })),
    ...r.entries.map((e) => ({
      Kind: "Weighing", Month: month, Day: e.dayISO, Section: e.departmentLabel, "Drawn (kg)": "", "Scrap (kg)": e.kg, "Net used (kg)": "", "Scrap rate": "", Notes: e.notes ?? "", "Recorded by": e.recordedBy,
    })),
  ];
}

/** The consumables catalogue: a row per limit (one for an item with none),
 *  with where each stands now. */
export function consumableLimitRows(items: readonly CatalogueItemDTO[], standings: Record<number, LimitStandingView>): SheetRow[] {
  return items.flatMap((i) => (i.limits.length ? i.limits : [null]).map((l) => {
    const s = l ? standings[l.id] : undefined;
    return {
      Code: i.code ?? "",
      Item: i.name,
      UOM: i.uom,
      Active: i.active ? "yes" : "retired",
      Limit: l ? l.qty : "",
      Per: l ? PERIOD_LABEL[l.period] : "",
      Counted: l ? BASIS_EXPORT[l.basis] : "",
      Departments: l ? l.departmentsLabel : "",
      Window: s?.windowLabel ?? "",
      // an each-department or per-worker limit: every department's number added up
      "Limit now": s ? s.limit : "",
      "Used now": s ? s.used : "",
      "Left now": s ? round3(s.limit - s.used) : "",
      "Departments over": s && s.departments.length ? s.departments.filter((d) => d.used > d.limit + 1e-9).map((d) => `${d.label} ${d.used}/${d.limit}`).join(" · ") : "",
      Remark: i.remark ?? "",
    };
  }));
}

/** Every change made to a recorded hand-out. */
export function consumableEditRows(edits: readonly ConsumableEditView[]): SheetRow[] {
  return edits.map((e) => ({
    "Changed at": e.atLabel,
    By: e.by,
    Action: e.action,
    Changes: e.changes.join(" | "),
    Before: e.before,
    After: e.after ?? "",
    "Row now": e.issue.deleted ? `(deleted) ${e.issue.now}` : e.issue.now,
    "Handed out": e.issue.issuedAtLabel,
    "Recorded by": e.issue.recordedBy,
  }));
}

/** The consumables log: a row per hand-out. */
export function consumablesLogRows(entries: ConsumablesPageData["entries"]): SheetRow[] {
  return entries.map((e) => ({
    "Date & time": e.issuedAtLabel,
    Item: e.item,
    Qty: e.qty,
    UOM: e.uom ?? "",
    Department: e.departmentLabel,
    "Emp ID": e.worker?.empId ?? "",
    "Requested / collected by": e.worker?.name ?? e.group?.label ?? "",
    "Group's workers": e.group ? e.group.workers.map((w) => `${w.empId} ${w.name}`).join(", ") : "",
    Notes: e.notes ?? "",
    "Over limit": e.overLimit ? "yes" : "",
    "Over-limit reason": e.overLimit?.reason ?? "",
    "Recorded by": e.recordedBy,
    "Edited by": e.edited ? `${e.edited.by} (${e.edited.atLabel})` : "",
  }));
}

/** What went out over a period, item by item. */
export function consumablesSummaryRows(items: readonly ItemStat[]): SheetRow[] {
  return items.map((i) => ({ Item: i.item, "Hand-outs": i.issues, Qty: i.qty, Workers: i.workers }));
}

/** The Consumables dashboard's detail table: a row per item and department,
 *  against the limit that reads worst at the period's end — the screen's own
 *  columns, under the same filters. */
export function consumablesDecisionRows(rows: readonly DecisionRow[]): SheetRow[] {
  return rows.map((r) => {
    const l = r.limits[0];
    return {
      Item: r.item,
      Code: r.code ?? "",
      UOM: r.uom ?? "",
      Department: r.departmentLabel,
      Qty: r.qty,
      "Hand-outs": r.handOuts,
      "Limit basis": l ? limitBasisText(l, r.uom) : "",
      Limit: l ? l.limit : "",
      Per: l ? PERIOD_LABEL[l.period] : "",
      Window: l ? `${l.windowLabel}${l.toDate ? " to date" : ""}` : "",
      "Used in window": l ? l.used : "",
      Left: l ? l.left : "",
      Over: l ? l.over : "",
      Status: ROW_STATUS_LABEL[r.status],
      "Other limits": r.limits.length > 1 ? r.limits.slice(1).map((x) => `${limitBasisText(x, r.uom)} ${PERIOD_LABEL[x.period]}: ${x.used}/${x.limit}`).join(" | ") : "",
      Headcount: l?.headcount ? headcountText(l.headcount) : "",
      "Recorded over": r.recordedOver,
      "Recorded reason": r.lastReason ?? "",
      Catalogue: r.itemId !== null ? "linked" : "not linked",
      "Suggested item (review)": r.suggestion ? `${r.suggestion.name}${r.suggestion.code ? ` (${r.suggestion.code})` : ""} — ${r.suggestion.match} name` : "",
      "Last hand-out": r.lastDayISO,
    };
  });
}

/** The monthly review: a row per item, then a row per limit under it, and a
 *  column per month of the trend. */
export function consumablesMonthlyRows(report: MonthlyReportView): SheetRow[] {
  return report.rows.flatMap((r) => [
    {
      Level: "Item", Code: r.code ?? "", Item: r.name, UOM: r.uom, Departments: "", Limit: "", "Monthly limit": r.allowance ?? "",
      Used: r.used, Left: r.allowance === null ? "" : round3(r.allowance - r.covered), "Outside the limits": r.outside, "Of the limit": r.ratio === null ? "" : `${Math.round(r.ratio * 100)}%`,
      Status: MONTH_STATUS_LABEL[r.status], [`Used ${report.prevMonth}`]: r.prevUsed,
      "Counted over": "",
      ...Object.fromEntries(r.trend.map((t) => [t.month, t.used])),
    },
    ...r.limits.map((l) => ({
      Level: "Limit", Code: r.code ?? "", Item: r.name, UOM: r.uom, Departments: l.departmentsLabel,
      Limit: l.perWorker
        ? `${l.perWorker.qty} per worker × ${Math.max(1, l.perWorker.workers)} ${PERIOD_LABEL[l.period]}`
        : `${l.qty} ${PERIOD_LABEL[l.period]} (${BASIS_EXPORT[l.basis]})`,
      "Monthly limit": l.allowance,
      Used: l.used, Left: l.left, "Outside the limits": "", "Of the limit": `${Math.round(l.ratio * 100)}%`, Status: MONTH_STATUS_LABEL[l.status],
      [`Used ${report.prevMonth}`]: l.prevUsed,
      "Counted over": l.toDate ?? "",
      ...Object.fromEntries(r.trend.map((t) => [t.month, ""])),
    })),
  ]);
}

/** The monthly Plan Tracker (transformers): a row per order. The columns
 *  follow the department filter — only the picked stages per component, and
 *  the summary columns only in the full, unfiltered view, as the table shows
 *  them. `month` is the tracker's month filter, which Odoo's closings follow. */
export function masterTrackerRows(rows: readonly MasterTrackerRow[], stages: readonly string[], month = ""): SheetRow[] {
  const scoped = stages.length > 0;
  const exportStages = scoped ? stages : TRACKER_STAGE_ORDER;
  const stageColLabel = (s: string, it: Item) =>
    s === "Cut" ? "Fab" : s === "Welding" ? "Weld" : s === "Delivered" ? "Dlvd" : isPaintExempt(it) ? "SHB" : "Paint";
  const stageColValue = (c: MasterTrackerRow["items"][Item], s: string, it: Item) =>
    s === "Cut" ? c.cut : s === "Welding" ? c.weld : s === "Delivered" ? c.delivered : isPaintExempt(it) ? c.shp : c.paint;
  return rows.map((r) => {
    const row: SheetRow = {
      MO: r.mo,
      BOM: r.bom,
      "Plan months": r.months.join(", "),
      "Odoo allocated to plan": r.odooPlanMonth ?? "No plan month",
      SOI: r.soi ?? "",
      Customer: r.customer ?? "",
      Urgent: r.urgent ? "Yes" : "",
      KVA: r.kva ?? "",
      "Color RAL": r.colorRal ?? "",
      "CRC Size": r.crcSize ?? "",
      SFM: r.sfm ?? "",
      Required: r.required,
      "On hold": r.hold.onHold ? holdLabel(r.hold) : "",
      Fins: r.fins ?? "",
    };
    for (const it of ITEMS) {
      const c = r.items[it];
      for (const s of exportStages) {
        // N/A components (rule or manual) export blank, like the table's dashes
        row[`${it} ${stageColLabel(s, it)}`] = !c.eligible || c.excluded ? "" : stageColValue(c, s, it);
      }
      const odoo = trackerOdooTotal([r], it, month);
      row[`${it} Odoo closed`] = !c.eligible || c.excluded ? "" : c.odooTracked === false && odoo.qty === 0 ? "Not tracked" : odoo.qty;
      if (odoo.unallocated) row[`${it} Odoo not allocated`] = `${odoo.unallocated} project pcs outside the allocated plan quantities`;
    }
    row.OSP = ITEMS.filter((it) => r.items[it].osp > 0).map((it) => `${it}×${r.items[it].osp}`).join(" ");
    if (!scoped) {
      row.Welded = r.welded;
      row["Complete (painted)"] = r.complete;
      row.Left = r.remaining;
      row["Achievement %"] = r.achievement === null ? "" : Math.round(r.achievement * 100);
    }
    row.Status = r.status;
    return row;
  });
}

/** The panels' Plan Tracker: a row per order. */
export function lvTrackerRows(rows: readonly LvTrackerRow[]): SheetRow[] {
  return rows.map((r) => ({
    MO: r.mo, SOI: r.soi ?? "", Customer: r.customer ?? "", Product: r.product ?? "", BoM: r.bom, "SEC Item": r.secItem ?? "",
    Required: r.state.required, Punched: r.state.punch, Bent: r.state.bend, Welded: r.state.weld, Painted: r.state.paint,
    "Odoo closed": r.odooClosed ?? "Not tracked", // as the transformers' sheet says it
    Left: r.remaining, Status: r.status, "On hold": r.hold.onHold ? holdLabel(r.hold) : "",
  }));
}

/** The Daily log: a row per entry, its SOI found from the MO or the BOM. */
export function dailyLogRows(entries: readonly LogRow[], soi: SoiLookup): SheetRow[] {
  return entries.map((r) => ({
    Date: r.date,
    DEPT: deptLabel(r.dept),
    BOM: r.bom,
    MO: r.mo ?? "",
    SOI: soiOf(soi, r.mo, r.bom) ?? "",
    Item: r.item,
    QTY: r.qty,
    Source: r.source,
    By: r.createdBy ?? "",
    "Corrected From": r.bomRaw && r.bomRaw !== r.bom ? r.bomRaw : "",
    "Check ⚠": r.flags?.join(" | ") ?? "",
  }));
}

/** A transformer order's (or a code's) trace: every ledger row behind it. */
export function traceRows(t: TraceResult): SheetRow[] {
  return t.ledger.map((l) => ({
    Date: l.dateISO, MO: l.mo ?? "", Plan: l.planLabel, Dept: deptLabel(l.dept), Item: l.item, Qty: l.qty,
    Source: l.source, By: l.by ?? "", "Corrected from": l.corrected ?? "",
  }));
}

/** A panel order's (or a code's) trace: its timeline. */
export function lvTraceRows(t: LvTraceResult): SheetRow[] {
  return t.timeline.map((e) => ({
    Date: e.dateISO, MO: e.mo ?? "", Stage: e.stage, Qty: e.qty, By: e.by ?? "", Source: e.source, Note: e.note ?? "",
  }));
}

/** The Orders Registry: the panels' columns or the transformers'. */
export function registryRows(orders: readonly OrderRow[], line: ProductLine): SheetRow[] {
  return orders.map((r): SheetRow => (line === "LV"
    ? {
      MO: r.mo, SOI: r.soi ?? "", Urgent: r.urgent ? "Yes" : "", Customer: r.customer ?? "",
      Product: r.product ?? "", "FG Code": r.fgCode ?? "", BoM: r.bom, "SEC Item": r.secItem ?? "",
      "Planned Qty": r.planQty, "OSP Encloser": r.ospEncloser, Remarks: r.remarks ?? "", "Materials Remarks": r.materialsRemarks ?? "",
      Source: r.source ?? "", Added: r.createdAt.slice(0, 10),
    }
    : {
      MO: r.mo, SOI: r.soi ?? "", Urgent: r.urgent ? "Yes" : "", Customer: r.customer ?? "",
      "FG Code": r.fgCode ?? "", BOM: r.bom, KVA: r.kva ?? "", Rating: r.rating ?? "",
      "Plan Qty": r.planQty, "Color RAL": r.colorRal ?? "", Remarks: r.remarks ?? "",
      Source: r.source ?? "", Added: r.createdAt.slice(0, 10),
    }));
}

/** A day's machine stops, an open one counted up to `now`. */
export function downtimeRows(data: DowntimeDay, now: Date): SheetRow[] {
  return data.rows.map((r) => {
    const { hours, dayHours } = liveStopHours(r, data.dateISO, now);
    return {
      Date: r.dateISO ?? data.dateISO, Status: r.isOpen ? "Open" : "Resolved", "As of": now.toISOString(),
      "Hours on selected day": dayHours, "End date": r.endDateISO ?? "",
      Machine: r.machineCode, Name: r.machineName, Department: rosterDeptName(r.dept), Centre: r.centre ? WORK_CENTRE_LABEL[r.centre] : rosterDeptName(r.dept),
      From: r.startTime ?? "", To: r.endTime ?? "", "End next day": r.endsNextDay ? "Yes" : "", Duration: stopDurationLabel(hours), Hours: hours,
      Why: downtimeLabel(r.reasonCode, r.reason), Note: r.reasonCode ? r.reason ?? "" : "", By: r.recordedBy ?? "",
    };
  });
}

/** A day's attendance as saved: a row per worker. */
export function rosterRows(data: ShiftRosterData): SheetRow[] {
  const hrs = data.shiftHours ?? DEFAULT_SHIFT_HOURS;
  return data.lines.map((d) => {
    const l = rosterLineReading(d, hrs);
    return {
      Date: data.dateISO,
      Badge: d.empId,
      Name: d.name,
      "Job title": d.jobTitle ?? "",
      Department: WORKER_DEPT_LABEL[d.dept],
      Section: d.sectionLabels.join(", "),
      "Work centre": l.centre ?? "",
      Attendance: l.attendance === "unset" ? "Not set" : ATTENDANCE_LABEL[l.attendance],
      Time: l.attendance === "day" || l.attendance === "night" ? ATTENDANCE_TIME[l.attendance] : "",
      "Overtime h": l.overtimeH || "",
      Hours: l.attendance === "unset" ? "" : l.hours,
      Note: d.note,
    };
  });
}

/** The Material dashboard's detail table: a row per MO × part × sheet spec,
 *  blank where a figure is unknown (never a zero). Closed qty is the MO's,
 *  on each of its lines. */
export function materialDashboardRows(rows: readonly DetailRow[]): SheetRow[] {
  const blank = (v: number | null) => (v === null ? "" : v);
  return rows.map((r) => ({
    MO: r.mo, SOI: r.soi, BOM: r.bom, "Part code": r.partCode, "Part name": r.partName, Material: r.material, "Thickness mm": r.thicknessMm, "Sheet size": r.sheetSize,
    "Sheet copy": r.month || "Living sheet", Units: r.units, "BOM sheets": r.bomSheets, "Actual sheets": blank(r.actualSheets), "Delta sheets": blank(r.deltaSheets),
    "Sheet kg": blank(r.sheetKg), "Weight source": WEIGHT_SOURCE_LABEL[r.weightSource], Utilization: r.utilization === null ? "" : Math.round(r.utilization * 1000) / 1000,
    "Closed qty (MO)": r.closedQty, "Consumed sheets": r.consumedSheets, "Consumed kg": blank(r.consumedKg), "Est. scrap kg": blank(r.scrapKg),
    "Rate source": RATE_SOURCE_LABEL[r.rateSource], "Sheets per unit": r.ratePerUnit,
  }));
}

/** The ODOO dashboard's days: a row per day with something logged or closed,
 *  a column per series on the dashboard's basis. */
export function odooDailyRows(d: OdooDashboardView): SheetRow[] {
  const word = d.basis === "closed" ? "closed" : "logged";
  return d.days.filter((p) => p.rows > 0 || p.loggedRows > 0 || p.doneRows > 0).map((p) => ({
    Day: p.dateISO,
    ...Object.fromEntries(d.series.map((s) => [`${s} (${word})`, p.bySeries[s]])),
    [`Total ${word}`]: p.qty,
    [`Rows ${word}`]: p.rows,
    "Logged qty": p.loggedQty,
    "Logged rows": p.loggedRows,
    "Closed qty": p.doneQty,
    "Closed rows": p.doneRows,
  }));
}
