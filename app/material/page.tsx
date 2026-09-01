import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { getMaterialData } from "@/lib/server/material";
import { PageHeader } from "@/components/ui";
import { ExportButton } from "@/components/ExportButton";
import { MaterialClient, MaterialBomPicker } from "@/components/MaterialClient";

export const metadata = { title: "Material — ATC" };
export const dynamic = "force-dynamic";

export default async function MaterialPage({
  searchParams,
}: {
  searchParams: Promise<{ bom?: string }>;
}) {
  // viewing is free for every account, like the rest of the app; recording is
  // gated on material.edit
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const sp = await searchParams;
  const bom = (sp.bom ?? "").trim().toUpperCase();
  const { lines, totals, orders, boms } = await getMaterialData(bom || undefined);

  // Export carries the workbook's OWN column names, so the file the planner
  // downloads drops straight into the sheet they already work from.
  const exportRows = lines.map((l) => ({
    "BOM Ref": l.bom,
    "Order (MO)": l.mo,
    "Quantity of Units": l.units,
    "Material Type": l.material,
    "Thickness (mm)": l.thicknessMm,
    "Sheet Size": l.sheetSize,
    "No. of Sheets Actually Used": l.sheetsUsed,
    "No. of Sheets in BOM for one Unit": l.sheetsPerUnit ?? "",
    "No. of Sheets in BOM for Job": l.allowed ?? "",
    Difference: l.difference ?? "",
    Notes: l.note ?? "",
  }));

  return (
    <div>
      <PageHeader title="🧱 MATERIAL — material actually used">
        <MaterialBomPicker boms={boms} value={bom} />
        <ExportButton
          rows={exportRows}
          filename={`material-nesting${bom ? `-${bom}` : ""}.xlsx`}
          sheetName="Nesting Tracker"
        />
      </PageHeader>

      <MaterialClient
        lines={lines}
        totals={totals}
        orders={orders}
        boms={boms}
        bom={bom}
        canEdit={hasPerm(me, "material.edit")}
      />
    </div>
  );
}
