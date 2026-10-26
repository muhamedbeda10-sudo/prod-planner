"use client";

import Link from "next/link";
import { Info } from "lucide-react";
import { Bullet, ChartCard, StatTile, TONE_TEXT, fmt, pct, pctOrDash, signed } from "@/components/charts/kit";
import { Badge } from "@/components/Badge";
import { EmptyState } from "@/components/primitives";
import { TableFrame, Th } from "@/components/DataTable";
import { PrintDecisions } from "@/components/CockpitDecisions";
import { LvStageTable } from "@/components/LvStageTable";
import { LV_STAGE_LABEL } from "@/lib/domain/lv";
import { LV_FLOOR_DEPT_LABEL } from "@/lib/domain/lvKpis";
import { combinedStat, paceTone, peopleShort } from "@/lib/domain/kpis";
import type { LvPlanningData } from "@/lib/server/lvKpis";

// The LV panels' Planning dashboard: will the month's plan be made? Where
// does the work wait between the stages? Do we have the people? The panels
// are planned month by month with no delivery date of their own, so the plan
// is judged against an even pace through the month's working days — never
// the transformers' oven dates or lead days. The figures come from
// lib/server/lvKpis.ts; the assistant reads the same loader.

export function LvPlanning({ data, floor = true }: { data: LvPlanningData; floor?: boolean }) {
  const m = data.month;
  const pace = m.pace;
  const w = data.wip;
  const mp = data.manpower;
  const short = peopleShort(mp.rows);
  const recent = { ...combinedStat(data.depts), days: Math.max(0, ...data.depts.map((d) => d.days)) };
  const peopleMax = Math.max(1, ...mp.rows.map((r) => Math.max(r.neededNow ?? 0, floor ? r.present ?? 0 : 0)));
  const wipRows = [
    ["Planned, not punched", w.notStarted, "/worklist/punching"],
    ["Punched, waiting for bending", w.waitingBend, "/worklist/bending"],
    ["Bent, waiting for welding", w.waitingWeld, "/worklist/welding"],
    ["Welded, waiting for painting", w.waitingPaint, "/worklist/painting"],
    ["Painted, not delivered", w.waitingDelivery, "/tracker"],
    ["On hold — out of every queue", w.onHold, "/tracker?status=hold"],
  ] as const;
  const wipMax = Math.max(1, ...wipRows.map((r) => r[1]));
  const unpriced = mp.coverage.orders - mp.coverage.priced;

  return (
    <div className="space-y-3">
      <PrintDecisions actions={data.actions} nothing="Nothing pressing — the month's plan, the chain and the people are on track." />

      {/* the headline figures */}
      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]">
        <StatTile hero label={`${m.monthLabel} — painted`} value={pctOrDash(pace.doneShare)} meter={pace.doneShare ?? undefined}
          sub={m.panels > 0 ? `${fmt(m.complete)} of ${fmt(m.panels)} panels · an even pace stands at ${pct(pace.expectedShare)}` : "no panels on the month's plan"}
          delta={pace.tone && m.panels > 0 ? <span className={`text-xs font-bold ${TONE_TEXT[pace.tone]}`}>{pace.aheadH >= 0 ? `${Math.floor(pace.aheadH)} panels ahead of` : `${Math.ceil(-pace.aheadH)} panels behind`} the pace${m.paintedBefore > 0 ? ` · ${fmt(m.paintedBefore)} painted before the month` : ""}</span> : undefined} />
        <StatTile label="Panels left this month" value={fmt(m.remaining)} sub={m.leftWd > 0 ? `${m.leftWd} of ${m.monthWd} working days left` : "the month's working days are over"} />
        <StatTile label="Urgent orders short" value={String(data.urgentStuck.length)} sub={`of ${data.open.urgent} urgent open order${data.open.urgent === 1 ? "" : "s"}`} />
        <StatTile label="Not started" value={fmt(w.notStarted)} sub="panels planned and not punched" />
        {floor && (
          <>
            <StatTile label="Panels' efficiency" value={pctOrDash(recent.efficiency)} sub={recent.days > 0 ? `${fmt(recent.earnedH, 1)} std-h of ${fmt(recent.workedH, 1)} worked · last ${recent.days} recorded days` : "no shift day recorded on the panels lately"} />
            <StatTile label="People short" value={m.leftWd > 0 && mp.rows.some((r) => r.gap !== null) ? String(short) : "—"} sub={m.leftWd > 0 ? `to finish ${m.monthLabel}'s panels` : "the month's working days are over"} />
          </>
        )}
      </div>

      <div className="grid gap-3 xl:grid-cols-12">
        {/* 1 — the month through the chain */}
        <ChartCard
          className="xl:col-span-4"
          title="Is the month on pace?"
          sub={`${m.monthLabel}: each stage's panels done of the month's ${fmt(m.panels)}, the tick where an even pace stands today (${m.monthWd - m.leftWd} of ${m.monthWd} working days behind us). The panel is finished when painted; delivery is the customer's pace.`}
          table={{ rows: m.byStage.map((b) => ({ Stage: LV_STAGE_LABEL[b.stage], Planned: b.required, Done: b.done, "Done %": b.required > 0 ? Math.round((b.done / b.required) * 100) : "", "Even pace %": Math.round(pace.expectedShare * 100) })) }}
        >
          {m.panels === 0 ? (
            <EmptyState compact icon={Info} title={`No panels on ${m.monthLabel}'s plan`} hint="Import the panels' monthly plan on the Orders Registry (with the LV toggle on) — the month's pace is read from it." />
          ) : (
            <div className="space-y-3">
              {m.byStage.map((b) => {
                const share = b.required > 0 ? b.done / b.required : 0;
                return <Bullet key={b.stage} label={LV_STAGE_LABEL[b.stage]} value={share} target={pace.expectedShare} max={1} tone={paceTone(share, pace.expectedShare)} text={`${fmt(b.done)} / ${fmt(b.required)} · ${pct(share)}`} />;
              })}
            </div>
          )}
        </ChartCard>

        {/* 2 — the work between the stages */}
        <ChartCard
          className="xl:col-span-4"
          title="Where does the work wait?"
          sub={`Panels between the stages over the ${w.orders} open order${w.orders === 1 ? "" : "s"}, netted order by order (punched − bent is waiting for bending) — never a stage's output added to the next's. The records say where a panel stands, not since when.`}
          table={{ rows: wipRows.map(([label, pcs]) => ({ Where: label, Panels: pcs })) }}
        >
          {w.orders === 0 ? (
            <EmptyState compact icon={Info} title="No open panel order" hint="Every panel order is closed." />
          ) : (
            <div className="space-y-3">
              {wipRows.map(([label, pcs, href]) => (
                <Bullet key={label} label={label} value={pcs} target={null} max={wipMax} text={<Link href={href} className="hover:underline">{fmt(pcs)} panels</Link>} />
              ))}
            </div>
          )}
        </ChartCard>

        {/* 3 — the people */}
        <ChartCard
          className="xl:col-span-4"
          title="Do we have the people?"
          sub={`What is left of ${m.monthLabel}'s panels in standard hours (the timings sheet's LV tab) over the ${m.leftWd} working days left × ${fmt(mp.hoursPerPersonDay, 1)} h a person.${floor ? " The bar is who comes on an average recorded day; the tick is who is needed from today." : " The tick is who is needed from today."}${unpriced > 0 ? ` ${unpriced} of ${mp.coverage.orders} orders have no row on the sheet and ask no hours here — partial coverage.` : ""}`}
          table={{ rows: mp.rows.map((r) => ({ Department: LV_FLOOR_DEPT_LABEL[r.centre], "Plan h": r.requiredH, "Done h": r.doneH, "Left h": r.leftH, "Needed (month)": r.needed ?? "", "Needed from today": r.neededNow ?? "", ...(floor ? { Present: r.present ?? "", Gap: r.gap ?? "" } : {}) })) }}
        >
          {m.panels === 0 ? (
            <EmptyState compact icon={Info} title={`No panels on ${m.monthLabel}'s plan`} hint="The people the month needs are read from the panels' monthly plan." />
          ) : mp.coverage.priced === 0 ? (
            <EmptyState compact icon={Info} title="No panel of the month is priced" hint={<>None of the month&apos;s orders has a row on the timings sheet&apos;s LV tab — <Link href="/admin/standard-times" className="text-brand-ink font-semibold hover:underline">type their hours</Link> to read the people needed.</>} />
          ) : (
            <div className="space-y-3">
              {mp.rows.map((r) => (
                <Bullet key={r.centre} label={LV_FLOOR_DEPT_LABEL[r.centre]} value={floor ? r.present ?? 0 : 0} target={r.neededNow} max={peopleMax} tone={floor ? r.tone : null}
                  text={floor
                    ? `need ${r.neededNow === null ? "—" : fmt(r.neededNow, 1)} · have ${r.present === null ? "—" : fmt(r.present, 1)}${r.gap === null ? "" : ` · ${signed(r.gap)}`}`
                    : `need ${r.neededNow === null ? "—" : fmt(r.neededNow, 1)} from today`} />
              ))}
            </div>
          )}
        </ChartCard>
      </div>

      <div className="grid gap-3 xl:grid-cols-12">
        {/* 4 — the urgent orders still short */}
        <ChartCard
          className="xl:col-span-5"
          title="Urgent orders still short"
          sub="Every urgent open order with panels still to make, the most short first, and the first stage that has not cleared it. The panels carry no delivery date, so nothing here is called late — urgency is the planner's flag."
          table={{ rows: data.urgentStuck.map((u) => ({ MO: u.mo, BOM: u.bom, Product: u.product ?? "", Short: u.remaining, "Stuck at": u.stage ?? "not started" })) }}
        >
          {data.urgentStuck.length === 0 ? (
            <EmptyState compact icon={Info} title="No urgent order is short" hint="Every urgent panel order is painted, or none is flagged." />
          ) : (
            <TableFrame className="!max-h-[22rem]">
              <table className="w-full text-sm">
                <thead><tr><Th label="Order" /><Th label="Product" /><Th label="Stuck at" /><Th label="Short" num className="text-right" /></tr></thead>
                <tbody>
                  {data.urgentStuck.map((u) => (
                    <tr key={u.mo}>
                      <td className="px-2 whitespace-nowrap"><Link href={`/trace?mo=${encodeURIComponent(u.mo)}&line=LV`} className="font-semibold hover:underline">{u.mo}</Link><span className="text-muted ms-1">{u.bom}</span></td>
                      <td className="px-2">{u.product ?? "—"}</td>
                      <td className="px-2">{u.stage ? <Badge tone="warning">{u.stage}</Badge> : <Badge tone="danger">not started</Badge>}</td>
                      <td className="px-2 text-right tabnum font-bold">{fmt(u.remaining)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
          )}
        </ChartCard>
        {/* 5 — the stages day by day */}
        <div className="xl:col-span-7 min-w-0">
          <LvStageTable d={data.days} today={data.todayISO} />
        </div>
      </div>

      <p className="text-xs text-muted">
        Not here, and why: the load over the next working days and the lines behind their stage date need delivery dates the panels&apos; plan does not carry; machine stops are recorded by department on shared machines, so none is the panels&apos; alone — the plant&apos;s stops are on the Production dashboard.
      </p>
    </div>
  );
}
