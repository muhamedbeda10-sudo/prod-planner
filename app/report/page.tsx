import Image from "next/image";
import { getDailyReport, getWorkedOn, getDayOutputByProject, getFullPlanGrouped, getWeekSnapshot, type ReportPlanRow } from "@/lib/server/report";
import { getPlanNos } from "@/lib/server/data";
import { pctStyle, Num } from "@/components/ui";
import { DayPicker, WeekSnapshotPicker, DeptPicker } from "@/components/controls";
import { OutputByComponentChart, PrintButton } from "@/components/ReportCharts";
import { parseISODate, toISODate, toDisplayDate } from "@/lib/domain/dates";
import { ITEMS, isPaintExempt, isDept, deptLabel, DEPT_SHORT, itemDailyTarget, type Dept } from "@/lib/domain/constants";

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
  // dept filter — scopes the output table, chart, worked-on projects AND the
  // tracker highlight to that department's work only
  const deptF: Dept | null = sp.dept && isDept(sp.dept) ? sp.dept : null;

  const [{ deptOutputs, target }, worked, dayProjects, planNos, planRows] = await Promise.all([
    getDailyReport(day),
    getWorkedOn(day, deptF ?? undefined),
    getDayOutputByProject(day, deptF ?? undefined),
    getPlanNos(),
    weekNo ? getWeekSnapshot(weekNo) : getFullPlanGrouped(),
  ]);

  const cut = deptOutputs.find((d) => d.dept === "Cut")!;
  const weld = deptOutputs.find((d) => d.dept === "Welding")!;
  const paint = deptOutputs.find((d) => d.dept === "Painting")!;

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
            {deptOutputs.filter((d) => !deptF || d.dept === deptF).map((d) => (
              <tr key={d.dept} className="text-center">
                <td className="p-2 text-left font-bold">{deptLabel(d.dept)}</td>
                {ITEMS.map((it) => (
                  <td key={it} className="p-2 tabnum">
                    {/* the core (CF) is never painted */}
                    {d.dept === "Painting" && isPaintExempt(it) ? <span className="text-muted">—</span> : <Num v={d.items[it]} />}
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
        <OutputByComponentChart cut={cut.items} welding={weld.items} painting={paint.items} target={target} only={deptF ?? undefined} />
      </div>

      {/* Worked-on-today table: ONLY the projects with output recorded on the
          selected day, showing THAT DAY's quantities per component and stage.
          The full plan table below keeps its yellow worked-on highlight. */}
      <section className="print-keep">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <h2 className="text-lg font-bold">
            Worked on — {toDisplayDate(day)}
            {deptF && <span className="text-brand"> · {deptLabel(deptF)} only</span>}
          </h2>
          <span className="pill pill-ok normal-case">{dayProjects.length} project{dayProjects.length === 1 ? "" : "s"}</span>
        </div>
        <div className="bg-surface border rounded-xl overflow-x-auto print-fit">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-brand text-white text-center">
                <th rowSpan={2} className="p-2 text-left">BOM</th>
                <th rowSpan={2} className="p-2 text-left">MOs</th>
                {ITEMS.map((it) => <th key={it} colSpan={deptF ? 1 : 3} className="p-2 border-l border-border-strong">{it}</th>)}
                <th rowSpan={2} className="p-2">Day total</th>
              </tr>
              <tr className="bg-brand-dark text-white text-[10px]">
                {ITEMS.map((it) => <StageHead key={it} only={deptF ?? undefined} />)}
              </tr>
            </thead>
            <tbody>
              {dayProjects.length === 0 && (
                <tr><td colSpan={3 + ITEMS.length * (deptF ? 1 : 3)} className="p-4 text-center text-muted">No output recorded on this day.</td></tr>
              )}
              {dayProjects.map((p, i) => (
                <tr key={p.bom} className={`text-center ${i % 2 ? "bg-zebra" : ""}`}>
                  <td className="p-2 text-left font-bold whitespace-nowrap">{p.bom}</td>
                  <td className="p-2 text-left text-xs text-muted whitespace-nowrap">{p.mos.length > 0 ? p.mos.join(", ") : "—"}</td>
                  {ITEMS.map((it) => {
                    const c = p.items[it] ?? { cut: 0, weld: 0, paint: 0 };
                    return <FragmentCW key={it} cut={c.cut} weld={c.weld} paint={c.paint} noPaint={isPaintExempt(it)} only={deptF ?? undefined} />;
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
            highlighted = worked on {toDisplayDate(day)}{deptF ? ` by ${deptLabel(deptF)}` : ""}
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
                {ITEMS.map((it) => <StageHead key={it} shb={isPaintExempt(it)} dlvd />)}
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
                      dlvd
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

function StageHead({ only, shb = false, dlvd = false }: { only?: Dept; shb?: boolean; dlvd?: boolean }) {
  if (only) return <th className="p-1 font-medium border-l border-border-strong">{DEPT_SHORT[only]}</th>;
  return (
    <>
      <th className="p-1 font-medium border-l border-border-strong">Fab</th>
      <th className="p-1 font-medium">Weld</th>
      {/* the core (CF) is never painted — its final stage is SHOT BLAST */}
      <th className="p-1 font-medium">{shb ? "SHB" : "Paint"}</th>
      {dlvd && <th className="p-1 font-medium" title="Delivered — received by the customer">Dlvd</th>}
    </>
  );
}

function FragmentCW({
  cut, weld, paint, noPaint = false, only, shp, delivered, dlvd = false,
}: {
  cut: number; weld: number; paint: number; noPaint?: boolean; only?: Dept;
  /** the core's SHOT BLAST total — shown in place of Paint when provided */
  shp?: number;
  delivered?: number;
  dlvd?: boolean; // append the Delivered cell (tracker-style tables)
}) {
  const cutCell = <td className="p-1 text-center tabnum text-xs border-l" style={{ background: "var(--cut-tint)" }}>{cut}</td>;
  const weldCell = <td className={`p-1 text-center tabnum text-xs ${only ? "border-l" : ""}`} style={{ background: "var(--weld-tint)" }}>{weld}</td>;
  const paintCell = noPaint ? (
    shp !== undefined ? (
      <td className={`p-1 text-center tabnum text-xs ${only ? "border-l" : ""}`} style={{ background: "var(--shp-tint)" }}>{shp}</td>
    ) : (
      <td className={`p-1 text-center text-muted text-xs ${only ? "border-l" : ""}`} title="not painted — core ships after welding">—</td>
    )
  ) : (
    <td className={`p-1 text-center tabnum text-xs ${only ? "border-l" : ""}`} style={{ background: "var(--paint-tint)" }}>{paint}</td>
  );
  if (only === "Cut") return cutCell;
  if (only === "Welding") return weldCell;
  if (only === "Painting") return paintCell;
  return (
    <>
      {cutCell}
      {weldCell}
      {paintCell}
      {dlvd && (
        <td className="p-1 text-center tabnum text-xs" style={{ background: "var(--dlvd-tint)" }}>{delivered ?? 0}</td>
      )}
    </>
  );
}
