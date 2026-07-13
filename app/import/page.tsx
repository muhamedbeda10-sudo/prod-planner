import { PageHeader } from "@/components/ui";
import { ImportForm } from "@/components/ImportForm";
import { toISODate } from "@/lib/domain/dates";
import { getPlanNos } from "@/lib/server/data";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const plans = await getPlanNos();
  return (
    <div className="space-y-5 max-w-3xl">
      <PageHeader
        title="Import Weekly Plan"
        sub="DELIVERY SCHEDULE ONLY — dates per MO come from here; order quantities live in the monthly registry, progress in the daily logs"
      />
      <p className="text-sm text-muted">
        Grid: A=BOM (merged, carried down) · B=SOI · C=MO · D=Description · E=Required · F..AC = 6 days × 4 components · AD=Remarks.
        Plan dates are oven dates. Remarks are stored for reference but never interpreted — no balance parsing.
      </p>
      <ImportForm defaultDate={toISODate(new Date())} />
      {plans.length > 0 && (
        <p className="text-xs text-muted">Existing plans: {plans.join(", ")}</p>
      )}
    </div>
  );
}
