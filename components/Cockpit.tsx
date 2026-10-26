"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Info } from "lucide-react";
import { Bullet, ChartCard, NO_BASE, NowBadge, RelativeChip, StatTile, fmt, pct, pctOrDash, signed } from "@/components/charts/kit";
import { StageByDayChart } from "@/components/LazyCharts";
import { AtRiskTable, DetailModal, LoadMatrix, PeopleDetail, QualityBar, cols, useDetail } from "@/components/PlanningParts";
import { EmptyState } from "@/components/primitives";
import { formatDate } from "@/lib/domain/format";
import { traceHref } from "@/lib/domain/links";
import { trItemName } from "@/lib/domain/outputByType";
import { WORK_CENTRE_LABEL, isWorkCentre, type WorkCentre } from "@/lib/domain/shifts";
import { STAGE_LABEL, monthPace, stageDueISO, weekChange, type KpiSnapshotData } from "@/lib/domain/kpis";
import { centreLoadRows, dueByTodayRows, hoursLeftRows, relativeChange, type PlanLine, type PlanningFilters, type TrView } from "@/lib/domain/planningDashboard";
import type { CockpitData } from "@/lib/server/kpis";

// 🧭 The transformers' section of the Planning dashboard: will the weekly plan
// be made, where is the next shortfall, what does it take? Every hour is a
// standard hour (what the work is worth), never pieces, so Fabrication's ten
// projects a day add up. The figures come from lib/server/kpis.ts, narrowed
// to the page's filters by lib/domain/planningDashboard.ts (trView) — the
// assistant reads the same loader. What a card means and how it is counted
// goes to the assistant on a right-click's "Ask AI"; a tile opens the rows it
// is the sum of.
//
// The section's order is the dashboard's own: what the figures rest on, the
// headline figures, the plan by its days, the load and
// the work between the stages, the month and its people, then every line at
// risk. A 12-column grid, so every row fills the width.

const centreName = (c: WorkCentre) => WORK_CENTRE_LABEL[c];

/** What the section reads of the cockpit — the page sends no more to the browser. */
export type CockpitShown = Pick<CockpitData, "todayISO" | "trend" | "leads" | "horizonDays" | "coverage" | "wip" | "manpower" | "load"> & { week: Pick<CockpitData["week"], "planNo" | "newest"> };
const lineLink = (l: Pick<PlanLine, "bom">, planNo: number | null) => <Link href={traceHref({ bom: l.bom, line: "TR" }, planNo ?? 0, "weekly")} className="font-semibold hover:underline">{l.bom}</Link>;
const h1 = (v: number) => `${fmt(v, 1)} h`;

/** `floor`: whether the account sees the Shifts screen — the shift log's
 *  figures (who is present, the people short) are shown only then. */
