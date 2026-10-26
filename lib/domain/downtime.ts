// Why a machine stood still — the plant's codes, so the stops can be counted
// by cause (a Pareto) and planned maintenance kept apart from breakdowns.
// Pure; the shift log records them and counts them by cause.

export const DOWNTIME_REASONS = [
  { code: "MECH", label: "Breakdown — mechanical", planned: false },
  { code: "ELEC", label: "Breakdown — electrical", planned: false },
  { code: "MATERIAL", label: "No material", planned: false },
  { code: "OPERATOR", label: "No operator", planned: false },
  { code: "PROGRAM", label: "No drawing / program", planned: false },
  { code: "SETUP", label: "Setup / changeover", planned: false },
  { code: "QUALITY", label: "Quality problem", planned: false },
  { code: "POWER", label: "Power or air cut", planned: false },
  { code: "PM", label: "Planned maintenance", planned: true },
  { code: "OTHER", label: "Other", planned: false },
] as const;
export type DowntimeCode = (typeof DOWNTIME_REASONS)[number]["code"];

/** The most a machine can stand in a day; quarter-hour step for legacy hours-only inputs. */
export const MAX_STOP_HOURS = 24;
export const STOP_STEP = 0.25;
/** Legacy duration-only input; clock ranges use stopTiming and keep minute precision. */
export const stopHours = (h: number) => Math.round(h / STOP_STEP) * STOP_STEP;

export function clockMinutes(time: string): number | null {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/** Minute-accurate factory clock duration, up to one day. Equal times need an explicit next-day end. */
export function stopTiming(startTime: string, endTime: string, endsNextDay = endTime < startTime) {
  const start = clockMinutes(startTime), end = clockMinutes(endTime);
  if (start === null || end === null) return null;
  const minutes = end + (endsNextDay ? 1440 : 0) - start;
  if (minutes <= 0 || minutes > 1440) return null;
  return { startTime, endTime, endsNextDay, minutes, hours: minutes / 60 };
}

export function stopDurationLabel(hours: number): string {
  const minutes = Math.round(hours * 60), h = Math.floor(minutes / 60), m = minutes % 60;
  return [h ? `${h} h` : "", m ? `${m} min` : ""].filter(Boolean).join(" ") || "0 min";
}

/** A named custom asset's department is deliberately separate from the machine registry. */
export function downtimeScope(depts: readonly string[]) {
  return { OR: [{ machine: { dept: { in: [...depts] } } }, { machineId: null, customDept: { in: [...depts] } }] };
}

const BY_CODE = new Map<string, (typeof DOWNTIME_REASONS)[number]>(DOWNTIME_REASONS.map((r) => [r.code, r]));

export function isDowntimeCode(x: string): x is DowntimeCode {
  return BY_CODE.has(x);
}

/** Whether a stop's code is planned maintenance — a row typed before the codes is not. */
export function isPlannedCode(code: string | null | undefined): boolean {
  return !!code && (BY_CODE.get(code)?.planned ?? false);
}

/** Hours to the minute — the precision a clock range is entered with. */
export const minuteHours = (hours: number) => Math.round(hours * 60) / 60;

/** How a stop reads: its code's label, or the words of a row typed before the codes. */
export function downtimeLabel(code: string | null | undefined, reason?: string | null): string {
  const r = code ? BY_CODE.get(code) : undefined;
  return r ? r.label : reason?.trim() || "Not given";
}

export interface DowntimeRow {
  reasonCode: string | null;
  reason?: string | null;
  hours: number;
}

export interface DowntimeCause {
  code: string;
  label: string;
  hours: number;
  stops: number;
  /** Share of the unplanned hours, 0–1; null for planned maintenance. */
  share: number | null;
  planned: boolean;
}

/** The stops by cause, most hours first — unplanned first, planned
 *  maintenance last and outside the shares, since it is not a loss to chase. */
export function downtimeByCause(rows: readonly DowntimeRow[]): { causes: DowntimeCause[]; unplannedH: number; plannedH: number } {
  const acc = new Map<string, { hours: number; stops: number; label: string; planned: boolean }>();
  for (const r of rows) {
    if (!(r.hours > 0)) continue;
    const known = r.reasonCode ? BY_CODE.get(r.reasonCode) : undefined;
    const code = known ? known.code : "UNCODED";
    const cur = acc.get(code) ?? { hours: 0, stops: 0, label: known ? known.label : "Not coded", planned: known?.planned ?? false };
    cur.hours += r.hours;
    cur.stops += 1;
    acc.set(code, cur);
  }
  const all = [...acc.entries()].map(([code, v]) => ({ code, ...v, hours: minuteHours(v.hours) }));
  const unplannedH = minuteHours(all.filter((c) => !c.planned).reduce((s, c) => s + c.hours, 0));
  const plannedH = minuteHours(all.filter((c) => c.planned).reduce((s, c) => s + c.hours, 0));
  const causes = all
    .map((c) => ({ ...c, share: c.planned ? null : unplannedH > 0 ? c.hours / unplannedH : 0 }))
    .sort((a, b) => Number(a.planned) - Number(b.planned) || b.hours - a.hours);
  return { causes, unplannedH, plannedH };
}

// ---------------------------------------------------------------- by machine

export interface MachineStopRow {
  machine: string;
  dept: string;
  hours: number;
  /** Planned maintenance (by its code) is kept apart from the ranking of losses. */
  reasonCode: string | null;
}

export interface MachineStopRank {
  machine: string;
  dept: string;
  hours: number;
  stops: number;
  /** Share of the unplanned hours ranked. */
  share: number;
}

/** The machines that stood still the most — unplanned stops only, most
 *  hours first, the top `top`. A machine shared by the two lines is one
 *  machine here: a stop is recorded on the machine, never on a line. */
export function stopsByMachine(rows: readonly MachineStopRow[], top = 5): MachineStopRank[] {
  const acc = new Map<string, MachineStopRank>();
  for (const r of rows) {
    if (isPlannedCode(r.reasonCode) || !(r.hours > 0)) continue;
    const k = `${r.dept}|${r.machine}`;
    const cur = acc.get(k) ?? { machine: r.machine, dept: r.dept, hours: 0, stops: 0, share: 0 };
    cur.hours += r.hours;
    cur.stops += 1;
    acc.set(k, cur);
  }
  const all = [...acc.values()];
  const total = all.reduce((s, m) => s + m.hours, 0);
  return all
    .map((m) => ({ ...m, hours: minuteHours(m.hours), share: total > 0 ? m.hours / total : 0 }))
    .sort((a, b) => b.hours - a.hours || a.machine.localeCompare(b.machine))
    .slice(0, top);
}
