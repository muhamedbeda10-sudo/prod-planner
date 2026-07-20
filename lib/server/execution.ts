import "server-only";
import { prisma } from "@/lib/db";
import {
  computeExecutionRows,
  computeWeldingQueue,
  computePaintingQueue,
  computeCascade,
  computeCutTranches,
  untouchedWeeklyMos,
  type ExecRow,
  type WeldQueueRow,
  type CascadeRow,
  type CutTranche,
} from "@/lib/domain/execution";
import { findPlanForDate } from "@/lib/domain/findPlan";
import { getSettings, getPlanWindows } from "./data";

export interface CutSheet {
  planNo: number | null;
  today: Date;
  scheduled: ExecRow[]; // legacy aggregate (kept for compatibility)
  dueNow: CutTranche[]; // cut-due exactly today, delivery date shown
  overdue: CutTranche[]; // missed dates — backlog carrying the original delivery date
  cascade: CascadeRow[]; // undated backlog from the monthly registry
  remarked: CascadeRow[]; // this week's REMARKED lines with no known date — shown date-less
}

/** The Cut screen: TODAY is computed by the app (no day picking).
 *  - Scheduled lines come from EVERY weekly plan's delivery dates — a line
 *    scheduled in ANY week stays here under its promised date until done or
 *    rescheduled (the newest plan's dates supersede older ones per line).
 *  - Progress ("done") is GLOBAL per MO — setup balances and any week's logs count.
 *  - Remarked lines of the CURRENT weekly plan with no date anywhere appear in
 *    the date-less bucket; unscheduled + unremarked lines stay off this screen. */
