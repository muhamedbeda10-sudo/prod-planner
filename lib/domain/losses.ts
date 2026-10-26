// Where the hours went — a centre's (or the floor's) rostered man-hours over
// a stretch of days, walked down to the standard hours it earned: what
// absence took, what overtime added, what the machine stops idled, and what
// is left — work slower than the standard, or work not on the Daily log.
// And, set against the stretch before, which of those moved the efficiency.
// Pure: the server reads the days (lib/server/kpis.ts) and hands them here.

import { DOWNTIME_REASONS, type DowntimeCode } from "./downtime";
import { WORK_CENTRE_LABEL, round1, type WorkCentre } from "./shifts";

/** The stretches the waterfall is read over, in calendar days up to today. */
export const LOSS_DAYS = [7, 14, 30] as const;

/** One recorded day at one centre, as the waterfall needs it. */
export interface LossDay {
  dateISO: string;
  centre: WorkCentre;
  /** Hours worked by those present, overtime included. */
  workedH: number;
  /** The shift hours of those set absent. */
  absentH: number;
  overtimeH: number;
  /** Standard hours earned by the Daily log. */
  earnedH: number;
  /** The centre's machine hours that day. */
  machineH: number;
  /** Machine hours stopped, by reason code. */
  stops: Partial<Record<DowntimeCode, number>>;
}

export interface StopLoss {
  code: DowntimeCode;
  label: string;
  planned: boolean;
  /** Machine hours stopped. */
  machineH: number;
  /** The man-hours those stops idled. */
  manH: number;
}

export interface LossStep {
  key: "rostered" | "absence" | "overtime" | "worked" | "stops" | "performance" | "earned";
  label: string;
  /** A total stands on its own; a step adds (+) or takes (−) from the one before. */
  total: boolean;
  hours: number;
}

export interface LossWaterfall {
  centre: WorkCentre | null;
  /** Recorded days in it (with hours worked). */
  days: number;
  rosteredH: number;
  absentH: number;
  overtimeH: number;
  workedH: number;
  stopsH: number;
  stops: StopLoss[];
  /** Worked − stops − earned: slower than the standard, or work not logged. Negative: faster than it. */
  performanceH: number;
  earnedH: number;
  /** earned ÷ worked; null without hours worked. */
  efficiency: number | null;
  steps: LossStep[];
}

const LABEL_OF = new Map<string, { label: string; planned: boolean }>(DOWNTIME_REASONS.map((r) => [r.code, { label: r.label, planned: r.planned }]));

/** The man-hours a machine-hour stopped idles at a centre on a day: its
 *  people's hours against its machines' — one for one where it keeps no
 *  machine hours. */
function crewRatio(d: LossDay): number {
  return d.machineH > 0 ? d.workedH / d.machineH : 1;
}

/** The waterfall over these days — one centre's, or every centre's (null). */
export function lossWaterfall(all: readonly LossDay[], centre: WorkCentre | null): LossWaterfall {
  const days = all.filter((d) => (centre === null || d.centre === centre) && (d.workedH > 0 || d.absentH > 0));
  let workedH = 0, absentH = 0, overtimeH = 0, earnedH = 0, stopsH = 0;
  const byCode = new Map<DowntimeCode, { machineH: number; manH: number }>();
  for (const d of days) {
    absentH += d.absentH;
    // a day nobody worked earns nothing here (as the Cockpit counts it): its absence only
    if (d.workedH <= 0) continue;
    workedH += d.workedH;
    overtimeH += d.overtimeH;
    earnedH += d.earnedH;
    // a day's stops never idle more than the hours it did not earn
    const ratio = crewRatio(d);
    const machine = Object.values(d.stops).reduce((s, h) => s + (h ?? 0), 0);
    const raw = machine * ratio;
    const room = Math.max(0, d.workedH - d.earnedH);
    const scale = raw > room && raw > 0 ? room / raw : 1;
    for (const [code, h] of Object.entries(d.stops) as [DowntimeCode, number][]) {
      if (!h) continue;
      const e = byCode.get(code) ?? { machineH: 0, manH: 0 };
      e.machineH += h;
      e.manH += h * ratio * scale;
      byCode.set(code, e);
      stopsH += h * ratio * scale;
    }
  }
  const rosteredH = workedH - overtimeH + absentH;
  const performanceH = workedH - stopsH - earnedH;
  const stops = [...byCode].map(([code, v]) => ({ code, label: LABEL_OF.get(code)?.label ?? code, planned: LABEL_OF.get(code)?.planned ?? false, machineH: round1(v.machineH), manH: round1(v.manH) }))
    .sort((a, b) => b.manH - a.manH);
  const steps: LossStep[] = [
    { key: "rostered", label: "Rostered", total: true, hours: round1(rosteredH) },
    { key: "absence", label: "Absence", total: false, hours: -round1(absentH) },
    { key: "overtime", label: "Overtime", total: false, hours: round1(overtimeH) },
    { key: "worked", label: "Worked", total: true, hours: round1(workedH) },
    { key: "stops", label: "Machine stops", total: false, hours: -round1(stopsH) },
    { key: "performance", label: performanceH >= 0 ? "Slower than standard / not logged" : "Faster than standard", total: false, hours: -round1(performanceH) },
    { key: "earned", label: "Earned (standard)", total: true, hours: round1(earnedH) },
  ];
  return {
    centre,
    days: days.filter((d) => d.workedH > 0).length,
    rosteredH: round1(rosteredH), absentH: round1(absentH), overtimeH: round1(overtimeH), workedH: round1(workedH),
    stopsH: round1(stopsH), stops, performanceH: round1(performanceH), earnedH: round1(earnedH),
    efficiency: workedH > 0 ? earnedH / workedH : null,
    steps,
  };
}

