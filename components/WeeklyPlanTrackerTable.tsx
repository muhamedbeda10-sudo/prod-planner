"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { recordGroupOutput } from "@/app/worklist/actions";
import { pctClass, Soi } from "@/components/ui";
import { SearchBox, FilterBar, useSavedFilter } from "@/components/FilterControls";
import { PlanViewToggle, WeekPlanPicker } from "@/components/PlanViewToggle";
import { PrintScope } from "@/components/PrintHeader";
import { RING_GRID, RingCard } from "@/components/ProgressRing";
import { ExportButton } from "@/components/ExportButton";
import { PrintButton } from "@/components/PrintButton";
import { WEEKLY_STAGES, filterWeeklyDays, owedOf, weeklyCoverage, weeklyMetricOf, weeklyPlanRows, weeklyStagesOf, type WeeklyStage } from "@/lib/domain/weeklyPlanView";
import { itemColor } from "@/lib/domain/productColors";
import { ITEMS, ITEM_NAME, isPaintExempt, type Item } from "@/lib/domain/constants";
import { traceHref } from "@/lib/domain/links";
import { ODOO_EXACT_FROM_LABEL } from "@/lib/domain/trackerOdoo";
import { OdooCell, OdooNotCounted } from "@/components/TrackerColumns";
import type { WeeklyPlanTracker, WeeklyPlanDay } from "@/lib/server/weeklyPlanTracker";

/* One weekly plan by DELIVERY DAY. The date runs down the left edge as a rail
   so it never breaks the grid, and every day repeats its own column headers —
   each day asks for different components, so each day gets its own columns. */

const TINT: Record<WeeklyStage, string> = {
  cut: "var(--cut-tint)", weld: "var(--weld-tint)", finish: "var(--paint-tint)", delivered: "var(--dlvd-tint)",
};

/** What the measured stage DID to a component — the core is shot blasted, not
 *  painted, so its finishing card has to say so. */
const doneWord = (metric: WeeklyStage, it: Item): string =>
  metric === "cut" ? "fabricated"
  : metric === "weld" ? "welded"
  : metric === "delivered" ? "delivered"
  : isPaintExempt(it) ? "shot blasted" : "painted";

/** Which ledger department a visible stage column writes to. The core's
 *  finishing column IS its shot blast — it is never painted. */
const deptOfStage = (s: WeeklyStage, it: Item): string =>
  s === "cut" ? "Cut" : s === "weld" ? "Welding" : s === "delivered" ? "Delivered" : isPaintExempt(it) ? "ShotBlast" : "Painting";

/** Recording straight onto the weekly sheet, wired once in the table and used
 *  by every day block. Cells ADD pieces (never "set a total"): a weekly cell
 *  shows a day's SLICE of the order's output — capped at the day's promise and
 *  waterfalled from the earliest promise — so a total would be ambiguous where
 *  "add N pcs" never is. */
interface RecCtl {
  can: boolean;
  editKey: string | null;
  val: string;
  err: string;
  pending: boolean;
  open: (key: string) => void;
  setVal: (v: string) => void;
  cancel: () => void;
  save: (a: { dept: string; bom: string; item: Item; mos: string[]; dayISO: string }) => void;
}

