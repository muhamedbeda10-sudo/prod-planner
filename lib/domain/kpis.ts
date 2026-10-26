// The planner's KPIs — pure, so every figure the cockpit and the assistant
// show is computed by one tested function from the same records.
//
// The unit is the STANDARD HOUR a piece is worth at a work centre (typed by
// the planner, else the estimate — lib/domain/stdEngine.ts). Pieces are not a
// unit of work: a 2500 kVA tank and a 100 kVA one are both "1", and a day of
// Fabrication spread over ten projects adds up to nothing in pieces. In
// standard hours every department, every project and every day add up.
//
//   earned      std-hours the output recorded at a centre is worth
//   worked      man-hours the shift log booked to that centre
//   efficiency  earned ÷ worked — 100% is the crew at the standard pace
//   availability  the centre's machine hours less what stood still, ÷ them
//   coverage    days of welding the pieces cut-but-not-welded keep in front of it
//   adherence   the plan's pieces due so far that are done, ÷ those due

import { hrefWithLine } from "./lines";
import { trackerHref } from "./links";
import { DEPT_CENTRES, WORK_CENTRES, WORK_CENTRE_LABEL, round1, type WorkCentre } from "./shifts";
import { efficiencyTone, type EfficiencyTone } from "./productivity";
import { stopDurationLabel } from "./downtime";

export type CentreHours = Record<WorkCentre, number>;
export const zeroCentres = (): CentreHours => Object.fromEntries(WORK_CENTRES.map((c) => [c, 0])) as CentreHours;

/** What ONE ledger record earns at each centre. A piece recorded at
 *  Fabrication has passed every centre of its route, so each earns its share;
 *  a Painting record carries the shot blast before it (the app records no
 *  separate blasting for a painted part); a Shot Blast record is the core's
 *  finish. The calibration reads the ledger through this same function. A
 *  correction (a negative quantity) takes its hours back. */
export function earnedOfRecord(dept: string, qty: number, perPiece: CentreHours | undefined): CentreHours {
  const out = zeroCentres();
  if (!perPiece || !Number.isFinite(qty) || qty === 0) return out;
  if (dept === "Cut") for (const c of DEPT_CENTRES.Cut) out[c] = perPiece[c] * qty;
  else if (dept === "Welding") out.Welding = perPiece.Welding * qty;
  else if (dept === "ShotBlast") out.ShotBlast = perPiece.ShotBlast * qty;
  else if (dept === "Painting") {
    out.ShotBlast = perPiece.ShotBlast * qty;
    out.Painting = perPiece.Painting * qty;
  }
  return out;
}

/** A centre's earned hours rolled up to its department's stage. */
export function byStage(c: CentreHours): { Cut: number; Welding: number; ShotBlast: number; Painting: number } {
  return { Cut: c.Cutting + c.Bending + c.Fins, Welding: c.Welding, ShotBlast: c.ShotBlast, Painting: c.Painting };
}

/** The next `n` working days from `fromISO` (inclusive) — Fridays and the
 *  factory calendar's holidays off. */
