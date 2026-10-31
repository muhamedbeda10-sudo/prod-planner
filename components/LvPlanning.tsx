"use client";

import Link from "next/link";
import { Info } from "lucide-react";
import { Bullet, ChartCard, DataQualityBar, NO_BASE, NowBadge, StatTile, fmt, pct, pctOrDash, signed } from "@/components/charts/kit";
import { LvMonthChart } from "@/components/LazyCharts";
import { AtRiskTable, DetailModal, PeopleDetail, cols, useDetail } from "@/components/PlanningParts";
import { EmptyState } from "@/components/primitives";
import { LvStageTable } from "@/components/LvStageTable";
import { LV_FAMILY_LABEL, LV_STAGE_LABEL } from "@/lib/domain/lv";
import { LV_FLOOR_DEPT_LABEL } from "@/lib/domain/lvKpis";
import { traceHref } from "@/lib/domain/links";
import { isPartial, type LvView, type PlanningFilters } from "@/lib/domain/planningDashboard";
import type { LvPlanningData } from "@/lib/server/lvKpis";

// The LV panels' section of the Planning dashboard: will the month's plan be
// made? Where does the work wait between the stages? Do we have the people?
// The panels are planned month by month with no delivery date of their own,
// so the plan is judged against an even pace through the month's working
// days — never the transformers' oven dates or lead days, and nothing here is
// "late". The figures come from lib/server/lvKpis.ts (the family filter is
// the loader's), narrowed by lib/domain/planningDashboard.ts (lvView); the
// assistant reads the same loader. A tile opens the rows it is the sum of.

/** What the section reads of the panels' planning — the page sends no more to the browser. */
export type LvShown = Pick<LvPlanningData, "todayISO" | "month" | "open" | "wip" | "manpower" | "family"> & {
  /** The stages day by day — sent only when the floor's figures are not on the page. */
  days?: LvPlanningData["days"];
};

