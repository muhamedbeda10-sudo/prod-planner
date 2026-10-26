import "server-only";
import { prisma } from "@/lib/db";
import { factoryDayISO, toISODate } from "@/lib/domain/dates";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { LV_FLOOR_DEPTS } from "@/lib/domain/lvKpis";
import { mergeActions } from "@/lib/domain/plantKpis";
import type { CockpitAction } from "@/lib/domain/kpis";
import type { ProductLine } from "@/lib/domain/lines";
import { SHIFT_DEPTS, centreOf, deptCentre, type RosterDept } from "@/lib/domain/shifts";
import { ROSTER_OF } from "@/lib/domain/floorKpis";
import type { OutputGroup } from "@/lib/domain/kpis";
import { sectionDept } from "@/lib/domain/tanks";
import { parseWorkerSections, workerDepts } from "@/lib/domain/workers";
import {
  linesOf, previousPeriod, productionView,
  type LineFacts, type ProductionRequest, type ProductionView, type UnitDay,
} from "@/lib/domain/productionDashboard";
import { getFloorFacts, getFloorPeriodWithFacts, type FloorPeriod } from "./kpis";
import { getLvFloorFacts, getLvFloorPeriodWithFacts, type LvFloorPeriod } from "./lvKpis";
import { loadHolidays } from "./loads";

// The Production dashboard's one loader, for the page and the assistant:
// each line's period (getFloorPeriod / getLvFloorPeriod, read once with
// their unit-days), the equal stretch before for the tiles' change, the
// roster's Not set, the factory calendar and when each line began recording
// attendance — then every figure from lib/domain/productionDashboard.ts.
// It only reads. A line that fails to load leaves the other on screen, said
// as partial data. Callers check the Shifts screen's access first.

const dayStart = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const DEPTS_OF: Record<ProductLine, readonly RosterDept[]> = { TR: SHIFT_DEPTS, LV: LV_FLOOR_DEPTS };

/** The first day a line's attendance was recorded, and its last up to `toISO`. */
async function trackingOf(line: ProductLine, toISO: string): Promise<{ since: string | null; last: string | null }> {
  const dept = { in: [...DEPTS_OF[line]] };
  const [first, last] = await Promise.all([
    prisma.shiftEntry.aggregate({ where: { dept }, _min: { date: true } }),
    prisma.shiftEntry.aggregate({ where: { dept, date: { lt: dayStart(addDaysISO(toISO, 1)) } }, _max: { date: true } }),
  ]);
  return { since: first._min.date ? toISODate(first._min.date) : null, last: last._max.date ? toISODate(last._max.date) : null };
}

/** Who was on the shift log over a period, and today's workers list — what Not set is read against. */
async function readRoster(fromISO: string, toISO: string) {
  const [rows, workers] = await Promise.all([
    prisma.shiftEntry.findMany({ where: { date: { gte: dayStart(fromISO), lt: dayStart(addDaysISO(toISO, 1)) } }, select: { date: true, dept: true, workerId: true } }),
    prisma.worker.findMany({ where: { active: true }, select: { id: true, depts: true, createdAt: true } }),
  ]);
  return { rows, workers };
}

/** Not set on the roster, the Shifts screen's own way: an active worker of a
 *  department with no row there on a day the department recorded. Read
 *  against today's list (the workers' list keeps no history), so a worker
 *  counts only from the day they were added. A Fabrication worker counts at
 *  his section's centre, else at the first centre that recorded the day. */
function addNotSet(days: UnitDay[], { rows, workers }: Awaited<ReturnType<typeof readRoster>>, todayISO: string): void {
  const recorded = days.filter((d) => d.rows > 0);
  const has = new Set(rows.map((r) => `${toISODate(r.date)}|${r.dept}|${r.workerId}`));
  const roster = workers.map((w) => {
    const sections = parseWorkerSections(w.depts);
    return { id: w.id, since: factoryDayISO(w.createdAt), sections, depts: workerDepts(sections) as readonly string[] };
  });
  // a day's recorded unit-days by roster department (Fabrication is the roster's Cut)
  const byDeptDay = new Map<string, UnitDay[]>();
  for (const d of recorded) {
    d.notSet = 0;
    const k = `${d.dateISO}|${d.line === "TR" ? ROSTER_OF[d.dept as OutputGroup] ?? d.dept : d.dept}`;
    const list = byDeptDay.get(k);
    if (list) list.push(d);
    else byDeptDay.set(k, [d]);
  }
  for (const [k, units] of byDeptDay) {
    const [dateISO, dept] = k.split("|");
    if (dateISO > todayISO) continue;
    for (const w of roster) {
      if (!w.depts.includes(dept) || w.since > dateISO || has.has(`${dateISO}|${dept}|${w.id}`)) continue;
      const own = centreOf(dept, w.sections.filter((s) => sectionDept(s) === dept)) ?? deptCentre(dept) ?? dept;
      const at = units.find((u) => u.unit === own) ?? units[0];
      at.notSet = (at.notSet ?? 0) + 1;
    }
  }
}