export function workingDaysFrom(fromISO: string, n: number, holidays: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const d = new Date(`${fromISO}T00:00:00.000Z`);
  for (let guard = 0; out.length < n && guard < n * 3 + 14; guard++) {
    const iso = d.toISOString().slice(0, 10);
    if (d.getUTCDay() !== 5 && !holidays.has(iso)) out.push(iso);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** One recorded day at one centre. */
export interface CentreDay {
  dateISO: string;
  centre: WorkCentre;
  workedH: number;
  people: number;
  earnedH: number;
  /** Machine hours the centre had that day (its machines' hours a day). */
  machineH: number;
  downtimeH: number;
}

export interface CentreStat {
  centre: WorkCentre;
  days: number;
  workedH: number;
  earnedH: number;
  /** earned ÷ worked; null without worked hours. */
  efficiency: number | null;
  downtimeH: number;
  /** 1 − downtime ÷ machine hours; null where the centre has no machine hours. */
  availability: number | null;
  /** Average people present on a recorded day. */
  people: number;
}

/** Centre-days as one figure — one centre's, or several centres' together.
 *  Days without worked hours are not recorded days — they count no
 *  efficiency, people or machine hours, but their stops still count. `days`
 *  counts the dates; `people` is the average present on one of them. */
export function hoursStat(days: readonly CentreDay[]): Omit<CentreStat, "centre"> & { personDays: number } {
  const worked = days.filter((d) => d.workedH > 0);
  const workedH = worked.reduce((s, d) => s + d.workedH, 0);
  const earnedH = worked.reduce((s, d) => s + d.earnedH, 0);
  const machineH = worked.reduce((s, d) => s + d.machineH, 0);
  const personDays = worked.reduce((s, d) => s + d.people, 0);
  const downtimeH = days.reduce((s, d) => s + d.downtimeH, 0);
  const dates = new Set(worked.map((d) => d.dateISO)).size;
  return {
    days: dates,
    workedH: round1(workedH),
    earnedH: round1(earnedH),
    efficiency: workedH > 0 ? earnedH / workedH : null,
    downtimeH: round1(downtimeH),
    availability: machineH > 0 ? Math.max(0, 1 - downtimeH / machineH) : null,
    people: dates ? round1(personDays / dates) : 0,
    personDays,
  };
}

/** A centre over a window of recorded days. */
export function centreStat(centre: WorkCentre, days: readonly CentreDay[]): CentreStat {
  const s = hoursStat(days.filter((d) => d.centre === centre));
  return { centre, days: s.days, workedH: s.workedH, earnedH: s.earnedH, efficiency: s.efficiency, downtimeH: s.downtimeH, availability: s.availability, people: s.people };
}

/** A centre's days lined up under `dates`: its hours and efficiency on each,
 *  null where it booked nothing. */
export function centreCells(days: readonly CentreDay[], centre: WorkCentre, dates: readonly string[]): { dateISO: string; workedH: number; earnedH: number; efficiency: number | null }[] {
  const at = new Map(days.filter((d) => d.centre === centre).map((d) => [d.dateISO, d]));
  return dates.map((dateISO) => {
    const workedH = at.get(dateISO)?.workedH ?? 0;
    const earnedH = at.get(dateISO)?.earnedH ?? 0;
    return { dateISO, workedH: round1(workedH), earnedH: round1(earnedH), efficiency: workedH > 0 ? earnedH / workedH : null };
  });
}

/** The tone an efficiency reads in — the Shifts page's own bands. */
export function efficiencyBand(e: number | null): EfficiencyTone | null {
  return e === null ? null : efficiencyTone(e);
}

/** Several centres as one — Fabrication is laser / punch, bending and fin
 *  folding together. */
export function combinedStat(stats: readonly CentreStat[]): { workedH: number; earnedH: number; efficiency: number | null } {
  const workedH = stats.reduce((s, c) => s + c.workedH, 0);
  const earnedH = stats.reduce((s, c) => s + c.earnedH, 0);
  return { workedH: round1(workedH), earnedH: round1(earnedH), efficiency: workedH > 0 ? earnedH / workedH : null };
}

// ------------------------------------------------------------------ coverage

export interface CoverageInput {
  item: string;
  /** Pieces cut and not yet welded, over the open orders. */
  pcs: number;
  /** Welding std-hours those pieces are worth. */
  weldH: number;
}

export interface Coverage {
  /** Welding std-hours waiting in front of the welders. */
  wipH: number;
  /** Welding std-hours earned on an average recorded day lately. */
  ratePerDay: number;
  /** wipH ÷ ratePerDay — null while welding has no recent output to divide by. */
  days: number | null;
  band: "short" | "ok" | "heavy" | null;
  byItem: { item: string; pcs: number; weldH: number }[];
}

/** Below a day of work in front of them the welders may wait for parts;
 *  above four, Fabrication is cutting too far ahead (work in progress piling up). */
export const COVERAGE_SHORT = 1;
export const COVERAGE_HEAVY = 4;

export function weldingCoverage(wip: readonly CoverageInput[], recentWeldEarned: readonly number[]): Coverage {
  const wipH = wip.reduce((s, w) => s + w.weldH, 0);
  const worked = recentWeldEarned.filter((h) => h > 0);
  const ratePerDay = worked.length ? worked.reduce((s, h) => s + h, 0) / worked.length : 0;
  const days = ratePerDay > 0 ? wipH / ratePerDay : null;
  return {
    wipH: round1(wipH),
    ratePerDay: round1(ratePerDay),
    days: days === null ? null : round1(days),
    band: days === null ? null : days < COVERAGE_SHORT ? "short" : days > COVERAGE_HEAVY ? "heavy" : "ok",
    byItem: wip.filter((w) => w.pcs > 0).map((w) => ({ item: w.item, pcs: w.pcs, weldH: round1(w.weldH) })).sort((a, b) => b.weldH - a.weldH),
  };
}

// ------------------------------------------------------------------ adherence

export type Stage = "cut" | "weld" | "finish";
export const STAGES: readonly Stage[] = ["cut", "weld", "finish"];
export const STAGE_LABEL: Record<Stage, string> = { cut: "Fabrication", weld: "Welding", finish: "Finishing" };

/** One component of one project on one delivery day of the weekly plan. */
export interface PlanCell {
  dayISO: string;
  bom: string;
  item: string;
  /** Pieces the day asks to be manufactured (N/A, already-promised and outsourced left out). */
  owed: number;
  done: Record<Stage, number>;
}

export interface StageAdherence {
  stage: Stage;
  /** Pieces due at this stage by today. */
  due: number;
  /** Of them, done. */
  done: number;
  /** done ÷ due; null while nothing is due yet. */
  rate: number | null;
}

/** The date a stage owes a delivery day's pieces: the oven date less the
 *  plant's lead days (Settings: Fabrication 4, Welding 1, calendar days). */
export function stageDueISO(dayISO: string, stage: Stage, leads: { cut: number; weld: number }): string {
  const back = stage === "cut" ? leads.cut : stage === "weld" ? leads.weld : 0;
  const d = new Date(`${dayISO}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/** How much of the plan each stage has done of what it owed by today. */
export function planAdherence(cells: readonly PlanCell[], todayISO: string, leads: { cut: number; weld: number }): StageAdherence[] {
  return STAGES.map((stage) => {
    let due = 0;
    let done = 0;
    for (const c of cells) {
      if (c.owed <= 0 || stageDueISO(c.dayISO, stage, leads) > todayISO) continue;
      due += c.owed;
      done += Math.min(c.owed, Math.max(0, c.done[stage]));
    }
    return { stage, due, done, rate: due > 0 ? done / due : null };
  });
}

export interface LateLine {
  dayISO: string;
  bom: string;
  item: string;
  owed: number;
  /** The first stage that is short, and by how many pieces. */
  stage: Stage;
  short: number;
}

/** The plan's lines past their stage date and still short — the earliest
 *  stage that is behind names where the line is stuck. Oldest first. */
export function lateLines(cells: readonly PlanCell[], todayISO: string, leads: { cut: number; weld: number }): LateLine[] {
  const out: LateLine[] = [];
  for (const c of cells) {
    if (c.owed <= 0) continue;
    const stage = STAGES.find((s) => stageDueISO(c.dayISO, s, leads) <= todayISO && c.done[s] < c.owed);
    if (!stage) continue;
    out.push({ dayISO: c.dayISO, bom: c.bom, item: c.item, owed: c.owed, stage, short: c.owed - Math.max(0, c.done[stage]) });
  }
  return out.sort((a, b) => a.dayISO.localeCompare(b.dayISO) || a.bom.localeCompare(b.bom));
}

// ------------------------------------------------------------------ load ahead

export interface LoadDayInput {
  dayISO: string;
  /** Std-hours this centre owes by the end of the day. */
  dueH: number;
}

export type LoadTone = "bad" | "warn" | null;

export interface LoadAhead {
  centre: WorkCentre;
  /** Whether the centre has booked man-hours to measure a capacity from —
   *  without them nothing here can say it is short. */
  measured: boolean;
  days: {
    dayISO: string;
    dueH: number;
    capacityH: number;
    /** Running owed against running capacity at the end of the day: past it, or within 10% of it. */
    tone: LoadTone;
    /** What it owes so far, and could have worked so far (null unmeasured) — the totals the tone is judged on. */
    owedCum: number;
    canCum: number | null;
  }[];
  /** Σ owed ÷ Σ capacity over the horizon (work can be done early). */
  loadRate: number | null;
  /** The most the running total owed gets ahead of the running capacity in the horizon. */
  behindH: number;
  /** The first day the running total owed passes the running capacity. */
  shortFromISO: string | null;
  /** The day the centre has caught up again — null while it never does in the horizon. */
  clearsISO: string | null;
  /** Std-hours owed beyond the horizon's capacity; 0 when it clears. */
  shortH: number;
}

/** Hours owed past what could be worked count from this much on — rounding is not a shortfall. */
const SHORT_EPS = 0.05;

/** The tone a load rate reads in: over the capacity, or within 10% of it. */
export function loadTone(owed: number, can: number): LoadTone {
  // no capacity left at all: anything owed is short
  if (!(can > 0)) return owed > SHORT_EPS ? "bad" : null;
  return owed > can + SHORT_EPS ? "bad" : owed > can * 0.9 ? "warn" : null;
}

/** A centre's plan ahead against what it can do: its capacity a day is the
 *  man-hours it usually has, worked at the pace it has measured — null when
 *  it has no booked hours to measure them from. */
export function loadAhead(centre: WorkCentre, days: readonly string[], due: readonly LoadDayInput[], capacityPerDay: number | null): LoadAhead {
  const byDay = new Map<string, number>();
  for (const d of due) {
    // owed before the horizon is owed now; owed on a Friday or a holiday is
    // owed by the working day after it; owed after the horizon is not its own
    const at = days.find((iso) => iso >= d.dayISO) ?? null;
    if (at === null) continue;
    byDay.set(at, (byDay.get(at) ?? 0) + d.dueH);
  }
  const measured = capacityPerDay !== null;
  const perDay = capacityPerDay ?? 0;
  let owed = 0;
  let can = 0;
  let peak = 0;
  let shortFromISO: string | null = null;
  let clearsISO: string | null = null;
  const rows = days.map((iso) => {
    const dueH = byDay.get(iso) ?? 0;
    owed += dueH;
    can += perDay;
    const tone = measured ? loadTone(owed, can) : null;
    if (measured) {
      const short = tone === "bad";
      peak = Math.max(peak, owed - can);
      if (short && shortFromISO === null) shortFromISO = iso;
      if (short) clearsISO = null;
      else if (shortFromISO !== null && clearsISO === null) clearsISO = iso;
    }
    return { dayISO: iso, dueH: round1(dueH), capacityH: round1(perDay), tone, owedCum: round1(owed), canCum: measured ? round1(can) : null };
  });
  // what is owed after the horizon is not this horizon's to clear
  return {
    centre, measured, days: rows,
    loadRate: can > 0 ? owed / can : null,
    behindH: shortFromISO === null ? 0 : round1(peak),
    shortFromISO, clearsISO,
    shortH: measured ? round1(Math.max(0, owed - can)) : 0,
  };
}

// ------------------------------------------------------------------ manpower

export interface ManpowerInput {
  centre: WorkCentre;
  /** Std-hours the month's plan asks of the centre, outsourced pieces left out. */
  requiredH: number;
  /** Std-hours of that plan the centre has earned — all of it, an order carried over bringing its earlier work. */
  doneH: number;
  /** Of them, earned before the month began. */
  doneBeforeH?: number;
  /** People present on an average recorded day lately; null while none is recorded. */
  present: number | null;
}

export interface ManpowerRow {
  centre: WorkCentre;
  requiredH: number;
  doneH: number;
  /** Of it, earned before the month began (carried-over orders). */
  doneBeforeH: number;
  leftH: number;
  /** People the month's plan needs on an average working day of the month. */
  needed: number | null;
  /** People what is left needs on each remaining working day — null once the month's working days are over. */
  neededNow: number | null;
  present: number | null;
  /** present − neededNow: people to spare (+) or short (−); null while either side is unknown. */
  gap: number | null;
  tone: "ok" | "warn" | "bad" | null;
}

export interface ManpowerCalendar {
  /** Net hours one person works on a day (the day shift less its break). */
  hoursPerPersonDay: number;
  /** Working days in the month, and those left from today (today included). */
  monthWd: number;
  leftWd: number;
}

/** Whether an order is on a month's plan: tagged with the month (the plans it
 *  appeared in, else the one that first brought it) and still open, or closed
 *  within the month — its work was the month's. */
export function inMonthPlan(o: { months: string; source: string | null; status: string; closedDayISO: string | null }, monthLabel: string, monthStartISO: string): boolean {
  const months = (o.months || o.source || "").split(",").map((s) => s.trim());
  if (!months.includes(monthLabel)) return false;
  return o.status === "open" || (o.closedDayISO !== null && o.closedDayISO >= monthStartISO);
}

/** Short by half a person or more is a deficit to act on; a fraction is the rounding of a crew. */
const MANPOWER_SHORT = 0.5;

/** The manpower plan: the month's required standard hours turned into people,
 *  against who comes — the plant's "required vs available manpower" sheet,
 *  read live. The plan's hours are divided over the working days a person
 *  works, so a month with a holiday needs more people a day, not fewer. */
export function manpowerPlan(rows: readonly ManpowerInput[], cal: ManpowerCalendar): ManpowerRow[] {
  const perPersonMonth = cal.hoursPerPersonDay * cal.monthWd;
  const perPersonLeft = cal.hoursPerPersonDay * cal.leftWd;
  return rows.map((r) => {
    const leftH = Math.max(0, r.requiredH - r.doneH);
    const needed = perPersonMonth > 0 ? r.requiredH / perPersonMonth : null;
    const neededNow = perPersonLeft > 0 ? leftH / perPersonLeft : null;
    // judged on the figure shown, so "−0.5" never reads in two colours
    const gap = r.present !== null && neededNow !== null ? round1(r.present - neededNow) : null;
    return {
      centre: r.centre,
      requiredH: round1(r.requiredH),
      doneH: round1(r.doneH),
      doneBeforeH: round1(r.doneBeforeH ?? 0),
      leftH: round1(leftH),
      needed: needed === null ? null : round1(needed),
      neededNow: neededNow === null ? null : round1(neededNow),
      present: r.present,
      gap,
      tone: gap === null ? null : gap <= -MANPOWER_SHORT ? "bad" : gap < 0 ? "warn" : "ok",
    };
  });
}

// ------------------------------------------------------------------ what to do

export type ActionTone = "bad" | "warn" | "info";
export interface CockpitAction {
  tone: ActionTone;
  /** One line that says what is wrong and what it points to. */
  text: string;
  /** Where to act on it. */
  href: string;
  /** Read off the shift log (a centre's pace, a stop, the attendance) — for
   *  the people who see the Shifts screen. */
  floor?: boolean;
}

export const isFloorAction = (a: CockpitAction) => a.floor === true;

export interface ActionInputs {
  late: readonly LateLine[];
  /** All the late lines, when `late` is cut short. */
  lateCount?: number;
  coverage: Coverage;
  load: readonly LoadAhead[];
  centres: readonly CentreStat[];
  topLoss: { label: string; hours: number } | null;
  todayRecorded: boolean;
  ddmm: (iso: string) => string;
  /** The month's manpower plan, when the cockpit has one. */
  manpower?: readonly ManpowerRow[];
}

/** The few things that need a decision today, worst first — each from a
 *  figure the cockpit shows, never more than six. */
export function cockpitActions(i: ActionInputs): CockpitAction[] {
  const out: CockpitAction[] = [];
  if (i.late.length > 0) {
    const first = i.late[0];
    out.push({ tone: "bad", href: trackerHref(0, "weekly", "TR"), text: `${i.lateCount ?? i.late.length} plan line(s) are behind — the oldest, ${first.bom} ${first.item} due ${i.ddmm(first.dayISO)}, is ${first.short} pc short at ${STAGE_LABEL[first.stage]}.` });
  }
  for (const l of i.load) {
    // short at the end of the horizon: the plan does not fit as it stands
    if (l.shortH > 0) out.push({ tone: "bad", href: "/simulate", text: `${WORK_CENTRE_LABEL[l.centre]} owes ${l.shortH} h more than it can work in the next ${l.days.length} working days${l.shortFromISO ? ` (short from ${i.ddmm(l.shortFromISO)})` : ""} — overtime, more people, or move work.` });
  }
  // falling behind in the horizon but catching up in it: one line for all of them, the furthest behind named
  const catching = i.load.filter((l) => l.shortH === 0 && l.shortFromISO && l.clearsISO).sort((a, b) => b.behindH - a.behindH);
  if (catching.length > 0) {
    const top = catching[0];
    out.push({ tone: "warn", href: "/simulate", text: `${catching.map((l) => WORK_CENTRE_LABEL[l.centre]).join(", ")} ${catching.length > 1 ? "are" : "is"} behind — ${WORK_CENTRE_LABEL[top.centre]} by up to ${top.behindH} h from ${i.ddmm(top.shortFromISO!)}, caught up by ${i.ddmm(top.clearsISO!)} at the usual pace.` });
  }
  if (i.coverage.band === "short") {
    const top = i.coverage.byItem[0];
    out.push({ tone: "bad", href: "/worklist/cut", text: `Welding has only ${i.coverage.days} day(s) of cut parts in front of it${top ? ` — cut ${top.item} next` : ""}.` });
  } else if (i.coverage.band === "heavy") {
    out.push({ tone: "warn", href: hrefWithLine("/worklist/welding", "TR"), text: `${i.coverage.days} days of cut parts are waiting for welding — Fabrication is far ahead; welding is the constraint.` });
  }
  // people short of the month's plan: one line for all of them, the shortest named
  const short = (i.manpower ?? []).filter((m) => m.tone === "bad").sort((a, b) => (a.gap ?? 0) - (b.gap ?? 0));
  if (short.length > 0) {
    const top = short[0];
    out.push({ tone: "bad", href: "/shifts", floor: true, text: `${short.map((m) => WORK_CENTRE_LABEL[m.centre]).join(", ")} ${short.length > 1 ? "are" : "is"} short of people for the month's plan — ${WORK_CENTRE_LABEL[top.centre]} needs ${Math.ceil(-(top.gap ?? 0))} more from today to finish it.` });
  }
  for (const c of i.centres) {
    if (c.days >= 3 && efficiencyBand(c.efficiency) === "bad") {
      out.push({ tone: "warn", href: "/shifts", floor: true, text: `${WORK_CENTRE_LABEL[c.centre]} worked at ${Math.round((c.efficiency ?? 0) * 100)}% of the standard over its last ${c.days} recorded days.` });
    }
  }
  if (i.topLoss && i.topLoss.hours > 0) out.push({ tone: "warn", href: "/shifts", floor: true, text: `${i.topLoss.label} cost ${stopDurationLabel(i.topLoss.hours)} of machine time this week — the biggest loss.` });
  if (!i.todayRecorded) out.push({ tone: "info", href: "/shifts", floor: true, text: "Today's attendance is not recorded yet — the hours and the efficiency wait for it." });
  return out.slice(0, 6);
}

// ------------------------------------------------------------------ the trend

/** What a day keeps for the trend (KpiSnapshot.data). */
export interface KpiSnapshotData {
  late: number | null;
  adherence: Partial<Record<Stage, number | null>>;
  coverageDays: number | null;
  efficiency: Partial<Record<WorkCentre, number | null>>;
  /** Laser / punch, bending and fin folding together — null on days kept before it was. */
  fabEfficiency: number | null;
  unplannedH: number | null;
}
export interface KpiSnapshotPoint extends KpiSnapshotData {
  dateISO: string;
}

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const keyed = <K extends string>(v: unknown, keys: readonly K[]): Partial<Record<K, number | null>> => {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, numOrNull(o[k])])) as Partial<Record<K, number | null>>;
};

