import { redirect } from "next/navigation";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { prisma } from "@/lib/db";
import { PageHead } from "@/components/ui";
import { MonthlyImport } from "@/components/MonthlyImport";
import { OrdersTable } from "@/components/OrdersTable";
import { LineSwitch } from "@/components/LineSwitch";
import { getActiveLine } from "@/lib/server/line";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  await guardTab("/orders");
  // admin-only page: invisible in the nav for others, and a direct URL bounces
  const me = await getCurrentUser();
  if (!me?.isAdmin) redirect("/");

  // one product line at a time — the switch in the orders' bar decides which
  const line = await getActiveLine();
  const orders = await prisma.masterOrder.findMany({ where: { line }, orderBy: [{ createdAt: "desc" }, { mo: "asc" }] });
  const totalQty = orders.reduce((s, o) => s + o.planQty, 0);

  return (
    <div className="space-y-6">
      <PageHead title="Orders Registry" sub={`Monthly plan · ${orders.length} orders · ${totalQty} pcs planned`} />
      <MonthlyImport line={line} />
      <div>
        <OrdersTable
          line={line}
          lineSwitch={<LineSwitch />}
          rows={orders.map((o) => ({
            id: o.id,
            mo: o.mo,
            soi: o.soi,
            urgent: o.urgent,
            customer: o.customer,
            fgCode: o.fgCode,
            bom: o.bom,
            kva: o.kva,
            rating: o.rating,
            planQty: o.planQty,
            colorRal: o.colorRal,
            remarks: o.remarks,
            source: o.source,
            createdAt: o.createdAt.toISOString(),
            updatedAt: o.updatedAt.toISOString(),
            product: o.product,
            secItem: o.secItem,
            ospEncloser: o.ospEncloser,
            materialsRemarks: o.materialsRemarks,
          }))}
        />
      </div>
    </div>
  );
}
