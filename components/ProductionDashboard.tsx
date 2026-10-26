"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Database, Info, Search } from "lucide-react";
import { BarPopup } from "@/components/BarPopup";
import { Badge } from "@/components/Badge";
import { Bullet, ChartCard, DeltaChip, Legend, StatTile, TONE_TEXT, fmt, pct, pctOrDash } from "@/components/charts/kit";
import { EfficiencyHeatmap } from "@/components/EfficiencyHeatmap";
import { OutputChart, ProductivityTrendChart, VolumeChart } from "@/components/LazyCharts";
import { LossWaterfallCard } from "@/components/LossWaterfallCard";
import { OutputByType } from "@/components/OutputByType";
import { ProductionExtras } from "@/components/ProductionExtras";
import { withParams } from "@/components/useSetParam";
import { Modal } from "@/components/Modal";
import { EmptyState } from "@/components/primitives";
import { TableFrame, Th } from "@/components/DataTable";
import { stopDurationLabel, type DowntimeCause } from "@/lib/domain/downtime";
import { paretoOf, efficiencyBand, type Stage } from "@/lib/domain/kpis";
import { formatDate } from "@/lib/domain/format";
import { LINE_LABEL, type ProductLine } from "@/lib/domain/lines";
import { round1 } from "@/lib/domain/shifts";
import type { LvStage } from "@/lib/domain/lv";
import type { OutputByTypeData } from "@/lib/domain/outputByType";
import {
  PRICED_FOCUS, SHIFT_FILTERS, UNUSUAL_EFFICIENCY, dailyLogHref, deptLabel, focusRows, hoursFigures, productionSheetRows, shiftsDayHref, unitLabel,
  type Kpi, type ProductionFocus, type ProductionRequest, type ProductionView, type ShiftFilter,
} from "@/lib/domain/productionDashboard";
import type { FloorPeriod } from "@/lib/server/kpis";

// The Production dashboard's body: what did we make, at what efficiency, and
// where is the gap between the effort and the output. The data's coverage
// first, then six tiles (each opens the rows it is the sum of), earned
// against booked day by day beside the biggest gaps, each unit's efficiency
// day by day, the output stage by stage, who came and on which shift, where
// the hours went, the departments' table — then the rest of the floor's
// cards. Every figure is computed on the server (lib/domain/
// productionDashboard.ts) for the page's one set of filters; what a card
// means and how it is counted goes to the assistant on a right-click.

export interface ProductionMore {
  trByType: OutputByTypeData<Stage> | null;
  lvByType: OutputByTypeData<LvStage> | null;
  /** The transformers' machines and quality — null off the transformers. */
  trExtras: Pick<FloorPeriod, "stops" | "quality"> | null;
  /** The machines' stops by cause (the plant's, counted once on the transformers' side). */
  stops: { causes: DowntimeCause[]; unplannedH: number; plannedH: number } | null;
}

const noSubscribe = () => () => {};
const SOURCES = "Hours: the shift log (Shifts). Output: the Daily log at the standard times (Admin → Standard Times, the KVA classes; the LV tab for the panels).";

const TILE: Record<ProductionFocus, { label: string; value: (v: number) => string; unit?: string; up: "good" | "bad" | undefined; about: string }> = {
  earned: { label: "Earned standard hours", value: (v) => fmt(v, 1), unit: "std-h", up: "good", about: "The standard hours the output was worth, on the unit-days that booked hours." },
  booked: { label: "Booked man-hours", value: (v) => fmt(v, 1), unit: "h", up: undefined, about: "The man-hours the shift log booked for those present, overtime included." },
  efficiency: { label: "Efficiency", value: (v) => pct(v), up: "good", about: "Σ standard hours earned ÷ Σ man-hours booked, over the same unit-days — never the mean of the departments' rates, and never capped at 100%." },
  stdpd: { label: "Std-h a person-day", value: (v) => fmt(v, 1), unit: "std-h", up: "good", about: "Standard hours earned ÷ the person-days present (one person on one recorded day)." },
  attendance: { label: "Attendance", value: (v) => pct(v), up: "good", about: "Rows recorded present ÷ rows recorded (present or absent). A worker not set on the roster is not an absence, and is not counted here." },
  overtime: { label: "Overtime share", value: (v) => pct(v), up: "bad", about: "Overtime hours ÷ the man-hours booked (which include them) — the shift log only, never added to the department's day totals again." },
};

