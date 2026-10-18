import { ITEM_NAME, deptLabel, type Item } from "@/lib/domain/constants";
import { machineWord } from "@/lib/domain/shifts";
import type { MachineCard, MachineQueueLine } from "@/lib/domain/machineBoard";
import { PrintHeader } from "@/components/PrintHeader";
import { manualIdOf, type ManualJobView } from "@/lib/domain/manualJob";
import { LineMaterialChips } from "@/components/LineMaterialChips";
import { sheetKeyOf, sheetSizeLabel, sheetsFor, thicknessLabel, type LineMaterial } from "@/lib/domain/machineMaterial";

// 🖨 One machine's sheet for the technician: what runs on it now, then what
// comes next, in the planner's order — one table shape throughout, so the
// two tables line up and a sheet job's parts sit under the same columns as a
// plan line. Plain markup: the page renders it on the server.

/** The sheet's columns, the same for every table on it — so "Running now"
 *  and "Next" line up. A machine that only cuts sheet jobs needs just the
 *  job, the parts on it and its sheet; a machine with plan lines carries
 *  their part, Required and pieces too. */
const FULL = ["w-[5%]", "w-[17%]", "w-[22%]", "w-[10%]", "w-[22%]", "w-[10%]", "w-[14%]"] as const;
const RUNS = ["w-[6%]", "w-[44%]", "w-[26%]", "w-[10%]", "w-[14%]"] as const;

function Head({ dept, runsOnly }: { dept: string; runsOnly: boolean }) {
  const th = "px-2 py-1.5";
  return (
    <>
      <colgroup>{(runsOnly ? RUNS : FULL).map((w, i) => <col key={i} className={w} />)}</colgroup>
      <thead>
        <tr className="bg-brand text-white text-left text-xs uppercase tracking-wide">
          <th className={`${th} text-center`}>#</th>
          <th className={th}>BOM ref</th>
          {!runsOnly && <th className={th}>Part</th>}
          {!runsOnly && <th className={`${th} text-right`} title="The plan's Required for the whole BOM">Required</th>}
          <th className={th}>{dept === "Cut" ? "Thk · Sheet" : "Thickness"}</th>
          <th className={`${th} text-center`}>{runsOnly ? "Sheets" : "Pcs"}</th>
          <th className={`${th} text-center`}>Done ✓</th>
        </tr>
      </thead>
    </>
  );
}

