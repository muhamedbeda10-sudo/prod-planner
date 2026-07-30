"use client";

import { Fragment, useMemo } from "react";
import Link from "next/link";
import { pctStyle } from "@/components/ui";
import { SearchBox, FilterBar, useSavedFilter } from "@/components/FilterControls";
import { PlanViewToggle, WeekPlanPicker } from "@/components/PlanViewToggle";
import { ExportButton } from "@/components/ExportButton";
import { PrintButton } from "@/components/PrintButton";
import { PrintScope } from "@/components/PrintHeader";
import { RingCard } from "@/components/ProgressRing";
import { ITEMS, isPaintExempt, FINISHING_LABEL, type Item } from "@/lib/domain/constants";
import { traceHref } from "@/lib/domain/links";
import type { WeeklyPlanTracker, WeeklyPlanRow, WeeklyPlanCell, WeeklyPlanDay } from "@/lib/server/weeklyPlanTracker";

/* One weekly plan by DELIVERY DAY. The date runs down the left edge as a rail
   so it never breaks the grid, and every day repeats its own column headers —
   each day asks for different components, so each day gets its own columns. */

const STAGE_OPTS = [
  { value: "cut", label: "Fabrication", short: "Fab" },
  { value: "weld", label: "Welding", short: "Weld" },
  { value: "finish", label: FINISHING_LABEL, short: "Paint" },
  { value: "delivered", label: "Delivered", short: "Dlvd" },
] as const;
type Stage = (typeof STAGE_OPTS)[number]["value"];

const TINT: Record<Stage, string> = {
  cut: "var(--cut-tint)", weld: "var(--weld-tint)", finish: "var(--paint-tint)", delivered: "var(--dlvd-tint)",
};

/** Achievement is measured at ONE stage — the last one still in view. Filter to
 *  Fabrication and the percentage becomes "how much of this day is fabricated";
 *  pick several and the LAST in pipeline order wins, since a later stage can't
 *  run ahead of an earlier one. Unfiltered it stays at finishing, the final
 *  production stage — delivery lags production and would read as a false zero. */
const metricOf = (stages: readonly Stage[], filtered: boolean): Stage =>
  filtered ? stages[stages.length - 1] : "finish";

/** What the measured stage DID to a component — the core is shot blasted, not
 *  painted, so its finishing card has to say so. */
const doneWord = (metric: Stage, it: Item): string =>
  metric === "cut" ? "fabricated"
  : metric === "weld" ? "welded"
  : metric === "delivered" ? "delivered"
  : isPaintExempt(it) ? "shot blasted" : "painted";

const coverage = (r: WeeklyPlanRow, metric: Stage): number | null => {
  const cells = Object.values(r.items) as WeeklyPlanCell[];
  const req = cells.reduce((s, c) => s + c.req, 0);
  return req > 0 ? cells.reduce((s, c) => s + c[metric], 0) / req : null;
};