export function LvPlanning({ data, view, f, floor = true }: { data: LvShown; view: LvView; f: PlanningFilters; floor?: boolean }) {
  const m = data.month;
  const pace = m.pace;
  const w = data.wip;
  const mp = data.manpower;
  const { open } = useDetail();
  // the urgent orders still short — the at-risk table's own rows, under the same filters
  const urgent = view.atRisk.filter((r) => r.status === "urgent");
  const peopleMax = Math.max(1, ...view.people.rows.map((r) => Math.max(r.neededNow ?? 0, floor ? r.present ?? 0 : 0)));
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
  const family = data.family === null ? "" : ` · ${LV_FAMILY_LABEL[data.family]}`;
  const elapsed = m.monthWd - m.leftWd;

  return (
    <div className="space-y-3">
      <DataQualityBar items={view.quality} partial={isPartial(view.quality)} about="What the panels' figures are read from: the panels' monthly plan against the Daily log, the timings sheet's LV tab, the shift log's booked hours." />

      {/* the headline figures */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]">
        <StatTile label="Panels this month" value={fmt(m.panels)} {...open("lv-planned")} sub={`${fmt(m.orders)} orders · ${m.monthLabel}${family}`} delta={NO_BASE}
          about={`Panels on ${m.monthLabel}'s plan: every order the month's plan brought or carried over, each counted once at its quantity. Source: the panels' monthly plan (MasterOrder, line LV).`} />
        <StatTile label="Painted" value={fmt(m.complete)} {...open("lv-painted")} sub={m.panels > 0 ? `of ${fmt(m.panels)} panels` : "no panel planned"} delta={NO_BASE}
          about={`Panels of the month's orders through painting — a panel is made when painted; delivery is the customer's pace, and ODOO's closing is the accounts'. Each order capped at its quantity.${m.paintedBefore > 0 ? ` ${fmt(m.paintedBefore)} were painted before the month began.` : ""}`} />
        <StatTile label="Left to paint" value={fmt(m.remaining)} {...open("lv-remaining")} sub={m.leftWd > 0 ? `${m.leftWd} of ${m.monthWd} working days left` : "the month's working days are over"} delta={NO_BASE}
          about="The month's panels not painted yet." />
        <StatTile hero label="Done against time gone" value={pctOrDash(pace.doneShare)} meter={pace.doneShare ?? undefined} {...open("lv-pace")}
          sub={m.panels > 0 ? `even pace ${pct(pace.expectedShare)} · ${elapsed} of ${m.monthWd} working days` : undefined} delta={NO_BASE}
          about={m.panels > 0 ? `Share of the month's panels painted (${pct(pace.doneShare ?? 0)}) against the share of its working days gone (${pct(pace.expectedShare)}); ${pace.aheadH >= 0 ? `${Math.floor(pace.aheadH)} panels ahead of` : `${Math.ceil(-pace.aheadH)} panels behind`} an even pace. Work a carried-over order brought starts the pace there.` : "No panels on the month's plan."} />
        <StatTile label="Urgent orders short" value={fmt(urgent.length)} {...open("lv-urgent")} sub={`of ${data.open.urgent} urgent open`} delta={NO_BASE}
          about={`Open orders the planner flagged urgent with panels still to paint (not on hold)${f.lvDept ? `, held at ${LV_FLOOR_DEPT_LABEL[f.lvDept]}` : ""}. The panels carry no delivery date — urgency is the planner's flag.`} />
        {floor && (
          <StatTile label="People to add" value={view.people.toAdd === null ? "—" : fmt(view.people.toAdd)} {...open("lv-people")} sub={m.leftWd > 0 ? `${m.monthLabel} · from today` : `${m.monthLabel}'s working days are over`} delta={NO_BASE}
            about={`People missing${f.lvDept ? ` in ${LV_FLOOR_DEPT_LABEL[f.lvDept]}` : ""} to finish the month's panels in the working days left at ${fmt(mp.hoursPerPersonDay, 1)} h a person, against who comes on an average recorded day; departments short by half a person or more. No overtime assumed.${unpriced > 0 ? ` ${unpriced} of ${mp.coverage.orders} orders have no row on the timings sheet and ask no hours — partial coverage.` : ""}`} />
        )}
      </div>

      {/* 1 — the month through the chain (what needs a decision is the bar's Decisions button) */}
      <ChartCard title="Planned against achieved, by stage"
          about={`${m.monthLabel}${family}: each stage's panels done of the month's ${fmt(m.panels)} — punched, bent, welded and painted each on its own — against where an even pace stands today (${elapsed} of ${m.monthWd} working days behind us). The panels carry no delivery date, so the month's pace is their yardstick.`}
          data={m.byStage.map((b) => ({ Stage: LV_STAGE_LABEL[b.stage], Planned: b.required, Done: b.done, "Done %": b.required > 0 ? Math.round((b.done / b.required) * 100) : "", "Even pace %": Math.round(pace.expectedShare * 100) }))}>
          {m.panels === 0 ? (
            <EmptyState compact icon={Info} title={`No panels on ${m.monthLabel}'s plan`} hint="Import the panels' monthly plan on the Orders Registry (with the LV toggle on) — the month's pace is read from it." />
          ) : (
            <LvMonthChart stages={m.byStage.map((b) => ({ stage: LV_STAGE_LABEL[b.stage], required: b.required, done: b.done }))} panels={m.panels} expectedShare={pace.expectedShare} />
          )}
      </ChartCard>

      {/* 2 — the work between the stages, and the people */}
      <div className="grid gap-3 xl:grid-cols-12">
        <ChartCard className="xl:col-span-6" title="Where does the work wait?" right={<NowBadge />}
          about={`Panels between the stages over the ${w.orders} open order${w.orders === 1 ? "" : "s"}${family}, netted order by order (punched − bent is waiting for bending) — never a stage's output added to the next's. How things stand now; the records say where a panel stands, not since when.`}
          data={wipRows.map(([label, pcs]) => ({ Where: label, Panels: pcs }))}>
          {w.orders === 0 ? (
            <EmptyState compact icon={Info} title="No open panel order" hint="Every panel order is closed." />
          ) : (
            <div className="space-y-3">
              {wipRows.map(([label, pcs, to]) => (
                <Bullet key={label} label={label} value={pcs} target={null} max={wipMax} text={<Link href={to} className="hover:underline">{fmt(pcs)} panels</Link>} />
              ))}
            </div>
          )}
        </ChartCard>
        <ChartCard className="xl:col-span-6" title="Do we have the people?"
          about={`What is left of ${m.monthLabel}'s panels in standard hours (the timings sheet's LV tab) over the ${m.leftWd} working days left × ${fmt(mp.hoursPerPersonDay, 1)} h a person.${floor ? " The bar is who comes on an average recorded day; the tick is who is needed from today." : " The tick is who is needed from today."}${unpriced > 0 ? ` ${unpriced} of ${mp.coverage.orders} orders have no row on the sheet and ask no hours here — partial coverage.` : ""}`}
          data={view.people.rows.map((r) => ({ Department: LV_FLOOR_DEPT_LABEL[r.centre], "Plan h": r.requiredH, "Done h": r.doneH, "Left h": r.leftH, "Needed (month)": r.needed ?? "", "Needed from today": r.neededNow ?? "", ...(floor ? { Present: r.present ?? "", Gap: r.gap ?? "" } : {}) }))}>
          {m.panels === 0 ? (
            <EmptyState compact icon={Info} title={`No panels on ${m.monthLabel}'s plan`} hint="The people the month needs are read from the panels' monthly plan." />
          ) : mp.coverage.priced === 0 ? (
            <EmptyState compact icon={Info} title="No panel of the month is priced" hint={<>None of the month&apos;s orders has a row on the timings sheet&apos;s LV tab — <Link href="/admin/standard-times" className="text-brand-ink font-semibold hover:underline">type their hours</Link> to read the people needed.</>} />
          ) : (
            <div className="space-y-3">
              {view.people.rows.map((r) => (
                <Bullet key={r.centre} label={LV_FLOOR_DEPT_LABEL[r.centre]} value={floor ? r.present ?? 0 : 0} target={r.neededNow} max={peopleMax} tone={floor ? r.tone : null}
                  text={floor
                    ? `need ${r.neededNow === null ? "—" : fmt(r.neededNow, 1)} · have ${r.present === null ? "—" : fmt(r.present, 1)}${r.gap === null ? "" : ` · ${signed(r.gap)}`}`
                    : `need ${r.neededNow === null ? "—" : fmt(r.neededNow, 1)} from today`} />
              ))}
            </div>
          )}
        </ChartCard>
      </div>

      {/* 3 — the stages day by day, over the period of its own — with the floor's figures on the page, their "What was made each day?" says it */}
      {data.days && <LvStageTable d={data.days} today={data.todayISO} />}

      {/* 4 — every order still short */}
      <ChartCard title="At risk — the panels' orders still short"
        about="The month's open orders and every urgent open one with panels still to paint, the urgent first, each with the stage of the chain that has not cleared it. No delivery date: nothing here is called late. Orders on hold are listed — out of every queue, still on the plan."
        data={view.atRisk.map((r) => ({ Status: r.status, MO: r.mo, SOI: r.soi ?? "", BOM: r.bom, Product: r.item, Required: r.required, Painted: r.done, Left: r.remaining, "Held at": r.stage ?? "", "Std-h left": r.hoursLeft ?? "not priced", Why: r.reason }))}>
        <AtRiskTable rows={view.atRisk} empty={{ title: "No panel order is short", hint: "Every order of the month and every urgent one is painted." }} />
      </ChartCard>

      <LvDetail data={data} view={view} floor={floor} />
    </div>
  );
}