function deltaOfKpi(k: Kpi, beforeRange: string | null, up: "good" | "bad" | undefined) {
  if (!k.delta) return <Badge tone="neutral" title={beforeRange ? `No valid base in ${beforeRange}` : "No stretch before within the history kept"}>N/A</Badge>;
  return <DeltaChip value={k.delta.value} unit={k.delta.kind === "pts" ? " pts" : "%"} up={up} title={`Against ${beforeRange}: ${k.before === null ? "—" : `${TILE[k.key].value(k.before)}${TILE[k.key].unit ? ` ${TILE[k.key].unit}` : ""}`}`} />;
}

export function ProductionDashboard({ view, req, range, beforeRange, more }: {
  view: ProductionView;
  req: ProductionRequest;
  range: string;
  beforeRange: string | null;
  more: ProductionMore;
}) {
  const params = useSearchParams();
  const path = usePathname();
  const router = useRouter();
  const href = (set: Record<string, string | null>) => `${path}${withParams(params, set)}`;
  // a link that opens with a tile's rows (?focus=) shows them once the page is in the browser — the popup needs the document
  const inBrowser = useSyncExternalStore(noSubscribe, () => true, () => false);
  const f = view.figures;
  const pf = view.pricedFigures;
  const noDays = f.unitDays === 0;
  const cov = view.coverage;
  const covText = `${cov.recordedDays} of ${cov.workingDays} working days recorded`;
  const multi = req.scope === "all" && view.byLine.TR && view.byLine.LV;
  const lineSplit = (pick: (x: ReturnType<typeof hoursFigures>) => string) => (multi ? `TR ${pick(view.byLine.TR!)} · LV ${pick(view.byLine.LV!)}` : null);

  const tileSub: Record<ProductionFocus, string> = {
    earned: lineSplit((x) => fmt(x.earnedH, 1)) ?? `${f.days} recorded day${f.days === 1 ? "" : "s"}`,
    booked: `${f.personDays} person-days`,
    efficiency: pf.efficiency !== null && pf.efficiency > UNUSUAL_EFFICIENCY ? "⚠ unusually high — check the records" : lineSplit((x) => pctOrDash(x.efficiency)) ?? `${fmt(pf.earnedH, 1)} of ${fmt(pf.workedH, 1)} h`,
    stdpd: `over ${pf.personDays} person-days`,
    attendance: `${f.rows - f.absent} of ${f.rows} rows present`,
    overtime: `${fmt(f.overtimeH, 1)} h of ${fmt(f.workedH, 1)} h`,
  };

  const empty = (
    <EmptyState compact icon={Info} title="No shift day recorded for this choice"
      hint={<>Pick a longer period or another department, or record the attendance on <Link href="/shifts" className="text-brand-ink font-semibold hover:underline">Shifts</Link>.</>} />
  );

  return (
    <div className="space-y-4">
      <p className="print-only text-sm font-bold">{view.scopeName} · {range}</p>

      {/* the six tiles — each opens the rows it adds up */}
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
        {view.kpis.map((k) => {
          const t = TILE[k.key];
          return (
            <Link key={k.key} href={href({ focus: k.key, day: null })} scroll={false} className="flex min-w-0 rounded-xl hover:ring-2 hover:ring-[var(--brand)] focus-visible:ring-2" aria-label={`${t.label}: ${k.value === null ? "not available" : `${t.value(k.value)}${t.unit ? ` ${t.unit}` : ""}`}${k.delta ? `, ${k.delta.value > 0 ? "+" : ""}${k.delta.value}${k.delta.kind === "pts" ? " points" : "%"} against the stretch before` : ""} — open its rows`}>
              <StatTile
                hero={k.key === "efficiency"}
                label={t.label}
                value={k.value === null ? "—" : t.value(k.value)}
                unit={k.value === null ? undefined : t.unit}
                meter={k.key === "efficiency" && k.value !== null ? Math.min(1, k.value) : undefined}
                delta={deltaOfKpi(k, beforeRange, t.up)}
                sub={noDays && k.key !== "attendance" ? "no recorded day" : k.value === null && PRICED_FOCUS.has(k.key) && view.unpriced.length > 0 ? "output not priced" : tileSub[k.key]}
                about={`${view.scopeName}, ${range}. ${t.about} ${SOURCES} Coverage: ${covText}${cov.unmatched.unitDays > 0 ? `; ${fmt(cov.unmatched.earnedH, 1)} std-h of output on days with no attendance are left out` : ""}.${beforeRange ? ` Compared with ${beforeRange}${k.before === null ? " (no valid base: N/A)" : `: ${t.value(k.before)}${t.unit ? ` ${t.unit}` : ""}`}.` : " No stretch before within the history kept."}`}
              />
            </Link>
          );
        })}
      </div>

      {/* earned against booked */}
      <ChartCard
        title="Earned against booked, day by day"
        about={`${view.scopeName}, ${range}: the standard hours each department earned (stacked) against the man-hours booked (the line), on the unit-days that booked hours — the gap is the time not earned. Click a day for its rows. Output on a day with no attendance is in the output chart below, not here.`}
        data={view.daily.days.map((d) => ({ Day: d.dateISO, ...Object.fromEntries(view.daily.groups.map((g) => [`${g.label} std-h`, d.values[g.key] ?? 0])), "Earned std-h": d.earnedH, "Booked h": d.workedH, "Efficiency %": d.efficiency === null ? "" : Math.round(d.efficiency * 100) }))}
      >
        {view.daily.days.length === 0 ? empty : (
          <OutputChart days={view.daily.days} groups={view.daily.groups.map((g) => g.key)} labels={Object.fromEntries(view.daily.groups.map((g) => [g.key, g.label]))} height={280}
            onDay={(iso) => router.push(href({ day: iso, focus: null }), { scroll: false })} />
        )}
      </ChartCard>

      {/* each unit's efficiency, and what was made */}
      <div className="grid gap-4 xl:grid-cols-12">
        <ChartCard
          className="xl:col-span-7"
          title="Did each unit work at the standard?"
          about={`Efficiency each recorded day of ${range}: standard hours earned ÷ man-hours booked at the work centre (TR) or department (LV). Green at the standard (90%+), amber short of it, red well short; grey where nobody booked hours — not a zero. The last column is the period. Click a cell for its day on Shifts.`}
          data={view.heat.rows.flatMap((r) => r.cells.filter((c) => c.workedH > 0).map((c) => ({ Unit: view.heat.labels[r.centre], Day: c.dateISO, "Earned std-h": c.earnedH, "Booked h": c.workedH, "Efficiency %": c.efficiency === null ? "" : Math.round(c.efficiency * 100) })))}
        >
          {view.heat.rows.length === 0 ? empty : (
            <EfficiencyHeatmap grid={view.heat.rows} dates={view.heat.dates} labels={view.heat.labels} rowHead="Unit"
              unpriced={new Set(view.heat.unpricedRows)}
              hrefOf={(key, iso) => shiftsDayHref(key.split(":")[0] as ProductLine, iso)} />
          )}
        </ChartCard>
        <VolumeCard view={view} range={range} stage={params.get("stage")} href={href} />
      </div>

      {/* who came, and where the hours went */}
      <div className="grid gap-4 xl:grid-cols-12">
        <AttendanceCard view={view} shift={req.shift} range={range} href={href} />
        <LossWaterfallCard className="xl:col-span-6" walk={view.hours} scope={view.scopeName} range={range} beforeRange={beforeRange}
          notPriced={view.figures.unitDays > 0 && view.kpis.find((k) => k.key === "efficiency")?.value === null} />
      </div>

      <DeptTable view={view} range={range} />

      {/* the rest of the floor's cards, over the same period */}
      <section className="space-y-4" aria-label="More">
        <h2 className="text-sm font-bold text-muted">More · {range}</h2>
        {(more.trByType || more.lvByType) && <OutputByType tr={more.trByType} lv={more.lvByType} range={range} />}
        <div className="grid gap-4 xl:grid-cols-12">
          <ChartCard
            className="xl:col-span-7"
            title="Is the floor getting faster?"
            about={`${view.scopeName}: the efficiency each recorded day (dots) and over the last 7 recorded days together (the line); the dashed line is the standard.`}
            data={view.trend.map((p) => ({ Day: p.dateISO, "Earned std-h": p.earnedH, "Booked h": p.workedH, "Efficiency %": p.efficiency === null ? "" : Math.round(p.efficiency * 100), "Last 7 recorded days %": p.rolling === null ? "" : Math.round(p.rolling * 100) }))}
          >
            {view.trend.length === 0 ? empty : <ProductivityTrendChart points={view.trend} window={7} />}
          </ChartCard>
          {more.stops && <StopsCard stops={more.stops} range={range} />}
        </div>
        {more.trExtras && <ProductionExtras period={more.trExtras} />}
      </section>

      {inBrowser && (req.focus || req.focusDay) && (
        <FocusModal view={view} focus={req.focus} day={req.focusDay} range={range} onClose={() => router.push(href({ focus: null, day: null }), { scroll: false })} />
      )}
    </div>
  );
}

