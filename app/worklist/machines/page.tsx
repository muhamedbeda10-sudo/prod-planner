import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/server/auth";
import { getDeptBoardLines, getMachineBoard, type BoardDept } from "@/lib/server/machineBoard";
import { getSoiLookup } from "@/lib/server/soi";
import { isMachinePlanningOn } from "@/lib/server/data";
import { factoryDayISO, toDisplayDate, parseISODate } from "@/lib/domain/dates";
import { deptLabel } from "@/lib/domain/constants";
import { isShiftDept, machineWord } from "@/lib/domain/shifts";
import type { MachineCard, MachineQueueLine } from "@/lib/domain/machineBoard";
import { PrintHeader } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Machine sheets — ATC" };
export const dynamic = "force-dynamic";

// 🖨 The technician's sheet: one machine (or every machine of a department,
// each on its own page) with what runs on it NOW and what comes next, in
// the order the planner set — the paper handed over at the start of the
// shift. Reached from the board's "Print sheet", the Floor's inspector, or
// "Print all sheets" on the board.
export default async function MachineSheetsPage({ searchParams }: { searchParams: Promise<{ dept?: string; machine?: string }> }) {
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
  const [lines, soi] = await Promise.all([getDeptBoardLines(dept, today), getSoiLookup()]);
  const board = await getMachineBoard(dept, lines, today);
  const cards = board.cards.filter((c) => (only ? c.machine.id === only : c.queue.length > 0));
  const word = machineWord(dept);
  const dateLabel = toDisplayDate(parseISODate(today)!);
  const back = dept === "ShotBlast" ? "/shifts?dept=ShotBlast" : `/worklist/${dept === "Cut" ? "cut" : dept.toLowerCase()}`;

  return (
    <div>
      <PageHeader title={only && cards[0] ? `🖨 ${cards[0].machine.code} · ${cards[0].machine.name}` : `🖨 ${deptLabel(dept)} — ${machineWord(dept, true)} sheets`}>
        <Link href={back} className="btn btn-sm">← Worklist</Link>
        <Link href={`/simulate?view=floor&dept=${dept}`} className="btn btn-sm">🗺 Floor</Link>
        {only && <Link href={`/worklist/machines?dept=${dept}`} className="btn btn-sm">All {machineWord(dept, true)}</Link>}
        <PrintButton />
      </PageHeader>
      {cards.length === 0 ? (
        <p className="text-sm text-muted">Nothing is on {only ? `this ${word}` : `any ${word}`} yet — put lines on it from the worklist or the Floor first.</p>
      ) : (
        cards.map((c, i) => <Sheet key={c.machine.id} c={c} dept={dept} dateLabel={dateLabel} soi={soi.byMo} first={i === 0} />)
      )}
    </div>
  );
}

function ddmm(iso: string) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

function Rows({ lines, from = 1, soi, today }: { lines: MachineQueueLine[]; from?: number; soi: Record<string, string>; today: string }) {
  return (
    <>
      {lines.map((q, i) => (
        <tr key={q.key} className="border-t">
          <td className="p-2 text-center font-extrabold tabnum">{from === 0 ? "▶" : from + i}</td>
          <td className="p-2 font-extrabold whitespace-nowrap">{q.bom}</td>
          <td className="p-2 text-center font-bold">{q.item}</td>
          <td className="p-2 whitespace-nowrap ltr">{q.mo || "—"}</td>
          <td className="p-2 whitespace-nowrap ltr">{(q.mo && soi[q.mo]) || "—"}</td>
          <td className="p-2 text-xs">{q.description}</td>
          <td className="p-2 text-center font-extrabold tabnum text-lg whitespace-nowrap">{q.remaining}{q.split && <span className="block text-[10px] font-semibold text-muted">of {q.lineRemaining}</span>}</td>
          <td className="p-2 text-center tabnum">{q.hours !== null ? q.hours : "—"}</td>
          <td className={`p-2 text-center tabnum whitespace-nowrap ${q.deliveryISO && q.deliveryISO < today ? "text-bad-fg font-bold" : ""}`}>{q.deliveryISO ? ddmm(q.deliveryISO) : "—"}</td>
          <td className="p-2 w-28 border-l"></td>
        </tr>
      ))}
    </>
  );
}

function Sheet({ c, dept, dateLabel, soi, first }: { c: MachineCard; dept: string; dateLabel: string; soi: Record<string, string>; first: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const head = (
    <tr className="bg-brand text-white text-left">
      <th className="p-2 w-10 text-center">#</th>
      <th className="p-2">BOM</th>
      <th className="p-2 text-center">Item</th>
      <th className="p-2">MO</th>
      <th className="p-2">SOI</th>
      <th className="p-2">Description</th>
      <th className="p-2 text-center">Pcs</th>
      <th className="p-2 text-center">Std h</th>
      <th className="p-2 text-center">Deliver</th>
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
      <div className="bg-surface border rounded-xl overflow-hidden mb-3">
        <div className="px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-brand bg-brand-light/40">▶ Running now{c.running.length > 1 ? ` — ${c.running.length} together` : ""}</div>
        <table className="w-full text-sm border-collapse">
          <thead>{head}</thead>
          <tbody>
            {c.running.length === 0 ? <tr><td colSpan={10} className="p-3 text-center text-muted text-xs">nothing started yet</td></tr> : <Rows lines={c.running} from={0} soi={soi} today={today} />}
          </tbody>
        </table>
      </div>
      {c.waiting.length > 0 && (
        <div className="bg-surface border rounded-xl overflow-hidden">
          <div className="px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-muted bg-surface-2">Next, in this order</div>
          <table className="w-full text-sm border-collapse">
            <thead>{head}</thead>
            <tbody><Rows lines={c.waiting} from={1} soi={soi} today={today} /></tbody>
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
