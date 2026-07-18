import Image from "next/image";
import { getDailyReport, getWorkedOn, getFullPlanGrouped, getWeekSnapshot, type ReportPlanRow } from "@/lib/server/report";
import { getPlanNos } from "@/lib/server/data";
import { pctStyle, Num } from "@/components/ui";
import { DayPicker, WeekSnapshotPicker } from "@/components/controls";
import { OutputByComponentChart, PrintButton } from "@/components/ReportCharts";
import { parseISODate, toISODate, toDisplayDate } from "@/lib/domain/dates";
import { ITEMS, isPaintExempt } from "@/lib/domain/constants";

export const dynamic = "force-dynamic";

function fmtPct(v: number | null) {
  return v === null ? "—" : `${(v * 100).toFixed(0)}%`;
}

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string; week?: string }>;
}) {
  const sp = await searchParams;
  const day = (sp.day && parseISODate(sp.day)) || new Date();
  const dayISO = toISODate(day);
  const weekNo = Number(sp.week) || null; // null = the FULL plan (default)

  const [{ deptOutputs, target }, worked, planNos, planRows] = await Promise.all([
    getDailyReport(day),
    getWorkedOn(day),
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
              {ITEMS.map((it) => <th key={it} className="p-2">{it}</th>)}
              <th className="p-2">Total</th>
              <th className="p-2">Target/item</th>
              <th className="p-2">Complete Sets</th>
              <th className="p-2">Efficiency %</th>
              <th className="p-2">Balance %</th>
            </tr>
          </thead>
          <tbody>
            {deptOutputs.map((d) => (
              <tr key={d.dept} className="text-center">
                <td className="p-2 text-left font-bold">{d.dept}</td>
                {ITEMS.map((it) => <td key={it} className="p-2 tabnum"><Num v={d.items[it]} /></td>)}
                <td className="p-2 font-bold tabnum">{d.total}</td>
                <td className="p-2 tabnum">{d.target}</td>
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
            Target {target}/item
          </span>
        </div>
        <OutputByComponentChart cut={cut.items} welding={weld.items} painting={paint.items} target={target} />
      </div>

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
            highlighted = worked on {toDisplayDate(day)}
          </span>
        </div>

        <div className="bg-surface border rounded-xl overflow-x-auto print-fit">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-brand text-white text-center">
                <th rowSpan={2} className="p-2 text-left">BOM</th>
                <th rowSpan={2} className="p-2">Required</th>
                {ITEMS.map((it) => <th key={it} colSpan={3} className="p-2 border-l border-border-strong">{it}</th>)}
                <th rowSpan={2} className="p-2">Complete</th>
                <th rowSpan={2} className="p-2">Left</th>
                <th rowSpan={2} className="p-2">Achv.</th>
              </tr>
              <tr className="bg-brand-dark text-white text-[10px]">
                {ITEMS.map((it) => <StageHead key={it} />)}
              </tr>
            </thead>
            <tbody>
              {planRows.length === 0 && (
                <tr><td colSpan={17} className="p-4 text-center text-muted">No orders in this view.</td></tr>
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
                    <FragmentCW key={it} cut={r.items[it].cut} weld={r.items[it].weld} paint={r.items[it].paint} noPaint={isPaintExempt(it)} />
                  ))}
                  <td className="p-2 font-extrabold tabnum">{r.complete}</td>
                  <td className="p-2 font-bold tabnum" style={{ color: r.left > 0 ? "var(--bad-fg)" : "var(--ok-fg)" }}>{r.left}</td>
                  <td className="p-2 font-bold tabnum" style={pctStyle(r.achievement)}>{fmtPct(r.achievement)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StageHead() {
  return (
    <>
      <th className="p-1 font-medium border-l border-border-strong">Cut</th>
      <th className="p-1 font-medium">Weld</th>
      <th className="p-1 font-medium">Paint</th>
    </>
  );
}

function FragmentCW({ cut, weld, paint, noPaint = false }: { cut: number; weld: number; paint: number; noPaint?: boolean }) {
  return (
    <>
      <td className="p-1 text-center tabnum text-xs border-l" style={{ background: "var(--cut-tint)" }}>{cut}</td>
      <td className="p-1 text-center tabnum text-xs" style={{ background: "var(--weld-tint)" }}>{weld}</td>
      {noPaint ? (
        <td className="p-1 text-center text-muted text-xs" title="not painted — core ships after welding">—</td>
      ) : (
        <td className="p-1 text-center tabnum text-xs" style={{ background: "var(--paint-tint)" }}>{paint}</td>
      )}
    </>
  );
}
