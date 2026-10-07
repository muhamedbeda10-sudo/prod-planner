import { formatDate } from "@/lib/domain/format";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { getDeptBoardLines, getMachineBoard, type BoardDept } from "@/lib/server/machineBoard";
import { isMachinePlanningOn } from "@/lib/server/data";
import { factoryDayISO } from "@/lib/domain/dates";
import { ITEM_NAME, deptLabel, type Item } from "@/lib/domain/constants";
import { isShiftDept, machineWord } from "@/lib/domain/shifts";
import type { MachineCard, MachineQueueLine } from "@/lib/domain/machineBoard";
import { PrintHeader } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { PageHeader } from "@/components/ui";
import { runIdOf, type NestRunView } from "@/lib/domain/nestRun";
import { LineMaterialChips } from "@/components/LineMaterialChips";
import { sheetKeyOf, sheetSizeLabel, sheetsFor, thicknessLabel, type LineMaterial } from "@/lib/domain/machineMaterial";

export const metadata = { title: "Machine sheets — ATC" };
export const dynamic = "force-dynamic";

// 🖨 The technician's sheet: one machine (or every machine of a department,
// each on its own page) with what runs on it NOW and what comes next, in
// the order the planner set — the paper handed over at the start of the
// shift. Reached from the board's "Print sheet", the Floor's inspector, or
// "Print all sheets" on the board.
export default async function MachineSheetsPage({ searchParams }: { searchParams: Promise<{ dept?: string; machine?: string }> }) {
  await guardTab("/worklist/machines");
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const sp = await searchParams;
  if (!(await isMachinePlanningOn())) {
    return (
      <div>
        <PageHeader title="🖨 Machine sheets" />
        <p className="text-sm text-muted bg-surface border rounded-xl p-4">
          Machine planning is turned off, so no work is planned onto machines and there are no sheets to print.
          {me.isAdmin ? <> Turn it on under <Link href="/admin/settings" className="text-accent font-semibold hover:underline">Admin → Settings</Link>.</> : " An admin can turn it on under Admin → Settings."}
        </p>
      </div>
    );
  }
  const dept: BoardDept = isShiftDept(sp.dept ?? "") ? (sp.dept as BoardDept) : "Cut";
  const only = Number(sp.machine) || null;
  const today = factoryDayISO(new Date());
  const lines = await getDeptBoardLines(dept, today);
  const board = await getMachineBoard(dept, lines, today);
  const cards = board.cards.filter((c) => (only ? c.machine.id === only : c.queue.length > 0));
  const word = machineWord(dept);
  const dateLabel = formatDate(today);
  const back = dept === "ShotBlast" ? "/shifts?dept=ShotBlast" : `/worklist/${dept === "Cut" ? "cut" : dept.toLowerCase()}`;

  return (
    <div>
      <PageHeader label={only && cards[0] ? `🖨 ${cards[0].machine.code} · ${cards[0].machine.name}` : `🖨 ${deptLabel(dept)} — ${machineWord(dept, true)} sheets`}>
        <Link href={back} className="btn btn-sm">← Worklist</Link>
        <Link href={`/simulate?view=floor&dept=${dept}`} className="btn btn-sm">🗺 Floor</Link>
        {only && <Link href={`/worklist/machines?dept=${dept}`} className="btn btn-sm">All {machineWord(dept, true)}</Link>}
        <PrintButton />
      </PageHeader>
      {cards.length === 0 ? (
        <p className="text-sm text-muted">Nothing is on {only ? `this ${word}` : `any ${word}`} yet — put lines on it from the worklist or the Floor first.</p>
      ) : (
        cards.map((c, i) => <Sheet key={c.machine.id} c={c} dept={dept} dateLabel={dateLabel} required={Object.fromEntries(board.runCandidates.map((x) => [x.bom, x.required]))} material={board.material} runs={Object.fromEntries(board.nestRuns.map((r) => [r.id, r]))} first={i === 0} />)
      )}
    </div>
  );
}

