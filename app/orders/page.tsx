import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/server/auth";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { MonthlyImport } from "@/components/MonthlyImport";
import { OrdersTable } from "@/components/OrdersTable";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  // admin-only page: invisible in the nav for others, and a direct URL bounces
  const me = await getCurrentUser();
  if (!me?.isAdmin) redirect("/");

  const orders = await prisma.masterOrder.findMany({ orderBy: [{ createdAt: "desc" }, { mo: "asc" }] });
  const totalQty = orders.reduce((s, o) => s + o.planQty, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Orders Registry"
        sub={`The master MO list, fed by the monthly plans — ${orders.length} orders · ${totalQty} pcs planned. Tick rows to take a wrong import back out.`}
      />
      <MonthlyImport />
      <div>
        <h2>All orders</h2>
        <OrdersTable
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
          }))}
        />
      </div>
    </div>
  );
}
