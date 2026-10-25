"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, Bot, CircleAlert, Info } from "lucide-react";
import { ChartCard, Meter, Sparkline, StatTile, fmt, pct } from "@/components/charts/kit";
import { Badge } from "@/components/Badge";
import { EmptyState } from "@/components/primitives";
import { TableFrame, Th } from "@/components/DataTable";
import { useAiPanel } from "@/components/AiPanel";
import { formatDate } from "@/lib/domain/format";
import { stopDurationLabel } from "@/lib/domain/downtime";
import { ITEM_NAME, isItem } from "@/lib/domain/constants";
import { WORK_CENTRE_LABEL, type WorkCentre } from "@/lib/domain/shifts";
import { STAGE_LABEL, efficiencyBand, isFloorAction } from "@/lib/domain/kpis";
import type { CockpitData } from "@/lib/server/kpis";

// 🧭 The planner's cockpit — six questions, each a card with the figure and
// the list to act on, worst news first. Every number is standard hours (what
// the work is worth), never pieces, so Fabrication's ten projects a day add
// up. The figures come from lib/server/kpis.ts; the assistant reads the same
// loader.
//
// The page is a 12-column grid: a short card sits beside a long one, so no
// card leaves a hole under it, and every row fills the width.

const TONE_TEXT = { ok: "text-ok-fg", warn: "text-warn-fg", bad: "text-bad-fg" } as const;
const ACTION_ICON = { bad: CircleAlert, warn: AlertTriangle, info: Info } as const;
const ACTION_TONE = { bad: "text-bad-fg", warn: "text-warn-fg", info: "text-info-fg" } as const;

const pctOrDash = (v: number | null | undefined) => (v === null || v === undefined ? "—" : pct(v));
const itemName = (it: string) => (isItem(it) ? ITEM_NAME[it] : it);
const centreName = (c: WorkCentre) => WORK_CENTRE_LABEL[c];

/** A list of named amounts, the longest bar the full width. */
function Bars({ rows, unit }: { rows: { key: string; label: string; value: number; valueLabel?: string; text: React.ReactNode }[]; unit: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.key}>
          <div className="flex justify-between gap-2 text-sm mb-1"><span className="font-semibold">{r.label}</span><span className="tabnum">{r.text}</span></div>
          <Meter value={r.value / max} label={`${r.label}: ${r.valueLabel ?? `${fmt(r.value, 1)} ${unit}`}`} />
        </div>
      ))}
    </div>
  );
}

/** `floor`: whether the account sees the Shifts screen — the shift log's
 *  figures (each centre's pace, the losses) are shown only then. */
