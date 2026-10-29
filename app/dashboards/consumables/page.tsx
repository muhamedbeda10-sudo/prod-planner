import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { getConsumablesDecisions } from "@/lib/server/consumables";
import { getMonthlyReport } from "@/lib/server/consumableMonthly";
import { loadOrNull } from "@/lib/server/dashboards";
import { monthShort, pastMonthOf } from "@/lib/domain/consumableMonthly";
import { consumablesPeriod } from "@/lib/domain/consumables";
import { consumablesActions, filterParams, firstParam, hasFilters, headcountText, readDecisionFilters } from "@/lib/domain/consumablesDecisions";
import { previousPeriod } from "@/lib/domain/consumablesStats";
import { factoryDayISO } from "@/lib/domain/dates";
import { formatDate, formatFigure as fmt, formatShare as pct } from "@/lib/domain/format";
import { DataQualityBar, MetricNotes, NowBadge, StatTile, DeltaChip } from "@/components/charts/kit";
import { Badge } from "@/components/Badge";
import { LoadFailed } from "@/components/DataTable";
import { CockpitDecisions, PrintDecisions, type DecisionCopy } from "@/components/CockpitDecisions";
import { ConsumablesMonthly } from "@/components/ConsumablesMonthly";
import { ConsumablesBreakdown, ConsumablesTrend } from "@/components/LazyCharts";
import { ConsumablesDetailTable, ConsumablesFilters } from "@/components/ConsumablesDecisionsUi";
import { PageHead } from "@/components/ui";
import { PrintHeader } from "@/components/PrintHeader";
import { RememberLastVisit } from "@/components/RememberLastVisit";
import { UrlDateSlicer } from "@/components/UrlDateSlicer";

export const metadata = { title: "Consumables dashboard — ATC" };
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

