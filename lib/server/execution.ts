import "server-only";
import { prisma } from "@/lib/db";
import {
  computeExecutionRows,
  computeWeldingQueue,
  computePaintingQueue,
  computeCascade,
  computeCutTranches,
  capTranchesToOrder,
  applyWorklistDateOverrides,
  diagnosePlanLines,
  type ExecRow,
  type WeldQueueRow,
  type CascadeRow,
  type CutTranche,
  type PlanLineIssue,
} from "@/lib/domain/execution";
import { toISODate } from "@/lib/domain/dates";
import { applicableItems, ospOf } from "@/lib/domain/constants";
import type { HiddenLineDTO, PriorityLineDTO } from "@/lib/server/worklistExtras";
import { findPlanForDate } from "@/lib/domain/findPlan";
import { getSettings, getPlanWindows } from "./data";
import { loadAllHandover, loadAllSchedules, loadMasterOrders } from "./loads";

export interface CutSheet {
  planNo: number | null;
  today: Date;
  scheduled: ExecRow[]; // legacy aggregate (kept for compatibility)
  dueNow: CutTranche[]; // cut-due exactly today, delivery date shown
  overdue: CutTranche[]; // missed dates — backlog carrying the original delivery date
  postponed: CutTranche[]; // admin re-dated to the FUTURE — visible so the date can be reverted
  remarked: CascadeRow[]; // this week's REMARKED lines with no known date — shown date-less
  unscheduled: CascadeRow[]; // open orders with NO date and NO remark — its own section
  pushed: CascadeRow[]; // sent down from the Plan Tracker (chosen qty) — to be scheduled here
  priority: PriorityLineDTO[]; // ⭐ orders the admin flagged — dedicated table on top
  hidden: HiddenLineDTO[]; // lines the admin removed from this worklist (restorable)
  /** Lines the CURRENT plan schedules that produced NO row above, each with the
   *  reason — so "it's in the plan but not on the list" always has an answer. */
  planIssues: PlanLineIssue[];
}

/** The Cut screen: TODAY is computed by the app (no day picking).
 *  - Scheduled lines come from EVERY weekly plan's delivery dates — a line
 *    scheduled in ANY week stays here under its promised date until done or
 *    rescheduled (the newest plan's dates supersede older ones per line).
 *  - Progress ("done") is GLOBAL per MO — setup balances and any week's logs count.
 *  - A line's shown remaining is silently capped at the ORDER's open quantity,
 *    so a weekly promise larger than the order never creates phantom work.
 *  - Date-less backlog splits by this week's remarks: remarked lines in one
 *    bucket, unscheduled+unremarked lines in their own section.
 *  - Admin date overrides re-date any line; reverting restores the plan date. */
