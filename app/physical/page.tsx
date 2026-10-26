import { redirect } from "next/navigation";
import { getCurrentUser, guardTab, hasPerm } from "@/lib/server/auth";
import { getPhysicalStock } from "@/lib/server/physicalStock";
import { PageHead } from "@/components/ui";
import { PhysicalStockClient } from "@/components/PhysicalStockClient";

export const metadata = { title: "Physical Material — ATC" };
export const dynamic = "force-dynamic";

export default async function PhysicalMaterialPage() {
  await guardTab("/physical");
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const { items, lastUpdate } = await getPhysicalStock();

  return (
    <div>
      <PageHead title="Physical Material" sub="Store count against Odoo's SF01 stock" />
      <PhysicalStockClient
        items={items} lastUpdate={lastUpdate} canEdit={hasPerm(me, "stock.edit")}
      />
    </div>
  );
}
