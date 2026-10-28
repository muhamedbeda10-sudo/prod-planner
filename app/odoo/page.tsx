import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm, guardTab } from "@/lib/server/auth";
import { linePermKey } from "@/lib/domain/permissions";
import { getOdooData } from "@/lib/server/odoo";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { factoryDayISO } from "@/lib/domain/dates";
import { odooScopeKey, parseOdooScope } from "@/lib/domain/odoo";
import { PageHead } from "@/components/ui";
import { OdooClient } from "@/components/OdooClient";
import { UrlDateSlicer } from "@/components/UrlDateSlicer";
import { addDaysISO } from "@/lib/domain/dateSlicer";

export const metadata = { title: "Odoo — ATC" };
export const dynamic = "force-dynamic";

export default async function OdooPage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string; view?: string; range?: string; from?: string; to?: string; basis?: string; bom?: string; compare?: string; product?: string }>;
}) {
  await guardTab("/odoo");
  // viewing is free for every account, like the rest of the app; recording is
  // gated on each row's own line's Odoo key (odoo.edit / lv.odoo). Both lines
  // share the tab and its dashboard.
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const sp = await searchParams;
  // the last 30 days by default (the whole log grows without end and made the
  // page heavy), "All days" (?day=all), one day, or a from..to period
  const today = factoryDayISO(new Date());
  const scope = parseOdooScope(sp.day ?? `${addDaysISO(today, -29)}..${today}`, today);
  const day = odooScopeKey(scope);
  // the dashboard lives in the Dashboards tab now — an old ?view=dashboard link
  // lands there with its period, basis and picks
  if (sp.view === "dashboard") {
    const q = new URLSearchParams();
    for (const k of ["range", "from", "to", "basis", "bom", "compare", "product"] as const) if (sp[k]) q.set(k, sp[k]!);
    redirect(`/dashboards/odoo${q.size ? `?${q}` : ""}`);
  }

  const { entries, days, knownSois, nesting, soiBoms, soiMos, lv, totalRows, openRows } = await getOdooData(scope);

  // the strip runs from the first logged day (a month back at least) to today
  const oldest = days.length ? days[days.length - 1] : today;
  const min = [oldest, addDaysISO(today, -30)].sort()[0];
  const sel = scope.kind === "all" ? { from: null, to: null } : scope.kind === "day" ? { from: scope.iso, to: scope.iso } : { from: scope.from, to: scope.to };

  return (
    <div className="space-y-3">
      <RememberLastVisit storageKey="odoo:log" forget={["day"]} />
      <PageHead title="ODOO log" sub="The daily close-out log on Odoo · both lines" />
      <UrlDateSlicer
        encoding="odooDay" from={sel.from} to={sel.to} min={min} max={[today, days[0] ?? today].sort().reverse()[0]} today={today}
        presets={["today", "yesterday", "last3", "last7", "thisMonth", "lastMonth", "last30"]} allLabel="All days" marks={days}
      />
      <OdooClient
        entries={entries}
        day={day}
        knownSois={knownSois}
        nesting={nesting}
        needCtx={{ lv, soiBoms, soiMos }}
        canEditLine={{ TR: hasPerm(me, linePermKey("TR", "odoo")), LV: hasPerm(me, linePermKey("LV", "odoo")) }}
        totalRows={totalRows}
        openRows={openRows}
      />
    </div>
  );
}
