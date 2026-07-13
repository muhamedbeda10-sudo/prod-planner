import { getBomReview, getReallocationMoves } from "@/lib/server/boms";
import { getPlanNos, getLatestPlanNo } from "@/lib/server/data";
import { PageHeader } from "@/components/ui";
import { PlanPicker } from "@/components/controls";
import { BomReviewTable, ReallocPanel } from "@/components/BomsClient";

export const dynamic = "force-dynamic";

export default async function BomsPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string }>;
}) {
  const sp = await searchParams;
  const plans = await getPlanNos();
  const planNo = Number(sp.plan) || (await getLatestPlanNo()) || 0;
  const [review, moves] = await Promise.all([
    getBomReview(),
    planNo ? getReallocationMoves(planNo) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-8">
      <PageHeader
        title="BOM Review & Excess Reallocation"
        sub="Code hygiene for the handover log, and family-level excess moves (approve / reject)"
      >
        <PlanPicker plans={plans} value={planNo} />
      </PageHeader>

      <section>
        <h2 className="font-bold mb-2">BOM hygiene (NormalizeBoms)</h2>
        <BomReviewTable rows={review} />
      </section>

      <section>
        <h2 className="font-bold mb-2">Excess reallocation (ReallocateExcess) — Plan {planNo}</h2>
        <ReallocPanel
          planNo={planNo}
          moves={moves.map((m) => ({
            id: m.id, dept: m.dept, item: m.item, fromBom: m.fromBom, toBom: m.toBom, qty: m.qty, status: m.status, reason: m.reason,
          }))}
        />
      </section>
    </div>
  );
}
