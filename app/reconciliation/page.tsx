import { getReconciliation } from "@/lib/server/reconcile";
import { getPlanNos, getLatestPlanNo } from "@/lib/server/data";
import { PageHeader } from "@/components/ui";
import { PlanPicker } from "@/components/controls";
import { ExportButton } from "@/components/ExportButton";
import type { Severity, ReconCategory } from "@/lib/domain/reconcile";

export const dynamic = "force-dynamic";

const SEV: Record<Severity, { cls: string; label: string }> = {
  high: { cls: "bg-bad-bg text-bad-fg", label: "High" },
  warn: { cls: "bg-warn-bg text-warn-fg", label: "Warn" },
  info: { cls: "bg-brand-light text-brand", label: "Info" },
};
const CAT: Record<ReconCategory, string> = {
  CONTINUED: "Continued",
  DROPPED_WITH_BACKLOG: "Dropped w/ backlog",
  MOVED: "Moved (family)",
  DROPPED: "Dropped",
  NEW: "New",
};

export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string }>;
}) {
  const sp = await searchParams;
  const plans = await getPlanNos();
  const planNo = Number(sp.plan) || (await getLatestPlanNo()) || 0;
  const { previousPlanNo, rows } = planNo ? await getReconciliation(planNo) : { previousPlanNo: null, rows: [] };

  const exportRows = rows.map((r) => ({
    BOM: r.bom, Item: r.item, Category: r.category, Severity: r.severity,
    OldTarget: r.oldTarget, NewTarget: r.newTarget, WeldedPrev: r.weldedPrev,
    Expected: r.expected, Delta: r.delta, Backlog: r.backlog,
    PlannerBalance: r.plannerBalance ?? "", ActualRemaining: r.actualRemaining ?? "",
    BalanceConflict: r.balanceConflict ? "YES" : "", Message: r.message,
  }));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Plan Reconciliation"
        sub="What changed vs the previous plan — targets, drops, new orders, balance conflicts"
      >
        <PlanPicker plans={plans} value={planNo} />
        <ExportButton rows={exportRows} filename={`reconciliation-plan-${planNo}.xlsx`} sheetName="Reconciliation" />
      </PageHeader>

      {previousPlanNo === null ? (
        <p className="text-muted bg-brand-light rounded-lg p-3 inline-block">
          No previous plan to compare plan {planNo} against. Reconciliation appears once at least two plans are imported.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted">
            Comparing plan <b className="text-foreground">{planNo}</b> vs plan <b className="text-foreground">{previousPlanNo}</b> —
            {rows.length === 0 ? " no differences to review ✓" : ` ${rows.length} items to review.`}
          </p>
          {rows.length > 0 && (
            <div className="bg-surface border rounded-xl overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-brand text-white text-center">
                    <th className="p-2 text-left">BOM</th><th className="p-2">Item</th><th className="p-2">Category</th>
                    <th className="p-2">Old target</th><th className="p-2">New target</th><th className="p-2">Welded prev</th>
                    <th className="p-2">Expected</th><th className="p-2">Delta</th><th className="p-2 text-left">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className={`text-center ${SEV[r.severity].cls}`}>
                      <td className="p-2 text-left font-bold whitespace-nowrap">{r.bom}</td>
                      <td className="p-2 font-bold">{r.item}</td>
                      <td className="p-2 font-semibold">{CAT[r.category]}</td>
                      <td className="p-2 tabnum">{r.oldTarget}</td>
                      <td className="p-2 tabnum">{r.newTarget}</td>
                      <td className="p-2 tabnum">{r.weldedPrev}</td>
                      <td className="p-2 tabnum">{r.category === "CONTINUED" ? r.expected : "—"}</td>
                      <td className="p-2 tabnum font-bold">{r.category === "CONTINUED" ? (r.delta > 0 ? `+${r.delta}` : r.delta) : r.backlog || "—"}</td>
                      <td className="p-2 text-left text-xs">{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