/** How far the data goes — attendance recorded, the last day, the output
 *  priced, output nobody booked hours against — in the bar's popup, so the
 *  page carries only the figures. Its icon warns while something is short. */
export function DataCoveragePopup({ view, req, asOf, failed, beforeRange }: {
  view: ProductionView; req: ProductionRequest; asOf: string; failed: readonly ProductLine[]; beforeRange: string | null;
}) {
  const c = view.coverage;
  const items: { tone: "ok" | "warn" | "bad" | "muted" | "info"; text: React.ReactNode }[] = [
    ...failed.map((l) => ({ tone: "bad" as const, text: `${LINE_LABEL[l]}: could not load — the figures are partial.` })),
    { tone: c.share === null ? "muted" : c.share < 0.8 ? "warn" : "ok", text: `Attendance recorded on ${c.recordedDays} of ${c.workingDays} working days${c.share === null ? "" : ` (${pct(c.share)})`} — Fridays and holidays off, from the day recording began.` },
    { tone: "muted", text: `Last recorded day: ${c.lastRecordISO ? formatDate(c.lastRecordISO) : "—"}.` },
    ...(Object.entries(c.priced) as [ProductLine, number | null][]).map(([l, v]) => ({
      tone: v === null ? "muted" as const : v < 0.95 ? "warn" as const : "ok" as const,
      text: v === null ? `${LINE_LABEL[l]}: no output recorded.` : <>{LINE_LABEL[l]}: {pct(v)} of the output carries standard hours{v < 0.95 ? <> — the rest earns nothing and reads as slow (<Link href="/admin/standard-times" className="text-brand-ink font-semibold hover:underline">Standard Times</Link>)</> : ""}.</>,
    })),
    ...(view.figures.workedH > view.pricedFigures.workedH ? [{ tone: "warn" as const, text: `${fmt(round1(view.figures.workedH - view.pricedFigures.workedH), 1)} h booked in departments whose output carries no standard hours (n/p) — in the booked man-hours, left out of the efficiency.` }] : []),
    ...(c.unmatched.unitDays > 0 ? [{ tone: "warn" as const, text: `${fmt(c.unmatched.earnedH, 1)} std-h of output on ${c.unmatched.dates.map((d) => formatDate(d)).join(", ")} with no attendance recorded — shown in the output chart, left out of the efficiency.` }] : []),
    ...c.beforeTracking.map((b) => ({ tone: "muted" as const, text: `${LINE_LABEL[b.line]}: ${b.sinceISO ? `recording began ${formatDate(b.sinceISO)} — the days before are before tracking, not missing.` : "no attendance recorded yet."}` })),
    ...(c.todayOpen ? [{ tone: "info" as const, text: "Now: today is still being logged." }] : []),
    ...(req.clamped ? [{ tone: "warn" as const, text: "The period was adjusted to the floor's limits." }] : []),
    { tone: "muted", text: beforeRange ? `Each tile is compared with ${beforeRange}.` : "No earlier stretch within the history kept — the changes read N/A." },
    { tone: "muted", text: "Not set is read against today's workers list; efficiency by shift is not available — the Daily log records no shift." },
  ];
  const warns = items.filter((i) => i.tone === "warn" || i.tone === "bad").length;
  const tone = failed.length > 0 ? "bad" : warns > 0 ? "warn" : "ok";
  const DOT = { ok: "text-ok-fg", warn: "text-warn-fg", bad: "text-bad-fg", info: "text-info-fg", muted: "text-muted" } as const;
  return (
    <BarPopup icon={Database} label="Data" title="How far the data goes" sub={`${view.scopeName} · as of ${asOf}`} tone={tone} count={warns}>
      <ul className="space-y-2 text-sm">
        {items.map((i, n) => (
          <li key={n} className="flex gap-2"><span className={`${DOT[i.tone]} shrink-0`} aria-hidden>●</span><span>{i.text}</span></li>
        ))}
      </ul>
    </BarPopup>
  );
}

