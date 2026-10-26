import { formatDate } from "@/lib/domain/format";
import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm, guardTab } from "@/lib/server/auth";
import { getConsumableEdits, getConsumablesDashboard, getConsumablesData, getCustomDepartments } from "@/lib/server/consumables";
import { getCatalogue, getCatalogueChanges, getCurrentStandings, getLimitDashboard } from "@/lib/server/consumableLimits";
import { factoryDateTimeLabel } from "@/lib/domain/consumables";
import { WORKER_SECTIONS } from "@/lib/domain/tanks";
import { PERIOD_LABEL } from "@/lib/domain/consumableLimits";
import { ConsumableLimits } from "@/components/ConsumableLimits";
import { ConsumableAlarms } from "@/components/ConsumableAlarms";
import { ConsumablesMonthly } from "@/components/ConsumablesMonthly";
import { PowderScrap } from "@/components/PowderScrap";
import { getPowderReport } from "@/lib/server/powderScrap";
import { SCRAP_LIMITS } from "@/lib/domain/powderScrap";
import { getMonthlyReport } from "@/lib/server/consumableMonthly";
import { MONTH_STATUS_LABEL, isMonthKey, monthLong } from "@/lib/domain/consumableMonthly";
import { PrintHeader } from "@/components/PrintHeader";
import { addDaysISO, clampISO } from "@/lib/domain/dateSlicer";
import { factoryDayISO, parseISODate } from "@/lib/domain/dates";
import { PageHead } from "@/components/ui";
import { MaterialSections } from "@/components/MaterialSections";
import { ExportMenu } from "@/components/ExportMenu";
import { ViewTabs } from "@/components/ViewTabs";
import { UrlDateSlicer } from "@/components/UrlDateSlicer";
import { ConsumablesClient } from "@/components/ConsumablesClient";
import { ConsumableEdits } from "@/components/ConsumableEdits";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { ConsumablesDashboard } from "@/components/LazyCharts";

export const metadata = { title: "Consumables — ATC" };
export const dynamic = "force-dynamic";

const BASIS_EXPORT = { pool: "shared", each: "each department", person: "per worker" } as const;

// How far back the slicer reaches — a year of hand-outs.
const HISTORY_DAYS = 365;

