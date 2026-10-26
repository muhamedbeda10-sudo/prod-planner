"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ChartCard, StatTile, TONE_TEXT, fmt, pct, pctOrDash, signed } from "@/components/charts/kit";
import { DecisionList, PrintDecisions } from "@/components/CockpitDecisions";
import { TableFrame, Th } from "@/components/DataTable";
import { dashHref } from "@/lib/domain/dashboardScope";
import type { CockpitAction } from "@/lib/domain/kpis";
import { LV_FLOOR_DEPT_LABEL } from "@/lib/domain/lvKpis";
import { WORK_CENTRE_LABEL } from "@/lib/domain/shifts";
import type { PlantPlanningSummary } from "@/lib/domain/plantKpis";
import type { CockpitData } from "@/lib/server/kpis";
import type { LvPlanningData } from "@/lib/server/lvKpis";

/** What the plant's page needs of each line — the page sends no more to the browser. */
export type PlantPlanningTr = Pick<CockpitData, "todayISO" | "week" | "manpower" | "wip">;
export type PlantPlanningLv = Pick<LvPlanningData, "month" | "open" | "wip" | "urgentStuck" | "manpower">;

// The whole plant's Planning dashboard: the headline of each line, then the
// two side by side. The lines are planned differently — the transformers
// on dated weekly promises, the panels on a month with no delivery date —
// so plan progress is shown per line and never as one percentage; people
// add up (each line has its own departments), pieces never do.

