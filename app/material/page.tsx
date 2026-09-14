import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { getMaterialData } from "@/lib/server/material";
import { currentMonthLabel } from "@/lib/domain/dates";
import { PageHeader } from "@/components/ui";
import { ExportButton } from "@/components/ExportButton";
import { MaterialClient, MaterialMonthPicker } from "@/components/MaterialClient";
import { RememberLastVisit } from "@/components/RememberLastVisit";

export const metadata = { title: "Material — ATC" };
export const dynamic = "force-dynamic";

export default async function MaterialPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  // viewing is free for every account, like the rest of the app; recording is
  // gated on material.edit
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const sp = await searchParams;
  const month = (sp.month ?? "").trim() || currentMonthLabel();
  const { lines, totals, months, knownBoms } = await getMaterialData(month);

  // the export carries the sheet's OWN column names in its order, then the
  // tab's additions, so the file drops straight back into the workbook
  const exportRows = lines.map((l) => ({
    "BOM Ref": l.bom,
    "Quantity of Units": l.units,
    "Part Code": l.partCode,
    "Part Name": l.partName,
    Codes: l.materialCode,
    Material: l.material,
    "Thickness (mm)": l.thicknessMm,
    "Sheet Size": l.sheetSize,
    "No. of Sheets in BOM for one Unit": l.sheetsPerUnit,
    "No. of Sheets in BOM for Job": l.forJob,
    "No. of Sheets in Actual Nesting for one Unit": l.actualPerUnit === null ? "" : Number(l.actualPerUnit.toFixed(4)),
    "No. of Sheets in Actual Nesting for Job": l.sheetsUsed ?? "",
    Difference: l.difference ?? "",
    Notes: l.note ?? "",
    Quantity: l.producedQty ?? "",
    "Actual for Quantity": l.forProduced ?? "",
    Month: l.month,
    SOI: l.soi ?? "",
  }));

  return (
    <div>
      <RememberLastVisit storageKey="material:last" />
      <PageHeader title="🧱 MATERIAL — nesting project tracker">
        <MaterialMonthPicker month={month} months={months} />
        <ExportButton rows={exportRows} filename={`nesting-tracker-${month.replace(/\s+/g, "-")}.xlsx`} sheetName="Sheet1" />
      </PageHeader>
      <MaterialClient lines={lines} totals={totals} month={month} knownBoms={knownBoms} canEdit={hasPerm(me, "material.edit")} />
    </div>
  );
}