export function WeeklyPlanTrackerTable({ data, capacityCard }: { data: WeeklyPlanTracker; capacityCard?: React.ReactNode }) {
  const [q, setQ] = useSavedFilter("wtracker.q");
  const [stage, setStage] = useSavedFilter("wtracker.stage");
  const [hideDone, setHideDone] = useSavedFilter("wtracker.hideDone");

  const stages = useMemo(() => {
    const sel = new Set(stage.split(",").filter(Boolean));
    const picked = STAGE_OPTS.filter((o) => sel.has(o.value));
    return (picked.length > 0 ? picked : [...STAGE_OPTS]).map((o) => o.value);
  }, [stage]);
  const toggleStage = (v: Stage) => {
    const sel = new Set(stage.split(",").filter(Boolean));
    if (sel.has(v)) sel.delete(v); else sel.add(v);
    setStage(STAGE_OPTS.map((o) => o.value).filter((x) => sel.has(x)).join(","));
  };

  const metric = metricOf(stages, !!stage);

  const days = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.days
      .map((d) => {
        const rows = d.rows.filter((r) => {
          if (hideDone === "1" && (coverage(r, metric) ?? 0) >= 1) return false;
          if (!needle) return true;
          return [r.bom, r.soi, r.description].some((v) => v?.toLowerCase().includes(needle));
        });
        // the rail totals follow the SAME stage and the SAME rows as the table,
        // so the day header can never disagree with the rows under it
        let req = 0;
        let covered = 0;
        for (const r of rows) {
          for (const c of Object.values(r.items) as WeeklyPlanCell[]) {
            req += c.req;
            covered += c[metric];
          }
        }
        // a day's columns follow the rows that survived the filters
        return { ...d, rows, req, covered, items: d.items.filter((it) => rows.some((r) => r.items[it])) };
      })
      .filter((d) => d.rows.length > 0);
  }, [data, q, hideDone, metric]);

  // one card per component the plan asks for, measured at the SAME stage as the
  // table — required across every day in view against how much is covered
  const itemStats = useMemo(() => {
    const stats = ITEMS.map((it) => ({ it, need: 0, done: 0 }));
    for (const d of days) {
      for (const r of d.rows) {
        for (const st of stats) {
          const c = r.items[st.it];
          if (!c) continue;
          st.need += c.req;
          st.done += c[metric];
        }
      }
    }
    return stats.filter((s) => s.need > 0);
  }, [days, metric]);

  const shown = days.reduce((s, d) => s + d.rows.length, 0);
  const total = data.days.reduce((s, d) => s + d.rows.length, 0);
  const hasActive = !!q || !!stage || hideDone === "1";

  const exportRows = useMemo(
    () =>
      days.flatMap((d) =>
        d.rows.flatMap((r) =>
          (Object.keys(r.items) as Item[]).map((it) => ({
            "Delivery date": d.iso, Project: r.bom, SOI: r.soi ?? "", Component: it,
            Required: r.items[it]!.req,
            ...Object.fromEntries(stages.map((s) => [STAGE_OPTS.find((o) => o.value === s)!.short, r.items[it]![s]])),
          }))
        )
      ),
    [days, stages]
  );

  const metricLabel = STAGE_OPTS.find((o) => o.value === metric)!.label;

  return (
    // the cards and filters stay put and ONLY the table scrolls — the page
    // itself never does, so the headline is always on screen. `print-flow`
    // hands the height back to the paper: a fixed-height scroller would print
    // one page and clip everything under it.
    <div className="print-flow space-y-3 md:flex md:flex-col md:space-y-0 md:gap-3 md:h-[calc(100vh-7rem)]">
      {/* what the sheet is showing — filters don't survive onto paper otherwise */}
      <PrintScope
        parts={[
          `Measured at: ${metricLabel}`,
          !!stage && `Departments: ${STAGE_OPTS.filter((o) => stages.includes(o.value)).map((o) => o.short).join(", ")}`,
          !!q && `Search: "${q}"`,
          hideDone === "1" && "Finished rows hidden",
          `${shown} of ${total} rows`,
        ]}
      />

      {/* one shared row: the capacity check and the component rings side by
          side, wrapping on narrow screens — neither owns a whole line */}
      {(capacityCard || itemStats.length > 0) && (
        <div className="print-keep flex flex-wrap items-center justify-center gap-2">
          {capacityCard}
          {/* the rings travel as ONE group, so on a narrower screen the whole
              group drops below the capacity card instead of splitting */}
          {itemStats.length > 0 && (
            <div className="flex flex-wrap justify-center gap-2">
              {itemStats.map(({ it, need, done }) => (
                <RingCard key={it} label={it} note={doneWord(metric, it)} done={done} need={need} />
              ))}
            </div>
          )}
        </div>
      )}

      <FilterBar
        count={shown}
        total={total}
        hasActive={hasActive}
        onReset={() => { setQ(""); setStage(""); setHideDone(""); }}
      >
        <PlanViewToggle value="weekly" />
        <WeekPlanPicker plans={data.planNos} value={data.planNo} />
        <SearchBox value={q} onChange={setQ} placeholder="Search project / SOI…" />
        <div className="col-span-2 flex min-w-0 flex-col gap-1 text-sm sm:col-span-1 sm:flex-row sm:items-center sm:gap-1.5">
          <span className="text-muted text-[10px] sm:text-[11px] font-bold uppercase tracking-wide">Dept</span>
          <div className="flex flex-wrap gap-1">
            {STAGE_OPTS.map((o) => {
              const on = stage.split(",").includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => toggleStage(o.value)}
                  className={`rounded-md border px-2 py-1 text-xs font-bold transition-colors ${on ? "bg-brand text-white border-brand" : "bg-surface text-muted hover:text-foreground hover:border-brand/60"}`}
                  title={`${o.label} — pick one or more departments to narrow the columns`}
                >
                  {o.short}
                </button>
              );
            })}
          </div>
        </div>
        <label className="col-span-2 flex items-center gap-1.5 text-sm sm:col-span-1">
          <input type="checkbox" checked={hideDone === "1"} onChange={(e) => setHideDone(e.target.checked ? "1" : "")} />
          <span className="text-muted text-[11px] font-bold uppercase tracking-wide">Hide finished</span>
        </label>
        <div className="col-span-2 flex items-center gap-2 sm:col-span-1">
          <ExportButton rows={exportRows} filename={`weekly-plan-${data.planNo ?? "none"}.csv`} />
          <PrintButton />
        </div>
      </FilterBar>

      {data.planNo === null ? (
        <div className="bg-surface border rounded-xl p-8 text-center text-muted">
          No weekly plans have been imported yet. Import one from the <Link href="/import" className="text-brand font-bold underline">Import</Link> page.
        </div>
      ) : days.length === 0 ? (
        <div className="bg-surface border rounded-xl p-8 text-center text-muted">Nothing matches these filters.</div>
      ) : (
        <div className="print-flow print-fit print-tracker bg-surface border rounded-xl overflow-auto md:flex-1 md:min-h-0">
          <table className="w-full text-sm border-collapse">
            {days.map((d) => <DayBlock key={d.iso} day={d} stages={stages} metric={metric} planNo={data.planNo ?? 0} />)}
          </table>
        </div>
      )}
    </div>
  );
}

