import "server-only";
import { prisma } from "@/lib/db";
import { computeDailyReport, type DailyReport } from "@/lib/domain/report";
import { findPlanForDate } from "@/lib/domain/findPlan";
import { getSettings, getPlanWindows, getGlobalGrouper, getLatestPlanNo } from "./data";
import { getTracker } from "./tracker";
import { getMasterTracker, type MasterTrackerRow } from "./masterTracker";
import type { TrackerRow } from "@/lib/domain/tracker";
import { ITEMS, type Item } from "@/lib/domain/constants";

export interface DailyReportResult extends DailyReport {
  target: number;
  planNo: number | null;
  tracker: TrackerRow[];
}

export async function getDailyReport(day: Date): Promise<DailyReportResult> {
  const settings = await getSettings();
  const target = settings.dailyTarget || settings.capacityPerItem || 27;
  const [orders, handover, grouper, windows] = await Promise.all([
    prisma.planOrder.findMany({ orderBy: { id: "asc" } }),
    prisma.handoverEntry.findMany(),
    getGlobalGrouper(),
    getPlanWindows(),
  ]);

  const report = computeDailyReport(
    orders.map((o) => ({
      planNo: o.planNo, bom: o.bom, mo: o.mo, description: o.description,
      item: o.item, requiredQty: o.requiredQty, targetQty: o.targetQty,
    })),
    handover.map((h) => ({ date: h.date, dept: h.dept, bom: h.bom, item: h.item, qty: h.qty, planNo: h.planNo })),
    day,
    target,
    grouper
  );

  const planNo = findPlanForDate(windows, day, settings.leadCut) ?? (await getLatestPlanNo());
  const tracker = planNo ? await getTracker(planNo) : [];

  return { ...report, target, planNo, tracker };
}

/** One BOM-level row of the report's plan table — the "cascade closed" view:
 *  totals across the BOM's MOs and the percentage for the whole BOM. Both the
 *  full-plan table and the week snapshot share this exact shape, and both are
 *  built from the SAME live master-tracker numbers (global, capped per order),
 *  so the report always agrees with the Plan Tracker page. */
export interface ReportPlanRow {
  bom: string;
  moCount: number;
  urgentCount: number;
  ospCount: number; // MOs with any outsourced component
  required: number;
  items: Record<Item, { cut: number; weld: number; paint: number }>;
  complete: number; // Σ member completes (paint-based, OSP-credited, capped)
  left: number;
  achievement: number | null;
  mos: string[]; // members — for day-highlighting
}

function emptyItems(): ReportPlanRow["items"] {
  return { CF: { cut: 0, weld: 0, paint: 0 }, TC: { cut: 0, weld: 0, paint: 0 }, TN: { cut: 0, weld: 0, paint: 0 }, CB: { cut: 0, weld: 0, paint: 0 } };
}

function groupByBom(members: MasterTrackerRow[], requiredOf?: Map<string, number>): ReportPlanRow[] {
  const map = new Map<string, ReportPlanRow>();
  for (const m of members) {
    let g = map.get(m.bom);
    if (!g) {
      g = { bom: m.bom, moCount: 0, urgentCount: 0, ospCount: 0, required: 0, items: emptyItems(), complete: 0, left: 0, achievement: null, mos: [] };
      map.set(m.bom, g);
    }
    g.moCount++;
    g.mos.push(m.mo);
    if (m.urgent) g.urgentCount++;
    if (ITEMS.some((it) => m.items[it].osp > 0)) g.ospCount++;
    g.required += requiredOf?.get(m.mo) ?? m.required;
    for (const it of ITEMS) {
      g.items[it].cut += m.items[it].cut;
      g.items[it].weld += m.items[it].weld;
      g.items[it].paint += m.items[it].paint;
    }
    g.complete += m.complete;
    g.left += m.remaining;
  }
  const rows = [...map.values()];
  for (const r of rows) {
    if (requiredOf) r.left = Math.max(0, r.required - r.complete); // week scope: left vs the week's required
    r.achievement = r.required > 0 ? Math.min(1, r.complete / r.required) : null;
  }
  return rows.sort((a, b) => (a.bom < b.bom ? -1 : a.bom > b.bom ? 1 : 0));
}

/** The report's default table: the WHOLE registry, one row per BOM. */
export async function getFullPlanGrouped(): Promise<ReportPlanRow[]> {
  return groupByBom(await getMasterTracker());
}