/** A stored day read back — a field it does not carry (an older shape) reads
 *  as unknown, never as zero. */
export function parseKpiSnapshot(json: unknown): KpiSnapshotData {
  const o = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  return {
    late: numOrNull(o.late),
    adherence: keyed(o.adherence, STAGES),
    coverageDays: numOrNull(o.coverageDays),
    efficiency: keyed(o.efficiency, WORK_CENTRES),
    fabEfficiency: numOrNull(o.fabEfficiency),
    unplannedH: numOrNull(o.unplannedH),
  };
}

/** A figure today against the same figure a week ago — the newest kept day at
 *  least seven days back that knows it. Null while there is none. */
export function weekChange(trend: readonly KpiSnapshotPoint[], todayISO: string, pick: (p: KpiSnapshotData) => number | null | undefined): { now: number; before: number; beforeISO: string } | null {
  const today = trend.find((p) => p.dateISO === todayISO);
  const now = today ? pick(today) : null;
  if (now === null || now === undefined) return null;
  const weekAgo = new Date(`${todayISO}T00:00:00.000Z`);
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
  const limit = weekAgo.toISOString().slice(0, 10);
  for (let i = trend.length - 1; i >= 0; i--) {
    const p = trend[i];
    if (p.dateISO > limit) continue;
    const v = pick(p);
    if (v !== null && v !== undefined) return { now, before: v, beforeISO: p.dateISO };
  }
  return null;
}

