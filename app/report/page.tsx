import Image from "next/image";
import { getDailyReport } from "@/lib/server/report";
import { PageHeader, StatusPill, pctStyle, Num } from "@/components/ui";
import { DayPicker } from "@/components/controls";
import { OutputByComponentChart, SetsVsTargetChart, PrintButton } from "@/components/ReportCharts";
import { parseISODate, toISODate, toDisplayDate } from "@/lib/domain/dates";
import { ITEMS } from "@/lib/domain/constants";

export const dynamic = "force-dynamic";

function fmtPct(v: number | null) {
  return v === null ? "—" : `${(v * 100).toFixed(0)}%`;
}

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string }>;
}) {
  const sp = await searchParams;
  const day = (sp.day && parseISODate(sp.day)) || new Date();
  const dayISO = toISODate(day);
  const { deptOutputs, projects, target, tracker, planNo } = await getDailyReport(day);

  const cut = deptOutputs.find((d) => d.dept === "Cut")!;
  const weld = deptOutputs.find((d) => d.dept === "Welding")!;
  const paint = deptOutputs.find((d) => d.dept === "Painting")!;

  // merge the per-dept project rows into ONE row per BOM — Cut | Weld | Paint
  // per component, the same layout as the tracker snapshot below
  const stageOf: Record<string, "cut" | "weld" | "paint"> = { Cut: "cut", Welding: "weld", Painting: "paint" };
  const merged = new Map<
    string,
    {
      bom: string;
      description: string;
      items: Record<(typeof ITEMS)[number], { cut: number; weld: number; paint: number }>;
      totalToday: number;
      required: number | null;
      completed: number | null;
      progress: number | null;
      status: (typeof projects)[number]["status"];
    }
  >();
  for (const p of projects) {
    const stage = stageOf[p.dept];
    if (!stage) continue;
    let e = merged.get(p.bom);
    if (!e) {
      e = {
        bom: p.bom,
        description: p.description,
        items: { CF: { cut: 0, weld: 0, paint: 0 }, TC: { cut: 0, weld: 0, paint: 0 }, TN: { cut: 0, weld: 0, paint: 0 }, CB: { cut: 0, weld: 0, paint: 0 } },
        totalToday: 0,
        required: p.required,
        completed: p.completed,
        progress: p.progress,
        status: p.status,
      };
      merged.set(p.bom, e);
    }
    for (const it of ITEMS) e.items[it][stage] += p.items[it];
    e.totalToday += p.totalToday;
  }
  const workedToday = [...merged.values()];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Daily Report"
        sub="Department output, projects worked today, and the plan snapshot — print-ready"
      >
        <DayPicker value={dayISO} />
        <PrintButton />
      </PageHeader>

      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-bold">Department output — {toDisplayDate(day)}</h2>
        <Image
          src="/brand/atc-logo-horizontal.svg"
          alt="Arabian Transformers Co."
          width={250}
          height={30}
          className="opacity-90"
        />
      </div>

      {/* Section 1: department output */}
      <div className="bg-surface border rounded-xl overflow-x-auto">
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

      {/* Charts */}
      <div className="grid md:grid-cols-2 gap-4 print-break">
        <div className="bg-surface border rounded-xl p-3">
          <h3 className="font-bold text-sm mb-2">Output by component</h3>
          <OutputByComponentChart cut={cut.items} welding={weld.items} painting={paint.items} />
        </div>
        <div className="bg-surface border rounded-xl p-3">
          <h3 className="font-bold text-sm mb-2">Complete sets vs daily target</h3>
          <SetsVsTargetChart target={target} cutSets={cut.sets} weldSets={weld.sets} paintSets={paint.sets} />
        </div>
      </div>

      {/* Section 2: projects worked today */}
      <div>
        <h2 className="text-lg font-bold mb-2">Projects worked today</h2>
        <div className="bg-surface border rounded-xl overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-brand text-white text-center">
                <th rowSpan={2} className="p-2 text-left">BOM</th>
                <th rowSpan={2} className="p-2 text-left">Description</th>
                {ITEMS.map((it) => <th key={it} colSpan={3} className="p-2 border-l border-white/20">{it}</th>)}
                <th rowSpan={2} className="p-2">Total today</th>
                <th rowSpan={2} className="p-2">Required</th>
                <th rowSpan={2} className="p-2">Completed</th>
                <th rowSpan={2} className="p-2">Progress</th>
                <th rowSpan={2} className="p-2">Status</th>
              </tr>
              <tr className="bg-brand-dark text-white text-[10px]">
                {ITEMS.map((it) => <StageHead key={it} />)}
              </tr>
            </thead>
            <tbody>
              {workedToday.length === 0 && <tr><td colSpan={19} className="p-4 text-center text-muted">No work recorded on this day.</td></tr>}
              {workedToday.map((p, i) => (
                <tr key={p.bom} className={`text-center ${i % 2 ? "bg-zebra" : ""}`}>
                  <td className="p-2 text-left font-bold whitespace-nowrap">{p.bom}</td>
                  <td className="p-2 text-left text-xs text-muted">{p.description}</td>
                  {ITEMS.map((it) => (
                    <FragmentCW key={it} cut={p.items[it].cut} weld={p.items[it].weld} paint={p.items[it].paint} />
                  ))}
                  <td className="p-2 font-bold tabnum">{p.totalToday}</td>
                  <td className="p-2 tabnum">{p.required ?? "—"}</td>
                  <td className="p-2 tabnum">{p.completed ?? "—"}</td>
                  <td className="p-2 font-bold tabnum" style={pctStyle(p.progress)}>{fmtPct(p.progress)}</td>
                  <td className="p-2"><StatusPill status={p.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Section 3: all projects snapshot */}
      <div className="print-break">
        <h2 className="text-lg font-bold mb-2">All projects — tracker snapshot {planNo ? `(Plan ${planNo})` : ""}</h2>
        <div className="bg-surface border rounded-xl overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-brand text-white text-center">
                <th rowSpan={2} className="p-2 text-left">BOM</th>
                <th rowSpan={2} className="p-2">Required</th>
                {ITEMS.map((it) => <th key={it} colSpan={3} className="p-2 border-l border-white/20">{it}</th>)}
                <th rowSpan={2} className="p-2">Complete</th>
                <th rowSpan={2} className="p-2">Progress</th>
              </tr>
              <tr className="bg-brand-dark text-white text-[10px]">
                {ITEMS.map((it) => <StageHead key={it} />)}
              </tr>
            </thead>
            <tbody>
              {tracker.map((r, i) => (
                <tr key={r.bom} className={`text-center ${i % 2 ? "bg-zebra" : ""}`}>
                  <td className="p-2 text-left font-bold whitespace-nowrap">{r.bom}</td>
                  <td className="p-2 font-bold tabnum">{r.required}</td>
                  {ITEMS.map((it) => (
                    <FragmentCW key={it} cut={r.items[it].cutDone} weld={r.items[it].weldDone} paint={r.items[it].paintDone} />
                  ))}
                  <td className="p-2 font-extrabold tabnum">{r.complete}</td>
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
      <th className="p-1 font-medium border-l border-white/20">Cut</th>
      <th className="p-1 font-medium">Weld</th>
      <th className="p-1 font-medium">Paint</th>
    </>
  );
}

function FragmentCW({ cut, weld, paint }: { cut: number; weld: number; paint: number }) {
  return (
    <>
      <td className="p-1 text-center tabnum text-xs border-l" style={{ background: "var(--cut-tint)" }}>{cut}</td>
      <td className="p-1 text-center tabnum text-xs" style={{ background: "var(--weld-tint)" }}>{weld}</td>
      <td className="p-1 text-center tabnum text-xs" style={{ background: "var(--paint-tint)" }}>{paint}</td>
    </>
  );
}