function Rows({ lines, from = 1, required, material, dept, jobs, runsOnly }: { lines: MachineQueueLine[]; from?: number; required: Record<string, number>; material: Record<string, LineMaterial>; dept: string; jobs: Record<number, ManualJobView>; runsOnly: boolean }) {
  const mark = (i: number) => (from === 0 ? "▶" : from + i);
  return (
    <>
      {lines.map((q, i) => {
        const job = jobs[manualIdOf(q.mo) ?? -1];
        // a sheet job: one band for the job — its sheet, its sheets and the
        // tick box — then every project's part on its sheets, one a row
        if (job) {
          return (
            <tbody key={`${q.key}#${q.sheet}`} className="border-t-2 border-border">
              <tr className="bg-surface-2">
                <td className="px-2 py-1.5 text-center font-extrabold tabnum align-middle" rowSpan={job.parts.length + 1}>{mark(i)}</td>
                <td className="px-2 py-1.5" colSpan={runsOnly ? 1 : 3}>
                  <span className="font-extrabold">🧾 Job #{job.id}</span>
                  {job.title.trim() && <span className="ms-2 text-xs font-semibold">{job.title}</span>}
                  {job.note && <span className="ms-2 text-xs font-semibold text-muted">{job.note}</span>}
                </td>
                <td className="px-2 py-1.5"><LineMaterialChips m={material[q.key]} pcs={q.remaining} sheets={false} size="print" /></td>
                <td className="px-2 py-1.5 text-center whitespace-nowrap">
                  <span className="font-extrabold tabnum text-lg">{q.remaining}</span><span className="text-xs font-semibold"> sh</span>
                  {job.doneQty > 0 && <span className="block text-[10px] font-semibold text-muted">{job.doneQty} of {job.qty} cut</span>}
                  {q.split && <span className="block text-[10px] font-semibold text-muted">of {q.lineRemaining} left</span>}
                </td>
                <td className="border-l" rowSpan={job.parts.length + 1}></td>
              </tr>
              {job.parts.map((p) => (
                <tr key={p.id} className="border-t border-border/50">
                  <td className="px-2 py-1 ps-4" colSpan={runsOnly ? 3 : 5}>
                    <b className="tabnum">{p.bom || "—"}</b> <span className="font-semibold">{p.item}</span> {p.part} <b className="tabnum">×{p.pcs}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          );
        }
        const manual = manualIdOf(q.mo) !== null;
        return (
          <tbody key={`${q.key}#${q.sheet}`} className="border-t-2 border-border">
            <tr>
              <td className="px-2 py-1.5 text-center font-extrabold tabnum">{mark(i)}</td>
              {manual ? (
                <td className="px-2 py-1.5 font-bold" colSpan={2}>{q.description}</td>
              ) : (
                <>
                  <td className="px-2 py-1.5 font-extrabold whitespace-nowrap">{q.bom}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap"><b>{q.item}</b> <span className="text-xs text-muted">{ITEM_NAME[q.item as Item] ?? ""}</span></td>
                </>
              )}
              <td className="px-2 py-1.5 text-right tabnum">{manual ? "" : required[q.bom] ?? "—"}</td>
              {/* the sheet it is cut from: thickness first — what the machine is set for */}
              <td className="px-2 py-1.5">{material[q.key] || q.sheet ? <LineMaterialChips m={material[q.key]} pcs={q.remaining} sheets={dept === "Cut" && q.stepNo === 1} sheet={q.sheet} size="print" /> : <span className="text-muted text-xs">—</span>}</td>
              <td className="px-2 py-1.5 text-center font-extrabold tabnum text-lg whitespace-nowrap">{q.remaining}{q.split && <span className="block text-[10px] font-semibold text-muted">of {q.lineRemaining}</span>}</td>
              <td className="border-l"></td>
            </tr>
          </tbody>
        );
      })}
    </>
  );
}

export function MachineSheet({ c, dept, dateLabel, required, material, jobs, first }: { c: MachineCard; dept: string; dateLabel: string; required: Record<string, number>; material: Record<string, LineMaterial>; jobs: Record<number, ManualJobView>; first: boolean }) {
  // the fabrication machines cut sheet jobs alone — the narrow table does
  const runsOnly = c.queue.length > 0 && c.queue.every((q) => !!jobs[manualIdOf(q.mo) ?? -1]);
  return (
    <section className={`mb-8 ${first ? "" : "print-break"}`}>
      <PrintHeader title={`${c.machine.code} · ${c.machine.name}`} subtitle={`${deptLabel(dept)} — ${machineWord(dept)} sheet`} date={dateLabel} />
      <div className="flex flex-wrap items-baseline gap-3 mb-2">
        <h2 className="!mb-0">{c.machine.code} <span className="font-semibold">· {c.machine.name}</span></h2>
        <span className="text-xs text-muted tabnum">
          {runsOnly ? `${c.pcs} sheet(s) · ${c.queue.length} job(s)` : `${c.pcs} pcs · ${c.hours} std-h${c.availableH !== null ? ` · ${c.availableH} h available today` : ""}${c.days !== null ? ` · ≈ ${c.days} day(s)` : ""}`}
        </span>
        {c.crew.length > 0 && <span className="text-xs text-muted">👷 {c.crew.join(", ")}</span>}
      </div>
      <SheetTotals c={c} material={material} dept={dept} />
      <div className="bg-surface border rounded-xl overflow-x-auto mb-3">
        <div className="px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-brand bg-brand-light/40">▶ Running now{c.running.length > 1 ? ` — ${c.running.length} together` : ""}</div>
        <table className="w-full table-fixed text-sm border-collapse">
          <Head dept={dept} runsOnly={runsOnly} />
          {c.running.length === 0 ? <tbody><tr><td colSpan={runsOnly ? 5 : 7} className="p-3 text-center text-muted text-xs">nothing started yet</td></tr></tbody> : <Rows lines={c.running} from={0} required={required} material={material} dept={dept} jobs={jobs} runsOnly={runsOnly} />}
        </table>
      </div>
      {c.waiting.length > 0 && (
        <div className="bg-surface border rounded-xl overflow-x-auto">
          <div className="px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-muted bg-surface-2">Next, in this order</div>
          <table className="w-full table-fixed text-sm border-collapse">
            <Head dept={dept} runsOnly={runsOnly} />
            <Rows lines={c.waiting} from={1} required={required} material={material} dept={dept} jobs={jobs} runsOnly={runsOnly} />
          </table>
        </div>
      )}
      <div className="print-only mt-6 grid grid-cols-3 gap-6 text-xs">
        <div className="border-t pt-1">Technician</div>
        <div className="border-t pt-1">Supervisor</div>
        <div className="border-t pt-1">Planner</div>
      </div>
    </section>
  );
}

/** What the machine draws from the store for its whole queue: sheets per
 *  thickness × material × size, added up over the lines it cuts — one look
 *  for the technician (and the store) before the shift starts. */
function SheetTotals({ c, material, dept }: { c: MachineCard; material: Record<string, LineMaterial>; dept: string }) {
  if (dept !== "Cut") return null;
  const tot = new Map<string, { label: string; size: string; sheets: number; estimated: boolean }>();
  for (const q of c.queue) {
    if (q.stepNo !== 1) continue;
    // one sheet of the item on this machine counts that sheet alone
    for (const s of (material[q.key]?.specs ?? []).filter((x) => !q.sheet || sheetKeyOf(x) === q.sheet)) {
      const k = `${s.thicknessMm}|${s.material}|${s.sheetSize}`;
      const cur = tot.get(k) ?? { label: thicknessLabel(s), size: sheetSizeLabel(s.sheetSize), sheets: 0, estimated: false };
      cur.sheets += sheetsFor(s, q.remaining);
      cur.estimated ||= !s.actual;
      tot.set(k, cur);
    }
  }
  if (tot.size === 0) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-2 text-sm">
      <span className="text-[11px] font-bold uppercase tracking-wide text-muted">Sheets for the queue</span>
      {[...tot.values()].map((t) => (
        <span key={`${t.label}|${t.size}`} className="whitespace-nowrap"><b>{t.label}</b> <span className="text-muted">{t.size}</span> · <b className="tabnum">{Math.round(t.sheets * 100) / 100}</b>{t.estimated ? "*" : ""}</span>
      ))}
      {[...tot.values()].some((t) => t.estimated) && <span className="text-[11px] text-muted">* part of it at the BOM rate — not nested yet</span>}
    </div>
  );
}
