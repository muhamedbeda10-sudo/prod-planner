import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm, guardTab } from "@/lib/server/auth";
import { linePermKey } from "@/lib/domain/permissions";
import { getMaterialData } from "@/lib/server/material";
import { PageHead } from "@/components/ui";
import { LineSwitch } from "@/components/LineSwitch";
import { MaterialClient } from "@/components/MaterialClient";
import { getActiveLine } from "@/lib/server/line";
import { RememberLastVisit } from "@/components/RememberLastVisit";

export const metadata = { title: "Material — ATC" };
export const dynamic = "force-dynamic";

export default async function MaterialPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await guardTab("/material");
  // viewing is free for every account, like the rest of the app; recording is
  // gated on material.edit
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  await searchParams; // an old link's ?month= is ignored
  // one living table — no month
  const month = "";
  const line = await getActiveLine(); // one product line at a time
  const { lines, totals, knownBoms, lvOrders, lvTemplates, odooByMo } = await getMaterialData(month);

  return (
    <div>
      <RememberLastVisit storageKey="material:last" />
      <PageHead title="Material" sub="Nesting sheet · one living table, matched on the MO" />
      <MaterialClient
        lines={lines} totals={totals} month={month} knownBoms={knownBoms} canEdit={hasPerm(me, linePermKey(line, "material"))}
        product={line} lvOrders={lvOrders} lvTemplates={lvTemplates} odooByMo={odooByMo}
        lineSwitch={<LineSwitch />}
      />
    </div>
  );
}
