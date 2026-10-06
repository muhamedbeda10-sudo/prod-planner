import { redirect } from "next/navigation";
import { getCurrentUser, guardTab, hasPerm } from "@/lib/server/auth";
import { getPhysicalStock } from "@/lib/server/physicalStock";
import { PageHead } from "@/components/ui";
import { ExportMenu } from "@/components/ExportMenu";
import { PhysicalStockClient } from "@/components/PhysicalStockClient";
import { STATUS_LABEL } from "@/lib/domain/physicalStock";

export const metadata = { title: "Physical Material — ATC" };
export const dynamic = "force-dynamic";

export default async function PhysicalMaterialPage() {
  await guardTab("/physical");
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const { items, lastUpdate } = await getPhysicalStock();

  // the export keeps the store's own headers, with the gap the tab works out
  const exportRows = items.map((i) => ({
    "Product Code": i.code,
    "Product Name": i.name,
    "Physically Stock Internal Store": i.physical,
    UOM: i.uom,
    "SF01 Stock In Odoo": i.odoo,
    Difference: i.diff,
    Family: i.group,
    Status: STATUS_LABEL[i.status],
    Note: i.note ?? "",
  }));

  return (
    <div>
      <PageHead
        title="Physical Material"
        sub="The store's count against SF01's stock in Odoo · one row per product code"
        actions={<ExportMenu excel={[{ rows: exportRows, filename: "physical-material.xlsx", sheetName: "Stock" }]} />}
      />
      <PhysicalStockClient items={items} lastUpdate={lastUpdate} canEdit={hasPerm(me, "stock.edit")} />
    </div>
  );
}
