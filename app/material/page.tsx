import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm, guardTab } from "@/lib/server/auth";
import { linePermKey } from "@/lib/domain/permissions";
import { getMaterialData } from "@/lib/server/material";
import { getPartRates } from "@/lib/server/odooBom";
import { PageHead } from "@/components/ui";
import { LineSwitch } from "@/components/LineSwitch";
import { MaterialClient } from "@/components/MaterialClient";
import { getActiveLine } from "@/lib/server/line";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { getUserPrefs } from "@/lib/server/userPrefs";
import { MATERIAL_PREF_KEYS } from "@/lib/domain/userPrefs";

export const metadata = { title: "Material — ATC" };
export const dynamic = "force-dynamic";

export default async function MaterialPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await guardTab("/material");
  // viewing is free for every account, like the rest of the app; uploading
  // the sheet — the tab's only change — needs the line's material right
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  await searchParams; // an old link's ?month= is ignored
  const line = await getActiveLine(); // one product line at a time
  // one living table — no month; the plan month is a filter on it
  const [{ lines, odooByMo }, prefs] = await Promise.all([getMaterialData(""), getUserPrefs(me.id, MATERIAL_PREF_KEYS)]);
  // Odoo's BOM figure beside the sheet's, per part — the transformers only:
  // the panels' sheet files a SEC item per thickness, which no BoM line answers
  const odooRates = line === "LV" ? {} : await getPartRates(lines.filter((l) => l.partCode.trim()).map((l) => ({ partCode: l.partCode, bom: l.bom })));

  return (
    <div>
      <RememberLastVisit storageKey="material:last" />
      <PageHead title="Material" sub="Nesting sheet · one living table, matched on the MO" />
      <MaterialClient
        lines={lines} prefs={prefs} canImport={hasPerm(me, linePermKey(line, "material"))}
        product={line} odooByMo={odooByMo} odooRates={odooRates}
        lineSwitch={<LineSwitch />}
      />
    </div>
  );
}