/** What moved the efficiency between two stretches: each loss as a share of
 *  the hours worked, then against now — in points of efficiency. */
export interface LossDriver {
  key: "stops" | "performance" | "absence";
  label: string;
  /** Points of efficiency it cost (+) or gave back (−) against the stretch before. */
  points: number;
}

export interface LossChange {
  before: number | null;
  now: number | null;
  /** Efficiency points, now − before. */
  change: number | null;
  drivers: LossDriver[];
  /** One sentence: what moved it most. */
  text: string;
}

const pts = (x: number) => Math.round(x * 1000) / 10;

/** Why the efficiency moved from one stretch to the next. Stops and the
 *  performance gap are shares of the hours worked (they decide the
 *  efficiency); absence, a share of the rostered hours, is shown beside them —
 *  it costs hours, not efficiency. */
export function explainChange(before: LossWaterfall, now: LossWaterfall): LossChange {
  const name = now.centre ? WORK_CENTRE_LABEL[now.centre] : "The floor";
  if (now.efficiency === null || before.efficiency === null || before.workedH <= 0 || now.workedH <= 0) {
    return { before: before.efficiency, now: now.efficiency, change: null, drivers: [], text: `${name} has too few recorded days to compare with the stretch before.` };
  }
  const share = (w: LossWaterfall, h: number) => h / w.workedH;
  const absShare = (w: LossWaterfall) => (w.rosteredH > 0 ? w.absentH / w.rosteredH : 0);
  const drivers: LossDriver[] = [
    { key: "stops", label: "Machine stops", points: pts(share(now, now.stopsH) - share(before, before.stopsH)) },
    { key: "performance", label: "Slower than standard / not logged", points: pts(share(now, now.performanceH) - share(before, before.performanceH)) },
    { key: "absence", label: "Absence", points: pts(absShare(now) - absShare(before)) },
  ];
  const change = pts(now.efficiency - before.efficiency);
  const effDrivers = drivers.filter((d) => d.key !== "absence");
  const top = [...effDrivers].sort((a, b) => b.points - a.points)[0];
  const stopTop = now.stops[0];
  let text: string;
  if (Math.abs(change) < 1) text = `${name} held its efficiency (${pct(now.efficiency)}, ${signed(change)} pts).`;
  else if (change < 0) {
    const why = top.points > 0 ? `${top.label.toLowerCase()} took ${top.points} pts more of the hours worked${top.key === "stops" && stopTop ? ` — most of it ${stopTop.label.toLowerCase()} (${stopTop.manH} man-h)` : ""}` : "no single loss grew — the output logged fell";
    text = `${name} fell from ${pct(before.efficiency)} to ${pct(now.efficiency)} (${signed(change)} pts): ${why}.`;
  } else {
    const best = [...effDrivers].sort((a, b) => a.points - b.points)[0];
    text = `${name} rose from ${pct(before.efficiency)} to ${pct(now.efficiency)} (${signed(change)} pts)${best.points < 0 ? `: ${best.label.toLowerCase()} took ${Math.abs(best.points)} pts less` : ""}.`;
  }
  const abs = drivers[2];
  if (Math.abs(abs.points) >= 2) text += ` Absence ${abs.points > 0 ? "rose" : "fell"} by ${Math.abs(abs.points)} pts of the rostered hours.`;
  return { before: before.efficiency, now: now.efficiency, change, drivers, text };
}

const pct = (e: number) => `${Math.round(e * 100)}%`;
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n)}`;

/** The biggest loss in a waterfall, said plainly — where to look first. */
export function biggestLoss(w: LossWaterfall): string | null {
  if (w.workedH <= 0) return null;
  const name = w.centre ? WORK_CENTRE_LABEL[w.centre] : "The floor";
  const cand = [
    { label: "absence", h: w.absentH },
    { label: w.stops[0] ? `machine stops — most of it ${w.stops[0].label.toLowerCase()}` : "machine stops", h: w.stopsH },
    { label: "work slower than the standard or not on the Daily log", h: Math.max(0, w.performanceH) },
  ].sort((a, b) => b.h - a.h)[0];
  if (cand.h <= 0) return `${name} earned all the hours it worked.`;
  const of = w.rosteredH > 0 ? Math.round((cand.h / w.rosteredH) * 100) : 0;
  return `${name}'s biggest loss is ${cand.label}: ${round1(cand.h)} man-h, ${of}% of the rostered hours.`;
}
