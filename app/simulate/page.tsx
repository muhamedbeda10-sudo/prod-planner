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
import { PageHeader } from "@/components/ui";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { WhatIfSimulator } from "@/components/WhatIfSimulator";
import { FloorCanvas, FloorDeptPicker } from "@/components/FloorCanvas";

export const metadata = { title: "Simulator — ATC" };
export const dynamic = "force-dynamic";

// Two views: the what-if control room, and the FLOOR — each department's bay
// drawn as the planner sees it, with what every machine is on right now.
export default async function SimulatePage({ searchParams }: { searchParams: Promise<{ view?: string; dept?: string }> }) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const sp = await searchParams;
  const view = sp.view === "floor" ? "floor" : "whatif";

  const viewSwitch = (
    <nav className="seg" aria-label="View">
      <Link href="/simulate?view=whatif" className={view === "whatif" ? "on" : ""}>What-if</Link>
      <Link href="/simulate?view=floor" className={view === "floor" ? "on" : ""}>Floor</Link>
    </nav>
  );

  if (view === "floor") {
    const dept: ShiftDept = isShiftDept(sp.dept ?? "") ? (sp.dept as ShiftDept) : "Cut";
    const today = factoryDayISO(new Date());
    const [{ layout, updatedBy, updatedAtISO }, lines] = await Promise.all([getFloorLayout(dept), getDeptBoardLines(dept, today)]);
    const board = await getMachineBoard(dept, lines, today);
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
