import { redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasPerm, canEditDept } from "@/lib/server/auth";
import { getWhatIfInputs } from "@/lib/server/whatif";
import { getFloorLayout } from "@/lib/server/floor";
import { getDeptBoardLines, getMachineBoard } from "@/lib/server/machineBoard";
import { factoryDayISO } from "@/lib/domain/dates";
import { deptPermKey } from "@/lib/domain/permissions";
import { isShiftDept, type ShiftDept } from "@/lib/domain/shifts";
import { placeMachine } from "@/lib/domain/floor";
import { PageHeader } from "@/components/ui";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { WhatIfSimulator } from "@/components/WhatIfSimulator";
import { FloorCanvas, FloorDeptPicker } from "@/components/FloorCanvas";

export const metadata = { title: "Simulator — ATC" };
export const dynamic = "force-dynamic";

// Two views under one tab. The FLOOR leads — each department's bay drawn as
// the planner sees it, with what every machine is on right now, which is what
// he opens this for daily. The what-if control room is the second view.
export default async function SimulatePage({ searchParams }: { searchParams: Promise<{ view?: string; dept?: string }> }) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const sp = await searchParams;
  const view = sp.view === "whatif" ? "whatif" : "floor";

  const viewSwitch = (
    <nav className="seg" aria-label="View">
      <Link href="/simulate?view=floor" className={view === "floor" ? "on" : ""} title="Each department's bay, and what every machine is on">Floor</Link>
      <Link href="/simulate?view=whatif" className={view === "whatif" ? "on" : ""} title="What-if: move the dates and the capacity and see what lands">Simulator</Link>
    </nav>
  );

  if (view === "floor") {
    const dept: ShiftDept = isShiftDept(sp.dept ?? "") ? (sp.dept as ShiftDept) : "Cut";
    const today = factoryDayISO(new Date());
    const [saved, lines] = await Promise.all([getFloorLayout(dept), getDeptBoardLines(dept, today)]);
    const board = await getMachineBoard(dept, lines, today);
    // a floor nobody has drawn yet starts with every machine on it, in rows —
    // what each is on shows at once; the planner then drags them into place
    const { updatedBy, updatedAtISO } = saved;
    const layout = saved.layout.nodes.length > 0 ? saved.layout : board.machines.reduce((l, m) => placeMachine(l, m.id), saved.layout);
    return (
      <div>
        <RememberLastVisit storageKey="simulate:last" />
        <PageHeader title="🗺 Floor — who is on what, where">
          {viewSwitch}
          <FloorDeptPicker dept={dept} />
        </PageHeader>
        <FloorCanvas
          key={dept}
          dept={dept}
          initial={layout}
          board={board}
          canDraw={hasPerm(me, "machines.manage")}
          canAssign={dept === "ShotBlast" ? hasPerm(me, deptPermKey("ShotBlast")) : canEditDept(me, dept)}
          updatedBy={updatedBy}
          updatedAtISO={updatedAtISO}
        />
      </div>
    );
  }

  const [inputs, saved, applied] = await Promise.all([
    getWhatIfInputs(),
    prisma.simScenario.findMany({ orderBy: { updatedAt: "desc" }, select: { name: true, data: true, savedBy: true } }),
    prisma.runOrderEntry.findFirst({ orderBy: { appliedAt: "desc" }, select: { appliedAt: true, appliedBy: true } }),
  ]);

  return (
    <div>
      <RememberLastVisit storageKey="simulate:last" />
      <PageHeader title="🧪 What-if Simulator">{viewSwitch}</PageHeader>
      <WhatIfSimulator
        inputs={inputs}
        isAdmin={me.isAdmin}
        savedScenarios={saved.map((s) => ({ name: s.name, data: s.data, savedBy: s.savedBy }))}
        appliedRunOrder={applied ? { atISO: applied.appliedAt.toISOString(), by: applied.appliedBy } : null}
      />
    </div>
  );
}
