import { redirect } from "next/navigation";
import { getCurrentUser, guardTab, hasPerm, hiddenTabsOf } from "@/lib/server/auth";
import { getPhysicalStock } from "@/lib/server/physicalStock";
import { getOpenSheetNeeds } from "@/lib/server/materialCoverage";
import { needByStock } from "@/lib/domain/materialCoverage";
import { PageHead } from "@/components/ui";
import { PhysicalStockClient } from "@/components/PhysicalStockClient";

export const metadata = { title: "Physical Material — ATC" };
export const dynamic = "force-dynamic";

export default async function PhysicalMaterialPage() {
  await guardTab("/physical");
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  // the open orders' need comes off the MATERIAL tab's nesting — only for whoever may see it
  // a failure there leaves the store's own table working, with a note
  const showNeed = !hiddenTabsOf(me).has("material");
  const [{ items, lastUpdate }, needs] = await Promise.all([getPhysicalStock(), showNeed ? getOpenSheetNeeds().catch(() => "failed" as const) : null]);

  return (
    <div>
      <PageHead title="Physical Material" sub="Store count against Odoo's SF01 stock" />
      <PhysicalStockClient
        items={items} lastUpdate={lastUpdate} canEdit={hasPerm(me, "stock.edit")}
        need={needs && needs !== "failed" ? needByStock(needs, items) : null}
        needFailed={needs === "failed"}
      />
    </div>
  );
}