function Rows({ lines, from = 1, required, material, dept, runs, runsOnly }: { lines: MachineQueueLine[]; from?: number; required: Record<string, number>; material: Record<string, LineMaterial>; dept: string; runs: Record<number, NestRunView>; runsOnly: boolean }) {
  return (
    <>
      {lines.map((q, i) => {
        // a nest run reads as what it is: the sheets, and every job on them
        const run = runs[runIdOf(q.mo) ?? -1];
        if (run) return (
          <tr key={`${q.key}#${q.sheet}`} className="border-t">
            <td className="p-2 text-center font-extrabold tabnum">{from === 0 ? "▶" : from + i}</td>
            <td className="p-2 font-extrabold whitespace-nowrap align-top" colSpan={runsOnly ? 1 : 2}>🧩 Nest run #{run.id}{run.note ? <span className="block text-xs font-semibold text-muted">{run.note}</span> : null}</td>
            {/* the jobs on its sheets — by BOM ref and part, the plan's Required for
                the BOM, and the pieces this run cuts of it */}
            <td className="p-2">
              <table className="text-xs border-collapse">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wide text-muted text-left">
                    <th className="pe-4 pb-0.5 font-bold">BOM ref</th><th className="pe-4 pb-0.5 font-bold">Part</th><th className="pe-4 pb-0.5 font-bold text-right">Required</th><th className="pb-0.5 font-bold text-right">Pcs</th>
                  </tr>
                </thead>
                <tbody>
                  {runJobs(run).map((p) => (
                    <tr key={`${p.bom}|${p.item}`} className="border-t border-border/60">
                      <td className="pe-4 py-0.5 font-bold whitespace-nowrap">{p.bom}</td>
                      <td className="pe-4 py-0.5 whitespace-nowrap"><b>{p.item}</b> <span className="text-muted">{ITEM_NAME[p.item as Item] ?? ""}</span></td>
                      <td className="pe-4 py-0.5 text-right tabnum">{required[p.bom] ?? "—"}</td>
                      <td className="py-0.5 text-right tabnum font-bold">{p.pcs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </td>
            {/* the sheets are counted in Pcs beside it — the thickness and size only here */}
            <td className="p-2"><LineMaterialChips m={material[q.key]} pcs={q.remaining} sheets={false} size="print" /></td>
            <td className="p-2 text-center font-extrabold tabnum text-lg whitespace-nowrap">{q.remaining}<span className="text-xs font-semibold"> sh</span>{run.sheetsDone > 0 && <span className="block text-[10px] font-semibold text-muted">{run.sheetsDone} of {run.sheets} cut</span>}</td>
            <td className="p-2 w-28 border-l"></td>
          </tr>
        );
        return (
        <tr key={`${q.key}#${q.sheet}`} className="border-t">
          <td className="p-2 text-center font-extrabold tabnum">{from === 0 ? "▶" : from + i}</td>
          <td className="p-2 font-extrabold whitespace-nowrap">{q.bom}</td>
          <td className="p-2 text-center font-bold">{q.item}</td>
          <td className="p-2 text-xs">{q.description}</td>
          {/* the sheet it is cut from: thickness first — what the machine is set for */}
          <td className="p-2">{material[q.key] || q.sheet ? <LineMaterialChips m={material[q.key]} pcs={q.remaining} sheets={dept === "Cut" && q.stepNo === 1} sheet={q.sheet} size="print" /> : <span className="text-muted text-xs">—</span>}</td>
          <td className="p-2 text-center font-extrabold tabnum text-lg whitespace-nowrap">{q.remaining}{runIdOf(q.mo) !== null && <span className="text-xs font-semibold"> sh</span>}{q.split && <span className="block text-[10px] font-semibold text-muted">of {q.lineRemaining}</span>}</td>
          <td className="p-2 w-28 border-l"></td>
        </tr>
        );
      })}
    </>
  );
}

/** A run's jobs, one line per BOM's part — its orders together. */
function runJobs(run: NestRunView) {
  const by = new Map<string, { bom: string; item: string; pcs: number }>();
  for (const p of run.parts) {
    const k = `${p.bom}|${p.item}`;
    const cur = by.get(k) ?? { bom: p.bom, item: p.item, pcs: 0 };
    cur.pcs += p.pcs;
    by.set(k, cur);
  }
  return [...by.values()];
}

function Sheet({ c, dept, dateLabel, required, material, runs, first }: { c: MachineCard; dept: string; dateLabel: string; required: Record<string, number>; material: Record<string, LineMaterial>; runs: Record<number, NestRunView>; first: boolean }) {
  // a laser working only nest runs needs no BOM / Item columns — they would
  // stand empty on every row; the run and the jobs on it say it all
  const runsOnly = c.queue.length > 0 && c.queue.every((q) => runIdOf(q.mo) !== null);
  const head = runsOnly ? (
    <tr className="bg-brand text-white text-left">
      <th className="p-2 w-10 text-center">#</th>
      <th className="p-2">Nest run</th>
      <th className="p-2">On the sheets</th>
      <th className="p-2">Thk · Sheet</th>
      <th className="p-2 text-center">Sheets</th>
      <th className="p-2 w-28">Done ✓</th>
    </tr>
  ) : (
    <tr className="bg-brand text-white text-left">
      <th className="p-2 w-10 text-center">#</th>
      <th className="p-2">BOM</th>
      <th className="p-2 text-center">Item</th>
      <th className="p-2">Description</th>
      <th className="p-2" title="Thickness · sheet size · sheets the pieces take (* = BOM rate, not nested yet)">{dept === "Cut" ? "Thk · Sheet · Sheets" : "Thickness"}</th>
      <th className="p-2 text-center">Pcs</th>
      <th className="p-2 w-28">Done ✓</th>
    </tr>
  );
  return (
    <section className={`mb-8 ${first ? "" : "print-break"}`}>
      <PrintHeader title={`${c.machine.code} · ${c.machine.name}`} subtitle={`${deptLabel(dept)} — ${machineWord(dept)} sheet`} date={dateLabel} />
      <div className="flex flex-wrap items-baseline gap-3 mb-2">
        <h2 className="!mb-0">{c.machine.code} <span className="font-semibold">· {c.machine.name}</span></h2>
        <span className="text-xs text-muted tabnum">{c.pcs} pcs · {c.hours} std-h{c.availableH !== null ? ` · ${c.availableH} h available today` : ""}{c.days !== null ? ` · ≈ ${c.days} day(s)` : ""}</span>
        {c.crew.length > 0 && <span className="text-xs text-muted">👷 {c.crew.join(", ")}</span>}
      </div>
      <SheetTotals c={c} material={material} dept={dept} />
      <div className="bg-surface border rounded-xl overflow-x-auto mb-3">
        <div className="px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-brand bg-brand-light/40">▶ Running now{c.running.length > 1 ? ` — ${c.running.length} together` : ""}</div>
        <table className="w-full text-sm border-collapse">
          <thead>{head}</thead>
          <tbody>
            {c.running.length === 0 ? <tr><td colSpan={runsOnly ? 6 : 7} className="p-3 text-center text-muted text-xs">nothing started yet</td></tr> : <Rows lines={c.running} from={0} required={required} material={material} dept={dept} runs={runs} runsOnly={runsOnly} />}
          </tbody>
        </table>
      </div>
      {c.waiting.length > 0 && (
        <div className="bg-surface border rounded-xl overflow-x-auto">
          <div className="px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-muted bg-surface-2">Next, in this order</div>
          <table className="w-full text-sm border-collapse">
            <thead>{head}</thead>
            <tbody><Rows lines={c.waiting} from={1} required={required} material={material} dept={dept} runs={runs} runsOnly={runsOnly} /></tbody>
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
      <span className="text-[11px] text-muted">* part of it at the BOM rate — not nested yet</span>
    </div>
  );
}
