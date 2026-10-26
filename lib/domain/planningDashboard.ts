// The Planning dashboard's own reading of the two lines' figures: the scope
// and the filters its address names, the transformers' plan lines narrowed to
// them, the lines at risk with the stage that holds each one, the load against
// the capacity day by day, how far the data behind the page can be trusted,
// and the rows behind every headline figure — one function per figure, so a
// tile and the details it opens can never disagree. Pure: the figures come
// from lib/server/kpis.ts and lib/server/lvKpis.ts, each line's rules from
// lib/domain/kpis.ts and lib/domain/lvKpis.ts.
//
// The lines are planned differently and stay apart here: the transformers on
// dated weekly promises (oven dates less the lead days in Settings), the
// panels on a month with no delivery date. Pieces of one line are never added
// to the other's, nor a stage's pieces to the next stage's; standard hours and
// people add.

import { STAGES, STAGE_LABEL, lateLines, peopleShort, planAdherence, stageDueISO, type LateLine, type LoadAhead, type ManpowerRow, type PlanCell, type Stage, type StageAdherence } from "./kpis";
import { LV_DEPT_STAGE_OF, cap, isLvFloorDept, lvRateAt, LV_FLOOR_DEPTS, type LvFloorDept } from "./lvKpis";
import { LV_STAGES, lvStageOf, type LvFamily, type LvStage, type LvState } from "./lv";
import type { LvRate } from "./lvStd";
import { WORK_CENTRES, WORK_CENTRE_LABEL, isWorkCentre, round1, type WorkCentre } from "./shifts";
import { isItem, isPaintExempt } from "./constants";
import { trItemName } from "./outputByType";
import { formatDate } from "./format";
import { traceHref } from "./links";
import { hrefWithLine, showsBothLines, type ProductLine } from "./lines";
import { href, one, type Search } from "./dashboardLinks";
import { parseISODate } from "./dates";

const arg = (sp: Search, k: string) => (one(sp, k) ?? "").trim();
/** A real calendar day as the address writes it, or null. */
const dayArg = (sp: Search, k: string) => (parseISODate(arg(sp, k)) ? arg(sp, k) : null);

// ------------------------------------------------------------ the address

export const PLANNING_SCOPES = ["all", "tr", "lv"] as const;
export type PlanningScope = (typeof PLANNING_SCOPES)[number];
export const PLANNING_SCOPE_LABEL: Record<PlanningScope, string> = { all: "All", tr: "Transformers", lv: "LV Panels" };
const isScope = (x: string): x is PlanningScope => (PLANNING_SCOPES as readonly string[]).includes(x);

/** The panels' plan families as the address names them ("" is the panels' own plan). */
export const FAMILY_PARAM: Record<LvFamily, string> = { "": "panels", MB: "mb" };
export const familyOfParam = (v: string): LvFamily | null => (v === "panels" ? "" : v === "mb" ? "MB" : null);

/** The line a scope shows alone — null under All — and back. */
export const SCOPE_LINE: Record<PlanningScope, ProductLine | null> = { all: null, tr: "TR", lv: "LV" };
export const scopeOfLine = (line: ProductLine | null): PlanningScope => (line === "TR" ? "tr" : line === "LV" ? "lv" : "all");

/** What the page shows, all of it in its address — a link, a bookmark and a
 *  reload open the same view. */
export interface PlanningFilters {
  scope: PlanningScope;
  /** The transformers' weekly plan; null is the newest. */
  plan: number | null;
  /** A transformer component (CF, TC, TN, CB, …). */
  item: string | null;
  /** A transformers' work centre. */
  centre: WorkCentre | null;
  /** An MO, BOM or SOI, as typed — part of one is enough. */
  q: string;
  /** The panels' plan family. */
  family: LvFamily | null;
  /** A panels' department. */
  lvDept: LvFloorDept | null;
  /** The panels' stage table's own period. */
  from: string | null;
  to: string | null;
  /** The figure whose details are open. */
  detail: string | null;
}

export const NO_FILTERS: PlanningFilters = { scope: "all", plan: null, item: null, centre: null, q: "", family: null, lvDept: null, from: null, to: null, detail: null };