export function Cockpit({ data, floor = true }: { data: CockpitData; floor?: boolean }) {
  const ai = useAiPanel();
  const finish = data.week.adherence.find((a) => a.stage === "finish");
  const actions = floor ? data.actions : data.actions.filter((a) => !isFloorAction(a));
  // a day the trend does not know is left out, never drawn as 0
  const spark = (k: "late" | "coverageDays") => data.trend.flatMap((t) => (t[k] === null || t[k] === undefined ? [] : [t[k]]));
  const recentDays = Math.max(...data.centres.map((c) => c.recent.days), 0);
  const mp = data.manpower;
  // the centres short by half a person or more — the ones the card colours red
  const peopleShort = mp.rows.reduce((s, r) => s + (r.tone === "bad" ? -(r.gap ?? 0) : 0), 0);

  return (
    <div className="space-y-3">
      {/* today's decisions, worst first */}
      <section className="bg-surface border rounded-xl p-3 md:p-4" aria-labelledby="decide">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h2 id="decide" className="!mb-0">Needs a decision today</h2>
          {ai && (
            <button type="button" className="btn btn-sm btn-secondary ms-auto no-print" onClick={() => ai.open()} title="Ask the assistant about these figures — it reads the same cockpit">
              <Bot size={14} aria-hidden /> Ask the assistant
            </button>
          )}
        </div>
        {actions.length === 0 ? (
          <p className="text-sm text-ok-fg font-semibold">Nothing pressing — the plan, the centres and welding&apos;s parts are all on track.</p>
        ) : (
          <ul className="space-y-1.5">
            {actions.map((a, i) => {
              const Icon = ACTION_ICON[a.tone];
              return (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <Icon size={16} className={`mt-0.5 shrink-0 ${ACTION_TONE[a.tone]}`} aria-hidden />
                  <span className="flex-1">{a.text}</span>
                  <Link href={a.href} className="no-print shrink-0 text-brand-ink font-semibold inline-flex items-center gap-1 hover:underline">Open <ArrowRight size={13} aria-hidden /></Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* the headline figures, spread over the width */}
      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]">
        <StatTile hero label="Plan delivered on its day" value={pctOrDash(finish?.rate)} sub={finish && finish.due > 0 ? `${finish.done} of ${finish.due} pcs due so far this plan` : "nothing due yet"} meter={finish?.rate ?? undefined} />
        <StatTile label="Plan lines behind" value={String(data.week.lateCount)} sub="past their stage date" spark={spark("late")} />
        <StatTile label="Welding covered" value={data.coverage.days === null ? "—" : `${fmt(data.coverage.days, 1)} d`} sub={data.coverage.band === "short" ? "short — welders may wait" : data.coverage.band === "heavy" ? "parts piling up" : "of cut parts in front of welding"} spark={spark("coverageDays")} />
        {floor && (
          <>
            <StatTile label="Fabrication efficiency" value={pctOrDash(data.fabrication.efficiency)} sub={`${fmt(data.fabrication.earnedH, 1)} std-h earned of ${fmt(data.fabrication.workedH, 1)} worked`} />
            <StatTile label="Machine hours lost" value={stopDurationLabel(data.losses.unplannedH)} sub={data.losses.fromISO ? `since ${formatDate(data.losses.fromISO)}` : "recent days"} />
            <StatTile label="People short" value={mp.leftWd > 0 && mp.rows.some((r) => r.gap !== null) ? String(Math.ceil(peopleShort)) : "—"} sub={mp.leftWd > 0 ? `to finish ${mp.monthLabel}'s plan from today` : "the month's working days are over"} />
          </>
        )}
      </div>

      {/* 1 — the plan: what each stage owed, and the lines behind */}
      {data.week.planNo === null ? (
        <ChartCard title="Are we on this week's plan?" sub="No weekly plan imported yet">
          <EmptyState compact icon={Info} title="No weekly plan yet" hint="Import the weekly delivery schedule under Orders & plan imports." />
        </ChartCard>
      ) : (
        <div className="grid gap-3 xl:grid-cols-12">
          <ChartCard
            className="xl:col-span-5"
            title="Are we on this week's plan?"
            sub={`Weekly plan ${data.week.planNo} · ${data.week.covered} of ${data.week.req} pcs finished. Pieces due at each stage by today (the oven date less its lead days), and how many are done.`}
            table={{ filename: `plan-adherence-${data.todayISO}.xlsx`, rows: data.week.adherence.map((a) => ({ Stage: STAGE_LABEL[a.stage], "Due by today": a.due, Done: a.done, "On time %": a.rate === null ? "" : Math.round(a.rate * 100) })) }}
          >
            <div className="space-y-2.5">
              {data.week.adherence.map((a) => (
                <div key={a.stage}>
                  <div className="flex justify-between text-sm mb-1"><span className="font-semibold">{STAGE_LABEL[a.stage]}</span><span className="tabnum">{a.done} / {a.due} · <b>{pctOrDash(a.rate)}</b></span></div>
                  <Meter value={a.rate ?? 0} label={`${STAGE_LABEL[a.stage]}: ${pctOrDash(a.rate)}`} />
                </div>
              ))}
              <div className="pt-2 border-t">
                <div className="text-sm font-bold text-muted mb-1.5">Finished, by delivery day</div>
                <div className="grid gap-1.5 grid-cols-3 sm:grid-cols-6">
                  {data.week.days.map((d) => (
                    <div key={d.iso} className={`rounded-md border px-2 py-1 text-sm text-center ${d.isToday ? "border-brand" : ""}`}>
                      <div className="font-bold whitespace-nowrap">{d.label}</div>
                      <div className={`tabnum ${d.isPast && d.covered < d.req ? "text-bad-fg font-bold" : "text-muted"}`}>{d.covered} / {d.req}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </ChartCard>
          <ChartCard
            className="xl:col-span-7"
            title="Behind — where each line is stuck"
            sub={data.week.lateCount > data.week.late.length ? `The oldest ${data.week.late.length} of ${data.week.lateCount}; the first stage that is short` : "Oldest first; the first stage that is short"}
            table={{ filename: `plan-behind-${data.todayISO}.xlsx`, rows: data.week.late.map((l) => ({ Day: l.dayISO, Project: l.bom, SOI: l.soi ?? "", Item: itemName(l.item), "Stuck at": STAGE_LABEL[l.stage], Owed: l.owed, Short: l.short })) }}
          >
            {data.week.late.length === 0 ? (
              <EmptyState compact icon={Info} title="Nothing behind" hint="Every line is at or ahead of its stage date." />
            ) : (
              // clamped so the card stays the height of the plan beside it (the global frame rule says 78vh)
              <TableFrame className="!max-h-[20rem]">
                <table className="w-full text-sm">
                  <thead><tr><Th label="Due" /><Th label="Project" /><Th label="Item" /><Th label="Stuck at" /><Th label="Short" num className="text-right" /></tr></thead>
                  <tbody>
                    {data.week.late.map((l, i) => (
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

      {/* 2 — the load ahead */}
      <ChartCard
          title="Where is the crunch?"
          sub="The plan's remaining hours against what each centre can work over the next 10 working days. Capacity a day = the man-hours the centre usually has × the pace it has measured; a centre is short once what it owes so far passes what it could have worked so far."
          table={{ filename: `load-${data.todayISO}.xlsx`, rows: data.load.flatMap((l) => l.days.map((d) => ({ Centre: centreName(l.centre), Day: d.dayISO, "Due h": d.dueH, "Capacity h": l.measured ? d.capacityH : "not measured" }))) }}
        >
          {data.load.length === 0 ? (
            <EmptyState compact icon={Info} title="No load to show" hint="The weekly plan has nothing left to make, or nothing is priced yet." />
          ) : (
            <TableFrame>
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <Th label="Centre" />
                    <Th label="Load" num className="text-right" hint="All the hours owed over the horizon, over all the hours it can work" />
                    <Th label="Status" hint="Falling behind and when it catches up at its usual pace, or short at the end of the horizon" />
                    {data.load[0].days.map((d) => <Th key={d.dayISO} label={formatDate(d.dayISO)} center />)}
                  </tr>
                </thead>
                <tbody>
                  {data.load.map((l) => {
                    // the running total over the whole horizon is the last day's
                    const rateTone = l.loadRate === null ? "text-muted" : l.days.at(-1)?.tone === "bad" ? "text-bad-fg" : l.days.at(-1)?.tone === "warn" ? "text-warn-fg" : "text-ok-fg";
                    const catching = l.shortH === 0 && l.shortFromISO !== null && l.clearsISO !== null;
                    return (
                      <tr key={l.centre}>
                        <td className="px-2 font-semibold whitespace-nowrap">{centreName(l.centre)}</td>
                        <td className={`px-2 text-right tabnum font-bold ${rateTone}`}>{pctOrDash(l.loadRate)}</td>
                        <td className={`px-2 whitespace-nowrap ${!l.measured ? "text-muted" : l.shortH > 0 ? "text-bad-fg font-bold" : catching ? "text-warn-fg font-semibold" : "text-ok-fg"}`} title={!l.measured ? "No man-hours booked to this centre lately, so there is no capacity to judge by" : undefined}>
                          {!l.measured ? "not measured" : l.shortH > 0 ? `${fmt(l.shortH, 1)} h short` : catching ? `${fmt(l.behindH, 1)} h behind · clear ${formatDate(l.clearsISO!)}` : "on track"}
                        </td>
                        {l.days.map((d) => (
                          <td key={d.dayISO} className={`px-1 text-center tabnum ${d.tone === "bad" ? "bg-bad-bg text-bad-fg" : d.tone === "warn" ? "bg-warn-bg text-warn-fg" : ""}`} title={l.measured ? `Due ${fmt(d.dueH, 1)} h · can work ${fmt(d.capacityH, 1)} h` : `Due ${fmt(d.dueH, 1)} h`}>{d.dueH > 0 ? Math.round(d.dueH) : "·"}</td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableFrame>
          )}
      </ChartCard>

      {/* 3 — the month in people, with welding's parts beside it */}
      <div className="grid gap-3 xl:grid-cols-12">
        <ChartCard
          className="xl:col-span-7"
          title="Do we have the people?"
          sub={`${mp.monthLabel}: the plan's ${mp.pieces} transformers in standard hours over ${mp.monthWd} working days × ${fmt(mp.hoursPerPersonDay, 1)} h a person; "from today" is what is left over the ${mp.leftWd} working days left.${floor ? " Present = people on an average recorded day lately." : ""}`}
          table={{ filename: `people-${data.todayISO}.xlsx`, rows: mp.rows.map((r) => ({ Centre: centreName(r.centre), "Plan h": r.requiredH, "Done h": r.doneH, "Left h": r.leftH, "Needed (month)": r.needed ?? "", "Needed from today": r.neededNow ?? "", ...(floor ? { Present: r.present ?? "", Gap: r.gap ?? "" } : {}) })) }}
        >
          {mp.pieces === 0 ? (
            <EmptyState compact icon={Info} title={`No orders on ${mp.monthLabel}'s plan`} hint="Import the monthly plan under Orders & plan imports — the people it needs are read from it." />
          ) : (
            <TableFrame>
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <Th label="Centre" />
                    <Th label="Plan" num className="text-right" unit="h" hint="Standard hours the month's plan asks of the centre, outsourced pieces left out" />
                    <Th label="Done" num className="text-right" unit="h" hint="Earned on the month's orders — all of it, for an order carried over from an earlier month" />
                    <Th label="Left" num className="text-right" unit="h" />
                    <Th label="Needed" num className="text-right" hint="People on an average working day of the month" />
                    <Th label="From today" num className="text-right" hint="People each remaining working day needs for what is left" />
                    {floor && <Th label="Present" num className="text-right" hint="People on an average recorded day lately" />}
                    {floor && <Th label="Gap" num className="text-right" hint="Present less needed from today: to spare (+) or short (−)" />}
                  </tr>
                </thead>
                <tbody>
                  {mp.rows.map((r) => (
                    <tr key={r.centre}>
                      <td className="px-2 font-semibold whitespace-nowrap">{centreName(r.centre)}</td>
                      <td className="px-2 text-right tabnum">{fmt(r.requiredH, 1)}</td>
                      <td className="px-2 text-right tabnum">{fmt(r.doneH, 1)}</td>
                      <td className="px-2 text-right tabnum">{fmt(r.leftH, 1)}</td>
                      <td className="px-2 text-right tabnum">{r.needed === null ? "—" : fmt(r.needed, 1)}</td>
                      <td className="px-2 text-right tabnum font-bold">{r.neededNow === null ? "—" : fmt(r.neededNow, 1)}</td>
                      {floor && <td className="px-2 text-right tabnum">{r.present === null ? "—" : fmt(r.present, 1)}</td>}
                      {floor && <td className={`px-2 text-right tabnum font-bold ${r.tone ? TONE_TEXT[r.tone] : "text-muted"}`}>{r.gap === null ? "—" : r.gap > 0 ? `+${fmt(r.gap, 1)}` : fmt(r.gap, 1)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
          )}
        </ChartCard>
        <ChartCard
          className="xl:col-span-5"
          title="Is welding covered?"
          sub={data.coverage.days === null
            ? "No recent welding to measure against."
            : `${fmt(data.coverage.days, 1)} days of cut parts in front of the welders: ${fmt(data.coverage.wipH, 1)} welding std-h waiting, against ${fmt(data.coverage.ratePerDay, 1)} std-h earned on a recorded day. Under 1 day they may wait; over 4, parts pile up.`}
          table={{ filename: `welding-coverage-${data.todayISO}.xlsx`, rows: data.coverage.byItem.map((b) => ({ Item: itemName(b.item), "Pieces waiting": b.pcs, "Welding std-h": b.weldH })) }}
        >
          {data.coverage.byItem.length === 0 ? (
            <EmptyState compact icon={Info} title="Nothing cut and waiting" hint="Every cut piece has been welded." />
          ) : (
            <Bars unit="welding std-h" rows={data.coverage.byItem.map((b) => ({ key: b.item, label: itemName(b.item), value: b.weldH, text: <><b>{fmt(b.weldH, 1)} h</b> <span className="text-muted">· {b.pcs} pcs</span></> }))} />
          )}
        </ChartCard>
      </div>

      {/* 3 — the shift log's side: each centre's pace, and what stopped the machines */}
      {floor && (
        <div className="grid gap-3 xl:grid-cols-12">
          <ChartCard
            className="xl:col-span-7"
            title="Did each centre work at the standard?"
            sub={data.lastDayISO
              ? `Earned = the standard hours the output is worth; worked = the man-hours the shift log booked there; 100% is the standard pace. Last recorded day ${formatDate(data.lastDayISO)}; recent = the last ${recentDays} recorded days.`
              : "No shift day recorded yet."}
            table={data.lastDayISO === null ? undefined : { filename: `centres-${data.todayISO}.xlsx`, rows: data.centres.map((c) => ({ Centre: centreName(c.centre), "Last day earned h": c.last.earnedH, "Last day worked h": c.last.workedH, "Last day %": c.last.efficiency === null ? "" : Math.round(c.last.efficiency * 100), "Recent earned h": c.recent.earnedH, "Recent worked h": c.recent.workedH, "Recent %": c.recent.efficiency === null ? "" : Math.round(c.recent.efficiency * 100), "People a day": c.recent.people, "Stopped h": c.recent.downtimeH })) }}
          >
            {data.lastDayISO === null ? (
              <EmptyState compact icon={Info} title="No shift day recorded yet" hint={<>Record the day&apos;s attendance on <Link href="/shifts" className="text-brand-ink font-semibold hover:underline">Shifts</Link> — each centre&apos;s pace is measured against the hours booked there.</>} />
            ) : (
              <TableFrame>
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <Th label="Centre" />
                      <Th label="Last day" num className="text-right" hint="Efficiency on the last recorded day" />
                      <Th label="Recent" num className="text-right" hint="Efficiency over the recent recorded days — the figure to read; one day swings with late logging" />
                      <Th label="Earned" num className="text-right" unit="h" />
                      <Th label="Worked" num className="text-right" unit="h" />
                      <Th label="People" num className="text-right" hint="Present on an average recorded day" />
                      <Th label="Avail." num className="text-right" hint="Availability: machine hours less the stops, over the machine hours" />
                      <Th label="Trend" hint="Efficiency per recorded day" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.centres.map((c) => {
                      const band = efficiencyBand(c.recent.efficiency);
                      const lastBand = efficiencyBand(c.last.efficiency);
                      // a day with nothing to measure is left out, never drawn as 0%
                      const pts = c.trend.flatMap((t) => (t.efficiency === null ? [] : [Math.round(t.efficiency * 100)]));
                      return (
                        <tr key={c.centre}>
                          <td className="px-2 font-semibold whitespace-nowrap">{centreName(c.centre)}</td>
                          <td className={`px-2 text-right tabnum ${lastBand ? TONE_TEXT[lastBand] : "text-muted"}`}>{pctOrDash(c.last.efficiency)}</td>
                          <td className={`px-2 text-right tabnum font-bold ${band ? TONE_TEXT[band] : "text-muted"}`}>{pctOrDash(c.recent.efficiency)}</td>
                          <td className="px-2 text-right tabnum">{fmt(c.recent.earnedH, 1)}</td>
                          <td className="px-2 text-right tabnum">{fmt(c.recent.workedH, 1)}</td>
                          <td className="px-2 text-right tabnum">{c.recent.people ? fmt(c.recent.people, 1) : "—"}</td>
                          <td className="px-2 text-right tabnum">{pctOrDash(c.recent.availability)}</td>
                          <td className="px-2">{pts.length > 1 ? <Sparkline values={pts} /> : <span className="text-muted">—</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableFrame>
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
            sub={`${stopDurationLabel(data.losses.unplannedH)} machine time lost${data.losses.fromISO ? ` since ${formatDate(data.losses.fromISO)}` : ""}${data.losses.plannedH > 0 ? ` · ${stopDurationLabel(data.losses.plannedH)} planned maintenance` : ""} · absent ${pctOrDash(data.losses.absentRate)} of the recorded rows · overtime ${stopDurationLabel(data.losses.overtimeH)}`}
            table={{ filename: `losses-${data.todayISO}.xlsx`, rows: data.losses.causes.map((c) => ({ Cause: c.label, Duration: stopDurationLabel(c.hours), Hours: c.hours, Stops: c.stops, "Share of lost %": c.share === null ? "" : Math.round(c.share * 100) })) }}
          >
            {data.losses.causes.length === 0 ? (
              <EmptyState compact icon={Info} title="No machine stops recorded" hint={<>Record stops on <Link href="/shifts" className="text-brand-ink font-semibold hover:underline">Shifts → Machine stops</Link> to see what costs the most.</>} />
            ) : (
              <Bars unit="h" rows={data.losses.causes.map((c) => ({ key: c.code, label: c.label, value: c.hours, valueLabel: stopDurationLabel(c.hours), text: <><b>{stopDurationLabel(c.hours)}</b> <span className="text-muted">· {c.stops} stop(s){c.share !== null ? ` · ${Math.round(c.share * 100)}%` : " · planned"}</span></> }))} />
            )}
          </ChartCard>
        </div>
      )}
    </div>
  );
}