/** The rows behind the figure the address names (?detail=lv-…). */
function LvDetail({ data, view, floor }: { data: LvShown; view: LvView; floor: boolean }) {
  const { detail: d } = useDetail();
  if (!d?.startsWith("lv-")) return null;
  const m = data.month;
  const mo = (v: string) => <Link href={traceHref({ mo: v, line: "LV" })} className="font-semibold hover:underline">{v}</Link>;

  if (d === "lv-planned" || d === "lv-painted" || d === "lv-remaining" || d === "lv-pace") {
    const rows = view.month.filter((r) => d !== "lv-remaining" || r.remaining > 0);
    const title = { "lv-planned": "Panels this month", "lv-painted": "Painted this month", "lv-remaining": "Left to paint", "lv-pace": "Done against time gone" }[d];
    return <DetailModal title={`${title} — ${m.monthLabel}`}
      sub={d === "lv-pace" ? `${fmt(m.complete)} of ${fmt(m.panels)} painted (${pctOrDash(m.pace.doneShare)}) against an even pace of ${pct(m.pace.expectedShare)} — ${m.monthWd - m.leftWd} of ${m.monthWd} working days gone` : "Each order of the month's plan once, capped at its quantity"}
      columns={cols("MO", "BOM", "Product", "Status", ["Panels", true], ["Painted", true], ["Left", true])}
      rows={rows.map((r) => [mo(r.order.mo), r.order.bom, r.order.product ?? "—", r.order.open ? (r.order.held ? "on hold" : "open") : "closed", fmt(r.required), fmt(r.painted), fmt(r.remaining)])}
      total={["Total", "", "", "", fmt(rows.reduce((s, r) => s + r.required, 0)), fmt(rows.reduce((s, r) => s + r.painted, 0)), fmt(rows.reduce((s, r) => s + r.remaining, 0))]} empty="No order on the month's plan." />;
  }
  if (d === "lv-urgent") {
    const rows = view.atRisk.filter((r) => r.status === "urgent");
    return <DetailModal title="Urgent orders still short" sub="Open, flagged urgent, not on hold, panels still to paint"
      columns={cols("MO", "BOM", "Product", "Held at", "Why", ["Left", true])}
      rows={rows.map((u) => [mo(u.mo), u.bom, u.item, u.stage ?? "—", u.reason, fmt(u.remaining)])}
      total={["Total", `${rows.length} orders`, "", "", "", fmt(rows.reduce((s, u) => s + u.remaining, 0))]} empty="No urgent order is short." />;
  }
  if (d === "lv-people" && floor) {
    const mp = data.manpower;
    return <PeopleDetail title={`People to add — ${m.monthLabel}`} sub={`What is left ÷ (${m.leftWd} working days × ${fmt(mp.hoursPerPersonDay, 1)} h a person); ${mp.coverage.priced} of ${mp.coverage.orders} orders priced`}
      rows={view.people.rows.map((r) => ({ key: r.centre, label: LV_FLOOR_DEPT_LABEL[r.centre], ...r }))} toAdd={view.people.toAdd} />;
  }
  return null;
}
