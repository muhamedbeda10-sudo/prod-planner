import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { getActiveLine } from "@/lib/server/line";
import { linePermKey } from "@/lib/domain/permissions";
import Link from "next/link";
import { getOdooData, getOdooDashboard } from "@/lib/server/odoo";
import { resolveBasis, resolveBom, resolvePeriod } from "@/lib/domain/odooStats";
import { OdooBasisPicker, OdooBomPicker } from "@/components/OdooPickers";
import { OdooDashboard } from "@/components/LazyCharts";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { toISODate } from "@/lib/domain/dates";
import { odooScopeKey, parseOdooScope } from "@/lib/domain/odoo";
import { PageHeader } from "@/components/ui";
import { ExportButton } from "@/components/ExportButton";
import { OdooClient } from "@/components/OdooClient";
import { UrlDateSlicer } from "@/components/UrlDateSlicer";
import { addDaysISO } from "@/lib/domain/dateSlicer";

export const metadata = { title: "Odoo — ATC" };
export const dynamic = "force-dynamic";

export default async function OdooPage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string; view?: string; range?: string; from?: string; to?: string; basis?: string; bom?: string }>;
}) {
  // viewing is free for every account, like the rest of the app; recording is
  // gated on the line's Odoo key (odoo.edit / lv.odoo)
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const line = await getActiveLine();

  const sp = await searchParams;
  // one day (today by default), a from..to period, or every day
  const scope = parseOdooScope(sp.day ?? "", toISODate(new Date()));
  const day = odooScopeKey(scope);
  const view = sp.view === "dashboard" ? "dashboard" : "log";

  const viewSwitch = (
    <nav className="seg" aria-label="View">
      <Link href="/odoo?view=log" className={view === "log" ? "on" : ""}>Log</Link>
      <Link href="/odoo?view=dashboard" className={view === "dashboard" ? "on" : ""}>Dashboard</Link>
    </nav>
  );

  if (view === "dashboard") {
    const period = resolvePeriod(sp);
    const basis = resolveBasis(sp);
    const data = await getOdooDashboard(period, basis, resolveBom(sp));
    const today = toISODate(new Date());
    return (
      <div className="space-y-3">
        <RememberLastVisit storageKey="odoo:last" />
        <PageHeader title="📦 ODOO — dashboard">
          {viewSwitch}
          <OdooBasisPicker basis={basis} />
          <OdooBomPicker bom={data.bom} boms={data.boms} />
        </PageHeader>
        <UrlDateSlicer
          encoding="odooDash" from={period.fromISO} to={period.fromISO ? period.toISO : null} min={addDaysISO(today, -120)} max={today} today={today}
          presets={["today", "yesterday", "last7", "thisMonth", "lastMonth", "last30", "last90"]} allLabel="All time"
        />
        <OdooDashboard data={data} />
      </div>
    );
  }

  const { entries, days, knownSois, knownFgCodes, nesting, soiBoms, soiMos, lv, totalRows, openRows } = await getOdooData(scope);

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
  const today = toISODate(new Date());
  const oldest = days.length ? days[days.length - 1] : today;
  const min = [oldest, addDaysISO(today, -30)].sort()[0];
  const sel = scope.kind === "all" ? { from: null, to: null } : scope.kind === "day" ? { from: scope.iso, to: scope.iso } : { from: scope.from, to: scope.to };

  return (
    <div className="space-y-3">
      <RememberLastVisit storageKey="odoo:last" />
      <PageHeader title="📦 ODOO — close-out log">
        {viewSwitch}
        <ExportButton rows={exportRows} filename={`odoo-${day.replace("..", "_to_")}.xlsx`} sheetName="Sheet1" />
      </PageHeader>
      <UrlDateSlicer
        encoding="odooDay" from={sel.from} to={sel.to} min={min} max={[today, days[0] ?? today].sort().reverse()[0]} today={today}
        presets={["today", "yesterday", "last3", "last7", "thisMonth", "lastMonth", "last30"]} allLabel="All days" marks={days}
      />
      <OdooClient
        entries={entries}
        day={day}
        knownSois={knownSois}
        knownFgCodes={knownFgCodes}
        nesting={nesting}
        needCtx={{ lv, soiBoms, soiMos }}
        canEdit={hasPerm(me, linePermKey(line, "odoo"))}
        totalRows={totalRows}
        openRows={openRows}
      />
    </div>
  );
}
