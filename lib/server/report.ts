import "server-only";
import { prisma } from "@/lib/db";
import { computeDailyReport, type DailyReport } from "@/lib/domain/report";
import { findPlanForDate } from "@/lib/domain/findPlan";
import { getSettings, getPlanWindows, getGlobalGrouper, getLatestPlanNo } from "./data";
import { getTracker } from "./tracker";
import { getMasterTracker, type MasterTrackerRow } from "./masterTracker";
import type { TrackerRow } from "@/lib/domain/tracker";
import { toISODate } from "@/lib/domain/dates";
import { ITEMS, type Item } from "@/lib/domain/constants";
import { tierForOrder, stdHoursFor } from "@/lib/domain/standardTimes";

export interface DailyReportResult extends DailyReport {
  target: number;
  planNo: number | null;
  tracker: TrackerRow[];
}

/** Working days (Sat–Thu, minus factory-calendar days off) inside an inclusive
 *  range — the multiplier the range report measures capacity against. */
export async function countWorkingDays(from: Date, to: Date): Promise<number> {
  const holidays = await prisma.holiday.findMany();
  const off = new Set(holidays.map((h) => toISODate(h.date)));
  let n = 0;
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  while (d.getTime() <= end) {
    // getUTCDay: 5 = Friday — the one weekly day off
    if (d.getUTCDay() !== 5 && !off.has(toISODate(d))) n++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return Math.max(1, n); // never divide by zero if a range is all days off
}

/** The report over ONE day, or over a range when `from` is given (the range
 *  ends on `day`). `days` scales the capacity the efficiency % is measured
 *  against — pass the working days the range spans. */
export async function getDailyReport(day: Date, from?: Date, days = 1): Promise<DailyReportResult> {
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
    grouper,
    from,
    days
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
  // shp = the core's real final stage (shown in place of Paint for CF);
  // delivered = what the customer received
  items: Record<Item, { cut: number; weld: number; paint: number; shp: number; delivered: number }>;
  complete: number; // Σ member completes (paint-based, OSP-credited, capped)
  left: number;
  achievement: number | null;
  mos: string[]; // members — for day-highlighting
}

function emptyItems(): ReportPlanRow["items"] {
  const cell = () => ({ cut: 0, weld: 0, paint: 0, shp: 0, delivered: 0 });
  return { CF: cell(), TC: cell(), TN: cell(), CB: cell(), AR: cell(), MB: cell() };
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
      g.items[it].shp += m.items[it].shp;
      g.items[it].delivered += m.items[it].delivered;
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
        mo, bom: o.bom, soi: o.soi, urgent: false, kva: null, rating: null, required: requiredOf.get(mo) ?? 0,
        items: {
          CF: { cut: 0, weld: 0, paint: 0, shp: 0, delivered: 0, osp: 0, excluded: false, eligible: true },
          TC: { cut: 0, weld: 0, paint: 0, shp: 0, delivered: 0, osp: 0, excluded: false, eligible: true },
          TN: { cut: 0, weld: 0, paint: 0, shp: 0, delivered: 0, osp: 0, excluded: false, eligible: true },
          CB: { cut: 0, weld: 0, paint: 0, shp: 0, delivered: 0, osp: 0, excluded: false, eligible: true },
          AR: { cut: 0, weld: 0, paint: 0, shp: 0, delivered: 0, osp: 0, excluded: false, eligible: false },
          MB: { cut: 0, weld: 0, paint: 0, shp: 0, delivered: 0, osp: 0, excluded: false, eligible: false },
        },
        welded: 0, complete: 0, remaining: requiredOf.get(mo) ?? 0, achievement: 0, status: "open", priority: false, months: [],
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
  items: Record<string, { cut: number; weld: number; paint: number; shp: number; delivered: number }>;
  total: number; // all pcs recorded that day on this BOM (every stage)
}

/** The day's output grouped by project (BOM): only projects with entries ON
 *  that day, with the quantities recorded THAT DAY per component and stage.
 *  Pass a dept to scope everything to that department's work only. */
export async function getDayOutputByProject(day: Date, depts?: string[], from?: Date): Promise<DayProjectRow[]> {
  const startDay = from ?? day;
  const start = new Date(Date.UTC(startDay.getUTCFullYear(), startDay.getUTCMonth(), startDay.getUTCDate()));
  const end = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) + 24 * 60 * 60 * 1000);
  const entries = await prisma.handoverEntry.findMany({
    where: { date: { gte: start, lt: end }, ...(depts && depts.length ? { dept: { in: depts } } : {}) },
    select: { bom: true, mo: true, dept: true, item: true, qty: true },
  });

  const rows = new Map<string, DayProjectRow>();
  const stageOf: Record<string, "cut" | "weld" | "paint" | "shp" | "delivered"> = {
    Cut: "cut", Welding: "weld", Painting: "paint", ShotBlast: "shp", Delivered: "delivered",
  };
  for (const e of entries) {
    const stage = stageOf[e.dept];
    if (!stage) continue;
    let row = rows.get(e.bom);
    if (!row) {
      row = { bom: e.bom, mos: [], items: {}, total: 0 };
      rows.set(e.bom, row);
    }
    if (e.mo && !row.mos.includes(e.mo)) row.mos.push(e.mo);
    if (!row.items[e.item]) row.items[e.item] = { cut: 0, weld: 0, paint: 0, shp: 0, delivered: 0 };
    row.items[e.item][stage] += e.qty;
    row.total += e.qty;
  }
  return [...rows.values()].sort((a, b) => b.total - a.total);
}

