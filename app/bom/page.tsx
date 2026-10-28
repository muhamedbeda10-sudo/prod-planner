import { redirect } from "next/navigation";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { getActiveLine } from "@/lib/server/line";
import { getBomList, getBomTree, lastBomSync } from "@/lib/server/odooBom";
import { PageHead } from "@/components/ui";
import { LineSwitch } from "@/components/LineSwitch";
import { BomListClient, BomTreeClient } from "@/components/BomClient";

export const metadata = { title: "BoMs — ATC" };
export const dynamic = "force-dynamic";

export default async function BomPage({ searchParams }: { searchParams: Promise<{ bom?: string | string[] }> }) {
  await guardTab("/bom");
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const asked = (await searchParams).bom;
  const bom = (Array.isArray(asked) ? asked[0] ?? "" : asked ?? "").trim();
  const sync = await lastBomSync();

  const line = await getActiveLine();
  if (bom) {
    const data = await getBomTree(bom, line);
    return (
      <div>
        <PageHead title={`BoM ${data.bom}`} sub="Odoo's bill of materials, level by level" />
        <BomTreeClient data={data} sync={sync} />
      </div>
    );
  }

  const rows = (await getBomList()).filter((r) => r.line === line);
  return (
    <div>
      <PageHead title="BoMs" sub="The open orders' bills of materials, from Odoo" />
      <BomListClient rows={rows} sync={sync} lineSwitch={<LineSwitch />} />
    </div>
  );
}