/** The filters an address carries; anything it does not know is left out, never an error. */
export function planningFiltersOf(sp: Search): PlanningFilters {
  const scope = arg(sp, "scope").toLowerCase();
  const plan = Number(arg(sp, "plan"));
  const item = arg(sp, "item").toUpperCase();
  const centre = arg(sp, "centre");
  const lvDept = arg(sp, "lvDept");
  const detail = arg(sp, "detail");
  return {
    scope: isScope(scope) ? scope : "all",
    plan: Number.isInteger(plan) && plan > 0 ? plan : null,
    item: isItem(item) ? item : null,
    centre: isWorkCentre(centre) ? centre : null,
    q: arg(sp, "q").slice(0, 60),
    family: familyOfParam(arg(sp, "family").toLowerCase()),
    lvDept: isLvFloorDept(lvDept) ? lvDept : null,
    from: dayArg(sp, "from"),
    to: dayArg(sp, "to"),
    detail: isPlanningDetail(detail) ? detail : null,
  };
}

/** The address of the page with these filters, `patch` over them; empty ones left out. */
export function planningUrl(f: PlanningFilters, patch: Partial<PlanningFilters> = {}): string {
  const v = { ...f, ...patch };
  return href("/", {
    scope: v.scope === "all" ? null : v.scope, plan: v.plan ? String(v.plan) : null, item: v.item, centre: v.centre, q: v.q,
    family: v.family === null ? null : FAMILY_PARAM[v.family], lvDept: v.lvDept, from: v.from, to: v.to, detail: v.detail,
  });
}

/** The line a page shows from its address: a line's own scope on Planning, both
 *  on a plant dashboard (Planning under All, Production), null elsewhere (the
 *  app's line). One answer for the chat's context and the assistant's tools. */
export function pageLineOf(page: { path: string; filters: Search } | null | undefined): ProductLine | "both" | null {
  if (!page || !showsBothLines(page.path)) return null;
  return (page.path === "/" ? SCOPE_LINE[planningFiltersOf(page.filters).scope] : null) ?? "both";
}

/** Whether the line is on screen under the scope. */
export const showsTr = (f: Pick<PlanningFilters, "scope">) => f.scope !== "lv";
export const showsLv = (f: Pick<PlanningFilters, "scope">) => f.scope !== "tr";

// ------------------------------------------------------------ the details

/** The figures whose rows open in a popup, named in the address (?detail=). */
export const TR_DETAILS = ["tr-ontime", "tr-behind", "tr-hours", "tr-coverage", "tr-capacity", "tr-people"] as const;
export const LV_DETAILS = ["lv-planned", "lv-painted", "lv-remaining", "lv-pace", "lv-urgent", "lv-people"] as const;
export const PLANT_DETAILS = ["all-hours", "all-people"] as const;
export type PlanningDetail = (typeof TR_DETAILS)[number] | (typeof LV_DETAILS)[number] | (typeof PLANT_DETAILS)[number] | `tr-load:${WorkCentre}`;

export function isPlanningDetail(x: string): x is PlanningDetail {
  if ((TR_DETAILS as readonly string[]).includes(x) || (LV_DETAILS as readonly string[]).includes(x) || (PLANT_DETAILS as readonly string[]).includes(x)) return true;
  return x.startsWith("tr-load:") && isWorkCentre(x.slice("tr-load:".length));
}

// ------------------------------------------------------------ the transformers' plan lines

/** The stage each centre works — what a weekly plan line owes it. */
export const STAGE_OF_CENTRE: Record<WorkCentre, Stage> = { Cutting: "cut", Bending: "cut", Fins: "cut", Welding: "weld", ShotBlast: "finish", Painting: "finish" };

/** The centres a stage of a component goes through — the core is never painted. */
export function centresOfStage(stage: Stage, item: string): WorkCentre[] {
  return WORK_CENTRES.filter((c) => STAGE_OF_CENTRE[c] === stage && !(c === "Painting" && isPaintExempt(item)));
}

/** One component of one project on one delivery day, as the dashboard reads it. */
export interface PlanLine extends PlanCell {
  soi: string | null;
  /** The orders the project owes the component on the day. */
  mos: string[];
  /** Of the promise, pieces made outside (OSP): counted made, no hours here. */
  osp: number;
  /** Of the promise, pieces the order marks not manufactured (N/A): out of every figure. */
  na: number;
  /** Every order on the line is on hold: out of the queues and the load, still on the plan. */
  held: boolean;
  /** Std-hours still to work at each centre; null while the order's class has no hours a piece. */
  leftH: Partial<Record<WorkCentre, number>> | null;
}

/** What a line still owes each centre, by the day the centre owes it — its
 *  stage's date (the oven date less the lead days). Nothing for a centre the
 *  stage has cleared. */
