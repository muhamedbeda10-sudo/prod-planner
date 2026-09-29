import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
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
import { PrintButton } from "@/components/PrintButton";
import { toDisplayDate } from "@/lib/domain/dates";
import { addDaysISO, clampISO } from "@/lib/domain/dateSlicer";
import { factoryDayISO, parseISODate } from "@/lib/domain/dates";
import { PageHeader } from "@/components/ui";
import { ExportButton } from "@/components/ExportButton";
import { UrlDateSlicer } from "@/components/UrlDateSlicer";
import { ConsumablesClient } from "@/components/ConsumablesClient";
import { ConsumableEdits } from "@/components/ConsumableEdits";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { ConsumablesDashboard } from "@/components/LazyCharts";

export const metadata = { title: "Consumables — ATC" };
export const dynamic = "force-dynamic";

// How far back the slicer reaches — a year of hand-outs.
const HISTORY_DAYS = 365;

export default async function ConsumablesPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; view?: string; month?: string }>;
}) {
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
  const periodLabel = from === to ? (from === today ? "today" : `on ${from}`) : `from ${from} to ${to}`;
  const period = from === to ? from : `${from}_to_${to}`;

  // the log and the dashboard are everyone's; the history of edits the admin's
  const view = sp.view === "dashboard" ? "dashboard" : sp.view === "limits" ? "limits" : sp.view === "monthly" ? "monthly" : sp.view === "powder" ? "powder" : me.isAdmin && sp.view === "edits" ? "edits" : "log";
  // the switch keeps the period on screen
  const hrefFor = (v: "log" | "dashboard" | "limits" | "monthly" | "powder" | "edits") => {
    const p = new URLSearchParams();
    if (sp.from) p.set("from", from);
    if (sp.to) p.set("to", to);
    if (v !== "log") p.set("view", v);
    const q = p.toString();
    return q ? `/consumables?${q}` : "/consumables";
  };
  const viewSwitch = (
    <nav className="seg" aria-label="View">
      <Link href={hrefFor("log")} className={view === "log" ? "on" : ""}>Log</Link>
      <Link href={hrefFor("dashboard")} className={view === "dashboard" ? "on" : ""}>Dashboard</Link>
      <Link href={hrefFor("monthly")} className={view === "monthly" ? "on" : ""}>Monthly</Link>
      <Link href={hrefFor("powder")} className={view === "powder" ? "on" : ""}>Powder</Link>
      <Link href={hrefFor("limits")} className={view === "limits" ? "on" : ""}>Limits</Link>
      {me.isAdmin && <Link href={hrefFor("edits")} className={view === "edits" ? "on" : ""}>Edits</Link>}
    </nav>
  );
  const slicer = (
    <UrlDateSlicer
      encoding="fromTo" from={from} to={to} min={min} max={today} today={today}
      presets={["yesterday", "last7", "thisMonth", "lastMonth", "last30", "last90"]}
      defaultRange={{ label: "Today", from: today, to: today }}
    />
  );

  if (view === "monthly") {
    // a calendar month, not the slicer: the review is month by month
    const month = sp.month && isMonthKey(sp.month) && sp.month <= today.slice(0, 7) ? sp.month : today.slice(0, 7);
    const report = await getMonthlyReport(month);
    const exportRows = report.rows.flatMap((r) => [
      {
        Level: "Item", Code: r.code ?? "", Item: r.name, UOM: r.uom, Departments: "", "Limit": "", "Monthly limit": r.allowance ?? "",
        Used: r.used, "Outside the limits": r.outside, "Of the limit": r.ratio === null ? "" : `${Math.round(r.ratio * 100)}%`,
        Status: MONTH_STATUS_LABEL[r.status], [`Used ${report.prevMonth}`]: r.prevUsed,
        "Weeks / days / workers over": "",
        ...Object.fromEntries(r.trend.map((t) => [t.month, t.used])),
      },
      ...r.limits.map((l) => ({
        Level: "Limit", Code: r.code ?? "", Item: r.name, UOM: r.uom, Departments: l.departmentsLabel,
        "Limit": `${l.qty} ${PERIOD_LABEL[l.period]}${l.basis === "person" ? " per person" : ""}`, "Monthly limit": l.allowance,
        Used: l.used, "Outside the limits": "", "Of the limit": `${Math.round(l.ratio * 100)}%`, Status: MONTH_STATUS_LABEL[l.status],
        [`Used ${report.prevMonth}`]: l.prevUsed,
        "Weeks / days / workers over": [
          ...l.weeks.filter((w) => w.over).map((w) => `${w.label}: ${w.used}/${w.limit}`),
          ...l.daysOver.map((d) => `${d.dayISO}: ${d.used}`),
          ...l.workersOver.map((w) => `${report.workers[w.workerId]?.name ?? "?"}: ${w.used}`),
        ].join(" | "),
        ...Object.fromEntries(r.trend.map((t) => [t.month, ""])),
      })),
    ]);
    return (
      <div className="space-y-3">
        <RememberLastVisit storageKey="consumables:last" />
        <PrintHeader title="Consumables — monthly review" subtitle={monthLong(month)} date={toDisplayDate(new Date())} />
        <PageHeader>
          {viewSwitch}
          <ExportButton rows={exportRows} filename={`consumables-monthly-${month}.xlsx`} sheetName={month} />
          <PrintButton />
        </PageHeader>
        <ConsumablesMonthly report={report} />
      </div>
    );
  }

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
        <RememberLastVisit storageKey="consumables:last" />
        <PrintHeader title="Powder scrap" subtitle={monthLong(month)} date={toDisplayDate(new Date())} />
        <PageHeader>
          {viewSwitch}
          <ExportButton rows={exportRows} filename={`powder-scrap-${month}.xlsx`} sheetName={month} />
          <PrintButton />
        </PageHeader>
        <PowderScrap r={r} canRecord={hasPerm(me, "consumables.edit")} isAdmin={me.isAdmin} today={today} earliest={addDaysISO(today, -SCRAP_LIMITS.daysBack)} />
      </div>
    );
  }

  if (view === "limits") {
    // the catalogue and its limits are about now, not the slicer's period
    const [items, standings, changes, custom] = await Promise.all([
      getCatalogue(), getCurrentStandings(today), getCatalogueChanges(60, factoryDateTimeLabel), getCustomDepartments(),
    ]);
    const exportRows = items.flatMap((i) => (i.limits.length ? i.limits : [null]).map((l) => ({
      Code: i.code ?? "",
      Item: i.name,
      UOM: i.uom,
      Active: i.active ? "yes" : "retired",
      Limit: l ? l.qty : "",
      Per: l ? PERIOD_LABEL[l.period] : "",
      Counted: l ? (l.basis === "person" ? "per person" : "shared") : "",
      Departments: l ? l.departmentsLabel : "",
      "Used now": l && standings[l.id] ? standings[l.id].used : "",
      Remark: i.remark ?? "",
    })));
    return (
      <div className="space-y-3">
        <RememberLastVisit storageKey="consumables:last" />
        <PageHeader>
          {viewSwitch}
          <ExportButton rows={exportRows} filename={`consumables-limits-${today}.xlsx`} sheetName="Limits" />
        </PageHeader>
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
    const [stats, limits] = await Promise.all([getConsumablesDashboard(from, to), getLimitDashboard(from, to, today)]);
    const exportRows = stats.items.map((i) => ({ Item: i.item, "Hand-outs": i.issues, Qty: i.qty, Workers: i.workers }));
    return (
      <div className="space-y-3">
        <RememberLastVisit storageKey="consumables:last" />
        <PageHeader>
          {viewSwitch}
          <ExportButton rows={exportRows} filename={`consumables-summary-${period}.xlsx`} sheetName="Items" />
        </PageHeader>
        {slicer}
        {/* the limits first: an alarm is what the page is opened for */}
        <ConsumableAlarms d={limits} periodLabel={periodLabel} period={period} />
        <ConsumablesDashboard s={stats} periodLabel={periodLabel} period={period} />
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
        <RememberLastVisit storageKey="consumables:last" />
        <PageHeader>
          {viewSwitch}
          <ExportButton rows={exportRows} filename={`consumables-edits-${period}.xlsx`} sheetName="Edits" />
        </PageHeader>
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
    Worker: e.worker?.name ?? e.group?.label ?? "",
    "Group's workers": e.group ? e.group.workers.map((w) => `${w.empId} ${w.name}`).join(", ") : "",
    Notes: e.notes ?? "",
    "Over limit": e.overLimit ? "yes" : "",
    "Over-limit reason": e.overLimit?.reason ?? "",
    "Recorded by": e.recordedBy,
    "Edited by": e.edited ? `${e.edited.by} (${e.edited.atLabel})` : "",
  }));

  return (
    <div className="space-y-3">
      <RememberLastVisit storageKey="consumables:last" />
      <PageHeader>
        {viewSwitch}
        <ExportButton rows={exportRows} filename={`consumables-${period}.xlsx`} sheetName="Consumables" />
      </PageHeader>
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
