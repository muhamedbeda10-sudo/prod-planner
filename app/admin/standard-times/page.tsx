import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { PageHead } from "@/components/ui";
import { getCalibration, CALIBRATION_WINDOW_DAYS } from "@/lib/server/calibration";
import { StandardTimesManager } from "./StandardTimesManager";
import { CalibrationPanel } from "./CalibrationPanel";
import { LvStdTimesManager } from "./LvStdTimesManager";
import { CentreTimesManager } from "./CentreTimesManager";
import { getStdData } from "@/lib/server/standardTimes";
import { getCentrePace } from "@/lib/server/kpis";
import { estimatedItemCentreHoursFor } from "@/lib/domain/stdEngine";
import { getLvOrderRates, getLvRates } from "@/lib/server/lvStd";

export const metadata = { title: "Standard Times & Capacity — ATC" };
export const dynamic = "force-dynamic";

export default async function StandardTimesPage() {
  await guardTab("/admin/standard-times");
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!me.isAdmin) redirect("/");

  const [tiers, capacity, fgs, calibration, lvRates, std, pace] = await Promise.all([
    prisma.stdTime.findMany({ orderBy: { kva: "asc" } }),
    prisma.stageCapacity.findMany(),
    prisma.stdFgMap.findMany({ orderBy: { fg: "asc" } }),
    getCalibration(),
    getLvRates(),
    getStdData(),
    getCentrePace(),
  ]);
  // the estimate each centre carries without a typed figure, per class
  const classes = tiers.map((t) => t.kva);
  const estimates = Object.fromEntries(classes.map((k) => [k, estimatedItemCentreHoursFor(std, k)]));
  const lvOrders = await getLvOrderRates(lvRates);

  return (
    <div className="space-y-4">
      <PageHead title="Standard Times & Capacity" sub="Man-hours per KVA class, stage capacity and the FG map — what every earned hour and capacity check is priced from" />
      <StandardTimesManager
        tiers={tiers.map((t) => ({ kva: t.kva, cutMh: t.cutMh, weldMh: t.weldMh, shbMh: t.shbMh, paintMh: t.paintMh }))}
        capacity={Object.fromEntries(capacity.map((c) => [c.dept, c.mhPerDay]))}
        fgs={fgs.map((f) => ({ fg: f.fg, kva: f.kva }))}
      />
      <CentreTimesManager classes={classes} typed={std.centre ?? {}} estimates={estimates} pace={pace} />
      <CalibrationPanel rows={calibration.rows} stages={calibration.stages} windowDays={CALIBRATION_WINDOW_DAYS} />
      <LvStdTimesManager
        rates={lvRates}
        orders={lvOrders.map((o) => ({ mo: o.mo, fgCode: o.fgCode, secItem: o.secItem, product: o.product, planQty: o.planQty, status: o.status, fg: o.rate?.fg ?? null, via: o.via }))}
      />
    </div>
  );
}
