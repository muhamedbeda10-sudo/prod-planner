import Image from "next/image";
import { Fragment } from "react";
import { getDailyReport, getWorkedOn, getFullPlanGrouped, getWeekSnapshot, countWorkingDays, type ReportPlanRow } from "@/lib/server/report";
import { getPlanVsActual } from "@/lib/server/planVsActual";
import { PlanVsActualProjects, PlanVsActualDays } from "@/components/PlanVsActualTables";
import { getPlanNos } from "@/lib/server/data";
import { pctStyle, Num } from "@/components/ui";
import { ReportPeriodPicker, WeekSnapshotPicker, DeptPicker } from "@/components/controls";
import { OutputByComponentChart, PrintButton } from "@/components/ReportCharts";
import { parseISODate, toISODate, toDisplayDate } from "@/lib/domain/dates";
import { ITEMS, isPaintExempt, deptLabel, itemDailyTarget, STAGE_COLOR, FINISHING_LABEL } from "@/lib/domain/constants";

// display label for a report stage: Painting reads as "Painting & Shot Blast"
const stageLabel = (dept: string) => (dept === "Painting" ? FINISHING_LABEL : deptLabel(dept));

// the report can be scoped to any COMBINATION of these stages. Painting is the
// whole finishing stage (painted items + the core's Shot Blast), so there is no
// separate Shot Blast filter — it lives inside Painting.
const REPORT_STAGES = ["Cut", "Welding", "Painting", "Delivered"] as const;
type ReportStage = (typeof REPORT_STAGES)[number];
// a filter stage → the ledger dept(s) it covers: Painting also pulls the core's
// Shot Blast entries (the core's finishing step)
function ledgerDepts(stages: string[]): string[] {
  const out = new Set<string>();
  for (const s of stages) {
    out.add(s);
    if (s === "Painting") out.add("ShotBlast");
  }
  return [...out];
}

export const dynamic = "force-dynamic";

function fmtPct(v: number | null) {
  return v === null ? "—" : `${(v * 100).toFixed(0)}%`;
}