// ------------------------------------------------------------------ the charts' series

/** The weekly plan, delivery day by delivery day: pieces asked and finished, each summed from the first day. */
export function burnUp(days: readonly { iso: string; label: string; req: number; covered: number; isToday: boolean }[]): { iso: string; label: string; req: number; covered: number; planCum: number; doneCum: number; isToday: boolean }[] {
  let plan = 0;
  let done = 0;
  return days.map((d) => {
    plan += d.req;
    done += d.covered;
    return { iso: d.iso, label: d.label, req: d.req, covered: d.covered, planCum: plan, doneCum: done, isToday: d.isToday };
  });
}

/** A centre's load ahead as running totals — what it owes so far against what
 *  it could have worked so far, the comparison its "short" is judged on. */
export function loadSeries(l: Pick<LoadAhead, "days">): { dayISO: string; dueH: number; owedCum: number; canCum: number | null; tone: LoadTone }[] {
  // the running totals loadAhead judged the tone on, unrounded until shown
  return l.days.map((d) => ({ dayISO: d.dayISO, dueH: d.dueH, owedCum: d.owedCum, canCum: d.canCum, tone: d.tone }));
}

/** The departments a day's output is told in: Fabrication's three centres as one. */
export const OUTPUT_GROUPS = ["Fabrication", "Welding", "ShotBlast", "Painting"] as const;
export type OutputGroup = (typeof OUTPUT_GROUPS)[number];
export const OUTPUT_GROUP_LABEL: Record<OutputGroup, string> = { Fabrication: "Fabrication", Welding: "Welding", ShotBlast: "Shot blast", Painting: "Painting" };
/** The department a centre's output and people count under — laser / punch,
 *  bending and fin folding are Fabrication. */