export function PlantPlanning({ tr, lv, floor, actions, summary }: { tr: PlantPlanningTr; lv: PlantPlanningLv; floor: boolean; actions: readonly CockpitAction[]; summary: PlantPlanningSummary }) {
  const finish = tr.week.adherence.find((a) => a.stage === "finish");
  // the people, both lines in one table and one export
  const peopleRows = [
    ...tr.manpower.rows.map((r) => ({ key: `TR-${r.centre}`, line: "TR", label: WORK_CENTRE_LABEL[r.centre], ...r })),
    ...lv.manpower.rows.map((r) => ({ key: `LV-${r.centre}`, line: "LV", label: LV_FLOOR_DEPT_LABEL[r.centre], ...r })),
  ];
  const people = (rows: readonly { neededNow: number | null; present: number | null }[]) => {
    const need = rows.reduce((s, r) => s + (r.neededNow ?? 0), 0);
    const have = rows.some((r) => r.present !== null) ? rows.reduce((s, r) => s + (r.present ?? 0), 0) : null;
    return `need ${fmt(need, 1)}${floor ? ` · have ${have === null ? "—" : fmt(have, 1)}` : ""}`;
  };
  const trCut = tr.wip.cutNotWelded.reduce((s, b) => s + b.pcs, 0);
  const trWeld = tr.wip.weldedNotFinished.reduce((s, b) => s + b.pcs, 0);
  const rows: { label: string; TR: string; LV: string; note?: string }[] = [
    { label: "Plan progress", TR: finish ? `${pctOrDash(finish.rate)} delivered on its day (${finish.done} of ${finish.due} pcs due by today, weekly plan ${tr.week.planNo ?? "—"})` : "no weekly plan", LV: lv.month.panels > 0 ? `${pctOrDash(lv.month.pace.doneShare)} of ${lv.month.monthLabel}'s panels painted (${lv.month.complete} of ${lv.month.panels}); an even pace stands at ${pct(lv.month.pace.expectedShare)}` : "no panels on the month's plan", note: "Judged per line: dated promises on one, a month's pace on the other." },
    { label: "Behind", TR: `${tr.week.lateCount} plan line${tr.week.lateCount === 1 ? "" : "s"} past their stage date`, LV: `${lv.urgentStuck.length} urgent order${lv.urgentStuck.length === 1 ? "" : "s"} still short (no delivery dates to be late against)` },
    { label: "Work between the stages", TR: `${fmt(trCut)} pcs cut, not welded · ${fmt(trWeld)} pcs welded, not finished`, LV: `${fmt(lv.wip.waitingBend)} wait for bending · ${fmt(lv.wip.waitingWeld)} for welding · ${fmt(lv.wip.waitingPaint)} for painting`, note: "Pieces of one line are never added to the other's." },
    { label: "Held and sent back", TR: `${tr.wip.held.orders} order${tr.wip.held.orders === 1 ? "" : "s"} on hold · ${tr.wip.returnsOpen.count} return${tr.wip.returnsOpen.count === 1 ? "" : "s"} open (${fmt(tr.wip.returnsOpen.qty)} pcs)`, LV: `${lv.open.onHold} order${lv.open.onHold === 1 ? "" : "s"} on hold (${fmt(lv.wip.onHold)} panels)` },
    { label: "People from today", TR: tr.manpower.pieces > 0 ? people(tr.manpower.rows) : "no month plan", LV: lv.month.panels > 0 && lv.manpower.coverage.priced > 0 ? people(lv.manpower.rows) : lv.month.panels > 0 ? "no panel of the month is priced" : "no month plan", note: "Each line's own departments; the one shot-blast crew is counted on the transformers' side." },
    ...(floor ? [{ label: "Efficiency, last recorded days", TR: pctOrDash(summary.recentEfficiency.TR), LV: pctOrDash(summary.recentEfficiency.LV), note: `Each line's standard hours ÷ its own man-hours; the plant's, from the sums: ${pctOrDash(summary.recentEfficiency.plant)}.` }] : []),
  ];

  return (
    <div className="space-y-3">
      <PrintDecisions actions={actions} />

      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]">
        <StatTile hero label="TR — plan delivered on its day" value={pctOrDash(finish?.rate)} meter={finish?.rate ?? undefined} sub={finish && finish.due > 0 ? `${finish.done} of ${finish.due} pcs due so far` : "nothing due yet"} />
        <StatTile label="TR — plan lines behind" value={String(tr.week.lateCount)} sub="past their stage date" />
        <StatTile hero label={`LV — ${lv.month.monthLabel} painted`} value={pctOrDash(lv.month.pace.doneShare)} meter={lv.month.pace.doneShare ?? undefined} sub={lv.month.panels > 0 ? `${lv.month.complete} of ${lv.month.panels} panels · even pace ${pct(lv.month.pace.expectedShare)}` : "no panels on the month's plan"} />
        <StatTile label="LV — urgent orders short" value={String(lv.urgentStuck.length)} sub={`of ${lv.open.urgent} urgent open`} />
        {floor && <StatTile label="People short — plant" value={String(summary.peopleShort.total)} sub={`TR ${summary.peopleShort.TR} · LV ${summary.peopleShort.LV} — distinct departments, so they add`} />}
      </div>

      <div className="grid gap-3 xl:grid-cols-12">
        <ChartCard className="xl:col-span-7" title="The two lines side by side" sub="Each line in its own terms. Standard hours and people add across the plant; pieces and plan percentages do not, so none is added here."
          table={{ rows: rows.map((r) => ({ Figure: r.label, Transformers: r.TR, "LV panels": r.LV, Note: r.note ?? "" })) }}>
          <TableFrame className="!max-h-none">
            <table className="w-full text-sm">
              <thead><tr><Th label="" /><Th label="Transformers" /><Th label="LV panels" /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label}>
                    <th scope="row" className="px-2 py-1.5 text-left font-semibold whitespace-nowrap align-top">{r.label}{r.note && <span className="block text-xs text-muted font-normal whitespace-normal">{r.note}</span>}</th>
                    <td className="px-2 py-1.5 align-top">{r.TR}</td>
                    <td className="px-2 py-1.5 align-top">{r.LV}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
          <div className="flex flex-wrap gap-3 mt-3 text-sm">
            <Link href={dashHref("/", "TR")} className="text-brand-ink font-semibold inline-flex items-center gap-1 hover:underline">Transformers&apos; planning <ArrowRight size={13} aria-hidden /></Link>
            <Link href={dashHref("/", "LV")} className="text-brand-ink font-semibold inline-flex items-center gap-1 hover:underline">LV panels&apos; planning <ArrowRight size={13} aria-hidden /></Link>
            <Link href={dashHref("/dashboards/production", "all")} className="text-brand-ink font-semibold inline-flex items-center gap-1 hover:underline">The plant&apos;s production <ArrowRight size={13} aria-hidden /></Link>
          </div>
        </ChartCard>
        <ChartCard className="xl:col-span-5" title="Needs a decision today" sub="Both lines' decisions in one list, worst first, each tagged with its line.">
          <DecisionList actions={actions} />
        </ChartCard>
      </div>

      {floor && (
        <ChartCard title="Who is needed where, from today" sub={`${tr.manpower.monthLabel}: the people each department needs on each remaining working day for what is left of the month's plan, against who comes on an average recorded day. Each line prices its own plan; the shot-blast crew is the transformers' and blasts the panels too.`}
          table={{ rows: peopleRows.map((r) => ({ Line: r.line, Department: r.label, "Needed from today": r.neededNow ?? "", Present: r.present ?? "", Gap: r.gap ?? "" })) }}>
          <TableFrame className="!max-h-[24rem]">
            <table className="w-full text-sm">
              <thead><tr><Th label="Line" /><Th label="Department" /><Th label="Needed from today" num className="text-right" /><Th label="Present" num className="text-right" /><Th label="Gap" num className="text-right" /></tr></thead>
              <tbody>
                {peopleRows.map((r) => (
                  <tr key={r.key}>
                    <td className="px-2"><span className="pill pill-muted">{r.line}</span></td>
                    <td className="px-2 font-semibold whitespace-nowrap">{r.label}</td>
                    <td className="px-2 text-right tabnum">{r.neededNow === null ? "—" : fmt(r.neededNow, 1)}</td>
                    <td className="px-2 text-right tabnum">{r.present === null ? "—" : fmt(r.present, 1)}</td>
                    <td className={`px-2 text-right tabnum font-bold ${r.tone ? TONE_TEXT[r.tone] : ""}`}>{r.gap === null ? "—" : signed(r.gap)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        </ChartCard>
      )}
    </div>
  );
}