export function Cockpit({ data, view, f, floor = true }: { data: CockpitShown; view: TrView; f: PlanningFilters; floor?: boolean }) {
  const mp = data.manpower;
  const planNo = data.week.planNo;
  const { open } = useDetail();
  const pace = useMemo(() => monthPace(view.people.rows, mp), [view.people.rows, mp]);
  const peopleMax = Math.max(1, ...view.people.rows.map((r) => Math.max(r.neededNow ?? 0, floor ? r.present ?? 0 : 0)));
  const plan = planNo === null ? "no weekly plan" : `weekly plan ${planNo}${data.week.newest ? "" : " (an earlier plan)"}`;

  /** Today's figure against a week ago, as a share of it — N/A without a reading then, or when the view is narrowed. */
  const weekAgo = (pick: (p: KpiSnapshotData) => number | null | undefined, comparable: boolean, up: "good" | "bad") => {
    const c = comparable ? weekChange(data.trend, data.todayISO, pick) : null;
    const rel = c ? relativeChange(c.now, c.before) : null;
    return <RelativeChip value={rel} up={up} title={c ? `Against ${formatDate(c.beforeISO)}: ${fmt(c.before, 2)}` : comparable ? "No reading a week ago to compare with" : "Readings are kept for the newest plan as a whole — not for a filter or an earlier plan"} />;
  };

  const wipRows: { where: string; pcs: number; href: string; detail: string }[] = [
    { where: "Cut, ready for welding", pcs: data.wip.cutNotWelded.reduce((s, b) => s + b.pcs, 0), href: "/worklist/welding", detail: data.wip.cutNotWelded.map((b) => `${trItemName(b.item)} ${b.pcs}`).join(" · ") },
    { where: "Welded, ready for finishing", pcs: data.wip.weldedNotFinished.reduce((s, b) => s + b.pcs, 0), href: "/worklist/painting", detail: data.wip.weldedNotFinished.map((b) => `${trItemName(b.item)} ${b.pcs}`).join(" · ") },
    { where: "Sent back, not re-delivered", pcs: data.wip.returnsOpen.qty, href: "/worklist/cut", detail: `${data.wip.returnsOpen.count} return${data.wip.returnsOpen.count === 1 ? "" : "s"}` },
    { where: "On hold — out of every queue", pcs: data.wip.held.pieces, href: "/tracker?status=hold", detail: `${data.wip.held.orders} order${data.wip.held.orders === 1 ? "" : "s"} (plan pieces)` },
  ];
  const wipMax = Math.max(1, ...wipRows.map((r) => r.pcs));
  const finish = view.finish;
  const heldLate = view.late.filter((l) => l.held).length;
  const measuredAny = view.capacity.rows.some((r) => r.measured);
  const centreNote = f.centre ? ` at ${centreName(f.centre)}` : "";

  return (
    <div className="space-y-3">
      <QualityBar notes={view.quality} label="Transformers" />

      {/* the headline figures */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]">
        <StatTile hero label="Plan on its date" value={pctOrDash(finish?.rate)} meter={finish?.rate ?? undefined} {...open("tr-ontime")}
          sub={finish && finish.due > 0 ? `${fmt(finish.done)} of ${fmt(finish.due)} pcs due by today` : "nothing due yet"}
          about={`Of the ${plan}'s pieces due to be finished (painted, or shot-blasted for the core) by today, the share finished: ${finish ? `${finish.done} of ${finish.due}` : "none due"}. Pieces made outside (OSP) count as finished; N/A and repeated promises are out. Source: the weekly plan (PlanSchedule, oven dates) against the Daily log. Not the share closed on ODOO, nor delivered.`}
          delta={weekAgo((p) => p.adherence.finish, view.comparable, "good")} />
        <StatTile label="Lines behind" value={fmt(view.late.length)} {...open("tr-behind")}
          sub={heldLate > 0 ? `${heldLate} of them on hold` : `past a stage date${centreNote}`}
          about={`Lines of the ${plan} whose stage date has passed and the stage has not cleared them: fabrication owes a line ${data.leads.cut} days and welding ${data.leads.weld} day before its oven date (Settings), finishing on it.`}
          delta={weekAgo((p) => p.late, view.comparable && !f.centre, "bad")} />
        <StatTile label="Work hours left" value={h1(view.hoursLeft.total)} {...open("tr-hours")}
          sub={view.hoursLeft.pricedShare === null ? `std-h on the ${plan}` : `std-h · ${pct(view.hoursLeft.pricedShare)} of the pieces priced`}
          about={`Standard hours still to work on the ${plan}${centreNote}: each open line's pieces left at each stage × its class's hours a piece. Lines on hold, OSP and N/A pieces ask none; ${view.hoursLeft.unpriced} line${view.hoursLeft.unpriced === 1 ? "" : "s"} without hours a piece are left out — partial coverage.`}
          delta={NO_BASE} />
        <StatTile label="Welding covered" value={data.coverage.days === null ? "—" : `${fmt(data.coverage.days, 1)} d`} {...open("tr-coverage")}
          sub={data.coverage.days === null ? "no recent welding to measure" : `${h1(data.coverage.wipH)} waiting · all open orders`}
          about={data.coverage.days === null
            ? "Days of cut parts in front of the welders: welding has earned nothing on its recent recorded days, so there is no daily rate to divide by — not available."
            : `Welding std-hours of the parts cut and not welded over every open order (${fmt(data.coverage.wipH, 1)} h), over the std-hours welding earns on a recorded day (${fmt(data.coverage.ratePerDay, 1)} h). Under 1 day the welders may wait; over 4, parts pile up. Not narrowed by the filters.`}
          delta={weekAgo((p) => p.coverageDays, true, "good")} />
        <StatTile label="Capacity short" value={measuredAny ? h1(view.capacity.shortH) : "—"} {...open("tr-capacity")}
          sub={`next ${data.horizonDays} working days${view.capacity.unmeasured.length ? ` · ${view.capacity.unmeasured.length} not measured` : ""}`}
          about={`Std-hours the plan's lines owe${centreNote} in the next ${data.horizonDays} working days beyond what each centre can work (its usual man-hours × its measured pace), each centre's own. Lines on hold are out. A centre with no booked hours is not measured — not counted as covered.`}
          delta={NO_BASE} />
        {floor && (
          <StatTile label="People to add" value={view.people.toAdd === null ? "—" : fmt(view.people.toAdd)} {...open("tr-people")}
            sub={mp.leftWd > 0 ? `${mp.monthLabel} · ${mp.leftWd} working days left` : `${mp.monthLabel}'s working days are over`}
            about={`People missing${centreNote} to finish what is left of ${mp.monthLabel}'s plan in the ${mp.leftWd} working days left at ${fmt(mp.hoursPerPersonDay, 1)} h a person (the day shift less its break, Settings), against who comes on an average recorded day; centres short by half a person or more. No overtime assumed.`}
            delta={NO_BASE} />
        )}
      </div>

      {/* 1 — the plan by its days (what needs a decision is the bar's Decisions button) */}
      <ChartCard title="Planned against achieved, by due day"
          about={`The ${plan} by delivery (oven) day: what each day owes, and each stage's pieces of it — fabrication, welding and finishing each on its own, never added up. Today is marked.${f.item || f.q ? " Narrowed by the filters." : ""}`}
          data={view.byDay.map((d) => ({ Day: d.dayISO, "Owed pcs": d.owed, "Fabricated pcs": d.cut, "Welded pcs": d.weld, "Finished pcs": d.finish }))}>
          {planNo === null ? (
            <EmptyState compact icon={Info} title="No weekly plan yet" hint="Import the weekly delivery schedule on the Orders Registry." />
          ) : view.byDay.length === 0 ? (
            <EmptyState compact icon={Info} title={view.lines.length === 0 && (f.item || f.q) ? "No plan line matches the filters" : "Nothing left on the plan"} hint="Clear a filter, or pick another weekly plan." />
          ) : (
            <StageByDayChart days={view.byDay} />
          )}
      </ChartCard>

      {/* 2 — the load ahead, and the work between the stages */}
      <div className="grid gap-3 xl:grid-cols-12">
        <ChartCard className="xl:col-span-7" title={`Load against capacity — next ${data.horizonDays} working days`}
          about={`Each centre's std-hours due on each of the next ${data.horizonDays} working days (Sat–Thu less the factory's holidays) over what it can work a day: the man-hours it usually has × the pace it has measured, the shot-blast crew less its LV share. A cell is short when what the centre owes so far passes what it could have worked so far, tight within 10% of it. Overdue work is owed on the first day. The whole plan's load, whatever the component filter — a centre's capacity is shared.`}
          data={view.capacity.rows.flatMap((r) => r.cells.map((c) => ({ Centre: centreName(r.centre), Day: c.dayISO, "Due h": c.dueH, "Can work h a day": c.capacityH ?? "not measured", "Owed summed h": c.owedCum, "Can work summed h": c.canCum ?? "not measured", State: c.state })))}>
          <LoadMatrix rows={view.capacity.rows} />
        </ChartCard>
        <ChartCard className="xl:col-span-5" title="Where does the work wait?" right={<NowBadge />}
          about="Pieces between the stages over every open order, netted project by project (cut − welded is ready for welding) — never a stage's output added to the next's. How things stand now; the records say where a piece stands, not since when."
          data={wipRows.map((r) => ({ Where: r.where, Detail: r.detail, Pieces: r.pcs }))}>
          {wipRows.every((r) => r.pcs === 0) ? (
            <EmptyState compact icon={Info} title="Nothing waiting between the stages" hint="Every cut piece is welded and every welded piece finished; nothing is sent back or on hold." />
          ) : (
            <div className="space-y-3">
              {wipRows.map((r) => (
                <Bullet key={r.where} label={r.where} value={r.pcs} target={null} max={wipMax} text={<Link href={r.href} className="hover:underline" title={r.detail}>{fmt(r.pcs)} pcs</Link>} />
              ))}
            </div>
          )}
        </ChartCard>
      </div>

      {/* 3 — the month: its pace, and the people it needs */}
      <div className="grid gap-3 xl:grid-cols-12">
        <ChartCard className="xl:col-span-6" title="Is the month on pace?"
          about={`${mp.monthLabel}: each centre's share of the month's plan done in std-hours, the tick where an even pace stands today (${mp.monthWd - mp.leftWd} of ${mp.monthWd} working days behind us). An order carried over from last month is counted once, with the work it brought.`}
          data={pace.map((r) => ({ Centre: centreName(r.centre), "Plan h": r.requiredH, "Done h": r.doneH, "Done %": r.doneShare === null ? "" : Math.round(r.doneShare * 100), "Even pace %": Math.round(r.expectedShare * 100), "Ahead (+) / behind (−) h": r.aheadH }))}>
          {mp.pieces === 0 ? (
            <EmptyState compact icon={Info} title={`No orders on ${mp.monthLabel}'s plan`} hint="Import the monthly plan on the Orders Registry — the month's pace is read from it." />
          ) : (
            <div className="space-y-3">
              {pace.map((r) => (
                <Bullet key={r.centre} label={centreName(r.centre)} value={r.doneShare ?? 0} target={r.expectedShare} max={1} tone={r.tone}
                  text={r.doneShare === null ? "nothing on the plan" : `${pct(r.doneShare)} done · ${r.aheadH >= 0 ? `${fmt(r.aheadH, 1)} h ahead` : `${fmt(-r.aheadH, 1)} h behind`}`} />
              ))}
            </div>
          )}
        </ChartCard>
        <ChartCard className="xl:col-span-6" title="Do we have the people?"
          about={`What is left of ${mp.monthLabel}'s plan over the ${mp.leftWd} working days left × ${fmt(mp.hoursPerPersonDay, 1)} h a person.${floor ? " The bar is who comes on an average recorded day; the tick is who is needed from today." : " The tick is who is needed from today."}`}
          data={view.people.rows.map((r) => ({ Centre: centreName(r.centre), "Plan h": r.requiredH, "Done h": r.doneH, "Left h": r.leftH, "Needed (month)": r.needed ?? "", "Needed from today": r.neededNow ?? "", ...(floor ? { Present: r.present ?? "", Gap: r.gap ?? "" } : {}) }))}>
          {mp.pieces === 0 ? (
            <EmptyState compact icon={Info} title={`No orders on ${mp.monthLabel}'s plan`} hint="Import the monthly plan on the Orders Registry — the people it needs are read from it." />
          ) : (
            <div className="space-y-3">
              {view.people.rows.map((r) => (
                <Bullet key={r.centre} label={centreName(r.centre)} value={floor ? r.present ?? 0 : 0} target={r.neededNow} max={peopleMax} tone={floor ? r.tone : null}
                  text={floor
                    ? `need ${r.neededNow === null ? "—" : fmt(r.neededNow, 1)} · have ${r.present === null ? "—" : fmt(r.present, 1)}${r.gap === null ? "" : ` · ${signed(r.gap)}`}`
                    : `need ${r.neededNow === null ? "—" : fmt(r.neededNow, 1)} from today`} />
              ))}
            </div>
          )}
        </ChartCard>
      </div>

      {/* 4 — every line at risk */}
      <ChartCard title="At risk — the transformers' lines that will not make their date"
        about={`Lines of the ${plan} late at a stage (its date passed), at risk (a centre of the stage holding it is short of capacity on or before the stage's date — the catch-up day is an estimate at the centre's measured pace and usual man-hours, no overtime), and on hold (out of every queue, still owed). Std-h left is every stage's still to work${centreNote}.`}
        data={view.atRisk.map((r) => ({ Status: r.status, MO: r.mo, SOI: r.soi ?? "", BOM: r.bom, Component: r.item, "Stage due": r.stageDueISO ?? "", Required: r.required, Done: r.done, Left: r.remaining, "Held at": r.stage ?? "", "Std-h left": r.hoursLeft ?? "not priced", Why: r.reason }))}>
        <AtRiskTable rows={view.atRisk} empty={{ title: "Nothing at risk", hint: "Every line is at or ahead of its stage date, and no centre is short before a line's date." }} />
      </ChartCard>

      <TrDetail data={data} view={view} f={f} floor={floor} />
    </div>
  );
}