export function lineDueHours(l: Pick<PlanCell, "dayISO" | "item" | "owed" | "done">, per: Record<WorkCentre, number>, leads: { cut: number; weld: number }): { centre: WorkCentre; dayISO: string; dueH: number }[] {
  const out: { centre: WorkCentre; dayISO: string; dueH: number }[] = [];
  for (const stage of STAGES) {
    const left = Math.max(0, l.owed - l.done[stage]);
    for (const c of centresOfStage(stage, l.item)) {
      const h = left * per[c];
      if (h > 0) out.push({ centre: c, dayISO: stageDueISO(l.dayISO, stage, leads), dueH: h });
    }
  }
  return out;
}

/** Whether the line still owes a centre work at a stage: the centre works the
 *  stage for the component, and the line has hours left there — or, unpriced,
 *  could have (no hours a piece to say it has none). */
export function owesCentre(l: Pick<PlanLine, "item" | "leftH">, stage: Stage, centre: WorkCentre): boolean {
  if (!centresOfStage(stage, l.item).includes(centre)) return false;
  return l.leftH === null || (l.leftH[centre] ?? 0) > 0;
}

/** The lines an MO, BOM or SOI search and a component name. */
export function trLinesOf<L extends PlanLine>(lines: readonly L[], f: Pick<PlanningFilters, "item" | "q">): L[] {
  const q = f.q.toLowerCase();
  return lines.filter((l) => (!f.item || l.item === f.item) && (!q || l.bom.toLowerCase().includes(q) || (l.soi ?? "").toLowerCase().includes(q) || l.mos.some((m) => m.toLowerCase().includes(q))));
}

/** The first stage that has not cleared the line — whatever its date. */
export const blockingStage = (l: Pick<PlanCell, "owed" | "done">): Stage | null => (l.owed > 0 ? STAGES.find((s) => l.done[s] < l.owed) ?? null : null);

/** A line's hours still to work: every centre, or one. Null while unpriced. */
export function lineHoursLeft(l: Pick<PlanLine, "leftH">, centre: WorkCentre | null = null): number | null {
  if (!l.leftH) return null;
  return centre ? l.leftH[centre] ?? 0 : Object.values(l.leftH).reduce((s, h) => s + (h ?? 0), 0);
}

/** The lines due through a stage by today, each with what it owed and what
 *  the stage did of it — the rows the stage's adherence is the sum of. */
export function dueByTodayRows(lines: readonly PlanLine[], stage: Stage, todayISO: string, leads: { cut: number; weld: number }): { line: PlanLine; dueISO: string; owed: number; done: number }[] {
  return lines
    .filter((l) => l.owed > 0 && stageDueISO(l.dayISO, stage, leads) <= todayISO)
    .map((l) => ({ line: l, dueISO: stageDueISO(l.dayISO, stage, leads), owed: l.owed, done: Math.min(l.owed, Math.max(0, l.done[stage])) }))
    .sort((a, b) => a.dueISO.localeCompare(b.dueISO) || a.line.bom.localeCompare(b.line.bom));
}

/** The lines with work still to do, each with its std-hours left (one
 *  centre's, or every centre's; null unpriced) — the rows the hours left are
 *  the sum of. A line on hold is out of the queues and asks no hours. */
export function hoursLeftRows(lines: readonly PlanLine[], centre: WorkCentre | null = null): { line: PlanLine; stage: Stage; hours: number | null }[] {
  const out: { line: PlanLine; stage: Stage; hours: number | null }[] = [];
  for (const l of lines) {
    const stage = blockingStage(l);
    if (l.held || !stage) continue;
    // a centre's own hours: only the lines with work left at its stage
    if (centre && (l.done[STAGE_OF_CENTRE[centre]] >= l.owed || !owesCentre(l, STAGE_OF_CENTRE[centre], centre))) continue;
    const hours = lineHoursLeft(l, centre);
    out.push({ line: l, stage, hours: hours === null ? null : round1(hours) });
  }
  return out.sort((a, b) => (b.hours ?? -1) - (a.hours ?? -1) || a.line.dayISO.localeCompare(b.line.dayISO));
}

// ------------------------------------------------------------ at risk

export type RiskStatus = "late" | "at-risk" | "on-hold" | "urgent" | "short";
export const RISK_LABEL: Record<RiskStatus, string> = { late: "Late", "at-risk": "At risk", "on-hold": "On hold", urgent: "Urgent", short: "Short" };
const RISK_RANK: Record<RiskStatus, number> = { late: 0, urgent: 1, "at-risk": 2, short: 3, "on-hold": 4 };

