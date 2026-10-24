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

import { DEPT_CENTRES, WORK_CENTRES, WORK_CENTRE_LABEL, round1, type WorkCentre } from "./shifts";

export type CentreHours = Record<WorkCentre, number>;
export const zeroCentres = (): CentreHours => Object.fromEntries(WORK_CENTRES.map((c) => [c, 0])) as CentreHours;

/** What ONE ledger record earns at each centre. A piece recorded at
 *  Fabrication has passed every centre of its route, so each earns its share;
 *  a Painting record carries the shot blast before it (the app records no
 *  separate blasting for a painted part); a Shot Blast record is the core's
 *  finish. The calibration reads the ledger through this same function. */
export function earnedOfRecord(dept: string, qty: number, perPiece: CentreHours | undefined): CentreHours {
  const out = zeroCentres();
  if (!perPiece || !(qty > 0)) return out;
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

export function addCentres(a: CentreHours, b: CentreHours): CentreHours {
  const out = zeroCentres();
  for (const c of WORK_CENTRES) out[c] = a[c] + b[c];
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

/** A centre over a window of recorded days. Days without worked hours are
 *  not recorded days — they count no efficiency, but their stops still count. */
export function centreStat(centre: WorkCentre, days: readonly CentreDay[]): CentreStat {
  const mine = days.filter((d) => d.centre === centre);
  const worked = mine.filter((d) => d.workedH > 0);
  const workedH = worked.reduce((s, d) => s + d.workedH, 0);
  const earnedH = worked.reduce((s, d) => s + d.earnedH, 0);
  const machineH = worked.reduce((s, d) => s + d.machineH, 0);
  const downtimeH = mine.reduce((s, d) => s + d.downtimeH, 0);
  return {
    centre,
    days: worked.length,
    workedH: round1(workedH),
    earnedH: round1(earnedH),
    efficiency: workedH > 0 ? earnedH / workedH : null,
    downtimeH: round1(downtimeH),
    availability: machineH > 0 ? Math.max(0, 1 - downtimeH / machineH) : null,
    people: worked.length ? round1(worked.reduce((s, d) => s + d.people, 0) / worked.length) : 0,
  };
}

/** The tone an efficiency reads in: at the standard, close to it, or short. */
export function efficiencyBand(e: number | null): "ok" | "warn" | "bad" | null {
  if (e === null) return null;
  return e >= 0.9 ? "ok" : e >= 0.75 ? "warn" : "bad";
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

export interface LoadAhead {
  centre: WorkCentre;
  days: { dayISO: string; dueH: number; capacityH: number }[];
  /** Σ owed ÷ Σ capacity over the horizon (work can be done early). */
  loadRate: number | null;
  /** Std-hours already owed (due today or before) beyond today's capacity. */
  behindH: number;
  /** The first day the running total owed passes the running capacity. */
  shortFromISO: string | null;
  /** The day the centre has caught up again — null while it never does in the horizon. */
  clearsISO: string | null;
  /** Std-hours owed beyond the horizon's capacity; 0 when it clears. */
  shortH: number;
}

/** A centre's plan ahead against what it can do: its capacity a day is the
 *  man-hours it usually has, worked at the pace it has measured. */
export function loadAhead(centre: WorkCentre, days: readonly string[], due: readonly LoadDayInput[], capacityPerDay: number): LoadAhead {
  const byDay = new Map<string, number>();
  for (const d of due) {
    // owed before the horizon is owed now; owed on a Friday or a holiday is
    // owed by the working day after it; owed after the horizon is not its own
    const at = days.find((iso) => iso >= d.dayISO) ?? null;
    if (at === null) continue;
    byDay.set(at, (byDay.get(at) ?? 0) + d.dueH);
  }
  let owed = 0;
  let can = 0;
  let shortFromISO: string | null = null;
  let clearsISO: string | null = null;
  const rows = days.map((iso) => {
    const dueH = byDay.get(iso) ?? 0;
    owed += dueH;
    can += capacityPerDay;
    const short = owed > can + 0.05;
    if (short && shortFromISO === null) shortFromISO = iso;
    if (short) clearsISO = null;
    else if (shortFromISO !== null && clearsISO === null) clearsISO = iso;
    return { dayISO: iso, dueH: round1(dueH), capacityH: round1(capacityPerDay) };
  });
  const behindH = days.length ? round1(Math.max(0, (byDay.get(days[0]) ?? 0) - capacityPerDay)) : 0;
  // what is owed after the horizon is not this horizon's to clear
  return { centre, days: rows, loadRate: can > 0 ? owed / can : null, behindH, shortFromISO, clearsISO, shortH: round1(Math.max(0, owed - can)) };
}

// ------------------------------------------------------------------ what to do

export type ActionTone = "bad" | "warn" | "info";
export interface CockpitAction {
  tone: ActionTone;
  /** One line that says what is wrong and what it points to. */
  text: string;
  /** Where to act on it. */
  href: string;
}

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
}

const STAGE_WORD: Record<Stage, string> = { cut: "Fabrication", weld: "Welding", finish: "finishing" };

/** The few things that need a decision today, worst first — each from a
 *  figure the cockpit shows, never more than six. */
export function cockpitActions(i: ActionInputs): CockpitAction[] {
  const out: CockpitAction[] = [];
  if (i.late.length > 0) {
    const first = i.late[0];
    out.push({ tone: "bad", href: "/tracker?view=weekly", text: `${i.lateCount ?? i.late.length} plan line(s) are behind — the oldest, ${first.bom} ${first.item} due ${i.ddmm(first.dayISO)}, is ${first.short} pc short at ${STAGE_WORD[first.stage]}.` });
  }
  for (const l of i.load) {
    // short at the end of the horizon: the plan does not fit as it stands
    if (l.shortH > 0) out.push({ tone: "bad", href: "/simulate", text: `${WORK_CENTRE_LABEL[l.centre]} owes ${l.shortH} h more than it can work in the next ${l.days.length} working days${l.shortFromISO ? ` (short from ${i.ddmm(l.shortFromISO)})` : ""} — overtime, more people, or move work.` });
  }
  // behind now but catching up: one line for all of them, the slowest named
  const catching = i.load.filter((l) => l.shortH === 0 && l.behindH > 0 && l.clearsISO).sort((a, b) => b.behindH - a.behindH);
  if (catching.length > 0) {
    const top = catching[0];
    out.push({ tone: "warn", href: "/simulate", text: `${catching.map((l) => WORK_CENTRE_LABEL[l.centre]).join(", ")} ${catching.length > 1 ? "are" : "is"} behind — ${WORK_CENTRE_LABEL[top.centre]} by ${top.behindH} h, caught up by ${i.ddmm(top.clearsISO!)} at the usual pace.` });
  }
  if (i.coverage.band === "short") {
    const top = i.coverage.byItem[0];
    out.push({ tone: "bad", href: "/worklist/cut", text: `Welding has only ${i.coverage.days} day(s) of cut parts in front of it${top ? ` — cut ${top.item} next` : ""}.` });
  } else if (i.coverage.band === "heavy") {
    out.push({ tone: "warn", href: "/worklist/welding", text: `${i.coverage.days} days of cut parts are waiting for welding — Fabrication is far ahead; welding is the constraint.` });
  }
  for (const c of i.centres) {
    if (c.days >= 3 && efficiencyBand(c.efficiency) === "bad") {
      out.push({ tone: "warn", href: "/shifts", text: `${WORK_CENTRE_LABEL[c.centre]} worked at ${Math.round((c.efficiency ?? 0) * 100)}% of the standard over its last ${c.days} recorded days.` });
    }
  }
  if (i.topLoss && i.topLoss.hours > 0) out.push({ tone: "warn", href: "/shifts", text: `${i.topLoss.label} cost ${i.topLoss.hours} machine hours this week — the biggest loss.` });
  if (!i.todayRecorded) out.push({ tone: "info", href: "/shifts", text: "Today's attendance is not recorded yet — the hours and the efficiency wait for it." });
  return out.slice(0, 6);
}
