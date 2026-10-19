import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm, guardTab } from "@/lib/server/auth";
import { getActiveLine } from "@/lib/server/line";
import { linePermKey } from "@/lib/domain/permissions";
import { getOdooData, getOdooDashboard } from "@/lib/server/odoo";
import { resolveBasis, resolveBom, resolveCompare, resolvePeriod } from "@/lib/domain/odooStats";
import { OdooBasisPicker, OdooBomPicker, OdooComparePicker } from "@/components/OdooPickers";
import { OdooDashboard } from "@/components/LazyCharts";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { factoryDayISO } from "@/lib/domain/dates";
import { odooScopeKey, parseOdooScope } from "@/lib/domain/odoo";
import { PageHead } from "@/components/ui";
import { ExportMenu } from "@/components/ExportMenu";
import { ViewTabs } from "@/components/ViewTabs";
import { OdooClient } from "@/components/OdooClient";
import { UrlDateSlicer } from "@/components/UrlDateSlicer";
import { addDaysISO } from "@/lib/domain/dateSlicer";

export const metadata = { title: "Odoo — ATC" };
export const dynamic = "force-dynamic";

export default async function OdooPage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string; view?: string; range?: string; from?: string; to?: string; basis?: string; bom?: string; compare?: string }>;
}) {
  await guardTab("/odoo");
  // viewing is free for every account, like the rest of the app; recording is
  // gated on each row's own line's Odoo key (odoo.edit / lv.odoo). Both lines
  // share the tab and its dashboard — the toggle only picks the default line
  // for a new row or a sheet.
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const line = await getActiveLine();

  const sp = await searchParams;
  // every day by default (the log opens on the whole period), one day, or a from..to period
  const scope = parseOdooScope(sp.day ?? "all", factoryDayISO(new Date()));
  const day = odooScopeKey(scope);
  const view = sp.view === "dashboard" ? "dashboard" : "log";

  // the tab's other view, top right — the same switch every tab carries
  const viewSwitch = (
    <ViewTabs
      views={[{ href: "/odoo?view=log", label: "Log", title: "The daily close-out log" }, { href: "/odoo?view=dashboard", label: "Dashboard", title: "Closed quantities per product, close-out time" }]}
      current={`/odoo?view=${view}`}
      label="ODOO view"
    />
  );

  if (view === "dashboard") {
    const period = resolvePeriod(sp);
    const basis = resolveBasis(sp);
    const data = await getOdooDashboard(period, basis, resolveBom(sp), resolveCompare(sp));
    const today = factoryDayISO(new Date());
    return (
      <div className="space-y-3">
        <RememberLastVisit storageKey="odoo:last" />
        <PageHead title="ODOO" sub="Dashboard · both lines" views={viewSwitch}>
          <OdooBasisPicker basis={basis} />
          <OdooBomPicker bom={data.bom} boms={data.boms} />
          <OdooComparePicker compare={data.compare} />
        </PageHead>
        <UrlDateSlicer
          encoding="odooDash" from={period.fromISO} to={period.fromISO ? period.toISO : null} min={addDaysISO(today, -120)} max={today} today={today}
          presets={["today", "yesterday", "last7", "thisMonth", "lastMonth", "last30", "last90"]} allLabel="All time"
        />
        <OdooDashboard data={data} />
      </div>
    );
  }

  const { entries, days, knownSois, nesting, soiBoms, soiMos, lv, totalRows, openRows } = await getOdooData(scope);

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
    "Done at": e.doneAtISO ? e.doneAtISO.slice(0, 16).replace("T", " ") : "",
    Source: e.source === "painting" ? "Painting" : e.source === "shotblast" ? "Shot Blast" : e.source === "import" ? "Import" : "",
    Notes: [...e.notes].reverse().map((n) => `${n.atISO.slice(0, 16).replace("T", " ")}: ${n.text}`).join(" | "),
  }));

  // the strip runs from the first logged day (a month back at least) to today
  const today = factoryDayISO(new Date());
  const oldest = days.length ? days[days.length - 1] : today;
  const min = [oldest, addDaysISO(today, -30)].sort()[0];
  const sel = scope.kind === "all" ? { from: null, to: null } : scope.kind === "day" ? { from: scope.iso, to: scope.iso } : { from: scope.from, to: scope.to };

  return (
    <div className="space-y-3">
      <RememberLastVisit storageKey="odoo:last" forget={["day"]} />
      <PageHead
        title="ODOO"
        sub="Close-out log · both lines"
        views={viewSwitch}
        actions={<ExportMenu excel={[{ rows: exportRows, filename: `odoo-${day.replace("..", "_to_")}.xlsx`, sheetName: "Sheet1" }]} />}
      />
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
        defaultLine={line}
        totalRows={totalRows}
        openRows={openRows}
      />
    </div>
  );
}