export async function getCutSheet(): Promise<CutSheet> {
  const today = new Date();
  const settings = await getSettings();
  const planNo = findPlanForDate(await getPlanWindows(), today, settings.leadCut);

  const [allSchedules, allMasters, entries, weekOrders, overrideRows, pushRows, hideRows] = await Promise.all([
    loadAllSchedules(), // ALL plans — every week's promises feed the worklist
    loadMasterOrders(),
    loadAllHandover(), // ALL entries — progress is global
    planNo === null
      ? Promise.resolve([])
      : prisma.planOrder.findMany({ where: { planNo }, select: { mo: true, remark: true } }),
    prisma.worklistDateOverride.findMany(),
    prisma.worklistPush.findMany({ where: { dept: "Cut" }, orderBy: { id: "asc" } }),
    prisma.worklistLineHide.findMany({ where: { dept: "Cut" }, orderBy: { id: "asc" } }),
  ]);
  // closed orders leave the daily screens
  const masters = [...allMasters].filter((m) => m.status === "open").sort((a, b) => a.id - b.id);
  const closedMos = allMasters.filter((m) => m.status === "closed");
  const allSchedIn = allSchedules.map((s) => ({ planNo: s.planNo, bom: s.bom, mo: s.mo, description: s.description, item: s.item, ovenDate: s.ovenDate, qty: s.qty }));
  const schedIn = allSchedIn.filter((s) => s.planNo === planNo);
  const entryIn = entries.map((e) => ({ dept: e.dept, bom: e.bom, mo: e.mo, item: e.item, qty: e.qty, date: e.date }));

  const scheduled =
    planNo === null
      ? []
      : computeExecutionRows({ schedules: schedIn, entries: entryIn, day: today, lead: settings.leadCut, dept: "Cut" });

  // date-stamped view over EVERY plan: due today vs overdue-with-its-date.
  // Closed orders and N/A components never reach the worklist; a weekly
  // re-import supersedes the line's old dates automatically.
  // OLD promises only survive for orders the MASTER REGISTRY knows — weekly
  // plans from months never imported (e.g. before the app was adopted) must
  // not resurrect unknown orders. The CURRENT week's plan always shows, even
  // if its month's registry hasn't been imported yet.
  const closed = new Set(closedMos.map((o) => o.mo));
  const openMos = new Set(masters.map((m) => m.mo));
  const excludedOf = new Map(masters.map((m) => [m.mo, new Set((m.excludedItems ?? "").split(",").map((s) => s.trim()).filter(Boolean))]));
  const trancheSched = allSchedIn.filter(
    (s) =>
      (openMos.has(s.mo) || s.planNo === planNo) &&
      !closed.has(s.mo) &&
      !excludedOf.get(s.mo)?.has(s.item)
  );
  const { dueNow: dueRaw, overdue: overdueRaw } = computeCutTranches({
    schedules: trancheSched,
    entries: entryIn,
    day: today,
    lead: settings.leadCut,
  });

  // enrich tranche rows with whole-order context: dept done / order qty (the
  // "finished of total" fraction shown next to the day's plan)
  const orderQtyOf = new Map<string, number>(); // mo|item -> planQty − OSP
  for (const m of masters) {
    for (const it of applicableItems(m)) {
      orderQtyOf.set(`${m.mo}|${it}`, Math.max(0, m.planQty - ospOf(m, it)));
    }
  }
  const cutDoneOf = new Map<string, number>(); // mo|item -> global cut output
  for (const e of entries) {
    if (e.dept !== "Cut" || !(e.mo ?? "").trim()) continue;
    const k = `${e.mo}|${e.item}`;
    cutDoneOf.set(k, (cutDoneOf.get(k) ?? 0) + e.qty);
  }
  const enrich = (r: CutTranche): CutTranche => ({
    ...r,
    deptDone: cutDoneOf.get(`${r.mo}|${r.item}`) ?? 0,
    orderQty: orderQtyOf.get(`${r.mo}|${r.item}`) ?? null,
  });
  // silent cap: a promise never asks for more than the order still needs
  const { dueNow: dueCapped, overdue: overdueCapped } = capTranchesToOrder({
    dueNow: dueRaw.map(enrich),
    overdue: overdueRaw.map(enrich),
  });

  // cascade from the master registry: every component of every order not yet
  // fully covered by the schedule or already-cut quantity
  const cascade = computeCascade({
    // applicableItems already drops N/A components and AR/MB that the order's
    // KVA/rating rule doesn't match — neither ever reaches our worklists. The
    // OSP share is made outside, so the target is planQty − OSP.
    orders: masters.flatMap((m) =>
      applicableItems(m).map((item) => ({
        bom: m.bom,
        mo: m.mo,
        description: [m.kva, m.rating].filter(Boolean).join(" · ") || null,
        item,
        targetQty: Math.max(0, m.planQty - ospOf(m, item)),
      })),
    ),
    schedules: schedIn,
    entries: entryIn,
    day: today,
    dept: "Cut",
    allSchedules: allSchedIn,
  });

  // date-less backlog (no open date in ANY plan), split three ways: lines the
  // admin PUSHED from the tracker (clamped to the pushed qty), this week's
  // REMARKED lines, and the rest (open orders). Push wins over remark.
  const remarkOf = new Map<string, string>(); // mo -> first non-empty remark this week
  for (const o of weekOrders) {
    const r = (o.remark ?? "").trim();
    if (r && !remarkOf.has(o.mo)) remarkOf.set(o.mo, r);
  }
  // output recorded since the push consumes the pushed quantity automatically;
  // an exhausted push retires and its line returns to the normal sections
  const pushQtyOf = new Map<string, number>();
  for (const p of pushRows) {
    const d = cutDoneOf.get(`${p.mo}|${p.item}`) ?? 0;
    const open = p.qty - Math.max(0, d - p.baseDone);
    if (open > 0) pushQtyOf.set(`${p.mo}|${p.item}`, open);
  }
  const undatedAll = cascade
    .filter((r) => r.deliveryISO === null)
    .map((r) => {
      const pushQty = pushQtyOf.get(`${r.mo}|${r.item}`);
      const row = remarkOf.has(r.mo) ? { ...r, remark: remarkOf.get(r.mo) } : { ...r };
      // pushed lines show the CHOSEN quantity (never more than the open pool)
      if (pushQty !== undefined) row.available = Math.min(row.available, pushQty);
      return row;
    })
    .filter((r) => r.available > 0);

  // admin date overrides: re-date lines (future → postponed), date the date-less
  const { dueNow, overdue, postponed, undated } = applyWorklistDateOverrides({
    dueNow: dueCapped,
    overdue: overdueCapped,
    undated: undatedAll,
    overrides: overrideRows.map((o) => ({ bom: o.bom, mo: o.mo, item: o.item, origISO: o.origISO, newISO: toISODate(o.newDate), qty: o.qty, baseDone: o.baseDone })),
    day: today,
    lead: settings.leadCut,
  });
  const isPushed = (r: CascadeRow) => pushQtyOf.has(`${r.mo}|${r.item}`);
  const pushed = undated.filter(isPushed);
  const remarked = undated.filter((r) => !isPushed(r) && (r.remark ?? "").trim() !== "");
  const unscheduled = undated.filter((r) => !isPushed(r) && (r.remark ?? "").trim() === "");

  // ⭐ priority orders — what fabrication still owes on each flagged order
  const priority: PriorityLineDTO[] = [];
  for (const m of masters) {
    if (!m.priority) continue;
    for (const item of applicableItems(m)) {
      const need = Math.max(0, m.planQty - ospOf(m, item));
      const done = cutDoneOf.get(`${m.mo}|${item}`) ?? 0;
      const remaining = Math.max(0, need - done);
      if (remaining <= 0) continue;
      priority.push({ bom: m.bom, mo: m.mo, description: [m.kva, m.rating].filter(Boolean).join(" · "), item, need, done, remaining });
    }
  }

  // admin-hidden lines leave every section (restorable from the page footer)
  const hiddenKeys = new Set(hideRows.map((h) => `${h.bom}|${h.mo}|${h.item}`));
  const notHidden = <T extends { bom: string; mo: string; item: string }>(rows: T[]) =>
    rows.filter((r) => !hiddenKeys.has(`${r.bom}|${r.mo}|${r.item}`));

  const out = {
    planNo,
    today,
    scheduled,
    dueNow: notHidden(dueNow),
    overdue: notHidden(overdue),
    postponed: notHidden(postponed),
    remarked: notHidden(remarked),
    unscheduled: notHidden(unscheduled),
    pushed: notHidden(pushed),
    priority: notHidden(priority),
    hidden: hideRows.map((h) => ({ dept: h.dept, bom: h.bom, mo: h.mo, item: h.item })),
  };

  // …and explain every line of the CURRENT plan that none of the sections above
  // ended up showing (its day hasn't come, already fabricated, N/A, closed…).
  const visibleKeys = new Set<string>();
  for (const rows of [out.dueNow, out.overdue, out.postponed] as { bom: string; mo: string; item: string }[][]) {
    for (const r of rows) visibleKeys.add(`${r.bom}|${r.mo}|${r.item}`);
  }
  for (const rows of [out.remarked, out.unscheduled, out.pushed]) {
    for (const r of rows) visibleKeys.add(`${r.bom}|${r.mo}|${r.item}`);
  }
  const planIssues = diagnosePlanLines({
    schedules: schedIn,
    visibleKeys,
    registryQty: orderQtyOf,
    deptDone: cutDoneOf,
    openMos,
    closedMos: closed,
    hiddenKeys,
    day: today,
    lead: settings.leadCut,
  });

  return { ...out, planIssues };
}

