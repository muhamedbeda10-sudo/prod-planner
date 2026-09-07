import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { getOdooData } from "@/lib/server/odoo";
import { toISODate } from "@/lib/domain/dates";
import { PageHeader } from "@/components/ui";
import { ExportButton } from "@/components/ExportButton";
import { OdooClient, OdooDayPicker } from "@/components/OdooClient";

export const metadata = { title: "Odoo — ATC" };
export const dynamic = "force-dynamic";

export default async function OdooPage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string }>;
}) {
  // viewing is free for every account, like the rest of the app; recording is
  // gated on odoo.edit
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const sp = await searchParams;
  const raw = (sp.day ?? "").trim();
  const day = raw === "all" ? "all" : /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : toISODate(new Date());
  const { entries, days, knownSois, knownFgCodes } = await getOdooData(day);

  // the export carries the sheet's OWN headers, so the file drops straight
  // back into the workbook the office keeps
  const exportRows = entries.map((e) => ({
    Date: e.dateISO,
    "SOI#": e.soi ?? "",
    "FG-CODE": e.fgCode,
    Product: e.product,
    "MO#": e.odooMo,
    QTY: e.qty,
    Status: e.status,
    Notes: [...e.notes].reverse().map((n) => `${n.atISO.slice(0, 16).replace("T", " ")}: ${n.text}`).join(" | "),
  }));

  return (
    <div>
      <PageHeader title="📦 ODOO — daily close-out log">
        <OdooDayPicker day={day} days={days} />
        <ExportButton rows={exportRows} filename={`odoo-${day}.xlsx`} sheetName="Sheet1" />
      </PageHeader>
      <OdooClient
        entries={entries}
        day={day}
        knownSois={knownSois}
        knownFgCodes={knownFgCodes}
        canEdit={hasPerm(me, "odoo.edit")}
      />
    </div>
  );
}