/** One line of the plan that will not make its date, or has not. */
export interface AtRiskRow {
  line: "TR" | "LV";
  status: RiskStatus;
  mo: string;
  soi: string | null;
  bom: string;
  /** The transformer component, or the panel's product. */
  item: string;
  /** The date the holding stage owes the line — null for the panels, which carry none. */
  stageDueISO: string | null;
  required: number;
  /** Through the holding stage. */
  done: number;
  remaining: number;
  /** The stage that holds the line, as the floor names it. */
  stage: string | null;
  /** Std-hours still to work on the line (every stage left); null unpriced. */
  hoursLeft: number | null;
  reason: string;
  /** The order's trace, and the worklist of the stage that holds it. */
  href: string;
  worklist: string | null;
}

const TR_WORKLIST: Record<Stage, string> = { cut: "/worklist/cut", weld: "/worklist/welding", finish: "/worklist/painting" };
const LV_WORKLIST: Record<LvStage, string> = { Punching: "/worklist/punching", Bending: "/worklist/bending", Welding: "/worklist/welding", Painting: "/worklist/painting" };

const riskOrder = (a: AtRiskRow, b: AtRiskRow) =>
  RISK_RANK[a.status] - RISK_RANK[b.status] || (a.stageDueISO ?? "").localeCompare(b.stageDueISO ?? "") || b.remaining - a.remaining || a.bom.localeCompare(b.bom) || a.item.localeCompare(b.item);

/** What the plan's lines owe one centre, by the day they owe it — the rows a
 *  load matrix row sums. `inHorizon`: owed by the horizon's last day (work
 *  owed before it is owed on its first); later is not this horizon's. A line on
 *  hold asks nothing. */
export function centreLoadRows(lines: readonly PlanLine[], centre: WorkCentre, leads: { cut: number; weld: number }, horizonEndISO: string | null): { line: PlanLine; dueISO: string; hours: number; inHorizon: boolean }[] {
  const stage = STAGE_OF_CENTRE[centre];
  return lines
    .filter((l) => !l.held && (l.leftH?.[centre] ?? 0) > 0)
    .map((l) => {
      const dueISO = stageDueISO(l.dayISO, stage, leads);
      return { line: l, dueISO, hours: l.leftH![centre]!, inHorizon: horizonEndISO !== null && dueISO <= horizonEndISO };
    })
    .sort((a, b) => a.dueISO.localeCompare(b.dueISO) || a.line.bom.localeCompare(b.line.bom));
}

/** The transformers' lines that are late at a stage, or will be: the stage
 *  holding the line owes it by a date a centre of the stage is already short
 *  of capacity on (the load ahead, at its measured pace). A line on hold is
 *  listed as such — out of the queues, still owed on the plan. `centre`
 *  keeps the lines held at that centre's stage. */
export function trAtRisk(lines: readonly PlanLine[], load: readonly LoadAhead[], todayISO: string, leads: { cut: number; weld: number }, o: { centre?: WorkCentre | null; planNo?: number | null; horizonDays: number }): AtRiskRow[] {
  const short = new Map(load.filter((l) => l.measured && l.shortFromISO !== null).map((l) => [l.centre, l]));
  const rows: AtRiskRow[] = [];
  for (const l of lines) {
    const stage = blockingStage(l);
    if (!stage) continue;
    // the centres the line still owes at the stage holding it
    const centres = centresOfStage(stage, l.item).filter((c) => owesCentre(l, stage, c));
    if (o.centre && !centres.includes(o.centre)) continue;
    const due = stageDueISO(l.dayISO, stage, leads);
    let status: RiskStatus;
    let reason: string;
    if (l.held) {
      status = "on-hold";
      reason = `On hold — out of every queue; ${STAGE_LABEL[stage]} ${due <= todayISO ? "was" : "is"} due ${formatDate(due)}`;
    } else if (due <= todayISO) {
      status = "late";
      reason = `${STAGE_LABEL[stage]} was due ${formatDate(due)}`;
    } else {
      const tight = centres.map((c) => short.get(c)).filter((x): x is LoadAhead => !!x && x.shortFromISO! <= due);
      if (tight.length === 0) continue;
      status = "at-risk";
      reason = tight.map((t) => `${WORK_CENTRE_LABEL[t.centre]} short of capacity from ${formatDate(t.shortFromISO!)}${t.clearsISO ? `, catching up by ${formatDate(t.clearsISO)} (estimate)` : `, not caught up in the next ${o.horizonDays} working days`}`).join("; ");
    }
    const done = Math.max(0, Math.min(l.owed, l.done[stage]));
    const h = lineHoursLeft(l, o.centre ?? null);
    rows.push({
      line: "TR", status, mo: l.mos.join(", "), soi: l.soi, bom: l.bom, item: trItemName(l.item),
      stageDueISO: due, required: l.owed, done, remaining: l.owed - done, stage: STAGE_LABEL[stage],
      hoursLeft: h === null ? null : round1(h), reason,
      href: traceHref({ bom: l.bom, line: "TR" }, o.planNo ?? 0, "weekly"),
      worklist: hrefWithLine(TR_WORKLIST[stage], "TR"),
    });
  }
  return rows.sort(riskOrder);
}

