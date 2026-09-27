import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import { PageHeader } from "@/components/ui";
import { getCalibration, CALIBRATION_WINDOW_DAYS } from "@/lib/server/calibration";
import { StandardTimesManager } from "./StandardTimesManager";
import { CalibrationPanel } from "./CalibrationPanel";
import { LvStdTimesManager } from "./LvStdTimesManager";
import { getLvOrderRates, getLvRates } from "@/lib/server/lvStd";

export const metadata = { title: "Standard Times & Capacity — ATC" };
export const dynamic = "force-dynamic";

export default async function StandardTimesPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!me.isAdmin) redirect("/");

  const [tiers, capacity, fgs, calibration, lvRates] = await Promise.all([
    prisma.stdTime.findMany({ orderBy: { kva: "asc" } }),
    prisma.stageCapacity.findMany(),
    prisma.stdFgMap.findMany({ orderBy: { fg: "asc" } }),
    getCalibration(),
    getLvRates(),
  ]);
  const lvOrders = await getLvOrderRates(lvRates);

  return (
    <div className="space-y-6">
      <PageHeader title="⏱ Standard Times & Capacity" />
      <StandardTimesManager
        tiers={tiers.map((t) => ({ kva: t.kva, cutMh: t.cutMh, weldMh: t.weldMh, shbMh: t.shbMh, paintMh: t.paintMh }))}
        capacity={Object.fromEntries(capacity.map((c) => [c.dept, c.mhPerDay]))}
        fgs={fgs.map((f) => ({ fg: f.fg, kva: f.kva }))}
      />
      <CalibrationPanel rows={calibration.rows} stages={calibration.stages} windowDays={CALIBRATION_WINDOW_DAYS} />
      <LvStdTimesManager
        rates={lvRates}
        orders={lvOrders.map((o) => ({ mo: o.mo, fgCode: o.fgCode, secItem: o.secItem, product: o.product, planQty: o.planQty, status: o.status, fg: o.rate?.fg ?? null, via: o.via }))}
      />
    </div>
  );
}