export interface ExecutionResult {
  planNo: number | null;
  rows: ExecRow[];
}

export async function getExecutionSheet(day: Date, dept: "Cut" | "Welding"): Promise<ExecutionResult> {
  const settings = await getSettings();
  const lead = dept === "Cut" ? settings.leadCut : settings.leadWeld;
  const planNo = findPlanForDate(await getPlanWindows(), day, lead);
  if (planNo === null) return { planNo: null, rows: [] };

  const [schedules, entries] = await Promise.all([
    prisma.planSchedule.findMany({ where: { planNo }, orderBy: { id: "asc" } }),
    prisma.handoverEntry.findMany({ where: { planNo } }),
  ]);

  const rows = computeExecutionRows({
    schedules: schedules.map((s) => ({ bom: s.bom, mo: s.mo, description: s.description, item: s.item, ovenDate: s.ovenDate, qty: s.qty })),
    entries: entries.map((e) => ({ dept: e.dept, bom: e.bom, mo: e.mo, item: e.item, qty: e.qty, date: e.date })),
    day,
    lead,
    dept,
  });
  return { planNo, rows };
}

async function loadQueueInputs() {
  const [schedules, entries, masters] = await Promise.all([loadAllSchedules(), loadAllHandover(), loadMasterOrders()]);
  // in-house share per MO×item where a part is outsourced: planQty − OSP.
  // The OSP share never reaches the welding/painting queues.
  const inhouseCap = new Map<string, number>();
  const orderQtyOf = new Map<string, number>(); // mo|item -> planQty − OSP (whole-order fraction denominator)
  for (const m of masters) {
    for (const it of applicableItems(m)) {
      const osp = ospOf(m, it);
      if (osp > 0) inhouseCap.set(`${m.bom}|${m.mo}|${it}`, Math.max(0, m.planQty - osp));
      orderQtyOf.set(`${m.mo}|${it}`, Math.max(0, m.planQty - osp));
    }
  }
  return {
    schedules: schedules.map((s) => ({ planNo: s.planNo, bom: s.bom, mo: s.mo, description: s.description, item: s.item, ovenDate: s.ovenDate, qty: s.qty })),
    entries: entries.map((e) => ({ planNo: e.planNo, dept: e.dept, bom: e.bom, mo: e.mo, item: e.item, qty: e.qty, date: e.date })),
    inhouseCap,
    orderQtyOf,
  };
}