// The consumables' dashboard, in the Dashboards tab, read as decisions: what
// went out, to which department, and is it over the limits that are set?
// One period (?from=&to=) and four filters (?dept=&item=&link=&status=) set
// every card, chart and the detail table — and the assistant's Excel of it
// (make_excel consumables_dashboard reads the same address). The limits now
// and the months closed over have their own time and say so; the monthly
// review at the foot has its own month (?month=, the period's last month by
// default). Seen with the Consumables screen (its tab id); the log, the
// powder and the limits stay in Material → Consumables.
export default async function ConsumablesDashboardPage({ searchParams }: { searchParams: Promise<Search> }) {
  await guardTab("/dashboards/consumables");
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const sp = await searchParams;
  const one = (k: string) => firstParam(sp[k]) || undefined;
  const today = factoryDayISO(new Date());
  const { from, to, min, label: periodLabel } = consumablesPeriod({ from: one("from"), to: one("to") }, today);
  const filters = readDecisionFilters(sp);
  // the monthly review follows the period's last month unless one is picked
  const pickedMonth = pastMonthOf(one("month"), today);
  const month = pickedMonth ?? to.slice(0, 7);
  const rank = one("rank") ?? "count";

  const [d, report] = await Promise.all([
    loadOrNull("consumables", "the period's hand-outs and limits", getConsumablesDecisions(from, to, today, filters)),
    loadOrNull("consumables", "the monthly review", getMonthlyReport(month)),
  ]);

  // every link on the page keeps the period, the filters and the month
  const base = new URLSearchParams();
  if (one("from")) base.set("from", from);
  if (one("to")) base.set("to", to);
  for (const [k, v] of filterParams(filters)) base.set(k, v);
  if (pickedMonth) base.set("month", pickedMonth);
  if (rank !== "count") base.set("rank", rank);
  const href = (over: Record<string, string | null> = {}, hash?: string) => {
    const p = new URLSearchParams(base);
    for (const [k, v] of Object.entries(over)) if (v === null) p.delete(k); else p.set(k, v);
    const q = p.toString();
    return `/dashboards/consumables${q ? `?${q}` : ""}${hash ? `#${hash}` : ""}`;
  };
  // the month goes last: the picker appends it
  const monthParams = new URLSearchParams(base);
  monthParams.delete("month");
  monthParams.set("month", "");

  const multiMonth = from.slice(0, 7) !== to.slice(0, 7);
  const prev = previousPeriod(from, to);
  const k = d?.kpis;
  // what needs someone: one button at the end of the bar, the list in its popup
  const closedLabel = d ? `${monthShort(d.limits.closedSpan.from.slice(0, 7))} – ${monthShort(d.limits.closedSpan.to.slice(0, 7))}` : "";
  const decisions = d ? consumablesActions(d, d.powder, periodLabel, closedLabel, href) : null;
  const store: DecisionCopy = { noun: "a decision", title: "Needs a decision at the store", button: "Decisions", nothing: "Nothing needs a decision — every hand-out in scope is a catalogue item within its limits." };
  // the browser parts get the rows, cards and charts — the list and the strip are drawn here
  const view = d && { fromISO: d.fromISO, toISO: d.toISO, endsToday: d.endsToday, filters: d.filters, kpis: d.kpis, rows: d.rows, trend: d.trend, items: d.items, units: d.units, quality: d.quality };

  return (
    <div className="space-y-4">
      <RememberLastVisit storageKey="dashboards:consumables" />
      <PrintHeader title="Consumables — dashboard" />
      <PageHead title="Consumables" sub={`Dashboard · what went out, to which department, against the limits · ${periodLabel}`} />
      {/* the page's one bar: the period, then its filters */}
      <UrlDateSlicer
        encoding="fromTo" from={from} to={to} min={min} max={today} today={today} label="Period"
        presets={["yesterday", "last7", "thisMonth", "lastMonth", "last30", "last90"]}
        defaultRange={{ label: "Today", from: today, to: today }}
        end={d && decisions && (
          <>
            <ConsumablesFilters filters={filters} options={d.options} />
            <CockpitDecisions actions={decisions.actions} notes={decisions.notes} copy={store} />
          </>
        )}
      />
      {decisions && <PrintDecisions actions={decisions.actions} notes={decisions.notes} copy={store} />}

      {d === null || k === undefined || view === null ? <LoadFailed what="The consumables' figures" /> : (
        <>
          <DataQualityBar
            partial={d.quality.unlinked > 0 || d.quality.pastWindows || d.quality.headcount.some((h) => h.kind === "fallback" || h.kind === "carried")}
            about="What the dashboard is read from: the live hand-outs on the log (deleted ones left out), the catalogue and its limits as they are set now, and the headcount recorded month by month."
            items={[
              { label: "Hand-outs on the log", value: `${fmt(d.quality.total)} ${periodLabel}`, title: "Live hand-outs — deleted ones are left out" },
              { label: "Not in the catalogue", value: d.quality.total ? `${fmt(d.quality.unlinked)} (${pct(d.quality.unlinked / d.quality.total)})` : "—", tone: d.quality.unlinked > 0 ? "warn" : undefined, title: "Typed by hand: no limit counts them" },
              { label: "Catalogue", value: `${fmt(d.catalogue.items)} items · ${fmt(d.catalogue.limits)} limits` },
              { label: "Limits", value: d.quality.pastWindows ? "Recomputed using current limits" : "as set now", tone: d.quality.pastWindows ? "warn" : undefined, title: "No history of the limits is kept: a window already over is counted with the limits as they stand today" },
              { label: "Per-worker limits", value: `× ${d.quality.headcount.map(headcountText).join("; ")}` },
              { label: "Last hand-out", value: d.lastIssueLabel ?? "none yet" },
              { label: "Read", value: d.readAtLabel },
            ]}
          />

          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <Link href={href({}, "detail")} className="flex rounded-xl">
              <StatTile hero label="Hand-outs" value={fmt(k.handOuts)} sub={periodLabel}
                delta={k.change !== null
                  ? <DeltaChip value={k.change} unit="%" title={`The ${prev.fromISO === prev.toISO ? "day" : "days"} before (${formatDate(prev.fromISO)} – ${formatDate(prev.toISO)}): ${fmt(k.previousHandOuts ?? 0)}`} />
                  : <Badge title={k.noComparison ?? undefined}>N/A</Badge>}
                about="Rows of the hand-out log in the period, filters applied. A hand-out to a group or a whole department is one hand-out, however many workers it was for. Compared with the same number of days just before, under the same filters, only when the log covers all of them." />
            </Link>
            <Link href={href({}, "detail")} className="flex rounded-xl">
              {k.quantity
                ? <StatTile label="Quantity" value={`${fmt(k.quantity.qty)} ${k.quantity.uom ?? ""}`.trim()} sub={k.quantity.uom ? `${periodLabel} · one item` : `${periodLabel} · as typed, no unit`}
                  about="The item picked, added up in its own unit — a quantity is never added across items." />
                : <StatTile label="Items handed out" value={fmt(k.items)} sub={periodLabel}
                  about="Different items in the period: a catalogue item, or a name typed by hand — the two are never merged." />}
            </Link>
            <Link href={href({}, "detail")} className="flex rounded-xl">
              <StatTile label="Departments served" value={fmt(k.departments)} sub={periodLabel} about="Departments the period's hand-outs were recorded to." />
            </Link>
            <Link href="/consumables?view=limits" className="flex rounded-xl">
              <StatTile label="Over a limit now" value={fmt(d.limits.overNow.length)} delta={<NowBadge />} sub="in the filters' scope"
                about="Limits past their number in their current window (this month, or a limit of several months over its months so far), for the department and item filtered. Today's reading, whatever the period." />
            </Link>
            <Link href={href({ status: "none" }, "detail")} className="flex rounded-xl">
              <StatTile label="No limit counts" value={fmt(k.uncovered.handOuts)} sub={`hand-outs · ${fmt(k.uncovered.items)} item${k.uncovered.items === 1 ? "" : "s"}`}
                about="Hand-outs no limit counts: items typed by hand (not in the catalogue) and catalogue items handed to a department none of their limits covers. No limit is not within the limit." />
            </Link>
            <Link href={href({ link: "linked" }, "detail")} className="flex rounded-xl">
              <StatTile label="In the catalogue" value={k.linkedShare === null ? "N/A" : pct(k.linkedShare)} sub={`${fmt(k.linked)} of ${fmt(k.handOuts)} hand-outs`} meter={k.linkedShare ?? undefined}
                about="Hand-outs of catalogue items over every hand-out in the period. Only those can be counted against a limit." />
            </Link>
          </div>
          <MetricNotes items={[
            { label: "Hand-outs", definition: "Rows of the hand-out log in the period. A group or whole-department hand-out is one hand-out, however many workers it was for.", source: "ConsumableIssue (not deleted)", coverage: k.noComparison ? `vs before: N/A — ${k.noComparison}` : "vs the same number of days just before, same filters" },
            { label: k.quantity ? "Quantity" : "Items handed out", definition: k.quantity ? "The picked item's quantity in its own unit." : "Different items: a catalogue item by its id, or a name typed by hand. Quantities are only added up within one item.", source: "ConsumableIssue · ConsumableItem" },
            { label: "Departments served", definition: "Departments the hand-outs were recorded to — a hand-out to a department is not a known worker's.", source: "ConsumableIssue.department" },
            { label: "Over a limit now", definition: "Limits past their number in their current window — today's reading, not the period's. Each-department and per-worker limits count each department on its own.", source: "ConsumableLimit · ConsumableIssue · ConsumableHeadcount", coverage: "catalogue items only" },
            { label: "No limit counts", definition: "Hand-outs of typed items, and of catalogue items to a department no limit covers. Never shown as within a limit.", source: "ConsumableIssue · ConsumableLimit" },
            { label: "In the catalogue", definition: "Catalogue hand-outs over all hand-outs. A typed name may be suggested a catalogue item in the table, for review — nothing is linked by itself.", source: "ConsumableIssue.itemId" },
          ]} />

          <ConsumablesTrend d={view} periodLabel={periodLabel} prevLabel={`${formatDate(prev.fromISO)} – ${formatDate(prev.toISO)}`} />
          <ConsumablesBreakdown d={view} rank={rank} periodLabel={periodLabel} />
          <ConsumablesDetailTable d={view} periodLabel={periodLabel} />
        </>
      )}

      <section id="monthly" className="space-y-3 scroll-mt-24 pt-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="font-bold text-lg">Monthly review: {month}</h2>
          <span className="text-sm text-muted">
            {pickedMonth || multiMonth ? "its own month, apart from the period above" : "the period's last month"}
            {" · every catalogue item and department"}{hasFilters(filters) ? " — the filters above do not apply here" : ""}
          </span>
        </div>
        {report === null ? <LoadFailed what="The monthly review" /> : <ConsumablesMonthly report={report} monthHref={`/dashboards/consumables?${monthParams.toString()}`} />}
      </section>
    </div>
  );
}