export async function getCutSheet(): Promise<CutSheet> {
  const today = new Date();
  const settings = await getSettings();
  const planNo = findPlanForDate(await getPlanWindows(), today, settings.leadCut);

  const [allSchedules, masters, closedMos, entries, weekOrders] = await Promise.all([
    prisma.planSchedule.findMany({ orderBy: { id: "asc" } }), // ALL plans — every week's promises feed the worklist
    prisma.masterOrder.findMany({ where: { status: "open" }, orderBy: { id: "asc" } }), // closed orders leave the daily screens
    prisma.masterOrder.findMany({ where: { status: "closed" }, select: { mo: true } }),
    prisma.handoverEntry.findMany(), // ALL entries — progress is global
    planNo === null
      ? Promise.resolve([])
      : prisma.planOrder.findMany({ where: { planNo }, select: { mo: true, remark: true } }),
  ]);
  const allSchedIn = allSchedules.map((s) => ({ planNo: s.planNo, bom: s.bom, mo: s.mo, description: s.description, item: s.item, ovenDate: s.ovenDate, qty: s.qty }));
  const schedIn = allSchedIn.filter((s) => s.planNo === planNo);
  const entryIn = entries.map((e) => ({ dept: e.dept, bom: e.bom, mo: e.mo, item: e.item, qty: e.qty, date: e.date }));

  // planner convention: an MO carried in the weekly plan with NO schedule and
  // NO remark is "not this week" — keep it out of the backlog entirely
  const untouched = untouchedWeeklyMos(weekOrders, schedIn);

  const scheduled =
    planNo === null
      ? []
      : computeExecutionRows({ schedules: schedIn, entries: entryIn, day: today, lead: settings.leadCut, dept: "Cut" });

  // date-stamped view over EVERY plan: due today vs overdue-with-its-date.
  // Closed orders and N/A components never reach the worklist; a weekly
  // re-import supersedes the line's old dates automatically.
  const closed = new Set(closedMos.map((o) => o.mo));
  const excludedOf = new Map(masters.map((m) => [m.mo, new Set((m.excludedItems ?? "").split(",").map((s) => s.trim()).filter(Boolean))]));
  const trancheSched = allSchedIn.filter((s) => !closed.has(s.mo) && !excludedOf.get(s.mo)?.has(s.item));
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
    const osp = { CF: m.ospCF, TC: m.ospTC, TN: m.ospTN, CB: m.ospCB } as const;
    for (const it of ["CF", "TC", "TN", "CB"] as const) {
      orderQtyOf.set(`${m.mo}|${it}`, Math.max(0, m.planQty - osp[it]));
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
  const dueNow = dueRaw.map(enrich);
  const overdue = overdueRaw.map(enrich);

  // cascade from the master registry: every component of every order not yet
  // fully covered by the schedule or already-cut quantity
  const cascade = computeCascade({
    orders: masters.filter((m) => !untouched.has(m.mo)).flatMap((m) => {
      const osp = { CF: m.ospCF, TC: m.ospTC, TN: m.ospTN, CB: m.ospCB } as const;
      const excluded = new Set((m.excludedItems ?? "").split(",").map((s) => s.trim()).filter(Boolean));
      return (["CF", "TC", "TN", "CB"] as const).map((item) => ({
        bom: m.bom,
        mo: m.mo,
        description: [m.kva, m.rating].filter(Boolean).join(" · ") || null,
        item,
        // OSP share is made outside; excluded components aren't needed at all —
        // neither ever reaches our worklists
        targetQty: excluded.has(item) ? 0 : Math.max(0, m.planQty - osp[item]),
      }));
    }),
    schedules: schedIn,
    entries: entryIn,
    day: today,
    dept: "Cut",
    allSchedules: allSchedIn,
  });

  // date-less bucket: lines the CURRENT weekly plan flags with a remark but no
  // schedule — and no plan (this week or earlier) holds an open date for them.
  // Lines with a known open date already sit in the dated tables above.
  const remarkOf = new Map<string, string>(); // mo -> first non-empty remark this week
  for (const o of weekOrders) {
    const r = (o.remark ?? "").trim();
    if (r && !remarkOf.has(o.mo)) remarkOf.set(o.mo, r);
  }
  const remarked = cascade
    .filter((r) => r.deliveryISO === null && remarkOf.has(r.mo))
    .map((r) => ({ ...r, remark: remarkOf.get(r.mo) }));

  return { planNo, today, scheduled, dueNow, overdue, cascade, remarked };
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
  const [schedules, entries, masters] = await Promise.all([
    prisma.planSchedule.findMany({ orderBy: { id: "asc" } }),
    prisma.handoverEntry.findMany(),
    prisma.masterOrder.findMany({ select: { mo: true, bom: true, planQty: true, ospCF: true, ospTC: true, ospTN: true, ospCB: true } }),
  ]);
  // in-house share per MO×item where a part is outsourced: planQty − OSP.
  // The OSP share never reaches the welding/painting queues.
  const inhouseCap = new Map<string, number>();
  const orderQtyOf = new Map<string, number>(); // mo|item -> planQty − OSP (whole-order fraction denominator)
  for (const m of masters) {
    const osp = { CF: m.ospCF, TC: m.ospTC, TN: m.ospTN, CB: m.ospCB } as const;
    for (const it of ["CF", "TC", "TN", "CB"] as const) {
      if (osp[it] > 0) inhouseCap.set(`${m.bom}|${m.mo}|${it}`, Math.max(0, m.planQty - osp[it]));
      orderQtyOf.set(`${m.mo}|${it}`, Math.max(0, m.planQty - osp[it]));
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

/** The welding queue: everything Cut produced (any plan, any day ≤ selected day)
 *  that Welding hasn't consumed yet. */
export async function getWeldingQueue(day: Date): Promise<WeldQueueRow[]> {
  const [inputs, settings] = await Promise.all([loadQueueInputs(), getSettings()]);
  const { orderQtyOf, ...rest } = inputs;
  return withOrderQty(computeWeldingQueue({ ...rest, day, lead: settings.leadWeld }), orderQtyOf);
}

/** The painting queue: everything Welding produced that Painting hasn't consumed yet. */
export async function getPaintingQueue(day: Date): Promise<WeldQueueRow[]> {
  const { orderQtyOf, ...rest } = await loadQueueInputs();
  return withOrderQty(computePaintingQueue({ ...rest, day }), orderQtyOf);
}
