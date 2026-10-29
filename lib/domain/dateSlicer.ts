// The date slicer's arithmetic — pure, shared by every page that filters by
// date, so "Last 7 days" means the same seven days everywhere.

const DAY_MS = 86_400_000;
// fixed names, not the locale's — the server and the browser must print the same text
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

export function addDaysISO(iso: string, n: number): string {
  return new Date(ms(iso) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Days from `a` to `b` (b − a); 0 for the same day. */
export function daysBetweenISO(a: string, b: string): number {
  return Math.round((ms(b) - ms(a)) / DAY_MS);
}

export const clampISO = (iso: string, min: string, max: string) => (iso < min ? min : iso > max ? max : iso);

/** The Saturday a day's work week started on — the plant's week. */
export function weekStartISO(iso: string): string {
  const dow = new Date(ms(iso)).getUTCDay(); // 6 = Saturday
  return addDaysISO(iso, -((dow + 1) % 7));
}

/** The quick filters a page may offer. The plant's work week starts on Saturday. */
export type PresetKey =
  | "today" | "yesterday" | "last3" | "last7" | "thisWeek" | "last14" | "thisMonth" | "lastMonth" | "last30" | "last90"
  | "next7" | "next30" | "overdue";

export const PRESET_LABEL: Record<PresetKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last3: "Last 3 days",
  last7: "Last 7 days",
  thisWeek: "This week",
  last14: "Last 14 days",
  thisMonth: "This month",
  lastMonth: "Last month",
  last30: "Last 30 days",
  last90: "Last 90 days",
  next7: "Next 7 days",
  next30: "Next 30 days",
  overdue: "Overdue",
};

export interface SlicerPreset { key: string; label: string; from: string; to: string }

/** A quick filter's days. `min` is the start of the data, for "Overdue". */
export function presetRange(key: PresetKey, todayISO: string, min: string = addDaysISO(todayISO, -365)): { from: string; to: string } {
  const monthStart = `${todayISO.slice(0, 7)}-01`;
  switch (key) {
    case "today": return { from: todayISO, to: todayISO };
    case "yesterday": { const y = addDaysISO(todayISO, -1); return { from: y, to: y }; }
    case "last3": return { from: addDaysISO(todayISO, -2), to: todayISO };
    case "last7": return { from: addDaysISO(todayISO, -6), to: todayISO };
    case "last14": return { from: addDaysISO(todayISO, -13), to: todayISO };
    case "thisWeek": return { from: weekStartISO(todayISO), to: todayISO };
    case "thisMonth": return { from: monthStart, to: todayISO };
    case "lastMonth": { const end = addDaysISO(monthStart, -1); return { from: `${end.slice(0, 7)}-01`, to: end }; }
    case "last30": return { from: addDaysISO(todayISO, -29), to: todayISO };
    case "last90": return { from: addDaysISO(todayISO, -89), to: todayISO };
    case "next7": return { from: todayISO, to: addDaysISO(todayISO, 6) };
    case "next30": return { from: todayISO, to: addDaysISO(todayISO, 29) };
    case "overdue": return { from: min, to: addDaysISO(todayISO, -1) };
  }
}

export function slicerPresets(keys: readonly PresetKey[], todayISO: string, min?: string): SlicerPreset[] {
  return keys.map((key) => ({ key, label: PRESET_LABEL[key], ...presetRange(key, todayISO, min) }));
}

/** The labels along the strip: the first of every month, or — on a strip of
 *  six weeks or less — every Saturday, the start of the work week. */
export function slicerTicks(min: string, max: string): { iso: string; label: string; pos: number }[] {
  const span = daysBetweenISO(min, max);
  if (span <= 0) return [];
  const out: { iso: string; label: string; pos: number }[] = [];
  const short = span <= 42;
  for (let d = min; d <= max; d = addDaysISO(d, 1)) {
    const date = new Date(ms(d));
    const hit = short ? date.getUTCDay() === 6 : date.getUTCDate() === 1;
    if (!hit) continue;
    const label = short
      ? `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`
      : MONTHS[date.getUTCMonth()] + (date.getUTCMonth() === 0 ? ` ${date.getUTCFullYear()}` : "");
    out.push({ iso: d, label, pos: daysBetweenISO(min, d) / span });
  }
  return out;
}

/** The strip's labels that fit side by side on a strip `width` px wide: a
 *  label is dropped when it would touch the one before it or run past an end
 *  of the strip (a phone's strip has room for about one month in two over a
 *  year). A label that names its year ("Jan 2026") wins over a plain month
 *  in its way, so the strip never loses the year. Widths are estimated from
 *  the 11px label font. */
export function fitSlicerTicks<T extends { label: string; pos: number }>(ticks: readonly T[], width: number): T[] {
  if (!(width > 0)) return [...ticks];
  const GAP = 8;
  const EDGE = 12; // the room the strip has past its ends (its card's padding)
  const span = (t: T) => {
    const w = t.label.length * 6.4;
    const left = t.pos * width - w / 2;
    return { left, right: left + w };
  };
  const hasYear = (t: T) => / \d{4}$/.test(t.label);
  const out: T[] = [];
  for (const t of ticks) {
    const { left, right } = span(t);
    if (left < -EDGE || right > width + EDGE) continue;
    const last = out[out.length - 1];
    if (!last || left >= span(last).right + GAP) { out.push(t); continue; }
    // in the way of the one before: a year beats a plain month
    if (hasYear(t) && !hasYear(last)) {
      out.pop();
      const prev = out[out.length - 1];
      if (!prev || left >= span(prev).right + GAP) out.push(t);
    }
  }
  return out;
}

/** "Sun 21 Sep" — how one day reads on the slicer. */
export function slicerDayLabel(iso: string): string {
  const d = new Date(ms(iso));
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "Sun 21 Sep → Sat 27 Sep · 7 days", or the one day. */
export function slicerRangeLabel(from: string, to: string): string {
  if (from === to) return slicerDayLabel(from);
  const n = daysBetweenISO(from, to) + 1;
  return `${slicerDayLabel(from)} → ${slicerDayLabel(to)} · ${n} days`;
}
