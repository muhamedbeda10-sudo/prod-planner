import { ITEMS, isPaintExempt, type Item } from "./constants";
import { LV_STAGES, lvStageOf, type LvState } from "./lv";
import type { ItemProgress } from "./trackerView";

export interface TrackerFilters {
  q?: string; month?: string; status?: string; progress?: string; urgent?: string;
  product?: string; family?: string; deptStage?: string;
}
interface CommonRow {
  mo: string; bom: string; soi: string | null; customer: string | null; status: string;
  urgent: boolean; months: string[]; hold: { onHold: boolean };
  complete: number; remaining: number;
}
export interface MasterSummaryRow extends CommonRow {
  kva: string | null; required: number;
  items: Record<Item, ItemProgress & { delivered: number }>;
}
export interface LvSummaryRow extends CommonRow {
  product: string | null; family: string; fgCode: string | null; secItem: string | null;
  state: LvState;
}

export function masterProgress(row: MasterSummaryRow): "complete" | "inprogress" | "notstarted" {
  if (row.required > 0 && row.complete >= row.required) return "complete";
  if (row.complete > 0 || ITEMS.some((it) => row.items[it].cut > 0 || row.items[it].weld > 0)) return "inprogress";
  return "notstarted";
}

/** Closed orders pile up month after month: the tracker page sends them only
 *  when the Status filter asks for them (?closed=1), and their count always. */
export function openFirst<T extends { status: string }>(sheet: readonly T[], withClosed: boolean) {
  const open = sheet.filter((r) => r.status !== "closed");
  return { rows: withClosed ? [...sheet] : open, hasClosed: withClosed, closedTotal: sheet.length - open.length };
}

/** Shared by the UI and the assistant: neither reinterprets the other's filters. */
export function filterMasterTracker<T extends MasterSummaryRow>(rows: readonly T[], f: TrackerFilters): T[] {
  const needle = (f.q ?? "").trim().toUpperCase();
  return rows.filter((r) => {
    if (f.month && !(f.month === "—" ? r.months.length === 0 : r.months.includes(f.month))) return false;
    if (f.status === "hold") { if (!r.hold.onHold) return false; }
    else if (f.status && r.status !== f.status) return false;
    if (needle && !`${r.mo} ${r.bom} ${r.soi ?? ""} ${r.customer ?? ""} ${r.kva ?? ""}`.toUpperCase().includes(needle)) return false;
    if (f.progress && masterProgress(r) !== f.progress) return false;
    return f.urgent !== "yes" || r.urgent;
  });
}

export function filterLvTracker<T extends LvSummaryRow>(rows: readonly T[], f: TrackerFilters): T[] {
  const needle = (f.q ?? "").trim().toUpperCase();
  const status = f.status || "open";
  return rows.filter((r) => {
    if (f.month && !r.months.includes(f.month)) return false;
    if (f.family && r.family !== (f.family === "PNL" ? "" : f.family)) return false;
    if (needle && !`${r.mo} ${r.bom} ${r.soi ?? ""} ${r.fgCode ?? ""} ${r.secItem ?? ""} ${r.customer ?? ""}`.toUpperCase().includes(needle)) return false;
    if (f.product && r.product !== f.product) return false;
    if (status === "hold") { if (!r.hold.onHold) return false; }
    else if (status !== "all" && r.status !== status) return false;
    if (f.urgent === "yes" && !r.urgent) return false;
    if (f.urgent === "no" && r.urgent) return false;
    if (f.progress === "none" && r.complete > 0) return false;
    if (f.progress === "partial" && !(r.complete > 0 && r.remaining > 0)) return false;
    if (f.progress === "done" && r.remaining > 0) return false;
    return true;
  });
}

export const TRACKER_STAGE_ORDER = ["Cut", "Welding", "Painting", "Delivered"] as const;
/** The departments picked in the tracker's filter ("Painting,Cut"), in
 *  pipeline order whatever order they were picked in. */
export function trackerStagesOf(picked = ""): string[] {
  const selected = new Set(picked.split(","));
  return TRACKER_STAGE_ORDER.filter((stage) => selected.has(stage));
}
export function summaryStage(picked = ""): string {
  return trackerStagesOf(picked).at(-1) ?? "";
}

export function trackerItemStats(rows: readonly MasterSummaryRow[], stage = "") {
  return ITEMS.map((it) => {
    let need = 0, done = 0;
    for (const r of rows) {
      const c = r.items[it];
      if (!c.eligible || c.excluded) continue;
      const target = Math.max(0, r.required - c.osp);
      const value = stage === "Cut" ? c.cut : stage === "Welding" ? c.weld : stage === "Delivered" ? c.delivered : isPaintExempt(it) ? c.shp : c.paint;
      need += target;
      done += Math.min(value, target);
    }
    const doneWord = stage === "Cut" ? "fabricated" : stage === "Welding" ? "welded" : stage === "Delivered" ? "delivered" : isPaintExempt(it) ? "shot blasted" : "painted";
    return { it, doneWord, need, done, remaining: Math.max(0, need - done), pct: need > 0 ? done / need : null };
  });
}

export function lvStageStats(rows: readonly LvSummaryRow[]) {
  return LV_STAGES.map((stage) => ({
    stage,
    need: rows.reduce((sum, r) => sum + r.state.required, 0),
    done: rows.reduce((sum, r) => sum + Math.min(lvStageOf(r.state, stage), r.state.required || Infinity), 0),
  }));
}

export function trackerTotals<T extends CommonRow>(rows: readonly T[], requiredOf: (r: T) => number) {
  const required = rows.reduce((sum, row) => sum + requiredOf(row), 0);
  const complete = rows.reduce((sum, row) => sum + row.complete, 0);
  return {
    orders: rows.length, required, complete, remaining: rows.reduce((sum, row) => sum + row.remaining, 0),
    achievement: required > 0 ? complete / required : null,
    onHold: rows.filter((r) => r.hold.onHold).length,
    urgent: rows.filter((r) => r.urgent).length,
    open: rows.filter((r) => r.status === "open").length,
  };
}