/** The rows behind the figure the address names (?detail=tr-…). */
function TrDetail({ data, view, f, floor }: { data: CockpitShown; view: TrView; f: PlanningFilters; floor: boolean }) {
  const { detail: d, open } = useDetail();
  if (!d?.startsWith("tr-")) return null;
  const planNo = data.week.planNo;
  const n = (v: number) => fmt(v);
  const mos = (l: Pick<PlanLine, "mos">) => <span className="text-muted">{l.mos.join(", ") || "—"}</span>;

  if (d === "tr-ontime") {
    const rows = dueByTodayRows(view.lines, "finish", data.todayISO, data.leads);
    const owed = rows.reduce((s, r) => s + r.owed, 0), done = rows.reduce((s, r) => s + r.done, 0);
    return <DetailModal title="Plan on its date — the lines due finished by today" sub={`Weekly plan ${planNo ?? "—"} · finished = painted, or shot-blasted for the core; OSP counts as finished`}
      columns={cols("Due", "BOM", "SOI", "MO", "Component", ["Owed", true], ["Finished", true], ["Short", true])}
      rows={rows.map((r) => [formatDate(r.dueISO), lineLink(r.line, planNo), r.line.soi ?? "—", mos(r.line), trItemName(r.line.item), n(r.owed), n(r.done), n(r.owed - r.done)])}
      total={["Total", "", "", "", "", n(owed), n(done), n(owed - done)]} empty="Nothing is due finished by today yet." />;
  }
  if (d === "tr-behind") {
    return <DetailModal title="Lines behind their stage date" sub={`Fabrication ${data.leads.cut} days and welding ${data.leads.weld} day before the oven date (Settings)`}
      columns={cols("Due", "BOM", "SOI", "MO", "Component", "Stuck at", ["Owed", true], ["Short", true], "On hold")}
      rows={view.late.map((l) => [formatDate(stageDueISO(l.dayISO, l.stage, data.leads)), lineLink(l, planNo), l.soi ?? "—", mos(l), trItemName(l.item), STAGE_LABEL[l.stage], n(l.owed), n(l.short), l.held ? "yes" : ""])}
      total={["Total", `${view.late.length} lines`, "", "", "", "", n(view.late.reduce((s, l) => s + l.owed, 0)), n(view.late.reduce((s, l) => s + l.short, 0)), ""]} empty="Every line is at or ahead of its stage date." />;
  }
  if (d === "tr-hours") {
    const rows = hoursLeftRows(view.lines, f.centre);
    return <DetailModal title={`Work hours left${f.centre ? ` at ${centreName(f.centre)}` : ""}`} sub="Std-hours still to work on each open line; on hold, OSP and N/A ask none"
      columns={cols("Oven day", "BOM", "SOI", "Component", "Held at", ["Owed", true], ["Std-h left", true])}
      rows={rows.map((r) => [formatDate(r.line.dayISO), lineLink(r.line, planNo), r.line.soi ?? "—", trItemName(r.line.item), STAGE_LABEL[r.stage], n(r.line.owed), r.hours === null ? "not priced" : fmt(r.hours, 1)])}
      total={["Total", "", "", "", "", "", fmt(view.hoursLeft.total, 1)]} />;
  }
  if (d === "tr-coverage") {
    const c = data.coverage;
    return <DetailModal title="Welding covered — cut parts waiting for welding" sub={c.days === null ? "No recent welding to measure the days against" : `${fmt(c.wipH, 1)} std-h waiting ÷ ${fmt(c.ratePerDay, 1)} std-h welding earns on a recorded day = ${fmt(c.days, 1)} days`}
      columns={cols("Component", ["Pieces waiting", true], ["Welding std-h", true])}
      rows={c.byItem.map((b) => [trItemName(b.item), n(b.pcs), fmt(b.weldH, 1)])}
      total={["Total", n(c.byItem.reduce((s, b) => s + b.pcs, 0)), fmt(c.wipH, 1)]} empty="Every cut piece has been welded." />;
  }
  if (d === "tr-capacity") {
    const rows = data.load.filter((l) => !f.centre || l.centre === f.centre);
    return <DetailModal title={`Capacity short — next ${data.horizonDays} working days`} sub="Each centre's own: one's spare hours never cover another's"
      columns={cols("Centre", ["Owed h", true], ["Can work h", true], ["Short at end", true], "Short from", "Catches up")}
      rows={rows.map((l) => {
        const last = l.days.at(-1);
        return [<a key="c" {...open(`tr-load:${l.centre}`)} className="font-semibold hover:underline">{centreName(l.centre)}</a>, fmt(last?.owedCum ?? 0, 1), l.measured ? fmt(last?.canCum ?? 0, 1) : "not measured", l.measured ? fmt(l.shortH, 1) : "—", l.shortFromISO ? formatDate(l.shortFromISO) : "—", l.clearsISO ? `${formatDate(l.clearsISO)} (estimate)` : l.shortFromISO ? "not in the horizon" : "—"];
      })}
      total={["Total", "", "", fmt(view.capacity.shortH, 1), "", ""]} />;
  }
  if (d.startsWith("tr-load:")) {
    const c = d.slice("tr-load:".length);
    if (!isWorkCentre(c)) return null;
    const end = data.load.find((l) => l.centre === c)?.days.at(-1)?.dayISO ?? null;
    const rows = centreLoadRows(view.lines, c, data.leads, end);
    const inHorizon = rows.filter((r) => r.inHorizon).reduce((s, r) => s + r.hours, 0);
    return <DetailModal title={`${centreName(c)} — what the plan's lines owe it`} sub={`Owed by its stage's date; on hold out${f.item || f.q ? " · narrowed by the filters (the matrix row is the whole plan's)" : ""}`}
      columns={cols("Owed by", "BOM", "SOI", "Component", "In the next working days", ["Std-h", true])}
      rows={rows.map((r) => [formatDate(r.dueISO), lineLink(r.line, planNo), r.line.soi ?? "—", trItemName(r.line.item), r.inHorizon ? "yes" : "after them", fmt(r.hours, 1)])}
      total={["In the next working days", "", "", "", "", fmt(inHorizon, 1)]} empty="No priced line owes this centre anything." />;
  }
  if (d === "tr-people" && floor) {
    return <PeopleDetail title={`People to add — ${data.manpower.monthLabel}`} sub={`What is left ÷ (${data.manpower.leftWd} working days × ${fmt(data.manpower.hoursPerPersonDay, 1)} h a person), against who comes on an average recorded day`}
      rows={view.people.rows.map((r) => ({ key: r.centre, label: centreName(r.centre), ...r }))} toAdd={view.people.toAdd} />;
  }
  return null;
}