/** The day's output weighted by STANDARD MAN-HOURS (the engineering timings
 *  sheet): a 3000 KVA tank counts ~2.6× a 100 KVA one instead of "1 piece".
 *  Resolution per order: the sheet's own FG map first, the numeric KVA as
 *  fallback. `coveredPcs`/`totalPcs` says how much of the day's output had a
 *  matching standard time — hours are UNDERcounted when orders lack both an FG
 *  code and a KVA, and the page says so instead of showing a false total. */
export interface EarnedHours {
  byStage: Record<string, number>; // Cut | Welding | Finishing (Paint + SHB)
  total: number;
  coveredPcs: number; // pcs that resolved to a KVA class (AR/MB excluded)
  totalPcs: number; // every production-stage pc recorded in the window
}

export async function getEarnedHours(day: Date, depts?: string[], from?: Date): Promise<EarnedHours> {
  const startDay = from ?? day;
  const start = new Date(Date.UTC(startDay.getUTCFullYear(), startDay.getUTCMonth(), startDay.getUTCDate()));
  const end = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) + 24 * 60 * 60 * 1000);
  const [entries, orders] = await Promise.all([
    prisma.handoverEntry.findMany({
      where: { date: { gte: start, lt: end }, ...(depts && depts.length ? { dept: { in: depts } } : {}) },
      select: { bom: true, mo: true, dept: true, item: true, qty: true },
    }),
    prisma.masterOrder.findMany({ select: { mo: true, bom: true, fgCode: true, kva: true } }),
  ]);

  // resolve a KVA class per MO — and per BOM for the ledger's MO-less rows
  // (BOM-level entries predate per-MO recording); a BOM whose orders disagree
  // on the class resolves to none rather than guessing
  const moTier = new Map<string, number | null>();
  const bomTier = new Map<string, number | null>();
  for (const o of orders) {
    const tier = tierForOrder(o);
    moTier.set(o.mo, tier);
    if (!bomTier.has(o.bom)) bomTier.set(o.bom, tier);
    else if (bomTier.get(o.bom) !== tier) bomTier.set(o.bom, null);
  }

  const byStage: Record<string, number> = { Cut: 0, Welding: 0, Finishing: 0 };
  let total = 0;
  let coveredPcs = 0;
  let totalPcs = 0;
  for (const e of entries) {
    if (e.dept === "Delivered") continue; // not a production stage
    // AR/MB carry no standard times — keep them out of the coverage figure so
    // "uncovered" always means "order not resolved", never "component unpriced"
    const gated = e.item === "AR" || e.item === "MB";
    const tier = (e.mo ? moTier.get(e.mo) : bomTier.get(e.bom)) ?? null;
    if (!gated) {
      totalPcs += e.qty;
      if (tier !== null) coveredPcs += e.qty;
    }
    const hrs = stdHoursFor(e.dept, e.item, tier) * e.qty;
    if (hrs <= 0) continue;
    const stage = e.dept === "Cut" ? "Cut" : e.dept === "Welding" ? "Welding" : "Finishing";
    byStage[stage] += hrs;
    total += hrs;
  }
  return { byStage, total, coveredPcs, totalPcs };
}

export async function getWorkedOn(day: Date, depts?: string[], from?: Date): Promise<{ mos: string[]; bomsNoMo: string[]; bomsAll: string[] }> {
  const startDay = from ?? day;
  const start = new Date(Date.UTC(startDay.getUTCFullYear(), startDay.getUTCMonth(), startDay.getUTCDate()));
  const end = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) + 24 * 60 * 60 * 1000);
  const entries = await prisma.handoverEntry.findMany({
    where: { date: { gte: start, lt: end }, ...(depts && depts.length ? { dept: { in: depts } } : {}) },
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