/** One panel order, as the dashboard reads it. */
export interface LvOrderLine {
  mo: string;
  bom: string;
  soi: string | null;
  product: string | null;
  urgent: boolean;
  held: boolean;
  /** Still open: a closed order owes nothing, whatever its counts say. */
  open: boolean;
  /** On this month's plan (brought or carried over). */
  inMonth: boolean;
  state: LvState;
  /** The timings sheet's row for the panel; null when it has none. */
  rate: LvRate | null;
}

/** The first stage of the chain that has not cleared the order. */
export function lvBlockingStage(s: LvState): LvStage | null {
  if (!(s.required > 0)) return null;
  return LV_STAGES.find((st) => cap(lvStageOf(s, st), s.required) < s.required) ?? null;
}

/** An order's std-hours still to work: every department, or one. Null while unpriced. */
export function lvHoursLeft(o: Pick<LvOrderLine, "state" | "rate">, dept: LvFloorDept | null = null): number | null {
  if (!o.rate) return null;
  const s = o.state;
  const depts: readonly LvFloorDept[] = dept ? [dept] : LV_FLOOR_DEPTS;
  let h = 0;
  for (const d of depts) h += lvRateAt(o.rate, d) * Math.max(0, s.required - cap(lvStageOf(s, LV_DEPT_STAGE_OF[d]), s.required));
  return h;
}

/** The panels' orders still short: the month's, and every urgent open one.
 *  They carry no delivery date, so none is "late" — urgency is the planner's
 *  flag, and a paused order is listed as on hold. `dept` keeps the orders
 *  held at that department's stage. */
export function lvAtRisk(orders: readonly LvOrderLine[], o: { dept?: LvFloorDept | null } = {}): AtRiskRow[] {
  const rows: AtRiskRow[] = [];
  for (const r of orders) {
    if (!r.open || (!r.inMonth && !r.urgent)) continue;
    const stage = lvBlockingStage(r.state);
    if (!stage) continue;
    if (o.dept && LV_DEPT_STAGE_OF[o.dept] !== stage) continue;
    const done = cap(r.state.paint, r.state.required);
    const notStarted = r.state.punch <= 0;
    const status: RiskStatus = r.held ? "on-hold" : r.urgent ? "urgent" : "short";
    const where = notStarted ? "Not punched yet" : `Waiting at ${stage.toLowerCase()}`;
    const h = lvHoursLeft(r, o.dept ?? null);
    rows.push({
      line: "LV", status, mo: r.mo, soi: r.soi, bom: r.bom, item: r.product ?? "—",
      stageDueISO: null, required: r.state.required, done, remaining: r.state.required - done, stage,
      hoursLeft: h === null ? null : round1(h),
      reason: r.held ? `On hold — out of every queue; ${where.toLowerCase()}` : `${r.urgent ? "Urgent · " : ""}${where}${r.inMonth ? "" : " · not on this month's plan"}`,
      href: traceHref({ mo: r.mo, line: "LV" }),
      worklist: hrefWithLine(LV_WORKLIST[stage], "LV"),
    });
  }
  return rows.sort(riskOrder);
}

// ------------------------------------------------------------ the load against the capacity

/** A cell's state, read on the running totals: what the centre owes so far
 *  against what it can work so far — never one day's alone. */
export type LoadState = "short" | "tight" | "ok" | "unmeasured";
export const LOAD_STATE_LABEL: Record<LoadState, string> = { short: "Short", tight: "Tight", ok: "Covered", unmeasured: "Not measured" };

export interface LoadMatrixRow {
  centre: WorkCentre;
  measured: boolean;
  /** Std-hours owed beyond the horizon's capacity. */
  shortH: number;
  cells: { dayISO: string; dueH: number; capacityH: number | null; owedCum: number; canCum: number | null; state: LoadState }[];
}

