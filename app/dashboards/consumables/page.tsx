import { redirect } from "next/navigation";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { getConsumablesDashboard } from "@/lib/server/consumables";
import { getLimitDashboard } from "@/lib/server/consumableLimits";
import { getMonthlyReport } from "@/lib/server/consumableMonthly";
import { BASIS_EXPORT, PERIOD_LABEL } from "@/lib/domain/consumableLimits";
import { MONTH_STATUS_LABEL, isMonthKey, monthLong } from "@/lib/domain/consumableMonthly";
import { consumablesPeriod } from "@/lib/domain/consumables";
import { factoryDayISO } from "@/lib/domain/dates";
import { formatDate } from "@/lib/domain/format";
import { ConsumableAlarms } from "@/components/ConsumableAlarms";
import { ConsumablesMonthly } from "@/components/ConsumablesMonthly";
import { ConsumablesDashboard } from "@/components/LazyCharts";
import { ExportMenu } from "@/components/ExportMenu";
import { PageHead } from "@/components/ui";
import { PrintHeader } from "@/components/PrintHeader";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { UrlDateSlicer } from "@/components/UrlDateSlicer";

export const metadata = { title: "Consumables dashboard — ATC" };
export const dynamic = "force-dynamic";

// The consumables' dashboard, in the Dashboards tab: what went out, to whom,
// against the limits, over the period picked — and the monthly review, by
// calendar month. Seen with the Consumables screen (its tab id); the log, the
// powder and the limits stay in Material → Consumables.
export default async function ConsumablesDashboardPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; month?: string }> }) {
  await guardTab("/dashboards/consumables");
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const sp = await searchParams;
  const today = factoryDayISO(new Date());
  const { from, to, min, label: periodLabel, stamp: period } = consumablesPeriod(sp, today);
  // the monthly review at the bottom goes by calendar month, not the slicer
  const month = sp.month && isMonthKey(sp.month) && sp.month <= today.slice(0, 7) ? sp.month : today.slice(0, 7);
  const [stats, limits, report] = await Promise.all([getConsumablesDashboard(from, to), getLimitDashboard(from, to, today), getMonthlyReport(month)]);
  const exportRows = stats.items.map((i) => ({ Item: i.item, "Hand-outs": i.issues, Qty: i.qty, Workers: i.workers }));
  const monthParams = new URLSearchParams();
  if (sp.from) monthParams.set("from", from);
  if (sp.to) monthParams.set("to", to);
  monthParams.set("month", "");

  return (
    <div className="space-y-3">
      <RememberLastVisit storageKey="dashboards:consumables" />
      <PrintHeader title="Consumables — dashboard" subtitle={`${periodLabel} · monthly review ${monthLong(month)}`} date={formatDate(today)} />
      <PageHead title="Consumables" sub={`Dashboard · ${periodLabel}`} />
      <UrlDateSlicer
        encoding="fromTo" from={from} to={to} min={min} max={today} today={today}
        presets={["yesterday", "last7", "thisMonth", "lastMonth", "last30", "last90"]}
        defaultRange={{ label: "Today", from: today, to: today }}
        end={<ExportMenu excel={[
          { label: "Items summary", rows: exportRows, filename: `consumables-summary-${period}.xlsx`, sheetName: "Items" },
          { label: "Monthly review", rows: monthlyExportRows(report), filename: `consumables-monthly-${month}.xlsx`, sheetName: month },
        ]} print />}
      />
      {/* the limits first: an alarm is what the page is opened for */}
      <ConsumableAlarms d={limits} periodLabel={periodLabel} />
      <ConsumablesDashboard s={stats} periodLabel={periodLabel} />
      <section id="monthly" className="space-y-3 scroll-mt-24 pt-2">
        <h2 className="font-bold text-lg">Monthly review · {monthLong(month)}</h2>
        <ConsumablesMonthly report={report} monthHref={`/dashboards/consumables?${monthParams.toString()}`} />
      </section>
    </div>
  );
}

function monthlyExportRows(report: Awaited<ReturnType<typeof getMonthlyReport>>) {
  return report.rows.flatMap((r) => [
    {
      Level: "Item", Code: r.code ?? "", Item: r.name, UOM: r.uom, Departments: "", "Limit": "", "Monthly limit": r.allowance ?? "",
      Used: r.used, Left: r.allowance === null ? "" : Math.round((r.allowance - r.covered) * 1000) / 1000, "Outside the limits": r.outside, "Of the limit": r.ratio === null ? "" : `${Math.round(r.ratio * 100)}%`,
      Status: MONTH_STATUS_LABEL[r.status], [`Used ${report.prevMonth}`]: r.prevUsed,
      "Counted over": "",
      ...Object.fromEntries(r.trend.map((t) => [t.month, t.used])),
    },
    ...r.limits.map((l) => ({
      Level: "Limit", Code: r.code ?? "", Item: r.name, UOM: r.uom, Departments: l.departmentsLabel,
      "Limit": l.perWorker
        ? `${l.perWorker.qty} per worker × ${Math.max(1, l.perWorker.workers)} ${PERIOD_LABEL[l.period]}`
        : `${l.qty} ${PERIOD_LABEL[l.period]} (${BASIS_EXPORT[l.basis]})`,
      "Monthly limit": l.allowance,
      Used: l.used, Left: l.left, "Outside the limits": "", "Of the limit": `${Math.round(l.ratio * 100)}%`, Status: MONTH_STATUS_LABEL[l.status],
      [`Used ${report.prevMonth}`]: l.prevUsed,
      "Counted over": l.toDate ?? "",
      ...Object.fromEntries(r.trend.map((t) => [t.month, ""])),
    })),
  ]);
}
