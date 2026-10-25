// The plant's watchdog — pure: what it looks for each working morning, and
// the report it writes. No AI in the finding: plain arithmetic over the
// app's own figures, so it costs nothing and says the same thing twice.
//
//   late      an open order whose forecast finish (lib/server/eta.ts) lands
//             after its delivery day — or one due soon that cannot be
//             forecast at all, because a stage it needs made nothing lately;
//   output    a stage whose earned standard hours on the last working day
//             fell well below its own recent median;
//   absence   a department whose share of absent workers on its last
//             recorded day is high and above its own usual, and the workers
//             absent on most of their recent days.
//
// Each finding has a key that stays the same for the same problem on the
// same day, so a re-run never says it twice.

export const WATCH_KINDS = ["late", "output", "absence"] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];
export const WATCH_KIND_LABEL: Record<WatchKind, string> = { late: "Orders heading late", output: "Output below its usual", absence: "Absence" };

export type WatchSeverity = "critical" | "warn";

export interface WatchFindingDraft {
  key: string;
  kind: WatchKind;
  severity: WatchSeverity;
  title: string;
  detail: string;
  /** The order it is about, for a task. */
  mo?: string;
}

export interface WatchOptions {
  /** A stage's day this far (%) under its median is a drop. */
  dropPct: number;
  /** A department's day with this share (%) absent is high. */
  absencePct: number;
  /** A worker absent this many of their last `chronicOf` recorded days. */
  chronicDays: number;
  chronicOf: number;
  /** Days late before an order is reported. */
  lateMinDays: number;
}

export const WATCH_DEFAULTS: WatchOptions = { dropPct: 30, absencePct: 15, chronicDays: 3, chronicOf: 5, lateMinDays: 1 };

export const WATCH_RANGES = {
  dropPct: { min: 10, max: 90 },
  absencePct: { min: 5, max: 80 },
  chronicDays: { min: 2, max: 10 },
  chronicOf: { min: 3, max: 15 },
  lateMinDays: { min: 1, max: 30 },
} as const;

/** The owner's settings, each held to its range. */
export function cleanWatchOptions(raw: Partial<Record<keyof WatchOptions, unknown>>): WatchOptions | { error: string } {
  const out = { ...WATCH_DEFAULTS };
  for (const k of Object.keys(WATCH_RANGES) as (keyof WatchOptions)[]) {
    if (raw[k] === undefined) continue;
    const n = Number(raw[k]);
    const r = WATCH_RANGES[k];
    if (!Number.isInteger(n) || n < r.min || n > r.max) return { error: `${k}: a whole number from ${r.min} to ${r.max}.` };
    out[k] = n;
  }
  if (out.chronicDays > out.chronicOf) return { error: "Absent days cannot be more than the days looked at." };
  return out;
}