const withOrderQty = (rows: WeldQueueRow[], orderQtyOf: Map<string, number>): WeldQueueRow[] =>
  rows.map((r) => ({ ...r, orderQty: r.mo ? orderQtyOf.get(`${r.mo}|${r.item}`) ?? null : null }));

/** Admin-hidden lines leave the dept's queue (restorable from the page). */
async function dropHidden(dept: string, rows: WeldQueueRow[]): Promise<WeldQueueRow[]> {
  const hides = await prisma.worklistLineHide.findMany({ where: { dept } });
  if (hides.length === 0) return rows;
  const keys = new Set(hides.map((h) => `${h.bom}|${h.mo}|${h.item}`));
  return rows.filter((r) => !keys.has(`${r.bom}|${r.mo}|${r.item}`));
}

/** The welding queue: everything Cut produced (any plan, any day ≤ selected day)
 *  that Welding hasn't consumed yet. */
export async function getWeldingQueue(day: Date): Promise<WeldQueueRow[]> {
  const [inputs, settings] = await Promise.all([loadQueueInputs(), getSettings()]);
  const { orderQtyOf, ...rest } = inputs;
  return dropHidden("Welding", withOrderQty(computeWeldingQueue({ ...rest, day, lead: settings.leadWeld }), orderQtyOf));
}

/** The painting queue: everything Welding produced that Painting hasn't consumed yet. */
export async function getPaintingQueue(day: Date): Promise<WeldQueueRow[]> {
  const { orderQtyOf, ...rest } = await loadQueueInputs();
  return dropHidden("Painting", withOrderQty(computePaintingQueue({ ...rest, day }), orderQtyOf));
}
