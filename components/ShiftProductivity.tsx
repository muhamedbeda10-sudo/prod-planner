import { Activity } from "lucide-react";
import { EmptyState } from "@/components/primitives";
import { formatDate } from "@/lib/domain/format";
import Link from "next/link";
import { WORKER_DEPT_LABEL } from "@/lib/domain/tanks";
import { efficiencyTone, type ProdStat } from "@/lib/domain/productivity";
import type { ShiftProductivity as Data } from "@/lib/server/productivity";

// The rates the shift log feeds: man-hours per piece for every department,
// and for the transformers the efficiency against the standard times — the
// day on screen beside the last recorded days, which is the figure to read.

const TONE = { ok: "text-ok-fg", warn: "text-warn-fg", bad: "text-bad-fg" } as const;
const fmt = (n: number) => n.toLocaleString("en");
const dmy = (iso: string) => formatDate(iso);

function Cells({ s, priced }: { s: ProdStat | null; priced: boolean }) {
  if (!s || s.days === 0) {
    return <td colSpan={4} className="p-2 text-center text-xs text-muted border-s">not recorded</td>;
  }
  return (
    <>
      <td className="p-2 text-right tabnum border-s" title={`${s.people} present on average`}>{fmt(s.manHours)}</td>
      <td className="p-2 text-right tabnum">{fmt(s.pieces)}</td>
      <td className="p-2 text-right tabnum font-bold">{s.mhPerPiece === null ? <span className="text-muted font-normal">—</span> : s.mhPerPiece}</td>
      <td className="p-2 text-right tabnum" title={s.earned !== null ? `${fmt(s.earned)} std-hours earned ÷ ${fmt(s.manHours)} man-hours worked` : "No standard times for this department"}>
        {s.efficiency === null ? <span className="text-muted">{priced ? "—" : "n/a"}</span> : <b className={TONE[efficiencyTone(s.efficiency)]}>{Math.round(s.efficiency * 100)}%</b>}
      </td>
    </>
  );
}

export function ShiftProductivity({ data, dayISO, filterLabel, isAdmin }: { data: Data; dayISO: string; filterLabel: string; isAdmin: boolean }) {
  const n = data.windowDates.length;
  const span = n ? `${dmy(data.windowDates[0])} → ${dmy(data.windowDates[n - 1])}` : "";
  return (
    <section>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-2">
        <h2 className="!mb-0">📈 Productivity — {filterLabel}</h2>
        <span className="explain text-[11px] text-muted">
          man-hours from this log against the pieces the daily log recorded on the same days · efficiency = std-hours the output is worth ÷ man-hours worked
        </span>
        {isAdmin && <Link href="/admin/standard-times" className="ms-auto text-xs text-brand-ink font-semibold hover:underline">Calibrate the standard times →</Link>}
      </div>
      {n === 0 ? (
        <div className="rounded-xl border border-dashed"><EmptyState compact icon={<Activity size={18} aria-hidden />} title="Nothing recorded yet" hint="The rates appear from the first saved day." /></div>
      ) : (
        <div className="bg-surface border rounded-xl overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-surface-2 text-[11px] text-muted uppercase tracking-wide">
                <th className="p-2" />
                <th colSpan={4} className="p-2 text-center border-s">{dmy(dayISO)}</th>
                <th colSpan={4} className="p-2 text-center border-s" title={span}>Last {n} recorded day{n === 1 ? "" : "s"}</th>
              </tr>
              <tr className="bg-surface-2 text-[11px] text-muted">
                <th className="p-2 text-left">Department</th>
                {[0, 1].flatMap((i) => [
                  <th key={`h${i}`} className="p-2 text-right border-s">Man-hours</th>,
                  <th key={`p${i}`} className="p-2 text-right">Pieces</th>,
                  <th key={`r${i}`} className="p-2 text-right" title="Man-hours one piece took">mh / pc</th>,
                  <th key={`e${i}`} className="p-2 text-right">Efficiency</th>,
                ])}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const priced = r.window.earned !== null;
                return (
                  <tr key={r.dept} className="border-t">
                    <td className="p-2 font-semibold whitespace-nowrap">{WORKER_DEPT_LABEL[r.dept]}</td>
                    <Cells s={r.day} priced={priced} />
                    <Cells s={r.window} priced={priced} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="explain text-[11px] text-muted mt-1">
        A single day swings when output is logged a day late — read the last {Math.max(n, 1)} days. Shot blast counts every painted piece as well as the cores it finishes, and the LV panels it blasts. Panels are priced by the timings sheet&apos;s LV tab; a panel with no row there earns nothing.
      </p>
    </section>
  );
}
