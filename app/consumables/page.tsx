import { redirect } from "next/navigation";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { getConsumablesData } from "@/lib/server/consumables";
import { addDaysISO, clampISO } from "@/lib/domain/dateSlicer";
import { factoryDayISO, parseISODate } from "@/lib/domain/dates";
import { PageHeader } from "@/components/ui";
import { ExportButton } from "@/components/ExportButton";
import { UrlDateSlicer } from "@/components/UrlDateSlicer";
import { ConsumablesClient } from "@/components/ConsumablesClient";

export const metadata = { title: "Consumables — ATC" };
export const dynamic = "force-dynamic";

// How far back the slicer reaches — a year of hand-outs.
const HISTORY_DAYS = 365;

export default async function ConsumablesPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  // viewing is free for every account, like the rest of the app; recording is
  // consumables.edit, and changing a saved row is the admin's alone
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

  const data = await getConsumablesData(from, to);

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
        <ExportButton rows={exportRows} filename={`consumables-${from === to ? from : `${from}_to_${to}`}.xlsx`} sheetName="Consumables" />
      </PageHeader>
      <UrlDateSlicer
        encoding="fromTo" from={from} to={to} min={min} max={today} today={today}
        presets={["yesterday", "last7", "thisMonth", "lastMonth", "last30", "last90"]}
        defaultRange={{ label: "Today", from: today, to: today }}
      />
      <ConsumablesClient
        data={data}
        canRecord={hasPerm(me, "consumables.edit")}
        isAdmin={me.isAdmin}
        periodLabel={from === to ? (from === today ? "today" : `on ${from}`) : `from ${from} to ${to}`}
      />
    </div>
  );
}