const DAY = 86_400_000;
const daysBetween = (fromISO: string, toISO: string) => Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / DAY);
const median = (xs: readonly number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r1 = (n: number) => Math.round(n * 10) / 10;

// ------------------------------------------------------------------- late

export interface WatchOrder {
  mo: string;
  dueISO: string | null;
  etaISO: string | null;
  late: boolean;
  done: boolean;
  blockedBy: string | null;
}

/** Orders heading late, the latest first; and those due within a fortnight
 *  that cannot be forecast because a stage they need made nothing. */
export function lateFindings(orders: readonly WatchOrder[], todayISO: string, o: Pick<WatchOptions, "lateMinDays">): WatchFindingDraft[] {
  const late = orders
    .filter((x) => !x.done && x.late && x.dueISO && x.etaISO)
    .map((x) => ({ ...x, days: daysBetween(x.dueISO!, x.etaISO!) }))
    .filter((x) => x.days >= o.lateMinDays)
    .sort((a, b) => b.days - a.days || a.mo.localeCompare(b.mo));
  const out: WatchFindingDraft[] = late.map((x) => ({
    // said again only when the forecast moves
    key: `late:${x.mo}:${x.etaISO}`,
    kind: "late",
    severity: x.days >= 7 || x.dueISO! < todayISO ? "critical" : "warn",
    title: `${x.mo} heads ${x.days} day${x.days === 1 ? "" : "s"} late`,
    detail: `Due ${x.dueISO}, forecast to finish ${x.etaISO}${x.dueISO! < todayISO ? " — already past its due day" : ""}.`,
    mo: x.mo,
  }));
  for (const x of orders) {
    if (x.done || !x.blockedBy || !x.dueISO) continue;
    const left = daysBetween(todayISO, x.dueISO);
    if (left > 14) continue;
    out.push({
      key: `blocked:${x.mo}:${x.blockedBy}`,
      kind: "late",
      severity: left < 0 ? "critical" : "warn",
      title: `${x.mo} cannot be forecast — ${x.blockedBy} made nothing lately`,
      detail: `Due ${x.dueISO}${left < 0 ? " (passed)" : ` in ${left} day${left === 1 ? "" : "s"}`}; with no recent output at ${x.blockedBy} its finish cannot be dated.`,
      mo: x.mo,
    });
  }
  return out;
}

// ----------------------------------------------------------------- output

export interface StageSeries {
  /** cut | weld | finish */
  stage: string;
  label: string;
  /** Earned standard hours per working day, oldest first; the last is the day judged. */
  days: { dateISO: string; hours: number }[];
}

/** How many earlier days the median is taken over. */
export const OUTPUT_BASELINE_DAYS = 10;

export function outputFindings(series: readonly StageSeries[], o: Pick<WatchOptions, "dropPct">): (WatchFindingDraft & { baseline: number; latest: number })[] {
  const out: (WatchFindingDraft & { baseline: number; latest: number })[] = [];
  // nothing booked at any stage on the last day: its Daily log is not in yet,
  // not a plant that stood still — no finding from a day not yet written
  if (series.length > 0 && series.every((s) => (s.days.at(-1)?.hours ?? 0) === 0)) return out;
  for (const s of series) {
    if (s.days.length < 4) continue;
    const last = s.days[s.days.length - 1];
    const before = s.days.slice(-1 - OUTPUT_BASELINE_DAYS, -1).map((d) => d.hours);
    const base = median(before);
    if (!(base > 0)) continue;
    const drop = 1 - last.hours / base;
    if (drop * 100 < o.dropPct) continue;
    out.push({
      key: `output:${s.stage}:${last.dateISO}`,
      kind: "output",
      severity: drop * 100 >= Math.min(90, o.dropPct * 2) ? "critical" : "warn",
      title: `${s.label} earned ${r1(last.hours)} h on ${last.dateISO} — ${Math.round(drop * 100)}% under its usual ${r1(base)} h`,
      detail: `The median of its ${before.length} working days before was ${r1(base)} standard hours.`,
      baseline: r1(base),
      latest: r1(last.hours),
    });
  }
  return out;
}

// ---------------------------------------------------------------- absence

export interface DeptDay {
  dateISO: string;
  dept: string;
  /** Workers with a row that day. */
  rows: number;
  absent: number;
}

export interface WorkerDays {
  id: number;
  name: string;
  dept: string;
  /** Their recorded days, newest first. */
  recent: { dateISO: string; present: boolean }[];
}

/** Recorded days count when they are recent and finished: from `fromISO`,
 *  before `beforeISO` (today's roster may still be half entered). */
export function absenceFindings(
  days: readonly DeptDay[],
  workers: readonly WorkerDays[],
  o: Pick<WatchOptions, "absencePct" | "chronicDays" | "chronicOf"> & { fromISO: string; beforeISO: string },
): WatchFindingDraft[] {
  const out: WatchFindingDraft[] = [];
  const byDept = new Map<string, DeptDay[]>();
  for (const d of days) if (d.rows > 0 && d.dateISO < o.beforeISO) byDept.set(d.dept, [...(byDept.get(d.dept) ?? []), d]);
  for (const [dept, list] of byDept) {
    const sorted = [...list].sort((a, b) => a.dateISO.localeCompare(b.dateISO));
    const last = sorted[sorted.length - 1];
    // a department not recorded lately says nothing about this morning
    if (last.dateISO < o.fromISO) continue;
    const rate = last.absent / last.rows;
    const usual = sorted.slice(-11, -1).map((d) => d.absent / d.rows);
    const mean = usual.length ? usual.reduce((a, b) => a + b, 0) / usual.length : 0;
    if (rate * 100 < o.absencePct || rate < mean + 0.05) continue;
    out.push({
      key: `absence:${dept}:${last.dateISO}`,
      kind: "absence",
      severity: rate * 100 >= o.absencePct * 2 ? "critical" : "warn",
      title: `${dept}: ${last.absent} of ${last.rows} absent on ${last.dateISO} (${Math.round(rate * 100)}%)`,
      detail: usual.length ? `Its usual is ${Math.round(mean * 100)}% over the ${usual.length} recorded days before.` : "No earlier days to compare with.",
    });
  }
  for (const w of workers) {
    const recent = w.recent.filter((d) => d.dateISO < o.beforeISO).slice(0, o.chronicOf);
    if (recent.length < o.chronicOf || recent[0].dateISO < o.fromISO) continue;
    const absent = recent.filter((d) => !d.present).length;
    if (absent < o.chronicDays) continue;
    out.push({
      key: `chronic:${w.id}:${recent[0].dateISO}`,
      kind: "absence",
      severity: absent === recent.length ? "critical" : "warn",
      title: `${w.name} (${w.dept}) absent ${absent} of their last ${recent.length} days`,
      detail: `Absent on ${recent.filter((d) => !d.present).map((d) => d.dateISO).join(", ")}.`,
    });
  }
  return out;
}

// ----------------------------------------------------------------- report

const ORDER: Record<WatchSeverity, number> = { critical: 0, warn: 1 };

export function sortFindings<T extends WatchFindingDraft>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || WATCH_KINDS.indexOf(a.kind) - WATCH_KINDS.indexOf(b.kind));
}