export const groupOfCentre = (c: WorkCentre): OutputGroup => ((DEPT_CENTRES.Cut as readonly WorkCentre[]).includes(c) ? "Fabrication" : (c as OutputGroup));

export interface OutputDay extends Record<OutputGroup, number> {
  dateISO: string;
  /** Standard hours earned that day, every centre. */
  earnedH: number;
  /** Man-hours the shift log booked that day, every centre. */
  workedH: number;
  efficiency: number | null;
}

/** Each recorded day's output in standard hours, by department, against the
 *  man-hours booked — the plant's productivity day by day, one unit for all. */
export function dailyOutput(centres: readonly { centre: WorkCentre; trend: readonly { dateISO: string; earnedH: number; workedH: number }[] }[]): OutputDay[] {
  const days = new Map<string, OutputDay>();
  for (const c of centres) {
    for (const t of c.trend) {
      const d = days.get(t.dateISO) ?? { dateISO: t.dateISO, Fabrication: 0, Welding: 0, ShotBlast: 0, Painting: 0, earnedH: 0, workedH: 0, efficiency: null };
      d[groupOfCentre(c.centre)] += t.earnedH;
      d.earnedH += t.earnedH;
      d.workedH += t.workedH;
      days.set(t.dateISO, d);
    }
  }
  return [...days.values()]
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO))
    .map((d) => ({
      ...d,
      Fabrication: round1(d.Fabrication), Welding: round1(d.Welding), ShotBlast: round1(d.ShotBlast), Painting: round1(d.Painting),
      earnedH: round1(d.earnedH), workedH: round1(d.workedH),
      efficiency: d.workedH > 0 ? d.earnedH / d.workedH : null,
    }));
}