export default async function ConsumablesPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; view?: string; month?: string }>;
}) {
  await guardTab("/consumables");
  // viewing the log is free for every account, like the rest of the app;
  // recording is consumables.edit (and correcting one's own rows); the
  // history of changes, deleting and restoring are the admin's
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const sp = await searchParams;
  const today = factoryDayISO(new Date());
  const min = addDaysISO(today, -HISTORY_DAYS);
  const valid = (s?: string) => (s && parseISODate(s) ? clampISO(s, min, today) : null);
  // the tab opens on today; a period in the URL replaces it
  let from = valid(sp.from) ?? today;
  let to = valid(sp.to) ?? today;
  if (from > to) [from, to] = [to, from];
  const periodLabel = from === to ? (from === today ? "today" : `on ${formatDate(from)}`) : `from ${formatDate(from)} to ${formatDate(to)}`;
  const period = from === to ? from : `${from}_to_${to}`;

  // the log and the dashboard are everyone's; the history of edits the admin's
  // the monthly review lives on the dashboard now — an old ?view=monthly link lands there
  const view = sp.view === "dashboard" || sp.view === "monthly" ? "dashboard" : sp.view === "limits" ? "limits" : sp.view === "powder" ? "powder" : me.isAdmin && sp.view === "edits" ? "edits" : "log";
  // the switch keeps the period on screen
  const hrefFor = (v: "log" | "dashboard" | "limits" | "powder" | "edits") => {
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
        { href: hrefFor("dashboard"), label: "Dashboard", title: "What went out, to whom, against the limits" },
        { href: hrefFor("powder"), label: "Powder", title: "Powder scrap" },
        { href: hrefFor("limits"), label: "Limits", title: "The catalogue, its limits, and where each stands now" },
        ...(me.isAdmin ? [{ href: hrefFor("edits"), label: "Edits", title: "Every change made to a recorded hand-out" }] : []),
      ]}
      current={hrefFor(view)}
      label="Consumables view"
    />
  );
  const slicer = (
    <UrlDateSlicer
      encoding="fromTo" from={from} to={to} min={min} max={today} today={today}
      presets={["yesterday", "last7", "thisMonth", "lastMonth", "last30", "last90"]}
      defaultRange={{ label: "Today", from: today, to: today }}
    />
  );

  if (view === "powder") {
    // month by month, like the monthly review
    const month = sp.month && isMonthKey(sp.month) && sp.month <= today.slice(0, 7) ? sp.month : today.slice(0, 7);
    const r = await getPowderReport(month, { id: me.id, isAdmin: me.isAdmin, canRecord: hasPerm(me, "consumables.edit") });
    const rate = (x: { rate: number | null }) => (x.rate === null ? "" : `${Math.round(x.rate * 1000) / 10}%`);
    const exportRows = [
      ...[...r.departments, { label: "Both sections", ...r.total }].map((d) => ({
        Kind: "Month", Month: month, Day: "", Section: d.label, "Drawn (kg)": d.withdrawn, "Scrap (kg)": d.scrap, "Net used (kg)": d.net, "Scrap rate": rate(d), Notes: "", "Recorded by": "",
      })),
      ...r.entries.map((e) => ({
        Kind: "Weighing", Month: month, Day: e.dayISO, Section: e.departmentLabel, "Drawn (kg)": "", "Scrap (kg)": e.kg, "Net used (kg)": "", "Scrap rate": "", Notes: e.notes ?? "", "Recorded by": e.recordedBy,
      })),
    ];
    return (
      <div className="space-y-3">
        <RememberLastVisit storageKey="consumables:last" view={view} carry={["from", "to"]} />
        <PrintHeader title="Powder scrap" subtitle={monthLong(month)} date={formatDate(factoryDayISO(new Date()))} />
        <MaterialSections current="consumables" />
        <PageHead
          title="Consumables" sub={`Powder scrap · ${monthLong(month)}`} views={viewSwitch}
          actions={<ExportMenu excel={[{ rows: exportRows, filename: `powder-scrap-${month}.xlsx`, sheetName: month }]} print />}
        />
        <PowderScrap r={r} canRecord={hasPerm(me, "consumables.edit")} isAdmin={me.isAdmin} today={today} earliest={addDaysISO(today, -SCRAP_LIMITS.daysBack)} />
      </div>
    );
  }

  if (view === "limits") {
    // the catalogue and its limits are about now, not the slicer's period
    const [items, standings, changes, custom] = await Promise.all([
      getCatalogue(), getCurrentStandings(today), getCatalogueChanges(60, factoryDateTimeLabel), getCustomDepartments(),
    ]);
    const exportRows = items.flatMap((i) => (i.limits.length ? i.limits : [null]).map((l) => {
      const s = l ? standings[l.id] : undefined;
      return {
        Code: i.code ?? "",
        Item: i.name,
        UOM: i.uom,
        Active: i.active ? "yes" : "retired",
        Limit: l ? l.qty : "",
        Per: l ? PERIOD_LABEL[l.period] : "",
        Counted: l ? BASIS_EXPORT[l.basis] : "",
        Departments: l ? l.departmentsLabel : "",
        Window: s?.windowLabel ?? "",
        // an each-department or per-worker limit: every department's number added up
        "Limit now": s ? s.limit : "",
        "Used now": s ? s.used : "",
        "Left now": s ? Math.round((s.limit - s.used) * 1000) / 1000 : "",
        "Departments over": s && s.departments.length ? s.departments.filter((d) => d.used > d.limit + 1e-9).map((d) => `${d.label} ${d.used}/${d.limit}`).join(" · ") : "",
        Remark: i.remark ?? "",
      };
    }));
    return (
      <div className="space-y-3">
        <RememberLastVisit storageKey="consumables:last" view={view} carry={["from", "to"]} />
        <MaterialSections current="consumables" />
        <PageHead
          title="Consumables" sub="Catalogue & limits · where each stands now" views={viewSwitch}
          actions={<ExportMenu excel={[{ rows: exportRows, filename: `consumables-limits-${today}.xlsx`, sheetName: "Limits" }]} />}
        />
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

  if (view === "dashboard") {
    // the monthly review at the bottom goes by calendar month, not the slicer
    const month = sp.month && isMonthKey(sp.month) && sp.month <= today.slice(0, 7) ? sp.month : today.slice(0, 7);
    const [stats, limits, report] = await Promise.all([getConsumablesDashboard(from, to), getLimitDashboard(from, to, today), getMonthlyReport(month)]);
    const exportRows = stats.items.map((i) => ({ Item: i.item, "Hand-outs": i.issues, Qty: i.qty, Workers: i.workers }));
    const monthParams = new URLSearchParams({ view: "dashboard" });
    if (sp.from) monthParams.set("from", from);
    if (sp.to) monthParams.set("to", to);
    return (
      <div className="space-y-3">
        <RememberLastVisit storageKey="consumables:last" view={view} carry={["from", "to"]} />
        <PrintHeader title="Consumables — dashboard" subtitle={`${periodLabel} · monthly review ${monthLong(month)}`} date={formatDate(factoryDayISO(new Date()))} />
        <MaterialSections current="consumables" />
        <PageHead
          title="Consumables" sub={`Dashboard · ${periodLabel}`} views={viewSwitch}
          actions={<ExportMenu excel={[
            { label: "Items summary", rows: exportRows, filename: `consumables-summary-${period}.xlsx`, sheetName: "Items" },
            { label: "Monthly review", rows: monthlyExportRows(report), filename: `consumables-monthly-${month}.xlsx`, sheetName: month },
          ]} print />}
        />
        {slicer}
        {/* the limits first: an alarm is what the page is opened for */}
        <ConsumableAlarms d={limits} periodLabel={periodLabel} period={period} />
        <ConsumablesDashboard s={stats} periodLabel={periodLabel} period={period} />
        <section id="monthly" className="space-y-3 scroll-mt-24 pt-2">
          <h2 className="font-bold text-lg">Monthly review · {monthLong(month)}</h2>
          <ConsumablesMonthly report={report} monthHref={`/consumables?${monthParams.toString()}&month=`} />
        </section>
      </div>
    );
  }

  if (view === "edits") {
    const edits = await getConsumableEdits(from, to);
    const exportRows = edits.map((e) => ({
      "Changed at": e.atLabel,
      By: e.by,
      Action: e.action,
      Changes: e.changes.join(" | "),
      Before: e.before,
      After: e.after ?? "",
      "Row now": e.issue.deleted ? `(deleted) ${e.issue.now}` : e.issue.now,
      "Handed out": e.issue.issuedAtLabel,
      "Recorded by": e.issue.recordedBy,
    }));
    return (
      <div className="space-y-3">
        <RememberLastVisit storageKey="consumables:last" view={view} carry={["from", "to"]} />
        <MaterialSections current="consumables" />
        <PageHead
          title="Consumables" sub={`Edits · ${periodLabel}`} views={viewSwitch}
          actions={<ExportMenu excel={[{ rows: exportRows, filename: `consumables-edits-${period}.xlsx`, sheetName: "Edits" }]} />}
        />
        {slicer}
        <ConsumableEdits edits={edits} periodLabel={periodLabel} />
      </div>
    );
  }

  const data = await getConsumablesData(from, to, { id: me.id, isAdmin: me.isAdmin, canRecord: hasPerm(me, "consumables.edit") });

  const exportRows = data.entries.map((e) => ({
    "Date & time": e.issuedAtLabel,
    Item: e.item,
    Qty: e.qty,
    UOM: e.uom ?? "",
    Department: e.departmentLabel,
    "Emp ID": e.worker?.empId ?? "",
    "Requested / collected by": e.worker?.name ?? e.group?.label ?? "",
    "Group's workers": e.group ? e.group.workers.map((w) => `${w.empId} ${w.name}`).join(", ") : "",
    Notes: e.notes ?? "",
    "Over limit": e.overLimit ? "yes" : "",
    "Over-limit reason": e.overLimit?.reason ?? "",
    "Recorded by": e.recordedBy,
    "Edited by": e.edited ? `${e.edited.by} (${e.edited.atLabel})` : "",
  }));

  return (
    <div className="space-y-3">
      <RememberLastVisit storageKey="consumables:last" view={view} carry={["from", "to"]} />
      <MaterialSections current="consumables" />
      <PageHead
        title="Consumables" sub={`Log · ${periodLabel}`} views={viewSwitch}
        actions={<ExportMenu excel={[{ rows: exportRows, filename: `consumables-${period}.xlsx`, sheetName: "Consumables" }]} />}
      />
      {slicer}
      <ConsumablesClient
        data={data}
        canRecord={hasPerm(me, "consumables.edit")}
        isAdmin={me.isAdmin}
        periodLabel={periodLabel}
      />
    </div>
  );
}

/** The monthly review as a spreadsheet: a row per item, then a row per limit under it. */
function monthlyExportRows(report: Awaited<ReturnType<typeof getMonthlyReport>>) {
  return report.rows.flatMap((r) => [
    {
      Level: "Item", Code: r.code ?? "", Item: r.name, UOM: r.uom, Departments: "", "Limit": "", "Monthly limit": r.allowance ?? "",
      Used: r.used, Left: r.allowance === null ? "" : Math.round((r.allowance - r.covered) * 1000) / 1000, "Outside the limits": r.outside, "Of the limit": r.ratio === null ? "" : `${Math.round(r.ratio * 100)}%`,
      Status: MONTH_STATUS_LABEL[r.status], [`Used ${report.prevMonth}`]: r.prevUsed,
      "Counted over": "",
      ...Object.fromEntries(r.trend.map((t) => [t.month, t.used])),
    },
    ...r.limits.map((l) => ({
      Level: "Limit", Code: r.code ?? "", Item: r.name, UOM: r.uom, Departments: l.departmentsLabel,
      "Limit": l.perWorker
        ? `${l.perWorker.qty} per worker × ${Math.max(1, l.perWorker.workers)} ${PERIOD_LABEL[l.period]}`
        : `${l.qty} ${PERIOD_LABEL[l.period]} (${BASIS_EXPORT[l.basis]})`,
      "Monthly limit": l.allowance,
      Used: l.used, Left: l.left, "Outside the limits": "", "Of the limit": `${Math.round(l.ratio * 100)}%`, Status: MONTH_STATUS_LABEL[l.status],
      [`Used ${report.prevMonth}`]: l.prevUsed,
      "Counted over": l.toDate ?? "",
      ...Object.fromEntries(r.trend.map((t) => [t.month, ""])),
    })),
  ]);
}
