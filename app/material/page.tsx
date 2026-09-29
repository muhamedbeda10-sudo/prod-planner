import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { linePermKey } from "@/lib/domain/permissions";
import { getMaterialData } from "@/lib/server/material";
import { PageHeader } from "@/components/ui";
import { ExportButton } from "@/components/ExportButton";
import { MaterialClient, MaterialMonthPicker } from "@/components/MaterialClient";
import { getActiveLine } from "@/lib/server/line";
import { LINE_LABEL } from "@/lib/domain/lines";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { ViewTabs, MATERIAL_VIEWS } from "@/components/ViewTabs";

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
  // one living table — no month; ?month= opens an older sheet filed under one
  const month = (sp.month ?? "").trim();
  const line = await getActiveLine(); // one product line at a time
  const { lines, totals, months, knownBoms, lvOrders, lvTemplates, odooByMo } = await getMaterialData(month);

  // the export carries the sheet's OWN column names in its order, then the
  // tab's additions, so the file drops straight back into the workbook
  const exportRows = line === "LV" ? lines.map((l) => ({
    MO: l.mo,
    Product: l.partName,
    "Sec Item": l.materialCode,
    "Planned qty": l.units,
    BOM: l.bom,
    Material: l.material,
    Thickness: l.thicknessMm,
    "Sheet Size": l.sheetSize,
    "No. of Sheets In BOM For One Unit": l.sheetsPerUnit,
    "Sheets Qty as Per Bom": l.forJob,
    Produced: l.producedUsed ?? "",
    "Actually Consumed Sheets Qty as per Nesting": l.forProduced ?? "",
    "Remaining units": l.remainingUnits ?? "",
    REMARKS: l.note ?? "",
  })) : lines.map((l) => ({
    MO: l.mo,
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
    SOI: l.soi ?? "",
  }));

  return (
    <div>
      <RememberLastVisit storageKey="material:last" />
      <PageHeader title={`🧱 MATERIAL — material sheet · ${LINE_LABEL[line]}`}>
        <ViewTabs views={MATERIAL_VIEWS} current="/material" label="Material view" />
        <MaterialMonthPicker month={month} months={months} />
        <ExportButton rows={exportRows} filename={`material-sheet${month ? `-${month.replace(/\s+/g, "-")}` : ""}.xlsx`} sheetName="Sheet1" />
      </PageHeader>
      <MaterialClient lines={lines} totals={totals} month={month} knownBoms={knownBoms} canEdit={hasPerm(me, linePermKey(line, "material"))} product={line} lvOrders={lvOrders} lvTemplates={lvTemplates} odooByMo={odooByMo} />
    </div>
  );
}
