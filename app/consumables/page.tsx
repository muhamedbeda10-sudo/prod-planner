import { formatDate } from "@/lib/domain/format";
import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm, guardTab } from "@/lib/server/auth";
import { getConsumableEdits, getConsumablesData, getCustomDepartments } from "@/lib/server/consumables";
import { getCatalogue, getCatalogueChanges, getCurrentStandings } from "@/lib/server/consumableLimits";
import { consumablesPeriod, factoryDateTimeLabel, readLogIds } from "@/lib/domain/consumables";
import { WORKER_SECTIONS } from "@/lib/domain/tanks";
import { ConsumableLimits } from "@/components/ConsumableLimits";
import { PowderScrap } from "@/components/PowderScrap";
import { getPowderReport } from "@/lib/server/powderScrap";
import { SCRAP_LIMITS } from "@/lib/domain/powderScrap";
import { monthLong, pastMonthOf } from "@/lib/domain/consumableMonthly";
import { PrintHeader } from "@/components/PrintHeader";
import { factoryDayISO } from "@/lib/domain/dates";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { PageHead } from "@/components/ui";
import { ViewTabs } from "@/components/ViewTabs";
import { UrlDateSlicer } from "@/components/UrlDateSlicer";
import { ConsumablesClient } from "@/components/ConsumablesClient";
import { ConsumableEdits } from "@/components/ConsumableEdits";
import { RememberLastVisit } from "@/components/RememberLastVisit";

export const metadata = { title: "Consumables — ATC" };
export const dynamic = "force-dynamic";

export default async function ConsumablesPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; view?: string; month?: string; ids?: string }>;
}) {
  await guardTab("/consumables");
  // viewing the log is free for every account, like the rest of the app;
  // recording is consumables.edit (and correcting one's own rows); the
  // history of changes, deleting and restoring are the admin's
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const sp = await searchParams;
  // the dashboard and its monthly review live in the Dashboards tab now — an
  // old ?view=dashboard (or ?view=monthly) link lands there, period and month kept
  if (sp.view === "dashboard" || sp.view === "monthly") {
    const q = new URLSearchParams();
    for (const k of ["from", "to", "month"] as const) if (sp[k]) q.set(k, sp[k]!);
    redirect(`/dashboards/consumables${q.size ? `?${q}` : ""}`);
  }
  const today = factoryDayISO(new Date());
  // the tab opens on today; a period in the URL replaces it
  const { from, to, min, label: periodLabel } = consumablesPeriod(sp, today);

  // the log is everyone's; the history of edits the admin's
  const view = sp.view === "limits" ? "limits" : sp.view === "powder" ? "powder" : me.isAdmin && sp.view === "edits" ? "edits" : "log";
  // the switch keeps the period on screen
  const hrefFor = (v: "log" | "limits" | "powder" | "edits") => {
    const p = new URLSearchParams();
    if (sp.from) p.set("from", from);
    if (sp.to) p.set("to", to);
    if (v !== "log") p.set("view", v);
    const q = p.toString();
    return q ? `/consumables?${q}` : "/consumables";
  };
  // the tab's other views, top right — the same switch every tab carries
  const viewSwitch = (
    <ViewTabs
      views={[
        { href: hrefFor("log"), label: "Log", title: "Hand out and record" },
        { href: hrefFor("powder"), label: "Powder", title: "Powder scrap" },
        { href: hrefFor("limits"), label: "Limits", title: "The catalogue, its limits, and where each stands now" },
        ...(me.isAdmin ? [{ href: hrefFor("edits"), label: "Edits", title: "Every change made to a recorded hand-out" }] : []),
      ]}
      current={hrefFor(view)}
      label="Consumables view"
    />
  );
  // the period strip carries the view switch on its own row — the page has no
  // head row of its own
  const slicer = (
    <UrlDateSlicer
      encoding="fromTo" from={from} to={to} min={min} max={today} today={today}
      presets={["yesterday", "last7", "thisMonth", "lastMonth", "last30", "last90"]}
      defaultRange={{ label: "Today", from: today, to: today }}
      end={viewSwitch}
    />
  );

  if (view === "powder") {
    // month by month, like the monthly review
    const month = pastMonthOf(sp.month, today) ?? today.slice(0, 7);
    const r = await getPowderReport(month, { id: me.id, isAdmin: me.isAdmin, canRecord: hasPerm(me, "consumables.edit") });
    return (
      <div className="space-y-3">
        <RememberLastVisit storageKey="consumables:views" view={view} carry={["from", "to"]} />
        <PrintHeader title="Powder scrap" subtitle={monthLong(month)} date={formatDate(factoryDayISO(new Date()))} />
        <PageHead title="Consumables" sub={`Powder scrap · ${monthLong(month)}`} views={viewSwitch} />
        <PowderScrap r={r} canRecord={hasPerm(me, "consumables.edit")} isAdmin={me.isAdmin} today={today} earliest={addDaysISO(today, -SCRAP_LIMITS.daysBack)} />
      </div>
    );
  }

  if (view === "limits") {
    // the catalogue and its limits are about now, not the slicer's period
    const [items, standings, changes, custom] = await Promise.all([
      getCatalogue(), getCurrentStandings(today), getCatalogueChanges(60, factoryDateTimeLabel), getCustomDepartments(),
    ]);
    return (
      <div className="space-y-3">
        <RememberLastVisit storageKey="consumables:views" view={view} carry={["from", "to"]} />
        <PageHead title="Consumables" sub="Catalogue & limits · where each stands now" views={viewSwitch} />
        <ConsumableLimits
          items={items}
          standings={standings}
          departments={{ sections: WORKER_SECTIONS.map((s) => ({ code: s.code, label: s.label, group: s.group })), custom }}
          changes={changes}
          canEdit={hasPerm(me, "consumables.edit")}
        />
      </div>
    );
  }

  if (view === "edits") {
    const edits = await getConsumableEdits(from, to);
    return (
      <div className="space-y-3">
        <RememberLastVisit storageKey="consumables:views" view={view} carry={["from", "to"]} />
        <PageHead title="Consumables" sub={`Edits · ${periodLabel}`} />
        {slicer}
        <ConsumableEdits edits={edits} periodLabel={periodLabel} />
      </div>
    );
  }

  const data = await getConsumablesData(from, to, { id: me.id, isAdmin: me.isAdmin, canRecord: hasPerm(me, "consumables.edit") });

  return (
    <div className="space-y-3">
      <RememberLastVisit storageKey="consumables:views" view={view} carry={["from", "to"]} />
      <PageHead title="Consumables" sub={`Log · ${periodLabel}`} />
      {slicer}
      <ConsumablesClient
        data={data}
        canRecord={hasPerm(me, "consumables.edit")}
        isAdmin={me.isAdmin}
        periodLabel={periodLabel}
        onlyIds={readLogIds(sp.ids)}
        periodParams={[...(sp.from ? [["from", from]] : []), ...(sp.to ? [["to", to]] : [])] as [string, string][]}
      />
    </div>
  );
}