export interface MonthPaceRow {
  centre: WorkCentre;
  requiredH: number;
  doneH: number;
  /** done ÷ the month's plan. */
  doneShare: number | null;
  /** The share of the month's working days already behind us — where an even pace would stand today. */
  expectedShare: number;
  /** Hours ahead (+) or behind (−) of that even pace. */
  aheadH: number;
  tone: "ok" | "warn" | "bad" | null;
}

/** Behind the month's even pace by a tenth of its plan or more is a month that will not finish without help. */
const PACE_BEHIND = 0.1;

/** Each centre's month so far against an even pace through its working days:
 *  what it has done of the plan, and where it should stand by today. Work a
 *  carried-over order brought from before the month starts the pace there —
 *  the month owes only the rest, evenly over its working days. */
export function monthPace(rows: readonly (Pick<ManpowerRow, "centre" | "requiredH" | "doneH"> & { doneBeforeH?: number })[], cal: Pick<ManpowerCalendar, "monthWd" | "leftWd">): MonthPaceRow[] {
  const elapsed = cal.monthWd > 0 ? Math.min(1, Math.max(0, (cal.monthWd - cal.leftWd) / cal.monthWd)) : 0;
  return rows.map((r) => {
    if (!(r.requiredH > 0)) return { centre: r.centre, requiredH: 0, doneH: round1(r.doneH), doneShare: null, expectedShare: elapsed, aheadH: 0, tone: null };
    const startShare = Math.min(1, Math.max(0, (r.doneBeforeH ?? 0) / r.requiredH));
    const expectedShare = startShare + (1 - startShare) * elapsed;
    const doneShare = r.doneH / r.requiredH;
    const gap = doneShare - expectedShare;
    return {
      centre: r.centre,
      requiredH: round1(r.requiredH),
      doneH: round1(r.doneH),
      doneShare,
      expectedShare,
      aheadH: round1(r.doneH - r.requiredH * expectedShare),
      tone: gap >= 0 ? "ok" : gap > -PACE_BEHIND ? "warn" : "bad",
    };
  });
}

/** The unplanned stops by cause, most hours first, each with the share of the
 *  loss it and the causes above it account for — where to look first. */
export function paretoOf(causes: readonly { code: string; label: string; hours: number; stops: number; planned: boolean }[]): { code: string; label: string; hours: number; stops: number; share: number; cumShare: number }[] {
  const unplanned = causes.filter((c) => !c.planned && c.hours > 0).sort((a, b) => b.hours - a.hours);
  const total = unplanned.reduce((s, c) => s + c.hours, 0);
  let cum = 0;
  return unplanned.map((c) => {
    cum += c.hours;
    return { code: c.code, label: c.label, hours: c.hours, stops: c.stops, share: total > 0 ? c.hours / total : 0, cumShare: total > 0 ? cum / total : 0 };
  });
}