/** The morning's report as the inbox shows it: what needs a look, kind by
 *  kind, with a chart where one says it faster. */
export function watchReport(o: {
  todayISO: string;
  findings: readonly WatchFindingDraft[];
  /** The stages' recent days, for the output chart. */
  series?: readonly StageSeries[];
  /** The AI's few lines over it, when it wrote them. */
  summary?: string;
}): string {
  const f = sortFindings(o.findings);
  if (f.length === 0) return `Nothing out of the ordinary on ${o.todayISO}: no order heading late, output at its usual, attendance as usual.`;
  const critical = f.filter((x) => x.severity === "critical").length;
  const parts: string[] = [`**${f.length} thing${f.length === 1 ? "" : "s"} to look at${critical ? ` — ${critical} urgent` : ""}.**`];
  if (o.summary?.trim()) parts.push(o.summary.trim());
  for (const kind of WATCH_KINDS) {
    const of = f.filter((x) => x.kind === kind);
    if (of.length === 0) continue;
    parts.push(`### ${WATCH_KIND_LABEL[kind]}`);
    parts.push(of.map((x) => `- ${x.severity === "critical" ? "🔴" : "🟠"} **${x.title}** — ${x.detail}`).join("\n"));
    if (kind === "output" && o.series?.length) {
      const flagged = new Set(of.map((x) => x.key.split(":")[1]));
      for (const s of o.series.filter((x) => flagged.has(x.stage))) {
        const days = s.days.slice(-15);
        const base = median(s.days.slice(-1 - OUTPUT_BASELINE_DAYS, -1).map((d) => d.hours));
        parts.push(
          "```chart\n" +
            JSON.stringify({
              type: "line",
              title: `${s.label} — earned standard hours per working day`,
              unit: "h",
              curve: "linear",
              series: ["Earned"],
              data: days.map((d) => ({ name: d.dateISO.slice(5), Earned: r1(d.hours) })),
              targets: [{ value: r1(base), label: "Usual" }],
            }) +
            "\n```",
        );
      }
    }
  }
  return parts.join("\n\n");
}
