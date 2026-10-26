"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Info } from "lucide-react";
import { ChartCard, Meter, StatTile, TONE_TEXT, TRACK, fmt, pct } from "@/components/charts/kit";
import { LossWaterfallCard } from "@/components/LossWaterfallCard";
import { BurnUpChart, LoadChart, OutputChart, PaceMultiples } from "@/components/LazyCharts";
import { Badge } from "@/components/Badge";
import { EmptyState } from "@/components/primitives";
import { TableFrame, Th } from "@/components/DataTable";
import { DecisionList } from "@/components/CockpitDecisions";
import { formatDate } from "@/lib/domain/format";
import { stopDurationLabel } from "@/lib/domain/downtime";
import { ITEM_NAME, isItem } from "@/lib/domain/constants";
import { WORK_CENTRE_LABEL, type WorkCentre } from "@/lib/domain/shifts";
import {
  OUTPUT_GROUPS, OUTPUT_GROUP_LABEL, STAGE_LABEL, burnUp, dailyOutput, loadSeries, monthPace, paretoOf, weekChange,
  type KpiSnapshotData,
} from "@/lib/domain/kpis";
import type { CockpitData } from "@/lib/server/kpis";

// 🧭 The planner's cockpit — each card a question, answered with a chart that
// reads in a second and the list to act on, worst news first. Every number is
// standard hours (what the work is worth), never pieces, so Fabrication's ten
// projects a day add up. The figures come from lib/server/kpis.ts and the
// series from lib/domain/kpis.ts; the assistant reads the same loader. Each
// card's numbers are one click away under its Table switch, with the export.
//
// The page is a 12-column grid: a short card sits beside a long one, so no
// card leaves a hole under it, and every row fills the width.

const pctOrDash = (v: number | null | undefined) => (v === null || v === undefined ? "—" : pct(v));
const itemName = (it: string) => (isItem(it) ? ITEM_NAME[it] : it);
const centreName = (c: WorkCentre) => WORK_CENTRE_LABEL[c];
const signed = (v: number, digits = 1) => (v > 0 ? `+${fmt(v, digits)}` : fmt(v, digits));

/** Today's figure against a week ago, in the tile's own unit: points for a
 *  rate, the figure's own unit otherwise; green or red where up is good or bad. */
function WeekChange({ trend, todayISO, pick, rate, unit = "", up }: {
  trend: CockpitData["trend"]; todayISO: string; pick: (p: KpiSnapshotData) => number | null | undefined; rate?: boolean; unit?: string; up?: "good" | "bad";
}) {
  const today = trend.find((p) => p.dateISO === todayISO);
  // no figure today (the tile reads "—"): nothing to compare
  if (!today || pick(today) === null || pick(today) === undefined) return null;
  const c = weekChange(trend, todayISO, pick);
  if (!c) return <span className="text-xs text-muted">no reading a week ago yet</span>;
  const diff = rate ? Math.round((c.now - c.before) * 100) : Math.round((c.now - c.before) * 10) / 10;
  const arrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "•";
  const good = !up || diff === 0 ? null : (diff > 0) === (up === "good");
  const amount = rate ? `${Math.abs(diff)} pts` : `${fmt(Math.abs(diff), 1)}${unit}`;
  return (
    <span className={`text-xs font-bold ${good === null ? "" : good ? "text-ok-fg" : "text-bad-fg"}`} title={`${formatDate(c.beforeISO)}: ${rate ? pct(c.before) : `${fmt(c.before, 1)}${unit}`}`}>
      {arrow} {amount} <span className="font-normal text-muted">since {formatDate(c.beforeISO)}</span>
    </span>
  );
}

/** One row of a bullet chart: the bar is what there is, the tick is where it should be. */
function Bullet({ label, value, target, max, text, tone }: { label: string; value: number; target: number | null; max: number; text: React.ReactNode; tone?: "ok" | "warn" | "bad" | null }) {
  const w = (v: number) => `${Math.max(0, Math.min(1, max > 0 ? v / max : 0)) * 100}%`;
  return (
    <div>
      <div className="flex flex-wrap justify-between gap-x-3 text-sm mb-1">
        <span className="font-semibold">{label}</span>
        <span className={`tabnum ${tone ? TONE_TEXT[tone] : ""}`}>{text}</span>
      </div>
      <div className="relative h-3 rounded-full" style={{ background: TRACK }} role="img" aria-label={`${label}: ${typeof text === "string" ? text : ""}`}>
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: w(value), background: "var(--viz-1)" }} />
        {target !== null && <div className="absolute -inset-y-1 w-0.5 rounded bg-foreground" style={{ left: `calc(${w(target)} - 1px)` }} aria-hidden />}
      </div>
    </div>
  );
}