export function WeeklyPlanTrackerTable({ data, capacityCard, canRecord = false, fabrication = false, lineSwitch }: {
  data: WeeklyPlanTracker;
  capacityCard?: React.ReactNode;
  /** The Plan Tracker's Transformers | LV Panels switch, first in the filter bar. */
  lineSwitch?: React.ReactNode;
  /** The Plan Tracker: "weekly.record", one permission for the whole sheet.
   *  The fabrication page: the Cut worklist's own permission. */
  canRecord?: boolean;
  /** On the fabrication page, under its machines: the week measured and
   *  recorded at Fabrication only — what the floor cuts against — with the
   *  page's own filters, flowing with the page rather than filling the screen. */
  fabrication?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [cellErr, setCellErr] = useState("");

  const rec: RecCtl = {
    can: canRecord,
    editKey,
    val: editVal,
    err: cellErr,
    pending,
    open: (key) => { setEditKey(key); setEditVal(""); setCellErr(""); },
    setVal: (v) => { setEditVal(v); setCellErr(""); },
    cancel: () => { setEditKey(null); setCellErr(""); },
    save: ({ dept, bom, item, mos, dayISO }) => {
      const qty = Number(editVal);
      if (!Number.isInteger(qty) || qty <= 0) { setCellErr("Enter a whole quantity greater than zero."); return; }
      const fd = new FormData();
      // the fabrication page records as its worklist does (the Cut key); the
      // ledger note still names the plan and the delivery day
      fd.set("source", fabrication ? "worklist" : "weekly");
      fd.set("dept", dept);
      fd.set("bom", bom);
      fd.set("item", item);
      fd.set("qty", String(qty));
      fd.set("mos", mos.join(","));
      fd.set("dayISO", dayISO);
      fd.set("planLabel", String(data.planNo ?? ""));
      setCellErr("");
      startTransition(async () => {
        const res = await recordGroupOutput(fd);
        if (res.ok) {
          setEditKey(null);
          setEditVal("");
        } else {
          setCellErr(res.error ?? "Failed");
        }
      });
    },
  };

  const filterKey = fabrication ? "fab.wplan" : "wtracker";
  const [q, setQ] = useSavedFilter(`${filterKey}.q`);
  const [stage, setStage] = useSavedFilter(`${filterKey}.stage`);
  const [hideDone, setHideDone] = useSavedFilter(`${filterKey}.hideDone`);

  const stages = useMemo((): WeeklyStage[] => (fabrication ? ["cut"] : weeklyStagesOf(stage)), [stage, fabrication]);
  const toggleStage = (v: WeeklyStage) => {
    const sel = new Set(stage.split(",").filter(Boolean));
    if (sel.has(v)) sel.delete(v); else sel.add(v);
    setStage(WEEKLY_STAGES.map((o) => o.value).filter((x) => sel.has(x)).join(","));
  };

  const metric = fabrication ? "cut" : weeklyMetricOf(stages, !!stage);

  // the rail totals follow the SAME stage and the SAME rows as the table, so
  // the day header can never disagree with the rows under it
  const days = useMemo(() => filterWeeklyDays(data.days, { q, hideDone: hideDone === "1" }, metric), [data, q, hideDone, metric]);

  // one card per component the plan asks for, measured at the SAME stage as the
  // table — required across every day in view against how much is covered
  const itemStats = useMemo(() => {
    const stats = ITEMS.map((it) => ({ it, need: 0, done: 0 }));
    for (const d of days) {
      for (const r of d.rows) {
        for (const st of stats) {
          const c = r.items[st.it];
          if (!c) continue;
          st.need += owedOf(c);
          st.done += c[metric];
        }
      }
    }
    return stats.filter((s) => s.need > 0);
  }, [days, metric]);

  const shown = days.reduce((s, d) => s + d.rows.length, 0);
  const total = data.days.reduce((s, d) => s + d.rows.length, 0);
  const hasActive = !!q || !!stage || hideDone === "1";

  // the Floor's weekly sheet keeps its own export; the Plan Tracker's comes
  // from the assistant (lib/server/ai/tools/sheets.ts), built the same way
  const exportRows = useMemo(() => (fabrication ? weeklyPlanRows(days, stages) : []), [fabrication, days, stages]);

  const metricLabel = WEEKLY_STAGES.find((o) => o.value === metric)!.label;

  return (
    // the cards and filters stay put and ONLY the table scrolls — the page
    // itself never does, so the headline is always on screen. `print-flow`
    // hands the height back to the paper: a fixed-height scroller would print
    // one page and clip everything under it.
    <div className={fabrication ? "space-y-3" : "print-flow space-y-3 md:flex md:flex-col md:space-y-0 md:gap-3 md:h-[var(--page-fill)]"}>
      {/* what the sheet is showing — filters don't survive onto paper otherwise */}
      <PrintScope
        parts={[
          `Measured at: ${metricLabel}`,
          !!stage && `Departments: ${WEEKLY_STAGES.filter((o) => stages.includes(o.value)).map((o) => o.short).join(", ")}`,
          !!q && `Search: "${q}"`,
          hideDone === "1" && "Finished rows hidden",
          `${shown} of ${total} rows`,
        ]}
      />

      {/* the capacity check, then the component cards — each a full-width row */}
      {capacityCard}
      {itemStats.length > 0 && (
        <div className={`print-keep ${RING_GRID}`}>
          {itemStats.map(({ it, need, done }) => (
            <RingCard key={it} label={it} name={ITEM_NAME[it]} color={itemColor(it)} note={doneWord(metric, it)} done={done} need={need} wide compact />
          ))}
        </div>
      )}

      <FilterBar
        count={shown}
        total={total}
        hasActive={hasActive}
        onReset={() => { setQ(""); setStage(""); setHideDone(""); }}
      >
        {lineSwitch}
        {!fabrication && <PlanViewToggle value="weekly" />}
        <WeekPlanPicker plans={data.planNos} value={data.planNo} basePath={fabrication ? "/worklist/cut" : undefined} />
        <SearchBox value={q} onChange={setQ} placeholder="Search project / SOI…" />
        {!fabrication && <div className="col-span-full flex min-w-0 flex-col gap-1 text-sm sm:col-span-1 sm:flex-row sm:items-center sm:gap-1.5">
          <span className="filter-label max-sm:hidden">Dept</span>
          <div className="chip-row sm:flex sm:flex-wrap sm:gap-1">
            {WEEKLY_STAGES.map((o) => {
              const on = stage.split(",").includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => toggleStage(o.value)}
                  aria-pressed={on}
                  className="chip-toggle"
                  title={`${o.label} — pick one or more departments to narrow the columns`}
                >
                  {o.short}
                </button>
              );
            })}
          </div>
        </div>}
        <label className="col-span-full flex items-center gap-1.5 text-sm sm:col-span-1">
          <input type="checkbox" checked={hideDone === "1"} onChange={(e) => setHideDone(e.target.checked ? "1" : "")} />
          <span className="text-muted text-[11px] font-bold uppercase tracking-wide">Hide finished</span>
        </label>
        {fabrication && (
          <div className="col-span-full flex items-center gap-2 sm:col-span-1">
            <ExportButton rows={exportRows} filename={`fabrication-weekly-plan-${data.planNo ?? "none"}.csv`} label="Export CSV" />
            <PrintButton />
          </div>
        )}
      </FilterBar>

      {data.planNo === null ? (
        <div className="bg-surface border rounded-xl p-8 text-center text-muted">
          No weekly plans have been imported yet. Import one from the <Link href="/import" className="text-brand-ink font-bold underline">Import</Link> page.
        </div>
      ) : days.length === 0 ? (
        <div className="bg-surface border rounded-xl p-8 text-center text-muted">Nothing matches these filters.</div>
      ) : (
        <div className={`print-flow print-fit print-tracker bg-surface border rounded-xl overflow-auto ${fabrication ? "md:max-h-[75vh]" : "md:flex-1 md:min-h-0"}`}>
          <table className="w-full text-sm border-collapse">
            {/* the Cut worklist's view of the plan has no Odoo column — closing is not the floor's step */}
            {days.map((d) => <DayBlock key={d.iso} day={d} stages={stages} metric={metric} planNo={data.planNo ?? 0} rec={rec} odoo={!fabrication} />)}
          </table>
        </div>
      )}
    </div>
  );
}

