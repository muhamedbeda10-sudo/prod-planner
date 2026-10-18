import { redirect } from "next/navigation";
import { PageHead } from "@/components/ui";
import { formatDate } from "@/lib/domain/format";
import { getSettings } from "@/lib/server/data";
import { getReturnsFor } from "@/lib/server/returns";
import { factoryDayISO } from "@/lib/domain/dates";
import { heldOrders } from "@/lib/domain/hold";
import { CutWorklistView } from "@/components/CutWorklistView";
import { PrintHeader } from "@/components/PrintHeader";
import { getCurrentUser, canEditDept, hasPerm, guardTab } from "@/lib/server/auth";
import { getMachineBoard } from "@/lib/server/machineBoard";
import { getWeeklyPlanTracker } from "@/lib/server/weeklyPlanTracker";
import { loadMasterOrdersOf } from "@/lib/server/loads";
import { getActiveLine } from "@/lib/server/line";

export const dynamic = "force-dynamic";

// The fabrication page: the machines and the SHEET JOBS on them (sheets of
// one thickness carrying the parts of several projects, closed sheet by
// sheet), then the weekly plan measured at Fabrication — what the jobs are
// cut against, and where the cut pieces are recorded. The PrintHeader
// appears only on the printed/PDF sheet.
export default async function CutWorklistPage({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  await guardTab("/worklist/cut");
  // a panel is not cut on the lasers — its fabrication is punching, then bending
  if ((await getActiveLine()) === "LV") redirect("/worklist/punching");
  const sp = await searchParams;
  const dayISO = factoryDayISO(new Date());
  // an unknown ?plan= falls back to the newest plan inside the loader
  const [returns, settings, user, week, orders] = await Promise.all([
    getReturnsFor("Cut"),
    getSettings(),
    getCurrentUser(),
    getWeeklyPlanTracker(Number(sp.plan) || null),
    loadMasterOrdersOf("TR"),
  ]);
  const canEdit = !!user && canEditDept(user, "Cut");
  // the machine board only while the plant plans by machine (Settings); the
  // fabrication machines carry the jobs alone — no plan line of its own
  const board = settings.machinePlanning ? await getMachineBoard("Cut", [], dayISO, week.planNo ?? 0) : undefined;

  return (
    <>
      <PrintHeader title="Fabrication Worklist" subtitle={week.planNo === null ? undefined : `Weekly plan ${week.planNo}`} date={formatDate(dayISO)} />
      <PageHead title="Fabrication Worklist" sub={`Transformers · ${formatDate(dayISO)}`} />
      <CutWorklistView
        board={board}
        week={week}
        returns={returns}
        held={heldOrders(orders)}
        canEdit={canEdit}
        canManage={!!user && hasPerm(user, "machines.manage")}
      />
    </>
  );
}