/** Each centre's next working days: the std-hours its plan lines owe on the
 *  day, the hours it can work a day (what it usually has × its measured pace),
 *  and whether the running totals are short. `centre` keeps one. */
export function loadMatrix(load: readonly LoadAhead[], centre: WorkCentre | null = null): LoadMatrixRow[] {
  return load
    .filter((l) => !centre || l.centre === centre)
    .map((l) => ({
      centre: l.centre,
      measured: l.measured,
      shortH: l.shortH,
      cells: l.days.map((d) => ({
        dayISO: d.dayISO, dueH: d.dueH, capacityH: l.measured ? d.capacityH : null, owedCum: d.owedCum, canCum: d.canCum,
        state: !l.measured ? "unmeasured" : d.tone === "bad" ? "short" : d.tone === "warn" ? "tight" : "ok",
      })),
    }));
}

/** The std-hours the measured centres cannot work within the horizon — one
 *  centre's, or all of theirs (each centre's own: one's spare hours never
 *  cover another's). */
export function capacityShortH(load: readonly LoadAhead[], centre: WorkCentre | null = null): number {
  return round1(load.filter((l) => l.measured && (!centre || l.centre === centre)).reduce((s, l) => s + l.shortH, 0));
}

// ------------------------------------------------------------ planned against achieved

/** One delivery day of the weekly plan: what it owes, and each stage's pieces
 *  of it — every stage on its own (a stage's pieces are never added to the
 *  next's, nor read as finished transformers). */
export interface StageDay {
  dayISO: string;
  owed: number;
  cut: number;
  weld: number;
  finish: number;
  /** Today's slot, put between the plan's days where it falls. */
  isToday: boolean;
}

export function stageByDay(lines: readonly PlanLine[], todayISO: string): StageDay[] {
  const by = new Map<string, StageDay>();
  for (const l of lines) {
    if (l.owed <= 0) continue;
    const d = by.get(l.dayISO) ?? { dayISO: l.dayISO, owed: 0, cut: 0, weld: 0, finish: 0, isToday: l.dayISO === todayISO };
    d.owed += l.owed;
    for (const s of STAGES) d[s] += Math.min(l.owed, Math.max(0, l.done[s]));
    by.set(l.dayISO, d);
  }
  const days = [...by.values()].sort((a, b) => a.dayISO.localeCompare(b.dayISO));
  // today has a slot of its own when the plan owes nothing on it — the marker sits there
  if (days.length > 0 && !by.has(todayISO)) days.push({ dayISO: todayISO, owed: 0, cut: 0, weld: 0, finish: 0, isToday: true });
  return days.sort((a, b) => a.dayISO.localeCompare(b.dayISO));
}

// ------------------------------------------------------------ against a week ago

/** The change against an earlier reading, as a share of it — null where there
 *  is no earlier reading, or it was zero: no base, no change to read. */
export function relativeChange(now: number | null | undefined, before: number | null | undefined): number | null {
  if (now === null || now === undefined || before === null || before === undefined) return null;
  if (!Number.isFinite(now) || !Number.isFinite(before) || before === 0) return null;
  return (now - before) / Math.abs(before);
}

// ------------------------------------------------------------ the data behind the page

/** One fact about the data the figures rest on — what they cover and what
 *  they leave out — as the dashboards' data-quality strip shows it (a word
 *  with its colour: "warn" or "bad" marks what is missing). */
export interface QualityNote {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "bad";
}

/** Whether the notes mark the figures as resting on partial data. */
export const isPartial = (notes: readonly QualityNote[]) => notes.some((n) => n.tone === "warn" || n.tone === "bad");

// ------------------------------------------------------------ the transformers' view

/** What the transformers' section reads from the cockpit (lib/server/kpis.ts). */
export interface TrViewInput {
  todayISO: string;
  lastDayISO: string | null;
  leads: { cut: number; weld: number };
  week: { planNo: number | null; newest: boolean; lines: PlanLine[] };
  load: LoadAhead[];
  manpower: { rows: ManpowerRow[]; leftWd: number };
  coverage: { days: number | null };
  horizonDays: number;
}

export interface TrView {
  /** The figures can be read against a week ago: the newest plan, nothing narrowed. */
  comparable: boolean;
  lines: PlanLine[];
  adherence: StageAdherence[];
  finish: StageAdherence | null;
  late: (LateLine & { soi: string | null; mos: string[]; held: boolean })[];
  hoursLeft: { total: number; unpriced: number; pricedShare: number | null };
  capacity: { shortH: number; unmeasured: WorkCentre[]; rows: LoadMatrixRow[] };
  atRisk: AtRiskRow[];
  byDay: StageDay[];
  people: { rows: ManpowerRow[]; toAdd: number | null };
  quality: QualityNote[];
}

