import { formatDate } from "@/lib/domain/format";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { getDeptBoardLines, getMachineBoard, type BoardDept } from "@/lib/server/machineBoard";
import { isMachinePlanningOn } from "@/lib/server/data";
import { factoryDayISO } from "@/lib/domain/dates";
import { deptLabel } from "@/lib/domain/constants";
import { isShiftDept, machineWord } from "@/lib/domain/shifts";
import { PrintButton } from "@/components/PrintButton";
import { PageHeader } from "@/components/ui";
import { MachineSheet } from "@/components/MachineSheet";

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
  // the sheet jobs, by id — a machine line that is one prints its parts
  const jobs = Object.fromEntries(board.manualJobs.filter((j) => j.bySheet).map((j) => [j.id, j]));
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
        cards.map((c, i) => <MachineSheet key={c.machine.id} c={c} dept={dept} dateLabel={dateLabel} required={board.required} material={board.material} jobs={jobs} first={i === 0} />)
      )}
    </div>
  );
}
