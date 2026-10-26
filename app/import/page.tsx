import { redirect } from "next/navigation";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { PageHead, ReadingColumn } from "@/components/ui";
import { ImportForm } from "@/components/ImportForm";
import { factoryDayISO } from "@/lib/domain/dates";
import { getPlanNos } from "@/lib/server/data";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  await guardTab("/import");
  // admin-only page: invisible in the nav for others, and a direct URL bounces
  const me = await getCurrentUser();
  if (!me?.isAdmin) redirect("/");
  // the weekly delivery schedule is the transformers' (PINNED_LINE) — the panels plan monthly
  const plans = await getPlanNos();
  return (
    <ReadingColumn width="3xl" className="space-y-5">
      <PageHead title="Weekly plan import" sub="Transformers · the delivery schedule" />
      <p className="text-sm text-muted">
        <b>Delivery schedule only.</b> Dates per MO come from here; order quantities live in the monthly registry
        beside it, and progress in the daily logs.
      </p>
      <p className="text-sm text-muted">
        Grid: A=BOM (merged, carried down) · B=SOI · C=MO · D=Description · E=Required · F..AC = 6 days × 4 components · AD=Remarks.
        Plan dates are oven dates. Remarks are stored for reference but never interpreted — no balance parsing.
      </p>
      <ImportForm defaultDate={factoryDayISO(new Date())} />
      {plans.length > 0 && (
        <p className="text-xs text-muted">Existing plans: {plans.join(", ")}</p>
      )}
    </ReadingColumn>
  );
}