/** The transformers' section under the filters. The component and the search
 *  narrow the plan lines (the plan's figures, the lines behind and at risk);
 *  the centre narrows the hours, the load, the people and the lines held at
 *  its stage. The load is always the whole plan's: a centre's capacity is
 *  shared by every component, so one component's load alone would read light. */
export function trView(c: TrViewInput, f: PlanningFilters, o: { floor: boolean }): TrView {
  const lines = trLinesOf(c.week.lines, f);
  const adherence = planAdherence(lines, c.todayISO, c.leads);
  const late = lateLines(lines, c.todayISO, c.leads).flatMap(({ cell, ...l }) =>
    // a centre keeps the lines stuck at its stage that still owe it work — the at-risk table's own rule
    f.centre && !owesCentre(cell, l.stage, f.centre) ? [] : [{ ...l, soi: cell.soi, mos: cell.mos, held: cell.held }]);
  // the hours still to work, the lines on hold left out (they are out of the queues)
  const left = hoursLeftRows(lines, f.centre);
  const total = left.reduce((s, r) => s + (r.hours ?? 0), 0);
  const unpriced = left.filter((r) => r.hours === null).length;
  const owedAll = left.reduce((s, r) => s + r.line.owed, 0);
  const owedPriced = left.reduce((s, r) => s + (r.hours === null ? 0 : r.line.owed), 0);
  const rows = loadMatrix(c.load, f.centre);
  const peopleRows = c.manpower.rows.filter((r) => !f.centre || r.centre === f.centre);
  const toAdd = o.floor && c.manpower.leftWd > 0 && peopleRows.some((r) => r.gap !== null) ? peopleShort(peopleRows) : null;
  const unmeasured = rows.filter((r) => !r.measured).map((r) => r.centre);

  const quality: QualityNote[] = [];
  const allOwed = c.week.lines.reduce((s, l) => s + l.owed, 0);
  if (c.week.planNo === null) quality.push({ label: "Weekly plan", value: "none imported", tone: "bad" });
  else {
    quality.push({ label: "Weekly plan", value: c.week.newest ? `${c.week.planNo}` : `${c.week.planNo} — an earlier plan, its lines as they stand now` });
    quality.push(owedAll === 0
      ? { label: "Std times", value: "nothing left to price", tone: "ok" }
      : { label: "Std times", value: `${Math.round((owedPriced / owedAll) * 100)}% of the pieces left priced${unpriced > 0 ? ` · ${unpriced} line${unpriced === 1 ? "" : "s"} not` : ""}`, tone: owedPriced < owedAll ? "warn" : "ok" });
    const osp = lines.reduce((s, l) => s + l.osp, 0);
    if (osp > 0) quality.push({ label: "Outsourced (OSP)", value: `${osp} pcs — counted made, no hours here` });
    const na = lines.reduce((s, l) => s + l.na, 0);
    if (na > 0) quality.push({ label: "N/A on the order", value: `${na} pcs — out of every figure` });
    const held = lines.filter((l) => l.held);
    if (held.length > 0) quality.push({ label: "On hold", value: `${held.length} line${held.length === 1 ? "" : "s"}, ${held.reduce((s, l) => s + l.owed, 0)} pcs — on the plan, out of the load` });
    if (allOwed > 0 && lines.length === 0) quality.push({ label: "Filters", value: "leave no plan line", tone: "warn" });
  }
  if (unmeasured.length > 0) quality.push({ label: "Capacity not measured", value: unmeasured.map((x) => WORK_CENTRE_LABEL[x]).join(", "), tone: "warn" });
  if (o.floor) quality.push(c.lastDayISO ? { label: "Last shift day", value: formatDate(c.lastDayISO) } : { label: "Last shift day", value: "none lately — capacity and people not measured", tone: "warn" });

  return {
    comparable: c.week.newest && !f.item && !f.q,
    lines,
    adherence,
    finish: adherence.find((a) => a.stage === "finish") ?? null,
    late,
    hoursLeft: { total: round1(total), unpriced, pricedShare: owedAll > 0 ? owedPriced / owedAll : null },
    capacity: { shortH: capacityShortH(c.load, f.centre), unmeasured, rows },
    atRisk: trAtRisk(lines, c.load, c.todayISO, c.leads, { centre: f.centre, planNo: c.week.planNo, horizonDays: c.horizonDays }),
    byDay: stageByDay(lines, c.todayISO),
    people: { rows: peopleRows, toAdd },
    quality,
  };
}