/** Where the effort and the output parted — the unit-days with the most hours
 *  not earned, those unusually above the standard, and what moved the
 *  efficiency — in the bar's popup. */
export function WorthALookPopup({ view, scope }: { view: ProductionView; scope: ProductionRequest["scope"] }) {
  const gaps = view.gaps;
  const above = gaps.filter((g) => g.kind === "above").length;
  const w = view.hours;
  return (
    <BarPopup icon={Search} label="Worth a look" title="Worth a look" sub={`${view.scopeName} — where the effort and the output parted`} tone={gaps.length === 0 ? "ok" : above > 0 ? "warn" : "info"} count={gaps.length}>
      <div className="space-y-4 text-sm">
        {(w.change || w.biggest) && (
          <div className="space-y-1">
            {w.change && <p>{w.change.text}</p>}
            {w.biggest && <p className="font-semibold">{w.biggest}</p>}
          </div>
        )}
        {gaps.length === 0 ? <p className="text-muted">{view.figures.unitDays === 0 ? "No recorded day." : "Every recorded unit-day earned what it booked."}</p> : (
          <ul className="space-y-2">
            {gaps.map((g) => {
              const b = efficiencyBand(g.efficiency);
              return (
                <li key={`${g.line}${g.unit}${g.dateISO}${g.kind}`}>
                  <Link href={shiftsDayHref(g.line, g.dateISO)} className="flex items-baseline justify-between gap-2 hover:underline">
                    <span className="min-w-0 truncate">
                      {g.kind === "above" && <AlertTriangle size={13} className="inline me-1 text-warn-fg" aria-label="Unusually high" />}
                      <span className="font-semibold">{unitLabel(g.line, g.unit)}</span>{scope === "all" ? ` · ${g.line}` : ""} · {formatDate(g.dateISO)}
                    </span>
                    <span className={`tabnum shrink-0 font-semibold ${b ? TONE_TEXT[b] : ""}`}>
                      {g.kind === "gap" ? `${fmt(g.gapH, 1)} h not earned · ${pct(g.efficiency)}` : `${pct(g.efficiency)} — check the records`}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </BarPopup>
  );
}

function VolumeCard({ view, range, stage, href }: { view: ProductionView; range: string; stage: string | null; href: (s: Record<string, string | null>) => string }) {
  const stages = view.volume.stages;
  const on = stages.find((s) => s.key === stage) ?? stages[0] ?? null;
  const days = on ? view.volume.days.filter((d) => d.stage === on.key) : [];
  return (
    <ChartCard
      className="xl:col-span-5"
      title="What was made each day?"
      sub={on ? `${on.label} · ${on.unit} · ${fmt(on.total)} in the period` : undefined}
      about={`What the Daily log recorded in ${range}, one stage at a time and in its own unit — pieces for the transformers, panels for the LV — by component. Every day it recorded shows, with attendance or not. A piece passing several stages is counted at each, so the stages are never added together as finished units. Shot blast counts every painted piece.`}
      data={days.map((d) => ({ Stage: on!.label, Day: d.dateISO, ...d.byComponent, [`Total ${on!.unit}`]: d.total }))}
      right={stages.length > 1 ? (
        <nav className="seg flex-wrap" aria-label="Stage">
          {stages.map((s) => <Link key={s.key} scroll={false} href={href({ stage: s.key })} className={s.key === on?.key ? "on" : ""} aria-current={s.key === on?.key ? "true" : undefined}>{s.label}</Link>)}
        </nav>
      ) : undefined}
    >
      {!on ? <EmptyState compact icon={Info} title="Nothing recorded on the Daily log in this period" /> : (
        <VolumeChart days={days} components={view.volume.components[on.key] ?? []} unit={on.unit} stage={on.label} height={260} />
      )}
    </ChartCard>
  );
}

const SHIFT_LABEL: Record<ShiftFilter, string> = { both: "Both", day: "Day", night: "Night" };

function AttendanceCard({ view, shift, range, href }: { view: ProductionView; shift: ShiftFilter; range: string; href: (s: Record<string, string | null>) => string }) {
  const rows = view.attendance;
  const showDay = shift !== "night", showNight = shift !== "day";
  return (
    <ChartCard
      className="xl:col-span-6"
      title="Who came, and on which shift?"
      sub={`${range} · ${shift === "both" ? "both shifts" : `${SHIFT_LABEL[shift]} shift only · attendance and hours`}`}
      about={`Each department over ${range}: rows the shift log recorded present and absent, and the workers Not set (on today's workers list, counted from the day they were added, on the days the department recorded — not an absence). Present people, hours and overtime by shift; an absent row carries no shift, so the absences stay whole when a shift is picked. Efficiency by shift is not available: the Daily log does not record the shift.`}
      data={rows.map((r) => ({ Line: r.line, Department: r.label, Recorded: r.rows, Present: r.present, Absent: r.absent, "Not set": r.notSet ?? "", "Day people": r.day.people, "Day h": r.day.hours, "Night people": r.night.people, "Night h": r.night.hours, "Overtime h": r.overtimeH }))}
      right={
        <nav className="seg" aria-label="Shift">
          {SHIFT_FILTERS.map((s) => <Link key={s} scroll={false} href={href({ shift: s === "both" ? null : s })} className={s === shift ? "on" : ""} aria-current={s === shift ? "true" : undefined}>{SHIFT_LABEL[s]}</Link>)}
        </nav>
      }
    >
      {rows.length === 0 ? <EmptyState compact icon={Info} title="No attendance recorded for this choice" /> : (
        <TableFrame className="!max-h-none">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th label="Department" />
                <Th label="Present" full={shift === "both" ? "Rows recorded present" : `Present on the ${SHIFT_LABEL[shift].toLowerCase()} shift`} num className="text-right" />
                <Th label="Absent" full="Rows recorded absent (no shift)" num className="text-right" />
                <Th label="Not set" full="Workers on the list with no row on a day the department recorded" num className="text-right" />
                <Th label="" full="Present · absent · not set" />
                {showDay && <Th label="Day" unit="h" full="Man-hours on the day shift" num className="text-right" />}
                {showNight && <Th label="Night" unit="h" full="Man-hours on the night shift" num className="text-right" />}
                <Th label="OT" unit="h" full="Overtime hours" num className="text-right" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const total = r.present + r.absent + (r.notSet ?? 0);
                const w = (n: number) => `${total > 0 ? (n / total) * 100 : 0}%`;
                return (
                  <tr key={`${r.line}${r.dept}`}>
                    <td className="px-2 font-semibold whitespace-nowrap">{r.label}{view.byLine.TR && view.byLine.LV ? <span className="text-muted font-normal"> · {r.line}</span> : null}</td>
                    <td className="px-2 text-right tabnum">{fmt(r.present)}</td>
                    <td className="px-2 text-right tabnum">{fmt(r.absent)}</td>
                    <td className="px-2 text-right tabnum" title={r.notSet === null ? "The roster cannot say for every day" : undefined}>{r.notSet === null ? "—" : fmt(r.notSet)}</td>
                    <td className="px-2 min-w-[6rem]">
                      <div className="flex h-2.5 rounded-full overflow-hidden bg-surface-2" role="img" aria-label={`${r.present} present, ${r.absent} absent${r.notSet ? `, ${r.notSet} not set` : ""}`}>
                        <span className="bg-[var(--viz-1)]" style={{ width: w(r.present) }} />
                        <span className="bg-bad-fg" style={{ width: w(r.absent) }} />
                      </div>
                    </td>
                    {showDay && <td className="px-2 text-right tabnum">{fmt(r.day.hours, 1)}</td>}
                    {showNight && <td className="px-2 text-right tabnum">{fmt(r.night.hours, 1)}</td>}
                    <td className="px-2 text-right tabnum">{fmt(r.overtimeH, 1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableFrame>
      )}
      <div className="mt-2 text-muted"><Legend items={[{ label: "present", color: "var(--viz-1)" }, { label: "absent", color: "var(--bad-fg)" }, { label: "not set", color: "var(--surface-2)" }]} /></div>
    </ChartCard>
  );
}

function DeptTable({ view, range }: { view: ProductionView; range: string }) {
  const rows = view.table;
  const f = view.figures;
  const both = !!(view.byLine.TR && view.byLine.LV);
  return (
    <ChartCard
      title="Department by department"
      about={`Each department over ${range}: the days it booked hours of the working days since recording began, the person-days, the man-hours booked and the overtime, the standard hours earned and the efficiency (earned ÷ booked), and what it recorded in its unit — every record, attendance or not, as the output chart. The total row is the tiles; output is never added across departments or lines.`}
      data={productionSheetRows(view)}
    >
      {rows.length === 0 ? <EmptyState compact icon={Info} title="No department recorded anything for this choice" /> : (
        <TableFrame className="!max-h-none">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th label="Department" />
                <Th label="Recorded" full="Days with booked hours, of the working days since recording began" num className="text-right" />
                <Th label="Coverage" full="Recorded ÷ working days" num className="text-right" />
                <Th label="Person-days" full="People present summed over the recorded days" num className="text-right" />
                <Th label="Booked" unit="h" full="Man-hours booked" num className="text-right" />
                <Th label="OT" unit="h" full="Overtime hours" num className="text-right" />
                <Th label="Earned" unit="std-h" full="Standard hours earned on the recorded days" num className="text-right" />
                <Th label="Efficiency" full="Earned ÷ booked" num className="text-right" />
                <Th label="Output" full="What the department recorded in the period, in its unit" num className="text-right" />
                <Th label="Day log" full="The department's last recorded day on Shifts" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const b = efficiencyBand(r.efficiency);
                return (
                  <tr key={`${r.line}${r.dept}`}>
                    <td className="px-2 font-semibold whitespace-nowrap">{r.label}{both ? <span className="text-muted font-normal"> · {r.line}</span> : null}</td>
                    <td className="px-2 text-right tabnum">{r.recordedDays} / {r.workingDays}</td>
                    <td className={`px-2 text-right tabnum ${r.coverage !== null && r.coverage < 0.8 ? "text-warn-fg font-semibold" : ""}`}>{pctOrDash(r.coverage)}</td>
                    <td className="px-2 text-right tabnum">{fmt(r.personDays)}</td>
                    <td className="px-2 text-right tabnum">{fmt(r.workedH, 1)}</td>
                    <td className="px-2 text-right tabnum">{fmt(r.overtimeH, 1)}</td>
                    <td className="px-2 text-right tabnum">{fmt(r.earnedH, 1)}</td>
                    <td className={`px-2 text-right tabnum font-bold ${b ? TONE_TEXT[b] : "text-muted"}`} title={r.priced ? undefined : "The output carries no standard hours — efficiency not known"}>
                      {!r.priced && r.workedH > 0 ? "n/p" : <>{r.efficiency !== null && r.efficiency > UNUSUAL_EFFICIENCY ? "⚠ " : ""}{pctOrDash(r.efficiency)}</>}
                    </td>
                    <td className="px-2 text-right tabnum whitespace-nowrap">{fmt(r.output)} <span className="text-muted">{r.outputUnit}</span></td>
                    <td className="px-2 whitespace-nowrap">
                      {r.lastDayISO ? <Link href={shiftsDayHref(r.line, r.lastDayISO)} className="text-brand-ink font-semibold hover:underline">{formatDate(r.lastDayISO)}</Link> : <span className="text-muted">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="font-bold">
                <td className="px-2">Total</td>
                <td className="px-2 text-right tabnum">{view.coverage.recordedDays} / {view.coverage.workingDays}</td>
                <td className="px-2 text-right tabnum">{pctOrDash(view.coverage.share)}</td>
                <td className="px-2 text-right tabnum">{fmt(f.personDays)}</td>
                <td className="px-2 text-right tabnum">{fmt(f.workedH, 1)}</td>
                <td className="px-2 text-right tabnum">{fmt(f.overtimeH, 1)}</td>
                <td className="px-2 text-right tabnum">{fmt(f.earnedH, 1)}</td>
                <td className="px-2 text-right tabnum">{pctOrDash(view.kpis.find((k) => k.key === "efficiency")?.value)}</td>
                <td className="px-2 text-right text-muted" title="Pieces and panels at different stages never add up">—</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </TableFrame>
      )}
    </ChartCard>
  );
}

function StopsCard({ stops, range }: { stops: NonNullable<ProductionMore["stops"]>; range: string }) {
  const pareto = paretoOf(stops.causes);
  const planned = stops.causes.filter((c) => c.planned);
  return (
    <ChartCard
      className="xl:col-span-5"
      title="What stopped the machines?"
      sub={`${stopDurationLabel(stops.unplannedH)} machine time lost · machine-hours, not man-hours`}
      about={`The machines' unplanned stops in ${range}, biggest cause first — machine-hours, recorded on the machine by department (the punches are shared, so the plant's stops are counted once, on the transformers' side). The detail of each stop is on Shifts → Machine stops.`}
      data={stops.causes.map((c) => ({ Cause: c.label, Hours: c.hours, Stops: c.stops, "Share of lost %": c.share === null ? "" : Math.round(c.share * 100), Planned: c.planned ? "yes" : "" }))}
    >
      {pareto.length === 0 ? (
        <EmptyState compact icon={Info} title="No unplanned stop in this period" hint={<>Stops are recorded on <Link href="/shifts?view=downtime" className="text-brand-ink font-semibold hover:underline">Shifts → Machine stops</Link>.</>} />
      ) : (
        <div className="space-y-3">
          {pareto.slice(0, 6).map((c) => (
            <Bullet key={c.code} label={c.label} value={c.hours} target={null} max={pareto[0].hours}
              text={`${stopDurationLabel(c.hours)} · ${c.stops} stop${c.stops === 1 ? "" : "s"} · ${Math.round(c.share * 100)}%`} />
          ))}
          <Link href="/shifts?view=downtime" className="text-xs text-brand-ink font-semibold hover:underline">Every stop on Shifts → Machine stops</Link>
        </div>
      )}
      {planned.length > 0 && <p className="text-sm text-muted mt-2">Planned maintenance, kept apart: {planned.map((c) => `${stopDurationLabel(c.hours)} (${c.stops} stop${c.stops === 1 ? "" : "s"})`).join(", ")}.</p>}
    </ChartCard>
  );
}

/** The rows a tile (or a day of the chart) adds up — the same unit-days, the same sums. */
function FocusModal({ view, focus, day, range, onClose }: { view: ProductionView; focus: ProductionFocus | null; day: string | null; range: string; onClose: () => void }) {
  const rows = focusRows(view, focus, day);
  const t = hoursFigures(rows);
  const title = day ? `${formatDate(day)} · ${view.scopeName}` : `${TILE[focus!].label} · ${view.scopeName}`;
  return (
    <Modal title={title} sub={day ? "Each unit's day — the hours, the output and who came" : `The rows behind the figure, ${range}`} onClose={onClose} width="max-w-5xl" focusField={false}>
      {rows.length === 0 ? <EmptyState compact icon={Info} title="No row behind this figure" /> : (
        <TableFrame className="max-h-[60vh]">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th label="Day" />
                <Th label="Unit" />
                <Th label="Booked" unit="h" num className="text-right" />
                <Th label="Earned" unit="std-h" num className="text-right" />
                <Th label="Efficiency" num className="text-right" />
                <Th label="People" num className="text-right" />
                <Th label="OT" unit="h" num className="text-right" />
                <Th label="Rows" full="Rows recorded (present or absent)" num className="text-right" />
                <Th label="Absent" num className="text-right" />
                <Th label="Records" />
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const eff = d.workedH > 0 ? d.earnedH / d.workedH : null;
                const b = efficiencyBand(eff);
                return (
                  <tr key={`${d.dateISO}${d.line}${d.unit}`}>
                    <td className="px-2 whitespace-nowrap">{formatDate(d.dateISO)}</td>
                    <td className="px-2 whitespace-nowrap font-semibold">{unitLabel(d.line, d.unit)}<span className="text-muted font-normal"> · {deptLabel(d.line, d.dept)}{d.line === "LV" || view.byLine.LV ? ` · ${d.line}` : ""}</span></td>
                    <td className="px-2 text-right tabnum">{fmt(d.workedH, 1)}</td>
                    <td className="px-2 text-right tabnum">{fmt(round1(d.earnedH), 1)}{d.workedH > 0 ? "" : d.earnedH > 0 ? <span className="text-warn-fg" title="No attendance this day: left out of the efficiency"> ⚠</span> : ""}</td>
                    <td className={`px-2 text-right tabnum ${b ? TONE_TEXT[b] : "text-muted"}`}>{pctOrDash(eff)}</td>
                    <td className="px-2 text-right tabnum">{fmt(d.people)}</td>
                    <td className="px-2 text-right tabnum">{fmt(d.overtimeH, 1)}</td>
                    <td className="px-2 text-right tabnum">{fmt(d.rows)}</td>
                    <td className="px-2 text-right tabnum">{fmt(d.absent)}</td>
                    <td className="px-2 whitespace-nowrap space-x-2">
                      <Link href={shiftsDayHref(d.line, d.dateISO, "attendance")} className="text-brand-ink font-semibold hover:underline">Shifts</Link>
                      <Link href={dailyLogHref(d.line)} className="text-brand-ink font-semibold hover:underline">Daily log</Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="font-bold">
                <td className="px-2" colSpan={2}>Total{focus ? " — the tile's figure" : ""}</td>
                <td className="px-2 text-right tabnum">{fmt(t.workedH, 1)}</td>
                <td className="px-2 text-right tabnum">{fmt(t.earnedH, 1)}</td>
                <td className="px-2 text-right tabnum">{pctOrDash(t.efficiency)}</td>
                <td className="px-2 text-right tabnum">{fmt(t.personDays)}</td>
                <td className="px-2 text-right tabnum">{fmt(t.overtimeH, 1)}</td>
                <td className="px-2 text-right tabnum">{fmt(t.rows)}</td>
                <td className="px-2 text-right tabnum">{fmt(t.absent)}</td>
                <td className="px-2 text-sm text-muted font-normal">{(focus === "attendance" || day) && t.attendance !== null ? `attendance ${pct(t.attendance)}` : ""}</td>
              </tr>
            </tfoot>
          </table>
        </TableFrame>
      )}
      <p className="text-xs text-muted mt-2">Earned counts only where hours were booked; ⚠ marks output on a day with no attendance, left out of the efficiency.</p>
    </Modal>
  );
}
