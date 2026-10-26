// "Needs intervention in production" — the Production dashboard's short
// list, each line from a figure the page shows and opening the screen to act
// on it. Pure, so the rules are tested; the server reads the period
// (lib/server/kpis.ts, lib/server/lvKpis.ts) and hands it here. Plain
// arithmetic over recorded figures: a missing record is a data gap to close,
// never a bad day for the people.

import { efficiencyBand, type CockpitAction } from "./kpis";
import { stopDurationLabel } from "./downtime";
import { formatDate } from "./format";

export interface OpenStopView {
  machine: string;
  dept: string;
  cause: string;
  /** Hours stopped so far. */
  hours: number;
  sinceISO: string;
}

export interface DeptPaceView {
  label: string;
  days: number;
  efficiency: number | null;
  /** Share of its pieces that carry standard hours; null without pieces. */
  pricedShare?: number | null;
}

/** A recorded day whose two records disagree: output with no hours booked,
 *  or hours booked with no output on the Daily log. */
export interface GapDay {
  dateISO: string;
  kind: "output-no-hours" | "hours-no-output";
}

/** The days whose two records disagree, oldest first — the Daily log's
 *  output (pieces or panels moved: recorded quantity, never earned hours, so
 *  an unpriced piece is still output) against the man-hours the shift log
 *  booked. Today is still being written, so it is never judged. */
export function gapDays(output: readonly { dateISO: string; qty: number }[], hours: readonly { dateISO: string; workedH: number }[], todayISO: string): GapDay[] {
  const byDate = new Map<string, { hasOutput: boolean; workedH: number }>();
  const at = (iso: string) => {
    if (!byDate.has(iso)) byDate.set(iso, { hasOutput: false, workedH: 0 });
    return byDate.get(iso)!;
  };
  for (const o of output) if (o.qty > 0) at(o.dateISO).hasOutput = true;
  for (const h of hours) at(h.dateISO).workedH += h.workedH;
  return [...byDate.entries()]
    .filter(([iso]) => iso < todayISO)
    .flatMap(([dateISO, v]): GapDay[] => (v.hasOutput && !(v.workedH > 0) ? [{ dateISO, kind: "output-no-hours" }] : v.workedH > 0 && !v.hasOutput ? [{ dateISO, kind: "hours-no-output" }] : []))
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO));
}

export interface ProductionActionInputs {
  openStops: readonly OpenStopView[];
  depts: readonly DeptPaceView[];
  gapDays: readonly GapDay[];
  /** Open returns, and those on urgent orders. */
  returns?: { open: number; onUrgent: number };
  /** Tanks waiting for a repair after a failed leak test. */
  tanksInRepair?: number;
  /** Share of the period's pieces that carry standard hours. */
  pricedShare: number | null;
  /** Where each kind of thing is acted on. */
  hrefs: { stops: string; shifts: string; returns?: string; repair?: string; standardTimes: string; dailyLog: string };
  /** Recorded days under which an efficiency is not judged. */
  minDays?: number;
}

/** The few things to act on in production, worst first — never more than six. */
export function productionActions(i: ProductionActionInputs): CockpitAction[] {
  const out: CockpitAction[] = [];
  const minDays = i.minDays ?? 3;
  const ddmm = formatDate;
  const stops = [...i.openStops].sort((a, b) => b.hours - a.hours);
  if (stops.length > 0) {
    const s = stops[0];
    out.push({ tone: "bad", href: i.hrefs.stops, floor: true, text: `${stops.length} machine${stops.length === 1 ? " is" : "s are"} still stopped — ${s.machine} (${s.dept}) since ${ddmm(s.sinceISO)}, ${stopDurationLabel(s.hours)} so far: ${s.cause}.` });
  }
  if (i.returns && i.returns.onUrgent > 0) {
    out.push({ tone: "bad", href: i.hrefs.returns ?? i.hrefs.dailyLog, text: `${i.returns.onUrgent} return${i.returns.onUrgent === 1 ? "" : "s"} on urgent orders ${i.returns.onUrgent === 1 ? "is" : "are"} still open — pieces sent back and not re-delivered.` });
  }
  for (const d of i.depts) {
    // judged only on enough days, and only when its output is priced — an unpriced piece reads as slow
    if (d.days >= minDays && efficiencyBand(d.efficiency) === "bad" && (d.pricedShare ?? 1) >= 0.8) {
      out.push({ tone: "warn", href: i.hrefs.shifts, floor: true, text: `${d.label} worked at ${Math.round((d.efficiency ?? 0) * 100)}% of the standard over ${d.days} recorded days — ask why before the week ends.` });
    }
  }
  if (i.tanksInRepair && i.tanksInRepair > 0) out.push({ tone: "warn", href: i.hrefs.repair ?? i.hrefs.dailyLog, text: `${i.tanksInRepair} tank${i.tanksInRepair === 1 ? "" : "s"} failed the leak test and wait${i.tanksInRepair === 1 ? "s" : ""} for a repair.` });
  if (i.returns && i.returns.open > 0 && !(i.returns.onUrgent > 0)) out.push({ tone: "warn", href: i.hrefs.returns ?? i.hrefs.dailyLog, text: `${i.returns.open} return${i.returns.open === 1 ? "" : "s"} still open — pieces sent back and not yet re-delivered.` });
  const noHours = i.gapDays.filter((g) => g.kind === "output-no-hours");
  const noOutput = i.gapDays.filter((g) => g.kind === "hours-no-output");
  if (noHours.length > 0) out.push({ tone: "info", href: i.hrefs.shifts, floor: true, text: `${noHours.length} day${noHours.length === 1 ? "" : "s"} with output but no attendance recorded (${noHours.slice(0, 3).map((g) => ddmm(g.dateISO)).join(", ")}${noHours.length > 3 ? ", …" : ""}) — the efficiency of those days cannot be read.` });
  if (noOutput.length > 0) out.push({ tone: "info", href: i.hrefs.dailyLog, floor: true, text: `${noOutput.length} day${noOutput.length === 1 ? "" : "s"} with hours booked but nothing on the Daily log (${noOutput.slice(0, 3).map((g) => ddmm(g.dateISO)).join(", ")}${noOutput.length > 3 ? ", …" : ""}) — unrecorded output, or a day that stood still.` });
  if (i.pricedShare !== null && i.pricedShare < 0.8) out.push({ tone: "info", href: i.hrefs.standardTimes, text: `Only ${Math.round(i.pricedShare * 100)}% of the period's pieces carry standard hours — the rest earns nothing and the efficiency reads low.` });
  return out.slice(0, 6);
}