// ------------------------------------------------------------ the panels' view

/** What the panels' section reads from their planning (lib/server/lvKpis.ts). */
export interface LvViewInput {
  lastDayISO: string | null;
  todayISO: string;
  orders: LvOrderLine[];
  manpower: { rows: ManpowerRow<LvFloorDept>[]; coverage: { orders: number; priced: number } };
  month: { leftWd: number };
  wip: { heldOrders: number };
}

export interface LvView {
  /** The month's orders, each once — what its panels, painted and left add up from. */
  month: ReturnType<typeof lvMonthRows>;
  atRisk: AtRiskRow[];
  people: { rows: ManpowerRow<LvFloorDept>[]; toAdd: number | null };
  quality: QualityNote[];
}

/** The panels' section under the filters: the family is the loader's (it
 *  narrows every order figure); the department narrows the people and the
 *  orders held at its stage. */
export function lvView(d: LvViewInput, f: PlanningFilters, o: { floor: boolean }): LvView {
  const rows = d.manpower.rows.filter((r) => !f.lvDept || r.centre === f.lvDept);
  const cov = d.manpower.coverage;
  const quality: QualityNote[] = [
    { label: "Delivery dates", value: "none on the panels' plan — judged on an even pace through the month" },
    cov.orders === 0 ? { label: "Month's plan", value: "no order", tone: "bad" } : { label: "Std times", value: `${cov.priced} of ${cov.orders} month orders priced`, tone: cov.priced < cov.orders ? "warn" : "ok" },
  ];
  if (d.wip.heldOrders > 0) quality.push({ label: "On hold", value: `${d.wip.heldOrders} order${d.wip.heldOrders === 1 ? "" : "s"} — out of the queues` });
  if (f.family !== null && o.floor) quality.push({ label: "People present", value: "the whole floor's, not one family's — no gap read" });
  if (o.floor) quality.push(d.lastDayISO ? { label: "Last shift day", value: formatDate(d.lastDayISO) } : { label: "Last shift day", value: "none lately — people present not measured", tone: "warn" });
  return {
    month: lvMonthRows(d.orders),
    atRisk: lvAtRisk(d.orders, { dept: f.lvDept }),
    people: { rows, toAdd: o.floor && d.month.leftWd > 0 && rows.some((r) => r.gap !== null) ? peopleShort(rows) : null },
    quality,
  };
}

/** The month's orders with a quantity — the rows the month's panels, painted
 *  and remaining are the sums of (lvMonthProgress's own counting). */
export function lvMonthRows(orders: readonly LvOrderLine[]): { order: LvOrderLine; required: number; painted: number; remaining: number }[] {
  return orders
    .filter((o) => o.inMonth && o.state.required > 0)
    .map((o) => {
      const painted = cap(o.state.paint, o.state.required);
      return { order: o, required: o.state.required, painted, remaining: Math.max(0, o.state.required - painted) };
    })
    .sort((a, b) => b.remaining - a.remaining || a.order.mo.localeCompare(b.order.mo));
}

/** Std-hours left on the month's plan — the people rows' own figure, one line's. */
export const hoursLeftOf = (rows: readonly Pick<ManpowerRow<string>, "leftH">[]) => round1(rows.reduce((s, r) => s + r.leftH, 0));

/** What adds up across the lines, each as its view reads it under the filters:
 *  the month's std-hours left and the people to add (each line's own
 *  departments, so they add) — pieces never. Null where neither line can say. */
export function plantTotals(tr: { people: { rows: readonly Pick<ManpowerRow<string>, "leftH">[]; toAdd: number | null } }, lv: { people: { rows: readonly Pick<ManpowerRow<string>, "leftH">[]; toAdd: number | null } }) {
  const hoursLeft = { TR: hoursLeftOf(tr.people.rows), LV: hoursLeftOf(lv.people.rows) };
  return {
    hoursLeft: { ...hoursLeft, total: round1(hoursLeft.TR + hoursLeft.LV) },
    toAdd: { TR: tr.people.toAdd, LV: lv.people.toAdd, total: tr.people.toAdd === null && lv.people.toAdd === null ? null : (tr.people.toAdd ?? 0) + (lv.people.toAdd ?? 0) },
  };
}
