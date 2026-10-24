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

/** The most a machine can stand in a day, and the step a stop is kept in. */
export const MAX_STOP_HOURS = 24;
export const STOP_STEP = 0.25;
/** Hours as a stop keeps them: to the quarter hour. */
export const stopHours = (h: number) => Math.round(h / STOP_STEP) * STOP_STEP;

const BY_CODE = new Map<string, (typeof DOWNTIME_REASONS)[number]>(DOWNTIME_REASONS.map((r) => [r.code, r]));

export function isDowntimeCode(x: string): x is DowntimeCode {
  return BY_CODE.has(x);
}

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
  const all = [...acc.entries()].map(([code, v]) => ({ code, ...v, hours: Math.round(v.hours * 10) / 10 }));
  const unplannedH = Math.round(all.filter((c) => !c.planned).reduce((s, c) => s + c.hours, 0) * 10) / 10;
  const plannedH = Math.round(all.filter((c) => c.planned).reduce((s, c) => s + c.hours, 0) * 10) / 10;
  const causes = all
    .map((c) => ({ ...c, share: c.planned ? null : unplannedH > 0 ? c.hours / unplannedH : 0 }))
    .sort((a, b) => Number(a.planned) - Number(b.planned) || b.hours - a.hours);
  return { causes, unplannedH, plannedH };
}
