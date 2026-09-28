import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { getConsumableEdits, getConsumablesData } from "@/lib/server/consumables";
import { addDaysISO, clampISO } from "@/lib/domain/dateSlicer";
import { factoryDayISO, parseISODate } from "@/lib/domain/dates";
import { PageHeader } from "@/components/ui";
import { ExportButton } from "@/components/ExportButton";
import { UrlDateSlicer } from "@/components/UrlDateSlicer";
import { ConsumablesClient } from "@/components/ConsumablesClient";
import { ConsumableEdits } from "@/components/ConsumableEdits";

export const metadata = { title: "Consumables — ATC" };
export const dynamic = "force-dynamic";

// How far back the slicer reaches — a year of hand-outs.
const HISTORY_DAYS = 365;

export default async function ConsumablesPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; view?: string }>;
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

  const view = me.isAdmin && sp.view === "edits" ? "edits" : "log";
  // the switch keeps the period on screen
  const hrefFor = (v: "log" | "edits") => {
    const p = new URLSearchParams();
    if (sp.from) p.set("from", from);
    if (sp.to) p.set("to", to);
    if (v === "edits") p.set("view", "edits");
    const q = p.toString();
    return q ? `/consumables?${q}` : "/consumables";
  };
  const viewSwitch = me.isAdmin && (
    <nav className="seg" aria-label="View">
      <Link href={hrefFor("log")} className={view === "log" ? "on" : ""}>Log</Link>
      <Link href={hrefFor("edits")} className={view === "edits" ? "on" : ""}>Edits</Link>
    </nav>
  );
  const slicer = (
    <UrlDateSlicer
      encoding="fromTo" from={from} to={to} min={min} max={today} today={today}
      presets={["yesterday", "last7", "thisMonth", "lastMonth", "last30", "last90"]}
      defaultRange={{ label: "Today", from: today, to: today }}
    />
  );

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
    Department: e.departmentLabel,
    "Emp ID": e.worker.empId,
    Worker: e.worker.name,
    Notes: e.notes ?? "",
    "Recorded by": e.recordedBy,
    "Edited by": e.edited ? `${e.edited.by} (${e.edited.atLabel})` : "",
  }));

  return (
    <div className="space-y-3">
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
