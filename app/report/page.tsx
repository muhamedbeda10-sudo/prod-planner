import Image from "next/image";
import { getDailyReport, getWorkedOn, getDayOutputByProject, getFullPlanGrouped, getWeekSnapshot, type ReportPlanRow } from "@/lib/server/report";
import { getPlanNos } from "@/lib/server/data";
import { pctStyle, Num } from "@/components/ui";
import { DayPicker, WeekSnapshotPicker, DeptPicker } from "@/components/controls";
import { OutputByComponentChart, PrintButton } from "@/components/ReportCharts";
import { parseISODate, toISODate, toDisplayDate } from "@/lib/domain/dates";
import { ITEMS, isPaintExempt, deptLabel, itemDailyTarget, STAGE_COLOR, type Item } from "@/lib/domain/constants";

// the report can be scoped to any COMBINATION of these stages. Painting is the
// whole finishing stage (painted items + the core's Shot Blast), so there is no
// separate Shot Blast filter — it lives inside Painting.
const REPORT_STAGES = ["Cut", "Welding", "Painting", "Delivered"] as const;
type ReportStage = (typeof REPORT_STAGES)[number];
// compact stage label for the per-stage column headers
const STAGE_SHORT: Record<string, string> = {
  Cut: "Fab", Welding: "Weld", Painting: "Paint", Delivered: "Dlvd",
};
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
// one worked-on day value for a stage × component: the core's Painting column
// is its Shot Blast (the rest are painted)
function stageDayValue(stage: string, it: Item, c: { cut: number; weld: number; paint: number; shp: number; delivered: number }): number {
  if (stage === "Cut") return c.cut;
  if (stage === "Welding") return c.weld;
  if (stage === "Delivered") return c.delivered;
  return isPaintExempt(it) ? c.shp : c.paint; // Painting / finishing
}
const STAGE_TINT: Record<string, string> = {
  Cut: "var(--cut-tint)", Welding: "var(--weld-tint)", Painting: "var(--paint-tint)", Delivered: "var(--dlvd-tint)",
};

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
  searchParams: Promise<{ day?: string; week?: string; dept?: string }>;
}) {
  const sp = await searchParams;
  // default = YESTERDAY: the daily report is reviewed the morning after the
  // day it covers, so it opens on the last finished day (picker overrides)
  const day = (sp.day && parseISODate(sp.day)) || lastFinishedDay();
  const dayISO = toISODate(day);
  const weekNo = Number(sp.week) || null; // null = the FULL plan (default)
  // dept filter — MULTI-select: any combination of stages scopes the output
  // table rows, the chart series, the worked-on columns AND the plan highlight.
  // Empty = all stages. Kept in pipeline order whatever the click order was.
  const picked = new Set((sp.dept ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const deptsF = REPORT_STAGES.filter((s) => picked.has(s)) as ReportStage[];
  const scoped = deptsF.length > 0;
  // the stage columns actually shown (all four when nothing is picked)
  const shownStages: readonly ReportStage[] = scoped ? deptsF : REPORT_STAGES;

  const [{ deptOutputs, target }, worked, dayProjects, planNos, planRows] = await Promise.all([
    getDailyReport(day),
    getWorkedOn(day, scoped ? ledgerDepts(deptsF) : undefined),
    getDayOutputByProject(day, scoped ? ledgerDepts(deptsF) : undefined),
    getPlanNos(),
    weekNo ? getWeekSnapshot(weekNo) : getFullPlanGrouped(),
  ]);

  const cut = deptOutputs.find((d) => d.dept === "Cut")!;
  const weld = deptOutputs.find((d) => d.dept === "Welding")!;
  // Painting is the finishing stage — its per-item totals already fold in the
  // core's Shot Blast (done in computeDailyReport)
  const paint = deptOutputs.find((d) => d.dept === "Painting")!;
  const delivered = deptOutputs.find((d) => d.dept === "Delivered")!;

  // highlight = this BOM had output recorded ON the selected day
  const workedMos = new Set(worked.mos);
  const workedBoms = new Set(worked.bomsAll);
  const hl = (r: ReportPlanRow) => workedBoms.has(r.bom) || r.mos.some((m) => workedMos.has(m));
  const hlStyle = { background: "var(--warn-bg)" } as const;

  return (
    <div className="space-y-6">
      {/* controls only — no on-screen title (the print masthead carries the name) */}
      <div className="no-print flex flex-wrap items-center gap-2">
        <DayPicker value={dayISO} />
        <DeptPicker value={sp.dept ?? ""} />
        <WeekSnapshotPicker plans={planNos} value={sp.week ?? ""} />
        <PrintButton />
      </div>

      {/* Print masthead — logo + title + day, only on paper */}
      <div className="print-only mb-3">
        <div className="flex items-center justify-between border-b-2 border-foreground pb-2">
          <Image src="/brand/atc-logo-horizontal.svg" alt="Arabian Transformers Co." width={230} height={28} priority />
          <div className="text-right">
            <div className="text-xl font-extrabold">Daily Production Report</div>
            <div className="text-sm tabnum">📅 {toDisplayDate(day)}</div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 no-print">
        <h2 className="text-lg font-bold min-w-0">Department output — {toDisplayDate(day)}</h2>
        <Image
          src="/brand/atc-logo-horizontal.svg"
          alt="Arabian Transformers Co."
          width={250}
          height={30}
          className="opacity-90 hidden md:block shrink-0"
        />
      </div>
      <h2 className="text-lg font-bold print-only">Department output — {toDisplayDate(day)}</h2>

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
                  <span className="block text-[10px] font-normal opacity-75 tabnum">/{itemDailyTarget(it, target)}</span>
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
                  {deptLabel(d.dept)}
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
          <h3 className="font-bold text-sm">Output by component — vs daily target</h3>
          <span className="pill pill-muted tabnum">
            <span aria-hidden style={{ width: 18, borderTop: "2px dashed var(--muted)", display: "inline-block" }} />
            Target {target}/item · AR & MB {itemDailyTarget("AR", target)}
          </span>
        </div>
        <OutputByComponentChart cut={cut.items} welding={weld.items} painting={paint.items} delivered={delivered.items} target={target} stages={shownStages} />
      </div>

      {/* Worked-on-today table: ONLY the projects with output recorded on the
          selected day, showing THAT DAY's quantities per component and stage.
          The full plan table below keeps its yellow worked-on highlight. */}
      <section className="print-keep">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <h2 className="text-lg font-bold">
            Worked on — {toDisplayDate(day)}
            {scoped && <span className="text-brand"> · {deptsF.map((d) => deptLabel(d)).join(" + ")} only</span>}
          </h2>
          <span className="pill pill-ok normal-case">{dayProjects.length} project{dayProjects.length === 1 ? "" : "s"}</span>
        </div>
        <div className="bg-surface border rounded-xl overflow-x-auto print-fit">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-brand text-white text-center">
                <th rowSpan={2} className="p-2 text-left">BOM</th>
                <th rowSpan={2} className="p-2 text-left">MOs</th>
                {ITEMS.map((it) => <th key={it} colSpan={shownStages.length} className="p-2 border-l border-border-strong">{it}</th>)}
                <th rowSpan={2} className="p-2">Day total</th>
              </tr>
              <tr className="bg-brand-dark text-white text-[10px]">
                {ITEMS.map((it) => shownStages.map((s, si) => (
                  <th key={`${it}|${s}`} className={`p-1 font-medium ${si === 0 ? "border-l border-border-strong" : ""}`}>
                    {/* the core's finishing column reads as SHB, everything else Paint */}
                    {s === "Painting" && isPaintExempt(it) ? "SHB" : STAGE_SHORT[s]}
                  </th>
                )))}
              </tr>
            </thead>
            <tbody>
              {dayProjects.length === 0 && (
                <tr><td colSpan={3 + ITEMS.length * shownStages.length} className="p-4 text-center text-muted">No output recorded on this day.</td></tr>
              )}
              {dayProjects.map((p, i) => (
                <tr key={p.bom} className={`text-center ${i % 2 ? "bg-zebra" : ""}`}>
                  <td className="p-2 text-left font-bold whitespace-nowrap">{p.bom}</td>
                  <td className="p-2 text-left text-xs text-muted whitespace-nowrap">{p.mos.length > 0 ? p.mos.join(", ") : "—"}</td>
                  {ITEMS.map((it) => {
                    const c = p.items[it] ?? { cut: 0, weld: 0, paint: 0, shp: 0, delivered: 0 };
                    return shownStages.map((s, si) => {
                      // the core's finishing tint is the same orange as Painting
                      const tint = s === "Painting" && isPaintExempt(it) ? "var(--shp-tint)" : STAGE_TINT[s];
                      return (
                        <td key={`${it}|${s}`} className={`p-1 text-center tabnum text-xs ${si === 0 ? "border-l" : ""}`} style={{ background: tint }}>
                          {stageDayValue(s, it, c)}
                        </td>
                      );
                    });
                  })}
                  <td className="p-2 font-extrabold tabnum">{p.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* The plan table — one row per BOM ("cascade" closed): totals across the
          BOM's MOs and the whole-BOM percentage. Default = the FULL plan with
          LIVE numbers; the dropdown switches to one week's snapshot (same live
          numbers, measured against that week's required). Rows worked on the
          selected day are highlighted — on screen and in the printed PDF. */}
      <div className="print-break">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <h2 className="text-lg font-bold">
            {weekNo ? `Week snapshot — Plan ${weekNo}` : "Plan tracker — all orders (live totals)"}
          </h2>
          <span className="text-xs rounded-md px-2 py-1 font-semibold" style={hlStyle}>
            highlighted = worked on {toDisplayDate(day)}{scoped ? ` by ${deptsF.map((d) => deptLabel(d)).join(" + ")}` : ""}
          </span>
        </div>

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
              {planRows.length === 0 && (
                <tr><td colSpan={2 + ITEMS.length * 4} className="p-4 text-center text-muted">No orders in this view.</td></tr>
              )}
              {planRows.map((r, i) => (
                <tr key={r.bom} className={`text-center ${i % 2 ? "bg-zebra" : ""}`} style={hl(r) ? hlStyle : undefined}>
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
      </div>
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