/** One delivery day: its date as a vertical rail down the left, its own header
 *  row, then a row per project. Each day is its own <tbody> so the rail can
 *  span exactly that day's rows. */
function DayBlock({ day, stages, metric, planNo }: { day: WeeklyPlanDay; stages: readonly Stage[]; metric: Stage; planNo: number }) {
  const metricLabel = STAGE_OPTS.find((o) => o.value === metric)!;
  const pct = day.req > 0 ? day.covered / day.req : null;
  const late = day.isPast && (pct ?? 1) < 1; // the delivery date passed unfinished

  return (
    <tbody className="border-t-4 border-border-strong">
      <tr>
        {/* the date rail — spans BOTH header rows plus every project row. It
            carries the date and nothing else; today and late read as colour. */}
        <th
          rowSpan={day.rows.length + 2}
          // vertical text needs no width — a narrow rail buys the table columns
          className={`p-0 w-7 align-middle border-r-2 border-border-strong ${day.isToday ? "bg-brand text-white" : "bg-brand-light/40"}`}
          // a delivery date that passed unfinished reads red — colour alone, no extra text
          style={late && !day.isToday ? { background: "var(--bad-bg)", color: "var(--bad-fg)" } : undefined}
        >
          <div className="mx-auto py-2 text-xs font-bold whitespace-nowrap" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>
            {day.label}
          </div>
        </th>
        <th rowSpan={2} className="px-2 py-1 text-left bg-brand text-white align-middle">Project (BOM)</th>
        <th rowSpan={2} className="px-2 py-1 bg-brand text-white align-middle" title={`How much of this day's promise ${metricLabel.label} has covered`}>
          Done
          <span className="block text-[9px] font-normal opacity-75">{metricLabel.short}</span>
        </th>
        {day.items.map((it) => (
          <th key={it} colSpan={1 + stages.length} className="px-2 py-1 bg-brand text-white border-l border-border-strong">{it}</th>
        ))}
      </tr>
      {/* each sub-header sits over the column it labels — one <th> each, never a
          joined-up string that only looks aligned */}
      <tr className="bg-brand-dark text-white text-[10px]">
        {day.items.map((it) => (
          <Fragment key={it}>
            <th className="px-1 py-0.5 font-medium border-l border-border-strong">Req</th>
            {stages.map((s) => (
              <th key={s} className="px-1 py-0.5 font-medium">
                {/* the core's finishing column reads as SHB — it is never painted */}
                {s === "finish" && isPaintExempt(it) ? "SHB" : STAGE_OPTS.find((o) => o.value === s)!.short}
              </th>
            ))}
          </Fragment>
        ))}
      </tr>

      {day.rows.map((r) => {
        const cov = coverage(r, metric);
        return (
          <tr key={r.bom} className="text-center border-t hover:bg-brand-light/20 transition-colors">
            <td className="px-2 py-1 text-left whitespace-nowrap font-bold">
              {r.urgent && <span className="text-danger mr-1" title="Urgent">★</span>}
              {/* the code opens its full Trace — the same all-plan history the
                  monthly view opens, and the trip back returns to THIS week */}
              <Link
                href={traceHref({ bom: r.bom }, planNo, "weekly")}
                className="text-accent hover:underline"
                title={`${r.soi ? r.soi + " · " : ""}Open the full trace for ${r.bom}`}
              >
                {r.bom}
              </Link>
            </td>
            <td className="px-2 py-1 tabnum font-bold" style={cov === null ? undefined : pctStyle(cov)}>
              {cov === null ? <span className="text-muted opacity-40">—</span> : `${Math.round(cov * 100)}%`}
            </td>
            {day.items.map((it) => {
              const c = r.items[it];
              if (!c) {
                // this project owes nothing of this component today — say so once
                return (
                  <td key={it} colSpan={1 + stages.length} className="px-1 py-1 border-l text-[10px] text-muted opacity-30">
                    not due
                  </td>
                );
              }
              return (
                <Fragment key={it}>
                  <td className="px-1 py-1 tabnum text-xs font-bold border-l">{c.req}</td>
                  {stages.map((s) => (
                    <td key={s} className={`px-1 py-1 tabnum text-xs ${c[s] >= c.req ? "font-bold" : ""}`} style={{ background: TINT[s] }}>
                      {c[s] || <span className="text-muted opacity-40">—</span>}
                    </td>
                  ))}
                </Fragment>
              );
            })}
          </tr>
        );
      })}
    </tbody>
  );
}