/** The report's optional week view: the week's MOs only, LIVE numbers (from the
 *  master tracker) against the week's own required quantities. */
export async function getWeekSnapshot(planNo: number): Promise<ReportPlanRow[]> {
  const [orders, master] = await Promise.all([
    prisma.planOrder.findMany({ where: { planNo }, orderBy: { id: "asc" } }),
    getMasterTracker(),
  ]);
  const byMo = new Map(master.map((m) => [m.mo, m]));

  // the week's required per MO (dedup: plan orders repeat per item row)
  const requiredOf = new Map<string, number>();
  for (const o of orders) {
    if (!requiredOf.has(o.mo)) requiredOf.set(o.mo, o.requiredQty || 0);
  }

  const members: MasterTrackerRow[] = [];
  for (const mo of requiredOf.keys()) {
    const m = byMo.get(mo);
    if (m) {
      members.push(m);
    } else {
      // MO planned this week but missing from the registry — show it with zeros
      const o = orders.find((x) => x.mo === mo)!;
      members.push({
        mo, bom: o.bom, soi: o.soi, urgent: false, kva: null, required: requiredOf.get(mo) ?? 0,
        items: {
          CF: { cut: 0, weld: 0, paint: 0, delivered: 0, osp: 0, excluded: false },
          TC: { cut: 0, weld: 0, paint: 0, delivered: 0, osp: 0, excluded: false },
          TN: { cut: 0, weld: 0, paint: 0, delivered: 0, osp: 0, excluded: false },
          CB: { cut: 0, weld: 0, paint: 0, delivered: 0, osp: 0, excluded: false },
        },
        welded: 0, complete: 0, remaining: requiredOf.get(mo) ?? 0, achievement: 0, status: "open", priority: false,
      });
    }
  }
  // cap each member's contribution at the week's required for honest week %s
  const capped = members.map((m) => {
    const req = requiredOf.get(m.mo) ?? m.required;
    return { ...m, complete: Math.min(m.complete, req), remaining: Math.max(0, req - Math.min(m.complete, req)) };
  });
  return groupByBom(capped, requiredOf);
}

/** Who was worked on a given day — for highlighting tracker rows.
 *  mos: MOs with any entry that day; bomsNoMo: BOM-level entries without an MO;
 *  bomsAll: every BOM touched (for BOM-level tables). */
export interface DayProjectRow {
  bom: string;
  mos: string[]; // MOs touched that day ("—" rows aggregate BOM-level entries)
  items: Record<string, { cut: number; weld: number; paint: number }>;
  total: number; // all pcs recorded that day on this BOM
}

/** The day's output grouped by project (BOM): only projects with entries ON
 *  that day, with the quantities recorded THAT DAY per component and stage. */
export async function getDayOutputByProject(day: Date): Promise<DayProjectRow[]> {
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const entries = await prisma.handoverEntry.findMany({
    where: { date: { gte: start, lt: end } },
    select: { bom: true, mo: true, dept: true, item: true, qty: true },
  });

  const rows = new Map<string, DayProjectRow>();
  const stageOf: Record<string, "cut" | "weld" | "paint"> = { Cut: "cut", Welding: "weld", Painting: "paint" };
  for (const e of entries) {
    const stage = stageOf[e.dept];
    if (!stage) continue;
    let row = rows.get(e.bom);
    if (!row) {
      row = { bom: e.bom, mos: [], items: {}, total: 0 };
      rows.set(e.bom, row);
    }
    if (e.mo && !row.mos.includes(e.mo)) row.mos.push(e.mo);
    if (!row.items[e.item]) row.items[e.item] = { cut: 0, weld: 0, paint: 0 };
    row.items[e.item][stage] += e.qty;
    row.total += e.qty;
  }
  return [...rows.values()].sort((a, b) => b.total - a.total);
}

export async function getWorkedOn(day: Date): Promise<{ mos: string[]; bomsNoMo: string[]; bomsAll: string[] }> {
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const entries = await prisma.handoverEntry.findMany({
    where: { date: { gte: start, lt: end } },
    select: { mo: true, bom: true },
  });
  const mos = new Set<string>();
  const bomsNoMo = new Set<string>();
  const bomsAll = new Set<string>();
  for (const e of entries) {
    bomsAll.add(e.bom);
    if (e.mo) mos.add(e.mo);
    else bomsNoMo.add(e.bom);
  }
  return { mos: [...mos], bomsNoMo: [...bomsNoMo], bomsAll: [...bomsAll] };
}