export interface ProductionDashboard {
  req: ProductionRequest;
  todayISO: string;
  view: ProductionView;
  /** Each line's period as its other cards need it; null when the line is not asked for or failed. */
  tr: FloorPeriod | null;
  lv: LvFloorPeriod | null;
  /** The lines that failed to load — the page says the figures are partial. */
  failed: ProductLine[];
  /** The stretch the tiles compare with; null when it is before the history kept. */
  before: { fromISO: string; toISO: string } | null;
  actions: (CockpitAction & { line: ProductLine })[];
}

const settle = <T,>(what: string, p: Promise<T>): Promise<T | null> => p.catch((e: unknown) => { console.error(`production: ${what} could not load`, e); return null; });

export async function loadProductionDashboard(req: ProductionRequest, now = new Date()): Promise<ProductionDashboard> {
  const todayISO = factoryDayISO(now);
  const lines = linesOf(req.scope);
  const before = previousPeriod(req.fromISO, req.toISO, todayISO);
  const range = { fromISO: req.fromISO, toISO: req.toISO, clamped: req.clamped };
  const wants = (l: ProductLine) => lines.includes(l);
  const [tr, lv, prevTr, prevLv, holidays, trackTr, trackLv, roster] = await Promise.all([
    wants("TR") ? settle("the transformers' period", getFloorPeriodWithFacts({ ...range, dept: req.trDept }, now)) : null,
    wants("LV") ? settle("the panels' period", getLvFloorPeriodWithFacts({ ...range, dept: req.lvDept }, now)) : null,
    wants("TR") && before ? settle("the transformers' stretch before", getFloorFacts(before.fromISO, before.toISO, now)) : null,
    wants("LV") && before ? settle("the panels' stretch before", getLvFloorFacts(before.fromISO, before.toISO)) : null,
    // the calendar and the tracking start only shape the coverage: one that fails leaves the figures on screen
    settle("the factory calendar", loadHolidays()),
    wants("TR") ? settle("the transformers' first recorded day", trackingOf("TR", req.toISO)) : null,
    wants("LV") ? settle("the panels' first recorded day", trackingOf("LV", req.toISO)) : null,
    // Not set stays unknown (null) where the roster cannot be read
    settle("the roster's Not set", readRoster(req.fromISO, req.toISO)),
  ]);
  const failed = lines.filter((l) => (l === "TR" ? tr : lv) === null);
  const facts: LineFacts[] = [];
  if (tr) facts.push({ line: "TR", ...tr.facts, trackingSinceISO: trackTr?.since ?? null, lastRecordISO: trackTr?.last ?? null });
  if (lv) facts.push({ line: "LV", ...lv.facts, trackingSinceISO: trackLv?.since ?? null, lastRecordISO: trackLv?.last ?? null });
  if (roster) addNotSet(facts.flatMap((f) => f.days), roster, todayISO);
  // the stretch before only where every line read it — a half comparison would mislead
  const prevFacts: LineFacts[] | null = before && lines.every((l) => (l === "TR" ? prevTr : prevLv) !== null)
    ? lines.map((l) => ({ line: l, ...(l === "TR" ? prevTr! : prevLv!), trackingSinceISO: null, lastRecordISO: null }))
    : null;
  const view = productionView(req, facts, prevFacts, { todayISO, holidays: new Set((holidays ?? []).map((h) => toISODate(h.date))) });
  return {
    req, todayISO, view,
    tr: tr?.period ?? null, lv: lv?.period ?? null, failed,
    before: prevFacts ? before : null,
    actions: mergeActions(tr?.period.actions ?? [], lv?.period.actions ?? []),
  };
}

/** The dashboard's figures alone for a request — the lines' unit-days and
 *  output, now and over the stretch before, without the cards around them
 *  (no item card, quality, Not set or tracking start): what the assistant's
 *  "why" reads. Throws when a line cannot be read. */
export async function loadProductionFigures(req: ProductionRequest, now = new Date()): Promise<{ view: ProductionView; before: { fromISO: string; toISO: string } | null }> {
  const todayISO = factoryDayISO(now);
  const lines = linesOf(req.scope);
  const before = previousPeriod(req.fromISO, req.toISO, todayISO);
  const read = (l: ProductLine, from: string, to: string) => (l === "TR" ? getFloorFacts(from, to, now) : getLvFloorFacts(from, to));
  const [nowFacts, prevFacts, holidays] = await Promise.all([
    Promise.all(lines.map((l) => read(l, req.fromISO, req.toISO))),
    before ? Promise.all(lines.map((l) => read(l, before.fromISO, before.toISO))) : null,
    loadHolidays(),
  ]);
  const asFacts = (got: Pick<LineFacts, "days" | "volume">[]) => got.map((f, i) => ({ line: lines[i], ...f, trackingSinceISO: null, lastRecordISO: null }));
  return {
    view: productionView(req, asFacts(nowFacts), prevFacts ? asFacts(prevFacts) : null, { todayISO, holidays: new Set(holidays.map((h) => toISODate(h.date))) }),
    before,
  };
}