/** One delivery day: its date as a vertical rail down the left, its own header
 *  row, then a row per project. Each day is its own <tbody> so the rail can
 *  span exactly that day's rows. */
function DayBlock({ day, stages, metric, planNo, rec, odoo }: { day: WeeklyPlanDay; stages: readonly WeeklyStage[]; metric: WeeklyStage; planNo: number; rec: RecCtl; odoo: boolean }) {
  // each component: Req, its stages, then Odoo
  const span = 1 + stages.length + (odoo ? 1 : 0);
  const metricLabel = WEEKLY_STAGES.find((o) => o.value === metric)!;
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
          className={`p-0 w-7 align-middle border-r-2 border-border-strong ${day.isToday ? "bg-brand-fill text-white" : "bg-brand-light/40"}`}
          // a delivery date that passed unfinished reads red — colour alone, no extra text
          style={late && !day.isToday ? { background: "var(--bad-bg)", color: "var(--bad-fg)" } : undefined}
        >
          <div className="mx-auto py-2 text-xs font-bold whitespace-nowrap" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>
            {day.label}
          </div>
        </th>
        <th rowSpan={2} className="px-2 py-1 text-left bg-brand-fill text-white align-middle">Project (BOM)</th>
        <th rowSpan={2} className="px-2 py-1 text-left bg-brand-fill text-white align-middle" title="Sales order item">SOI</th>
        <th rowSpan={2} className="px-2 py-1 bg-brand-fill text-white align-middle" title={`How much of this day's promise ${metricLabel.label} has covered`}>
          Done
          <span className="block text-[11px] font-normal">{metricLabel.short}</span>
        </th>
        {day.items.map((it) => (
          <th key={it} colSpan={span} className="px-2 py-1 bg-brand-fill text-white border-l border-border-strong">{it}</th>
        ))}
      </tr>
      {/* each sub-header sits over the column it labels — one <th> each, never a
          joined-up string that only looks aligned */}
      <tr className="bg-brand-dark text-white text-[11px]">
        {day.items.map((it) => (
          <Fragment key={it}>
            <th className="px-1 py-0.5 font-medium border-l border-border-strong">Req</th>
            {stages.map((s) => (
              <th key={s} className="px-1 py-0.5 font-medium">
                {/* the core's finishing column reads as SHB — it is never painted */}
                {s === "finish" && isPaintExempt(it) ? "SHB" : WEEKLY_STAGES.find((o) => o.value === s)!.short}
              </th>
            ))}
            {odoo && <th className="odoo-col px-1 py-0.5 font-medium" title={`Closed in Odoo — the day's orders' Done rows of the ODOO log, each on the MO it was recorded against, filling the earliest promise first. Counted from the ${ODOO_EXACT_FROM_LABEL} plans on; older orders read —`}>Odoo</th>}
          </Fragment>
        ))}
      </tr>

      {day.rows.map((r) => {
        const cov = weeklyCoverage(r, metric);
        return (
          <tr key={r.bom} className="text-center border-t hover:bg-brand-light/20 transition-colors">
            <td className="px-2 py-1 text-left whitespace-nowrap font-bold">
              {r.urgent && <span className="text-bad-fg mr-1" title="Urgent">★</span>}
              {/* the code opens its full Trace — the same all-plan history the
                  monthly view opens, and the trip back returns to THIS week */}
              <Link
                href={traceHref({ bom: r.bom, line: "TR" }, planNo, "weekly")}
                className="text-brand-ink hover:underline"
                title={`${r.soi ? r.soi + " · " : ""}Open the full trace for ${r.bom}`}
              >
                {r.bom}
              </Link>
            </td>
            <td className="px-2 py-1 text-left whitespace-nowrap">
              <Soi soi={r.soi} />
            </td>
            <td className={`px-2 py-1 tabnum font-bold ${pctClass(cov)}`}>
              {cov === null ? <span className="text-muted opacity-40">—</span> : `${Math.round(cov * 100)}%`}
            </td>
            {day.items.map((it) => {
              const c = r.items[it];
              if (!c) {
                // this project owes nothing of this component today — say so once
                return (
                  // hatched, like a component an order does not need on the monthly tracker
                  <td key={it} colSpan={span} className="na-cell px-1 py-1 border-l" title={`Nothing of ${it} is due from this project today`} aria-label={`${it} not due`}>
                    <span className="sr-only">not due</span>
                  </td>
                );
              }
              const owed = owedOf(c);
              if (owed === 0) {
                // the whole promise is N/A on the order, or the sheet already
                // asked for it earlier this week — it stays visible so the
                // plan's ask is on the sheet, but it is not work we will do
                const repeat = c.over >= c.na;
                const why = repeat
                  ? `The order only needs ${c.req - c.over} of these, and the plan already asked for them earlier this week — this line repeats that promise, so it is not counted again`
                  : "This component is marked N/A on the order — it will not be manufactured and does not count in any total";
                return (
                  <Fragment key={it}>
                    <td className="px-1 py-1 tabnum text-xs border-l text-muted line-through opacity-50" title={why}>
                      {c.req}
                    </td>
                    <td colSpan={span - 1} className="px-1 py-1 text-[11px] font-bold text-muted opacity-60" title={why}>
                      {repeat ? "Already promised earlier this week" : "N/A — not manufactured"}
                    </td>
                  </Fragment>
                );
              }
              return (
                <Fragment key={it}>
                  <td className="px-1 py-1 tabnum text-xs font-bold border-l">
                    {c.req}
                    {c.na > 0 && (
                      // part of the promise is N/A — the numbers run against the rest
                      <span className="block text-[11px] font-normal text-muted" title={`${c.na} of ${c.req} pcs are marked N/A on the order — only ${owed} will be manufactured`}>
                        N/A {c.na}
                      </span>
                    )}
                    {c.over > 0 && (
                      // the sheet asked for more than the order needs — the
                      // surplus repeats an earlier day and is not work
                      <span className="block text-[11px] font-normal text-muted" title={`${c.over} of ${c.req} pcs were already promised earlier this week — the order does not need them twice, so only ${owed} count here`}>
                        REPEAT {c.over}
                      </span>
                    )}
                    {c.osp > 0 && (
                      <span className="block text-[11px] font-bold text-brand-ink" title={`${c.osp} pcs of this day's promise are outsourced (OSP) — made outside, not by our departments`}>
                        OSP {c.osp}
                      </span>
                    )}
                  </td>
                  {stages.map((s) => {
                    const dept = deptOfStage(s, it);
                    const k = `${day.iso}|${r.bom}|${it}|${dept}`;
                    const editing = rec.editKey === k;
                    // an all-outsourced promise has no order to record against
                    const editable = rec.can && c.mos.length > 0;
                    const add = editing ? Number(rec.val) : 0;
                    const stageWord = WEEKLY_STAGES.find((o) => o.value === s)!.label;
                    return (
                      <td
                        key={s}
                        className={`px-1 py-1 tabnum text-xs ${c[s] >= owed ? "font-bold" : ""}`}
                        style={{ background: TINT[s] }}
                      >
                        {editing ? (
                          <span className="inline-flex flex-col items-center gap-0.5">
                            <span className="inline-flex items-center gap-1">
                              <input
                                type="number"
                                min={1}
                                value={rec.val}
                                autoFocus
                                placeholder="+ pcs"
                                onChange={(e) => rec.setVal(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") rec.save({ dept, bom: r.bom, item: it, mos: c.mos, dayISO: day.iso });
                                  if (e.key === "Escape") rec.cancel();
                                }}
                                className="w-14 border rounded-md px-1 py-0.5 text-center font-bold tabnum bg-surface"
                                disabled={rec.pending}
                              />
                              <button
                                type="button"
                                onClick={() => rec.save({ dept, bom: r.bom, item: it, mos: c.mos, dayISO: day.iso })}
                                disabled={rec.pending}
                                className="text-ok-fg font-extrabold px-0.5"
                                title="Save — the pieces land in today's Daily Log, marked as recorded from the weekly plan"
                              >
                                ✓
                              </button>
                              <button type="button" onClick={rec.cancel} disabled={rec.pending} className="text-muted px-0.5" title="Cancel">
                                ✕
                              </button>
                            </span>
                            {add > 0 && !rec.err && (
                              <span className="text-[11px] font-bold text-ok-fg whitespace-nowrap">
                                +{add}{c.mos.length > 1 ? ` · split over ${c.mos.length} MOs` : ""}
                              </span>
                            )}
                            {rec.err && <span className="text-[11px] text-bad-fg whitespace-normal max-w-48 text-start leading-tight">{rec.err}</span>}
                            <span className="print-only tabnum">{c[s]}</span>
                          </span>
                        ) : editable ? (
                          <button
                            type="button"
                            onClick={() => rec.open(k)}
                            disabled={rec.pending}
                            className="print-as-text w-full min-w-7 rounded px-1 py-0.5 tabnum hover:ring-2 hover:ring-brand/60 transition-shadow cursor-text"
                            title={`${stageWord} · ${r.bom} · ${it} — type how many pieces to ADD. They join today's Daily Log (marked: from the weekly plan)${c.mos.length > 1 ? `, split over the ${c.mos.length} orders this day owes` : ""}, and fill this project's EARLIEST unfilled promise first.`}
                          >
                            {c[s] || <span className="text-muted opacity-40">—</span>}
                          </button>
                        ) : (
                          c[s] || <span className="text-muted opacity-40">—</span>
                        )}
                      </td>
                    );
                  })}
                  {odoo && (c.odoo == null ? (
                    <OdooNotCounted className="px-1 py-1 text-xs" />
                  ) : (
                    <OdooCell
                      className="px-1 py-1 text-xs"
                      value={c.odoo}
                      of={c.odooOf ?? owed}
                      label={`${r.bom} · ${it}${(c.odooOf ?? owed) < owed ? ` (the orders planned from ${ODOO_EXACT_FROM_LABEL} on; the rest are not counted)` : ""}`}
                    />
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
