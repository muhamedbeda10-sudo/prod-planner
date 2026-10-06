import { redirect } from "next/navigation";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { prisma } from "@/lib/db";
import { PageHead } from "@/components/ui";
import { MonthlyImport } from "@/components/MonthlyImport";
import { OrdersTable } from "@/components/OrdersTable";
import { ViewTabs, PLANS_VIEWS } from "@/components/ViewTabs";
import { getActiveLine } from "@/lib/server/line";
import { LINE_LABEL } from "@/lib/domain/lines";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  await guardTab("/orders");
  // admin-only page: invisible in the nav for others, and a direct URL bounces
  const me = await getCurrentUser();
  if (!me?.isAdmin) redirect("/");

  // one product line at a time — the toggle in the nav decides which
  const line = await getActiveLine();
  const orders = await prisma.masterOrder.findMany({ where: { line }, orderBy: [{ createdAt: "desc" }, { mo: "asc" }] });
  const totalQty = orders.reduce((s, o) => s + o.planQty, 0);

  return (
    <div className="space-y-6">
      {/* the weekly delivery schedule is the transformers' — the panels have the monthly plan only */}
      <PageHead
        title="Orders Registry"
        sub={`${LINE_LABEL[line]} · ${orders.length} orders · ${totalQty} pcs planned · tick rows to take a wrong import back out`}
        views={<ViewTabs views={line === "LV" ? PLANS_VIEWS.filter((v) => v.href === "/orders") : PLANS_VIEWS} current="/orders" label="Plans view" />}
      />
      <MonthlyImport line={line} />
      <div>
        <h2>All {LINE_LABEL[line]} orders</h2>
        <OrdersTable
          line={line}
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