/** The report's default day: YESTERDAY — it is reviewed the morning after. */
function lastFinishedDay(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string; week?: string; dept?: string; from?: string }>;
}) {
  const sp = await searchParams;
  // default = YESTERDAY: the daily report is reviewed the morning after the
  // day it covers, so it opens on the last finished day (picker overrides)
  const day = (sp.day && parseISODate(sp.day)) || lastFinishedDay();
  const dayISO = toISODate(day);
  // ?from= turns the report into a RANGE ending on `day`; a stray from > day is
  // ignored so the page can never render an inverted period
  const fromRaw = sp.from ? parseISODate(sp.from) : null;
  const from = fromRaw && toISODate(fromRaw) < dayISO ? fromRaw : null;
  const fromISO = from ? toISODate(from) : dayISO;
  const ranged = !!from;
  // capacity scales with the working days the period spans
  const workingDays = ranged ? await countWorkingDays(from, day) : 1;
  const periodLabel = ranged ? `${toDisplayDate(from)} → ${toDisplayDate(day)}` : toDisplayDate(day);
  const weekNo = Number(sp.week) || null; // null = the FULL plan (default)
  // dept filter — MULTI-select: any combination of stages scopes the output
  // table rows, the chart series, the worked-on columns AND the plan highlight.
  // Empty = all stages. Kept in pipeline order whatever the click order was.
  const picked = new Set((sp.dept ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const deptsF = REPORT_STAGES.filter((s) => picked.has(s)) as ReportStage[];
  const scoped = deptsF.length > 0;
  // the stage columns actually shown (all four when nothing is picked)
  const shownStages: readonly ReportStage[] = scoped ? deptsF : REPORT_STAGES;

  const [{ deptOutputs, target }, worked, planNos, planRows, pva] = await Promise.all([
    getDailyReport(day, from ?? undefined, workingDays),
    getWorkedOn(day, scoped ? ledgerDepts(deptsF) : undefined, from ?? undefined),
    getPlanNos(),
    weekNo ? getWeekSnapshot(weekNo) : getFullPlanGrouped(),
    // Delivery carries no plan date — comparing it to a plan is meaningless, so
    // the plan-vs-actual section covers the plan-dated stages only
    getPlanVsActual(from ?? day, day, shownStages.filter((s) => s !== "Delivered")),
  ]);
  const pvaStages = shownStages.filter((s) => s !== "Delivered");

  const cut = deptOutputs.find((d) => d.dept === "Cut")!;
  const weld = deptOutputs.find((d) => d.dept === "Welding")!;
  // Painting is the finishing stage — its per-item totals already fold in the
  // core's Shot Blast (done in computeDailyReport)
  const paint = deptOutputs.find((d) => d.dept === "Painting")!;
  const delivered = deptOutputs.find((d) => d.dept === "Delivered")!;

  // the plan table lists ONLY the projects touched in the period (in the picked
  // departments) — the rest of the registry isn't part of this report
  const workedMos = new Set(worked.mos);
  const workedBoms = new Set(worked.bomsAll);
  const hl = (r: ReportPlanRow) => workedBoms.has(r.bom) || r.mos.some((m) => workedMos.has(m));
  const workedPlanRows = planRows.filter(hl);

  return (
    <div className="space-y-6">
      {/* controls only — no on-screen title (the print masthead carries the name) */}
      <div className="no-print flex flex-wrap items-center gap-2">
        <ReportPeriodPicker from={fromISO} to={dayISO} />
        <DeptPicker value={sp.dept ?? ""} />
        <WeekSnapshotPicker plans={planNos} value={sp.week ?? ""} />
        <PrintButton />
      </div>

      {/* Print masthead — logo + title + day, only on paper */}
      <div className="print-only mb-3">
        <div className="flex items-center justify-between border-b-2 border-foreground pb-2">
          <Image src="/brand/atc-logo-horizontal.svg" alt="Arabian Transformers Co." width={230} height={28} priority />
          <div className="text-right">
            <div className="text-xl font-extrabold">{ranged ? "Production Report" : "Daily Production Report"}</div>
            <div className="text-sm tabnum">📅 {periodLabel}</div>
          </div>
        </div>
      </div>

      {/* Headline: the whole period in four numbers, read left to right. */}
      <section className="print-keep">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Kpi label="Due in this period" value={pva.due} sub={`what the plan asked for${pvaStages.length < 3 ? " (picked stages)" : ""}`} />
          <Kpi label="Done of it" value={pva.done} sub={pva.due > 0 ? `${Math.round((pva.done / pva.due) * 100)}% of the promise` : "nothing was due"} />
          <Kpi
            label="Still open"
            value={Math.max(0, pva.due - pva.done)}
            sub={pva.due - pva.done > 0 ? "of this period's promise" : "the period is fully covered"}
            tone={pva.due - pva.done > 0 ? "warn" : "ok"}
          />
          <Kpi label="Total recorded" value={pva.output} sub="every piece logged in the period" />
        </div>
        <p className="text-[11px] text-muted mt-2">
          <b>Due</b> = what the weekly plan asked each department to finish{ranged ? " in this period" : " on this day"} · <b>Done</b> = how much of
          that promise is actually covered · <b>Recorded</b> = everything logged, promised or not. Each stage has its own due date:
          Fabrication {pva.leadCut} day{pva.leadCut === 1 ? "" : "s"} and Welding {pva.leadWeld} day{pva.leadWeld === 1 ? "" : "s"} before the oven
          date, finishing on it. Delivery carries no plan date, so it is reported as output only.
        </p>
      </section>

      <div className="flex items-center justify-between gap-4 no-print">
        <h2 className="text-lg font-bold min-w-0">Department output — {periodLabel}</h2>
        <Image
          src="/brand/atc-logo-horizontal.svg"
          alt="Arabian Transformers Co."
          width={250}
          height={30}
          className="opacity-90 hidden md:block shrink-0"
        />
      </div>
      <h2 className="text-lg font-bold print-only">Department output — {periodLabel}</h2>

      {/* Section 1: department output */}
      <div className="bg-surface border rounded-xl overflow-x-auto print-lg">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand text-white text-center">
              <th className="p-2 text-left">Dept</th>
              {/* each component carries its OWN daily target (base 27, AR/MB 20) */}
              {ITEMS.map((it) => (
                <th key={it} className="p-2">
                  {it}
                  <span className="block text-[10px] font-normal opacity-75 tabnum">/{itemDailyTarget(it, target) * workingDays}</span>
                </th>
              ))}
              <th className="p-2">Total</th>
              <th className="p-2">Complete Sets</th>
              <th className="p-2">Efficiency %</th>
              <th className="p-2">Balance %</th>
            </tr>
          </thead>
          <tbody>
            {deptOutputs.filter((d) => !scoped || picked.has(d.dept)).map((d) => (
              <tr key={d.dept} className="text-center">
                <td className="p-2 text-left font-bold">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm mr-1.5 align-middle" style={{ background: STAGE_COLOR[d.dept] }} />
                  {stageLabel(d.dept)}
                </td>
                {ITEMS.map((it) => (
                  <td key={it} className="p-2 tabnum">
                    <Num v={d.items[it]} />
                  </td>
                ))}
                <td className="p-2 font-bold tabnum">{d.total}</td>
                <td className="p-2 font-extrabold tabnum">{d.sets}</td>
                <td className="p-2 font-bold tabnum" style={pctStyle(d.efficiency)}>{fmtPct(d.efficiency)}</td>
                <td className="p-2 font-bold tabnum" style={pctStyle(d.balance)}>{fmtPct(d.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The single quantities chart — values on the bars, dashed target line.
          The target value lives HERE in the header, never inside the plot, so
          no bar or label can ever cover it. */}
      <div className="bg-surface border rounded-xl p-3 print-keep">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h3 className="font-bold text-sm">Output by component — vs {ranged ? "period" : "daily"} target</h3>
          <span className="pill pill-muted tabnum">
            <span aria-hidden style={{ width: 18, borderTop: "2px dashed var(--muted)", display: "inline-block" }} />
            Target {target * workingDays}/item · AR & MB {itemDailyTarget("AR", target) * workingDays}
            {ranged && <> · {workingDays} working days</>}
          </span>
        </div>
        <OutputByComponentChart cut={cut.items} welding={weld.items} painting={paint.items} delivered={delivered.items} target={target} days={workingDays} stages={shownStages} />
      </div>

      {/* Projects — for the work DUE in the period, how much of each component
          is done. Replaces the old separate plan-vs-actual + worked-on tables. */}
      <section className="print-keep print-break">
        {pvaStages.length === 0 ? (
          <p className="text-sm text-muted">Delivery carries no plan date — pick a production stage to compare against the plan.</p>
        ) : (
          <PlanVsActualProjects pva={pva} stages={pvaStages} />
        )}
      </section>

      {/* Day by day — only meaningful over a multi-day period; a single day is
          already the whole report. */}
      {ranged && pvaStages.length > 0 && (
        <section className="print-keep print-break">
          <PlanVsActualDays pva={pva} stages={pvaStages} />
        </section>
      )}


      {/* The plan table — one row per BOM ("cascade" closed): LIVE whole-order
          totals for the projects TOUCHED in the period (the rest of the
          registry is not part of this report). The dropdown switches to one
          week's snapshot, measured against that week's required. */}
      <details className="print-break" open={false}>
        <summary className="cursor-pointer select-none flex flex-wrap items-center gap-3 mb-2">
          <h2 className="text-lg font-bold inline">
            {weekNo ? `Week snapshot — Plan ${weekNo}` : "Whole-order progress (reference)"}
          </h2>
          <span className="pill pill-ok normal-case">
            {workedPlanRows.length} project{workedPlanRows.length === 1 ? "" : "s"} · {periodLabel}
            {scoped ? ` · ${deptsF.map((d) => stageLabel(d)).join(" + ")}` : ""}
          </span>
          <span className="text-[11px] text-muted">all-time totals for the projects worked on — not this period&apos;s work</span>
        </summary>

        <div className="bg-surface border rounded-xl overflow-x-auto print-fit">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-brand text-white text-center">
                <th rowSpan={2} className="p-2 text-left">BOM</th>
                <th rowSpan={2} className="p-2">Required</th>
                {/* tracker-style stage columns: Fab | Weld | SHB-or-Paint | Dlvd */}
                {ITEMS.map((it) => <th key={it} colSpan={4} className="p-2 border-l border-border-strong">{it}</th>)}
              </tr>
              <tr className="bg-brand-dark text-white text-[10px]">
                {ITEMS.map((it) => <StageHead key={it} shb={isPaintExempt(it)} />)}
              </tr>
            </thead>
            <tbody>
              {workedPlanRows.length === 0 && (
                <tr><td colSpan={2 + ITEMS.length * 4} className="p-4 text-center text-muted">No project was worked on in this period.</td></tr>
              )}
              {workedPlanRows.map((r, i) => (
                <tr key={r.bom} className={`text-center ${i % 2 ? "bg-zebra" : ""}`}>
                  <td className="p-2 text-left font-bold whitespace-nowrap">
                    {r.bom}
                    {r.urgentCount > 0 && <span className="pill pill-bad ml-1">U×{r.urgentCount}</span>}
                    {r.ospCount > 0 && (
                      <span className="pill ml-1" style={{ background: "#ece3f7", color: "#6b45a8" }}>OSP</span>
                    )}
                  </td>
                  <td className="p-2 font-bold tabnum">{r.required}</td>
                  {ITEMS.map((it) => (
                    <FragmentCW
                      key={it}
                      cut={r.items[it].cut}
                      weld={r.items[it].weld}
                      paint={r.items[it].paint}
                      noPaint={isPaintExempt(it)}
                      shp={r.items[it].shp}
                      delivered={r.items[it].delivered}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** One headline number with its plain-language caption. */
function Kpi({ label, value, sub, tone }: { label: string; value: number; sub: string; tone?: "ok" | "warn" }) {
  const color = tone === "ok" ? "var(--ok-fg)" : tone === "warn" ? "var(--warn-fg)" : undefined;
  return (
    <div className="bg-surface border rounded-xl px-4 py-3">
      <div className="text-[10px] font-bold uppercase tracking-wide text-muted">{label}</div>
      <div className="text-2xl font-extrabold tabnum leading-none mt-1" style={{ color }}>{value}</div>
      <div className="text-[11px] text-muted mt-1">{sub}</div>
    </div>
  );
}

// The plan-tracker table's four stage columns per component: Fab | Weld |
// (SHB for the core, Paint otherwise) | Dlvd — matching the Plan Tracker page.
function StageHead({ shb = false }: { shb?: boolean }) {
  return (
    <>
      <th className="p-1 font-medium border-l border-border-strong">Fab</th>
      <th className="p-1 font-medium">Weld</th>
      <th className="p-1 font-medium">{shb ? "SHB" : "Paint"}</th>
      <th className="p-1 font-medium" title="Delivered — received by the customer">Dlvd</th>
    </>
  );
}

function FragmentCW({
  cut, weld, paint, noPaint = false, shp, delivered,
}: {
  cut: number; weld: number; paint: number; noPaint?: boolean;
  shp: number; // the core's SHOT BLAST total — shown in place of Paint for CF
  delivered: number;
}) {
  return (
    <>
      <td className="p-1 text-center tabnum text-xs border-l" style={{ background: "var(--cut-tint)" }}>{cut}</td>
      <td className="p-1 text-center tabnum text-xs" style={{ background: "var(--weld-tint)" }}>{weld}</td>
      {/* the core (CF) is never painted — its finishing is SHOT BLAST */}
      {noPaint ? (
        <td className="p-1 text-center tabnum text-xs" style={{ background: "var(--shp-tint)" }}>{shp}</td>
      ) : (
        <td className="p-1 text-center tabnum text-xs" style={{ background: "var(--paint-tint)" }}>{paint}</td>
      )}
      <td className="p-1 text-center tabnum text-xs" style={{ background: "var(--dlvd-tint)" }}>{delivered}</td>
    </>
  );
}
