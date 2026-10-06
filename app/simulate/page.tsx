import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasPerm, canEditDept } from "@/lib/server/auth";
import { getWhatIfInputs } from "@/lib/server/whatif";
import { isMachinePlanningOn } from "@/lib/server/data";
import { getFloorLayout } from "@/lib/server/floor";
import { getDeptBoardLines, getMachineBoard } from "@/lib/server/machineBoard";
import { factoryDayISO } from "@/lib/domain/dates";
import { deptPermKey } from "@/lib/domain/permissions";
import { isShiftDept, type ShiftDept } from "@/lib/domain/shifts";
import { placeMachine } from "@/lib/domain/floor";
import { PageHead } from "@/components/ui";
import { ViewTabs } from "@/components/ViewTabs";
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
  // the floor is the machines' view — with machine planning off (Settings)
  // the tab is the what-if simulator alone
  const machinePlanning = await isMachinePlanningOn();
  const view = !machinePlanning || sp.view === "whatif" ? "whatif" : "floor";

  // the tab's other view, top right — the same switch every tab carries
  const viewSwitch = machinePlanning ? (
    <ViewTabs
      views={[
        { href: "/simulate?view=floor", label: "Floor", title: "Each department's bay, and what every machine is on" },
        { href: "/simulate?view=whatif", label: "Simulator", title: "What-if: move the dates and the capacity and see what lands" },
      ]}
      current={`/simulate?view=${view}`}
      label="Floor view"
    />
  ) : null;

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
        <PageHead title="Floor" sub="Who is on what, where" views={viewSwitch}>
          <FloorDeptPicker dept={dept} />
        </PageHead>
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
      <PageHead title="What-if Simulator" sub="Move the dates and the capacity and see what lands" views={viewSwitch} />
      <WhatIfSimulator
        inputs={inputs}
        isAdmin={me.isAdmin}
        savedScenarios={saved.map((s) => ({ name: s.name, data: s.data, savedBy: s.savedBy }))}
        appliedRunOrder={applied ? { atISO: applied.appliedAt.toISOString(), by: applied.appliedBy } : null}
      />
    </div>
  );
}
