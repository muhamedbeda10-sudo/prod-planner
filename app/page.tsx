import Link from "next/link";
import { getTargetDashboard, type DeptDay } from "@/lib/server/dashboard";
import { getSmartInsights } from "@/lib/server/insights";
import { SmartInsights } from "@/components/SmartInsights";
import { pctStyle } from "@/components/ui";
import { PeriodFilter, DashboardPeriodMemory } from "@/components/controls";
import { WeekTrendChart, WeekItemChart, HistoryChart } from "@/components/DashboardCharts";
import { LaserCutterIcon, WeldingIcon, PowderCoatIcon } from "@/components/icons";
import { parseISODate, toDisplayDate } from "@/lib/domain/dates";
import { ITEMS, PAINTED_ITEMS, type Item } from "@/lib/domain/constants";

export const dynamic = "force-dynamic";

const pct = (v: number, t: number) => (t > 0 ? v / t : 0);
const fmtPct = (v: number, t: number) => `${Math.round(pct(v, t) * 100)}%`;

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ w?: string; from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const [d, ai] = await Promise.all([
    getTargetDashboard({
      weekOf: sp.w ? parseISODate(sp.w) : null,
      from: sp.from ? parseISODate(sp.from) : null,
      to: sp.to ? parseISODate(sp.to) : null,
    }),
    getSmartInsights(),
  ]);

  const periodTitle =
    d.mode === "week"
      ? `Week ${toDisplayDate(parseISODate(d.fromISO)!)} → ${toDisplayDate(parseISODate(d.toISO)!)}`
      : `Period ${toDisplayDate(parseISODate(d.fromISO)!)} → ${toDisplayDate(parseISODate(d.toISO)!)}`;

  return (
    <div className="space-y-6">
      {/* the chosen From→To range survives even a full browser restart */}
      <DashboardPeriodMemory />
      {/* period controls — phones get a pager row (prev · title · next), then
          Insights and the period filter as tidy full-width rows */}
      <div className="no-print flex flex-wrap items-center justify-between gap-3 bg-surface border rounded-xl px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2 w-full xl:w-auto">
          {d.mode === "week" && (
            <Link href={`/?w=${d.prevWeekISO}`} className="btn btn-secondary btn-sm whitespace-nowrap">← Prev</Link>
          )}
          <span className="font-extrabold tabnum flex-1 text-center text-sm sm:text-base xl:flex-none xl:text-left">
            {periodTitle}
            {d.isCurrentWeek && <span className="pill pill-ok ml-2">current</span>}
            {d.mode === "range" && (
              <span className="pill pill-warn ml-2">{d.workingDays} working day{d.workingDays === 1 ? "" : "s"}</span>
            )}
          </span>
          {d.nextWeekISO && (
            <Link href={`/?w=${d.nextWeekISO}`} className="btn btn-secondary btn-sm whitespace-nowrap">Next →</Link>
          )}
          {d.mode === "week" && !d.isCurrentWeek && (
            <Link href="/" className="text-sm font-bold text-accent hover:underline whitespace-nowrap">Jump to current ↻</Link>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 w-full xl:w-auto">
          <SmartInsights data={ai} />
          <PeriodFilter from={d.fromISO} to={d.toISO} active={d.mode === "range"} />
        </div>
      </div>

      {d.clamped && (
        <p className="text-xs bg-warn-bg text-warn-fg rounded-md px-3 py-2 inline-block">
          The range was longer than 31 days — showing {d.fromISO} → {d.toISO}.
        </p>
      )}

      {/* ==== TODAY ==== */}
      {d.today && (
        <section>
          <h2>Today — {toDisplayDate(parseISODate(d.todayISO)!)} · target {d.targetPerItem}/item</h2>
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            <DeptScoreboard title={<DeptTitle icon={<LaserCutterIcon size={16} />} name="Fabrication" />} data={d.today.cut} target={d.targetPerItem} targetTotal={d.targetPerDeptDay} />
            <DeptScoreboard title={<DeptTitle icon={<WeldingIcon size={16} />} name="Welding" />} data={d.today.weld} target={d.targetPerItem} targetTotal={d.targetPerDeptDay} />
            {/* the core (CF) is never painted — the Painting card shows the 3 painted items and targets ×3 */}
            <DeptScoreboard title={<DeptTitle icon={<PowderCoatIcon size={16} />} name="Painting" />} data={d.today.paint} target={d.targetPerItem} targetTotal={d.targetPerItem * PAINTED_ITEMS.length} items={PAINTED_ITEMS} />
          </div>
        </section>
      )}

      {/* ==== PERIOD CUMULATIVE ==== */}
      <section>
        <h2>
          {d.mode === "week" ? "Week to date" : "Period total"} · target {d.targetPerItemPeriod}/item ({d.targetPerItem} × {d.workingDays} working days)
          {d.todayInPeriod && d.paceWorkingDays > 0 && d.paceWorkingDays < d.workingDays && (
            <span className="normal-case font-normal"> — pace: {d.paceWorkingDays} of {d.workingDays} days = {d.targetPerItem * d.paceWorkingDays}/item expected</span>
          )}
        </h2>
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          <DeptScoreboard
            title={<DeptTitle icon={<LaserCutterIcon size={16} />} name="Fabrication" />}
            data={d.period.cut}
            target={d.targetPerItemPeriod}
            targetTotal={d.targetPerDeptPeriod}
            paceTarget={d.todayInPeriod && d.paceWorkingDays < d.workingDays ? d.targetPerItem * d.paceWorkingDays : undefined}
          />
          <DeptScoreboard
            title={<DeptTitle icon={<WeldingIcon size={16} />} name="Welding" />}
            data={d.period.weld}
            target={d.targetPerItemPeriod}
            targetTotal={d.targetPerDeptPeriod}
            paceTarget={d.todayInPeriod && d.paceWorkingDays < d.workingDays ? d.targetPerItem * d.paceWorkingDays : undefined}
          />
          <DeptScoreboard
            title={<DeptTitle icon={<PowderCoatIcon size={16} />} name="Painting" />}
            data={d.period.paint}
            target={d.targetPerItemPeriod}
            targetTotal={d.targetPerItemPeriod * PAINTED_ITEMS.length}
            items={PAINTED_ITEMS}
            paceTarget={d.todayInPeriod && d.paceWorkingDays < d.workingDays ? d.targetPerItem * d.paceWorkingDays : undefined}
          />
        </div>
      </section>

      {/* ==== charts ==== */}
      <div className="grid lg:grid-cols-2 gap-4">
        <ChartCard title="Daily output vs target" sub={`dept totals per day · dashed line = ${d.targetPerDeptDay} pcs/dept/working day`}>
          <WeekTrendChart days={d.days} targetPerDeptDay={d.targetPerDeptDay} />
        </ChartCard>
        <ChartCard title={`${d.mode === "week" ? "Week" : "Period"} attainment by item`} sub={`fabricated vs welded vs painted per component · dashed line = ${d.targetPerItemPeriod} pcs/item`}>
          <WeekItemChart cut={d.period.cut.items} weld={d.period.weld.items} paint={d.period.paint.items} targetPerItemWeek={d.targetPerItemPeriod} />
        </ChartCard>
      </div>

      {/* ==== day × dept × item matrix ==== */}
      <section>
        <h2>Daily matrix — every cell vs {d.targetPerItem} (Fridays & calendar days off carry no target)</h2>
        <div className="bg-surface border rounded-xl overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-brand text-white text-center">
                <th className="p-2 text-left" rowSpan={2}>Day</th>
                <th className="p-2 border-l border-border-strong" colSpan={5}>
                  <span className="inline-flex items-center gap-1.5"><LaserCutterIcon size={13} />Fabrication</span>
                </th>
                <th className="p-2 border-l border-border-strong" colSpan={5}>
                  <span className="inline-flex items-center gap-1.5"><WeldingIcon size={13} />Welding</span>
                </th>
                <th className="p-2 border-l border-border-strong" colSpan={4}>
                  <span className="inline-flex items-center gap-1.5"><PowderCoatIcon size={13} />Painting</span>
                </th>
              </tr>
              <tr className="bg-brand-dark text-white text-center text-[10px]">
                {([ITEMS, ITEMS, PAINTED_ITEMS] as const).flatMap((list, i) =>
                  [...list, "Total"].map((h, j) => (
                    <th key={`${i}-${h}`} className={`p-1 ${j === 0 ? "border-l border-border-strong" : ""}`}>{h}</th>
                  ))
                )}
              </tr>
            </thead>
            <tbody>
              {d.days.map((row) => (
                <tr
                  key={row.iso}
                  className={`text-center ${row.isToday ? "bg-brand-light/60" : ""} ${row.isFuture ? "opacity-45" : ""} ${row.isFriday || row.isHoliday ? "opacity-70" : ""}`}
                >
                  <td className="p-2 text-left font-bold whitespace-nowrap">
                    {row.label}
                    {row.isToday && <span className="pill pill-ok ml-1">today</span>}
                    {row.isFriday && <span className="pill pill-muted ml-1">off</span>}
                    {row.isHoliday && <span className="pill pill-muted ml-1" title={row.holidayName ?? undefined}>🏖 {row.holidayName ?? "holiday"}</span>}
                  </td>
                  {(["cut", "weld", "paint"] as const).flatMap((dept) => {
                    const dd = row[dept];
                    const list = dept === "paint" ? PAINTED_ITEMS : ITEMS; // the core is never painted
                    return [
                      ...list.map((it, j) => (
                        <td
                          key={`${dept}-${it}`}
                          className={`p-1.5 tabnum font-semibold ${j === 0 ? "border-l" : ""}`}
                          style={row.isFuture || row.isFriday || row.isHoliday ? undefined : pctStyle(pct(dd.items[it], d.targetPerItem))}
                        >
                          {dd.items[it]}
                        </td>
                      )),
                      <td key={`${dept}-total`} className="p-1.5 tabnum font-extrabold">
                        {dd.total}
                        {!row.isFriday && !row.isHoliday && (
                          <span className="block text-[10px] font-normal text-muted">{fmtPct(dd.total, d.targetPerDeptDay)}</span>
                        )}
                      </td>,
                    ];
                  })}
                </tr>
              ))}
              {/* period totals row */}
              <tr className="text-center font-extrabold border-t-2">
                <td className="p-2 text-left">{d.mode === "week" ? "Week total" : "Period total"}</td>
                {(["cut", "weld", "paint"] as const).flatMap((dept) => {
                  const dd = d.period[dept];
                  const list = dept === "paint" ? PAINTED_ITEMS : ITEMS;
                  return [
                    ...list.map((it, j) => (
                      <td key={`t-${dept}-${it}`} className={`p-1.5 tabnum ${j === 0 ? "border-l" : ""}`}
                        style={pctStyle(pct(dd.items[it], d.targetPerItemPeriod))}>
                        {dd.items[it]}
                      </td>
                    )),
                    <td key={`t-${dept}-total`} className="p-1.5 tabnum">
                      {dd.total}
                      <span className="block text-[10px] font-normal text-muted">{fmtPct(dd.total, d.targetPerDeptPeriod)}</span>
                    </td>,
                  ];
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* ==== history ==== */}
      <div className="grid lg:grid-cols-2 gap-4">
        <ChartCard title="Last 6 weeks" sub={`dept totals per work week · line = ${d.targetPerItem * 24} pcs/dept/week`}>
          <HistoryChart history={d.history} targetPerDeptWeek={d.targetPerItem * 24} />
        </ChartCard>
        <ChartCard title="Weekly attainment" sub="output and complete sets per week (sets = MIN across the 4 items, summed daily)">
          <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-xs text-muted border-b">
                <th className="py-1.5">Week</th>
                <th className="py-1.5 text-center">Fab</th>
                <th className="py-1.5 text-center">Fab %</th>
                <th className="py-1.5 text-center">Welded</th>
                <th className="py-1.5 text-center">Weld %</th>
                <th className="py-1.5 text-center">Painted</th>
                <th className="py-1.5 text-center">Paint %</th>
                <th className="py-1.5 text-center">Sets (paint)</th>
              </tr>
            </thead>
            <tbody>
              {d.history.map((h) => (
                <tr key={h.startISO} className="border-b last:border-0">
                  <td className="py-1.5 font-bold whitespace-nowrap">
                    <Link href={`/?w=${h.startISO}`} className="text-accent hover:underline">{h.label}</Link>
                  </td>
                  <td className="py-1.5 text-center tabnum">{h.cutTotal}</td>
                  <td className="py-1.5 text-center tabnum font-bold" style={pctStyle(pct(h.cutTotal, d.targetPerItem * 24))}>
                    {fmtPct(h.cutTotal, d.targetPerItem * 24)}
                  </td>
                  <td className="py-1.5 text-center tabnum">{h.weldTotal}</td>
                  <td className="py-1.5 text-center tabnum font-bold" style={pctStyle(pct(h.weldTotal, d.targetPerItem * 24))}>
                    {fmtPct(h.weldTotal, d.targetPerItem * 24)}
                  </td>
                  <td className="py-1.5 text-center tabnum">{h.paintTotal}</td>
                  <td className="py-1.5 text-center tabnum font-bold" style={pctStyle(pct(h.paintTotal, d.targetPerItem * 24))}>
                    {fmtPct(h.paintTotal, d.targetPerItem * 24)}
                  </td>
                  <td className="py-1.5 text-center tabnum font-bold">{h.paintSets}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </ChartCard>
      </div>
    </div>
  );
}

/* ---------- building blocks ---------- */

function DeptTitle({ icon, name }: { icon: React.ReactNode; name: string }) {
  return <span className="inline-flex items-center gap-1.5">{icon}{name}</span>;
}

function DeptScoreboard({
  title, data, target, targetTotal, paceTarget, items = ITEMS,
}: {
  title: React.ReactNode;
  data: DeptDay;
  target: number;
  targetTotal: number;
  paceTarget?: number;
  items?: readonly Item[]; // Painting shows the 3 painted items (the core is never painted)
}) {
  return (
    <div className="bg-surface border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="font-extrabold">{title}</span>
        <div className="text-right">
          <span className="text-2xl font-extrabold tabnum px-2 rounded" style={pctStyle(pct(data.total, targetTotal))}>
            {fmtPct(data.total, targetTotal)}
          </span>
          <div className="text-[11px] text-muted mt-0.5">
            {data.total} / {targetTotal} pcs · sets: <b className="text-foreground">{data.sets}</b>
          </div>
        </div>
      </div>
      <div className={`grid grid-cols-2 ${items.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-4"} gap-2.5`}>
        {items.map((it) => {
          const v = data.items[it];
          const f = pct(v, target);
          return (
            <div key={it} className="rounded-lg border px-2 py-1.5">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-extrabold">{it}</span>
                <span className="text-[10px] tabnum text-muted">{Math.round(f * 100)}%</span>
              </div>
              <div className="text-lg font-extrabold tabnum leading-tight">
                {v}<span className="text-[11px] font-semibold text-muted">/{target}</span>
              </div>
              <div className="mt-1 h-1.5 rounded bg-border overflow-hidden">
                <div
                  className="h-full"
                  style={{ width: `${Math.min(100, f * 100)}%`, background: f >= 1 ? "var(--ok-fg)" : f >= 0.5 ? "var(--brand)" : "var(--bad-fg)" }}
                />
              </div>
              {paceTarget !== undefined && paceTarget > 0 && (
                <div className="text-[10px] mt-0.5" style={{ color: v >= paceTarget ? "var(--ok-fg)" : "var(--bad-fg)" }}>
                  {v >= paceTarget ? "on pace" : `−${paceTarget - v} vs pace`}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChartCard({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    // min-w-0: as a grid item the card must be allowed to shrink below its
    // content's min width, otherwise wide charts/tables push it past the
    // viewport on phones instead of scrolling inside their own box
    <div className="bg-surface border rounded-xl p-4 min-w-0">
      <div className="mb-2">
        <h3 className="font-bold text-sm">{title}</h3>
        {sub && <p className="text-xs text-muted">{sub}</p>}
      </div>
      {children}
    </div>
  );
}