/** `floor`: whether the account sees the Shifts screen — the shift log's
 *  figures (each centre's pace, the losses, who is present) are shown only then. */
export function Cockpit({ data, floor = true }: { data: CockpitData; floor?: boolean }) {
  const finish = data.week.adherence.find((a) => a.stage === "finish");
  // already without the shift log's decisions for an account Shifts is closed to (withoutFloor)
  const actions = data.actions;
  // the card shows the oldest lines behind; the export carries them all
  const lateShown = data.week.late.slice(0, 20);
  const recentDays = Math.max(...data.centres.map((c) => c.recent.days), 0);
  const mp = data.manpower;
  // the centres short by half a person or more — the ones the card colours red
  const peopleShort = mp.rows.reduce((s, r) => s + (r.tone === "bad" ? -(r.gap ?? 0) : 0), 0);
  const burn = useMemo(() => burnUp(data.week.days).map((d, i) => ({ ...d, isPast: data.week.days[i].isPast })), [data.week.days]);
  const pace = useMemo(() => monthPace(mp.rows, mp), [mp]);
  const output = useMemo(() => dailyOutput(data.centres), [data.centres]);
  const pareto = useMemo(() => paretoOf(data.losses.causes), [data.losses.causes]);
  const plannedStops = data.losses.causes.filter((c) => c.planned);

  // the load card opens on the centre worst off: short at the end, then furthest behind
  const worst = useMemo(() => [...data.load].sort((a, b) => b.shortH - a.shortH || b.behindH - a.behindH)[0]?.centre ?? null, [data.load]);
  const [picked, setPicked] = useState<WorkCentre | null>(null);
  const loadCentre = data.load.find((l) => l.centre === picked) ?? data.load.find((l) => l.centre === worst) ?? data.load[0];
  const peopleMax = Math.max(1, ...mp.rows.map((r) => Math.max(r.neededNow ?? 0, floor ? r.present ?? 0 : 0)));
  const tile = { trend: data.trend, todayISO: data.todayISO };

  return (
    <div className="space-y-3">
      {/* today's decisions sit behind the Decisions button in the page head
          (CockpitDecisions); the paper carries them here */}
      <section className="print-only" aria-label="Needs a decision today">
        <h2>Needs a decision today</h2>
        <DecisionList actions={actions} />
      </section>

      {/* the headline figures, each against a week ago */}
      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]">
        <StatTile hero label="Plan delivered on its day" value={pctOrDash(finish?.rate)} meter={finish?.rate ?? undefined}
          sub={finish && finish.due > 0 ? `${finish.done} of ${finish.due} pcs due so far` : "nothing due yet"}
          delta={<WeekChange {...tile} pick={(p) => p.adherence.finish} rate up="good" />} />
        <StatTile label="Plan lines behind" value={String(data.week.lateCount)} sub="past their stage date"
          delta={<WeekChange {...tile} pick={(p) => p.late} up="bad" />} />
        <StatTile label="Welding covered" value={data.coverage.days === null ? "—" : `${fmt(data.coverage.days, 1)} d`}
          sub={data.coverage.band === "short" ? "short — welders may wait" : data.coverage.band === "heavy" ? "parts piling up" : "of cut parts in front of welding"}
          delta={<WeekChange {...tile} pick={(p) => p.coverageDays} unit=" d" />} />
        {floor && (
          <>
            <StatTile label="Fabrication efficiency" value={pctOrDash(data.fabrication.efficiency)} sub={`${fmt(data.fabrication.earnedH, 1)} std-h of ${fmt(data.fabrication.workedH, 1)} worked`}
              delta={<WeekChange {...tile} pick={(p) => p.fabEfficiency} rate up="good" />} />
            <StatTile label="Machine time lost" value={stopDurationLabel(data.losses.unplannedH)} sub={data.losses.fromISO ? `since ${formatDate(data.losses.fromISO)}` : "recent days"}
              delta={<WeekChange {...tile} pick={(p) => p.unplannedH} unit=" h" up="bad" />} />
            <StatTile label="People short" value={mp.leftWd > 0 && mp.rows.some((r) => r.gap !== null) ? String(Math.ceil(peopleShort)) : "—"} sub={mp.leftWd > 0 ? `to finish ${mp.monthLabel}'s plan` : "the month's working days are over"} />
          </>
        )}
      </div>

      {/* 1 — the week's plan, and the lines behind */}
      {data.week.planNo === null ? (
        <ChartCard title="Are we on this week's plan?" sub="No weekly plan imported yet">
          <EmptyState compact icon={Info} title="No weekly plan yet" hint="Import the weekly delivery schedule under Orders & plan imports." />
        </ChartCard>
      ) : (
        <div className="grid gap-3 xl:grid-cols-12">
          <ChartCard
            className="xl:col-span-6"
            title="Are we on this week's plan?"
            sub={`Weekly plan ${data.week.planNo}: ${data.week.covered} of ${data.week.req} pcs finished. Up to today the gap between the two lines is what is behind; after it, what is still to make.`}
            table={{ filename: `weekly-plan-${data.todayISO}.xlsx`, rows: [
              ...burn.map((d) => ({ Row: "Delivery day", Day: d.iso, Name: d.label, "Asked pcs": d.req, "Finished pcs": d.covered, "Asked summed": d.planCum, "Finished summed": d.doneCum })),
              ...data.week.adherence.map((a) => ({ Row: "Stage due by today", Day: data.todayISO, Name: STAGE_LABEL[a.stage], "Asked pcs": a.due, "Finished pcs": a.done, "Asked summed": "", "Finished summed": "" })),
            ] }}
          >
            <BurnUpChart points={burn} />
            <div className="grid gap-x-4 gap-y-2 sm:grid-cols-3 mt-3 pt-3 border-t">
              {data.week.adherence.map((a) => (
                <div key={a.stage}>
                  <div className="flex justify-between text-sm mb-1"><span className="font-semibold">{STAGE_LABEL[a.stage]}</span><span className="tabnum">{a.done}/{a.due} · <b>{pctOrDash(a.rate)}</b></span></div>
                  <Meter value={a.rate ?? 0} label={`${STAGE_LABEL[a.stage]}: ${a.done} of ${a.due} due by today`} />
                </div>
              ))}
            </div>
          </ChartCard>
          <ChartCard
            className="xl:col-span-6"
            title="Behind — where each line is stuck"
            sub={data.week.lateCount > lateShown.length ? `The oldest ${lateShown.length} of ${data.week.lateCount} — the export has them all; the first stage that is short` : "Oldest first; the first stage that is short"}
            table={{ filename: `plan-behind-${data.todayISO}.xlsx`, rows: data.week.late.map((l) => ({ Day: l.dayISO, Project: l.bom, SOI: l.soi ?? "", Item: itemName(l.item), "Stuck at": STAGE_LABEL[l.stage], Owed: l.owed, Short: l.short })) }}
          >
            {lateShown.length === 0 ? (
              <EmptyState compact icon={Info} title="Nothing behind" hint="Every line is at or ahead of its stage date." />
            ) : (
              // clamped so the card stays the height of the plan beside it (the global frame rule says 78vh)
              <TableFrame className="!max-h-[22rem]">
                <table className="w-full text-sm">
                  <thead><tr><Th label="Due" /><Th label="Project" /><Th label="Item" /><Th label="Stuck at" /><Th label="Short" num className="text-right" /></tr></thead>
                  <tbody>
                    {lateShown.map((l, i) => (
                      <tr key={i}>
                        <td className="px-2 tabnum whitespace-nowrap">{formatDate(l.dayISO)}</td>
                        <td className="px-2 whitespace-nowrap"><Link href={`/trace?bom=${encodeURIComponent(l.bom)}`} className="font-semibold hover:underline">{l.bom}</Link>{l.soi && <span className="text-muted ms-1">{l.soi}</span>}</td>
                        <td className="px-2">{itemName(l.item)}</td>
                        <td className="px-2"><Badge tone={l.stage === "cut" ? "danger" : "warning"}>{STAGE_LABEL[l.stage]}</Badge></td>
                        <td className="px-2 text-right tabnum font-bold">{l.short} <span className="text-muted font-normal">/ {l.owed}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableFrame>
            )}
          </ChartCard>
        </div>
      )}

      {/* 2 — the load ahead: a centre's running totals, and every centre's status beside */}
      <ChartCard
        title="Where is the crunch?"
        sub="Each centre's remaining plan hours over the next 10 working days against what it can work (the man-hours it usually has × the pace it has measured). It is short where what it owes so far passes what it could have worked so far. Pick a centre on the right."
        table={{ filename: `load-${data.todayISO}.xlsx`, rows: data.load.flatMap((l) => loadSeries(l).map((d) => ({ Centre: centreName(l.centre), Day: d.dayISO, "Due h": d.dueH, "Owed summed h": d.owedCum, "Can work summed h": d.canCum ?? "not measured" }))) }}
      >
        {data.load.length === 0 || !loadCentre ? (
          <EmptyState compact icon={Info} title="No load to show" hint="The weekly plan has nothing left to make, or nothing is priced yet." />
        ) : (
          <div className="grid gap-4 lg:grid-cols-12">
            <div className="lg:col-span-8 min-w-0">
              <LoadChart points={loadSeries(loadCentre)} centre={centreName(loadCentre.centre)} />
            </div>
            <ul className="lg:col-span-4 space-y-1" aria-label="Centres">
              {data.load.map((l) => {
                const catching = l.shortH === 0 && l.shortFromISO !== null && l.clearsISO !== null;
                const status = !l.measured ? "not measured" : l.shortH > 0 ? `${fmt(l.shortH, 1)} h short` : catching ? `${fmt(l.behindH, 1)} h behind · clear ${formatDate(l.clearsISO!)}` : "on track";
                const tone = !l.measured ? null : l.shortH > 0 ? "bad" : catching ? "warn" : "ok";
                const on = l.centre === loadCentre.centre;
                return (
                  <li key={l.centre}>
                    <button type="button" onClick={() => setPicked(l.centre)} aria-pressed={on}
                      className={`option w-full !py-1.5 text-left text-sm flex-wrap !gap-x-2 !gap-y-0 ${on ? "option-on" : ""}`}>
                      <span className="font-semibold flex-1">{centreName(l.centre)}</span>
                      <span className="tabnum text-muted" title="All the hours owed over the horizon, over all the hours it can work">{pctOrDash(l.loadRate)}</span>
                      <span className={`tabnum ${tone ? TONE_TEXT[tone] : "text-muted"} ${tone === "bad" ? "font-bold" : ""}`}>{status}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </ChartCard>

      {/* 3 — the month: its pace, and the people it needs */}
      <div className="grid gap-3 xl:grid-cols-12">
        <ChartCard
          className="xl:col-span-6"
          title="Are we on the month's pace?"
          sub={`${mp.monthLabel}: each centre's share of the month's plan done, the tick where an even pace stands today (${mp.monthWd - mp.leftWd} of ${mp.monthWd} working days behind us).`}
          table={{ filename: `month-pace-${data.todayISO}.xlsx`, rows: pace.map((r) => ({ Centre: centreName(r.centre), "Plan h": r.requiredH, "Done h": r.doneH, "Done %": r.doneShare === null ? "" : Math.round(r.doneShare * 100), "Even pace %": Math.round(r.expectedShare * 100), "Ahead (+) / behind (−) h": r.aheadH })) }}
        >
          {mp.pieces === 0 ? (
            <EmptyState compact icon={Info} title={`No orders on ${mp.monthLabel}'s plan`} hint="Import the monthly plan under Orders & plan imports — the month's pace is read from it." />
          ) : (
            <div className="space-y-3">
              {pace.map((r) => (
                <Bullet key={r.centre} label={centreName(r.centre)} value={r.doneShare ?? 0} target={r.expectedShare} max={1} tone={r.tone}
                  text={r.doneShare === null ? "nothing on the plan" : `${pct(r.doneShare)} done · ${r.aheadH >= 0 ? `${fmt(r.aheadH, 1)} h ahead` : `${fmt(-r.aheadH, 1)} h behind`}`} />
              ))}
            </div>
          )}
        </ChartCard>
        <ChartCard
          className="xl:col-span-6"
          title="Do we have the people?"
          sub={`What is left of ${mp.monthLabel}'s plan over the ${mp.leftWd} working days left × ${fmt(mp.hoursPerPersonDay, 1)} h a person.${floor ? " The bar is who comes on an average recorded day; the tick is who is needed from today." : " The tick is who is needed from today."}`}
          table={{ filename: `people-${data.todayISO}.xlsx`, rows: mp.rows.map((r) => ({ Centre: centreName(r.centre), "Plan h": r.requiredH, "Done h": r.doneH, "Left h": r.leftH, "Needed (month)": r.needed ?? "", "Needed from today": r.neededNow ?? "", ...(floor ? { Present: r.present ?? "", Gap: r.gap ?? "" } : {}) })) }}
        >
          {mp.pieces === 0 ? (
            <EmptyState compact icon={Info} title={`No orders on ${mp.monthLabel}'s plan`} hint="Import the monthly plan under Orders & plan imports — the people it needs are read from it." />
          ) : (
            <div className="space-y-3">
              {mp.rows.map((r) => (
                <Bullet key={r.centre} label={centreName(r.centre)} value={floor ? r.present ?? 0 : 0} target={r.neededNow} max={peopleMax} tone={floor ? r.tone : null}
                  text={floor
                    ? `need ${r.neededNow === null ? "—" : fmt(r.neededNow, 1)} · have ${r.present === null ? "—" : fmt(r.present, 1)}${r.gap === null ? "" : ` · ${signed(r.gap)}`}`
                    : `need ${r.neededNow === null ? "—" : fmt(r.neededNow, 1)} from today`} />
              ))}
            </div>
          )}
        </ChartCard>
      </div>

      {/* 4 — what the floor turned out, and welding's parts */}
      <div className="grid gap-3 xl:grid-cols-12">
        {floor && (
          <ChartCard
            className="xl:col-span-7"
            title="What did we turn out each day?"
            sub="Standard hours the output was worth, by department, against the man-hours the shift log booked — the gap between the bars and the line is the pace lost (or won)."
            table={{ filename: `output-${data.todayISO}.xlsx`, rows: output.map((d) => ({ Day: d.dateISO, ...Object.fromEntries(OUTPUT_GROUPS.map((g) => [`${OUTPUT_GROUP_LABEL[g]} h`, d[g]])), "Earned h": d.earnedH, "Booked h": d.workedH, "Efficiency %": d.efficiency === null ? "" : Math.round(d.efficiency * 100) })) }}
          >
            {output.length === 0 ? (
              <EmptyState compact icon={Info} title="No shift day recorded yet" hint={<>Record the day&apos;s attendance on <Link href="/shifts" className="text-brand-ink font-semibold hover:underline">Shifts</Link> — each day&apos;s output is set against the hours booked.</>} />
            ) : (
              <OutputChart days={output} />
            )}
          </ChartCard>
        )}
        <ChartCard
          className={floor ? "xl:col-span-5" : "xl:col-span-12"}
          title="Is welding covered?"
          sub={data.coverage.days === null
            ? "No recent welding to measure against."
            : `${fmt(data.coverage.days, 1)} days of cut parts in front of the welders: ${fmt(data.coverage.wipH, 1)} welding std-h waiting, against ${fmt(data.coverage.ratePerDay, 1)} std-h earned on a recorded day. Under 1 day they may wait; over 4, parts pile up.`}
          table={{ filename: `welding-coverage-${data.todayISO}.xlsx`, rows: data.coverage.byItem.map((b) => ({ Item: itemName(b.item), "Pieces waiting": b.pcs, "Welding std-h": b.weldH })) }}
        >
          {data.coverage.byItem.length === 0 ? (
            <EmptyState compact icon={Info} title="Nothing cut and waiting" hint="Every cut piece has been welded." />
          ) : (
            <div className="space-y-3">
              {data.coverage.byItem.map((b) => (
                <Bullet key={b.item} label={itemName(b.item)} value={b.weldH} target={null} max={data.coverage.byItem[0].weldH} text={`${fmt(b.weldH, 1)} h · ${b.pcs} pcs`} />
              ))}
            </div>
          )}
        </ChartCard>
      </div>

      {/* 5 — the shift log's side: each centre's pace over the days, and what stopped the machines */}
      {floor && (
        <div className="grid gap-3 xl:grid-cols-12">
          <ChartCard
            className="xl:col-span-7"
            title="Did each centre work at the standard?"
            sub={data.lastDayISO
              ? `Efficiency each recorded day (earned standard hours ÷ the man-hours booked there); the line across is the standard pace, 100%. The figure is the last ${recentDays} recorded days together.`
              : "No shift day recorded yet."}
            table={data.lastDayISO === null ? undefined : { filename: `centres-${data.todayISO}.xlsx`, rows: data.centres.map((c) => ({ Centre: centreName(c.centre), "Last day earned h": c.last.earnedH, "Last day worked h": c.last.workedH, "Last day %": c.last.efficiency === null ? "" : Math.round(c.last.efficiency * 100), "Recent earned h": c.recent.earnedH, "Recent worked h": c.recent.workedH, "Recent %": c.recent.efficiency === null ? "" : Math.round(c.recent.efficiency * 100), "People a day": c.recent.people, "Availability %": c.recent.availability === null ? "" : Math.round(c.recent.availability * 100), "Stopped h": c.recent.downtimeH })) }}
          >
            {data.lastDayISO === null ? (
              <EmptyState compact icon={Info} title="No shift day recorded yet" hint={<>Record the day&apos;s attendance on <Link href="/shifts" className="text-brand-ink font-semibold hover:underline">Shifts</Link> — each centre&apos;s pace is measured against the hours booked there.</>} />
            ) : (
              <PaceMultiples panels={data.centres.map((c) => ({ centre: centreName(c.centre), recent: c.recent.efficiency, points: c.trend.map((t) => ({ dateISO: t.dateISO, efficiency: t.efficiency })) }))} />
            )}
            {data.pricedShare !== null && data.pricedShare < 0.95 && (
              <p className="text-xs text-muted mt-2">
                {Math.round(data.pricedShare * 100)}% of the recent output carries standard hours — the rest earns nothing and reads as slow.{" "}
                <Link href="/admin/standard-times" className="text-brand-ink font-semibold hover:underline">Type its hours a piece →</Link>
              </p>
            )}
          </ChartCard>
          <ChartCard
            className="xl:col-span-5"
            title="What stopped us?"
            sub={`${stopDurationLabel(data.losses.unplannedH)} machine time lost${data.losses.fromISO ? ` since ${formatDate(data.losses.fromISO)}` : ""}, biggest cause first; Σ is the share it and the causes above make up. Absent ${pctOrDash(data.losses.absentRate)} of the recorded rows · overtime ${stopDurationLabel(data.losses.overtimeH)}.`}
            table={{ filename: `losses-${data.todayISO}.xlsx`, rows: data.losses.causes.map((c) => ({ Cause: c.label, Duration: stopDurationLabel(c.hours), Hours: c.hours, Stops: c.stops, "Share of lost %": c.share === null ? "" : Math.round(c.share * 100), Planned: c.planned ? "yes" : "" })) }}
          >
            {pareto.length === 0 ? (
              <EmptyState compact icon={Info} title="No unplanned stop recorded" hint={<>Record stops on <Link href="/shifts" className="text-brand-ink font-semibold hover:underline">Shifts → Machine stops</Link> to see what costs the most.</>} />
            ) : (
              // a Pareto as rows: biggest cause first, its share and (Σ) the share it and the causes above make up
              <div className="space-y-3">
                {pareto.map((c) => (
                  <Bullet key={c.code} label={c.label} value={c.hours} target={null} max={pareto[0].hours}
                    text={`${stopDurationLabel(c.hours)} · ${c.stops} stop${c.stops === 1 ? "" : "s"} · ${Math.round(c.share * 100)}%${pareto.length > 1 ? ` (Σ ${Math.round(c.cumShare * 100)}%)` : ""}`} />
                ))}
              </div>
            )}
            {plannedStops.length > 0 && (
              <p className="text-sm text-muted mt-2">Planned maintenance, kept apart: {plannedStops.map((c) => `${stopDurationLabel(c.hours)} (${c.stops} stop${c.stops === 1 ? "" : "s"})`).join(", ")}.</p>
            )}
          </ChartCard>
        </div>
      )}

      {/* 6 — why: the hours walked down to what they earned */}
      {floor && <LossWaterfallCard />}
    </div>
  );
}
