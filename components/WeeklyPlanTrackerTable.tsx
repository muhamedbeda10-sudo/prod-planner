"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { pctStyle } from "@/components/ui";
import { SearchBox, FilterBar, useSavedFilter } from "@/components/FilterControls";
import { PlanViewToggle, WeekPlanPicker } from "@/components/PlanViewToggle";
import { ExportButton } from "@/components/ExportButton";
import { ITEMS, isPaintExempt, FINISHING_LABEL, type Item } from "@/lib/domain/constants";
import type { WeeklyPlanTracker, WeeklyPlanRow, WeeklyPlanCell } from "@/lib/server/weeklyPlanTracker";

/* One weekly plan, day by day. Each day lists the orders it promises and how
   far every department has got with them — CUMULATIVE and raw, so the figures
   are the order's whole life, not just this week's output. That is why a cell
   can read higher than the day's Req: the work was already done. */

const STAGE_OPTS = [
  { value: "Cut", label: "Fabrication", short: "Fab" },
  { value: "Welding", label: "Welding", short: "Weld" },
  { value: "Painting", label: FINISHING_LABEL, short: "Paint" },
  { value: "Delivered", label: "Delivered", short: "Dlvd" },
] as const;
type Stage = (typeof STAGE_OPTS)[number]["value"];

const TINT: Record<Stage, string> = {
  Cut: "var(--cut-tint)", Welding: "var(--weld-tint)", Painting: "var(--paint-tint)", Delivered: "var(--dlvd-tint)",
};

/** A stage's cumulative figure for one component. The core's finishing IS its
 *  shot blast, and an outsourced component counts as covered — our departments
 *  never make it. */
function stageValue(stage: Stage, item: Item, c: WeeklyPlanCell): number {
  if (stage === "Cut") return c.cut;
  if (stage === "Welding") return c.weld + c.osp;
  if (stage === "Delivered") return c.delivered;
  return (isPaintExempt(item) ? c.shp : c.paint) + c.osp;
}

/** How much of a day's promise its final stage has covered — the row's headline
 *  number. Capped at 100% for the bar's sake even though the figures are raw. */
function coverage(r: WeeklyPlanRow): number | null {
  let req = 0;
  let got = 0;
  for (const it of ITEMS) {
    const c = r.items[it];
    if (!c.req || !c.eligible || c.excluded) continue;
    req += c.req;
    got += Math.min(stageValue("Painting", it, c), c.req); // credit only what this day asked for
  }
  return req > 0 ? got / req : null;
}

export function WeeklyPlanTrackerTable({ data }: { data: WeeklyPlanTracker }) {
  const [q, setQ] = useSavedFilter("wtracker.q");
  const [stage, setStage] = useSavedFilter("wtracker.stage");
  const [hideDone, setHideDone] = useSavedFilter("wtracker.hideDone");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const stages = useMemo(() => {
    const sel = new Set(stage.split(",").filter(Boolean));
    const picked = STAGE_OPTS.filter((o) => sel.has(o.value));
    return (picked.length > 0 ? picked : STAGE_OPTS).map((o) => o.value);
  }, [stage]);
  const toggleStage = (v: Stage) => {
    const sel = new Set(stage.split(",").filter(Boolean));
    if (sel.has(v)) sel.delete(v); else sel.add(v);
    setStage(STAGE_OPTS.map((o) => o.value).filter((x) => sel.has(x)).join(","));
  };

  // only the components this plan actually promises — an empty column is noise
  const items = useMemo(
    () => ITEMS.filter((it) => data.days.some((d) => d.rows.some((r) => r.items[it].req > 0))),
    [data]
  );

  const days = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.days
      .map((d) => ({
        ...d,
        rows: d.rows.filter((r) => {
          if (hideDone === "1" && (coverage(r) ?? 0) >= 1) return false;
          if (!needle) return true;
          return [r.mo, r.bom, r.soi, r.description, r.kva].some((v) => v?.toLowerCase().includes(needle));
        }),
      }))
      .filter((d) => d.rows.length > 0);
  }, [data, q, hideDone]);

  const shownRows = days.reduce((s, d) => s + d.rows.length, 0);
  const totalRows = data.days.reduce((s, d) => s + d.rows.length, 0);
  const hasActive = !!q || !!stage || hideDone === "1";
  const cols = 3 + items.length * (1 + stages.length);

  const exportRows = useMemo(
    () =>
      days.flatMap((d) =>
        d.rows.map((r) => ({
          Day: d.label, MO: r.mo, BOM: r.bom, SOI: r.soi ?? "", Required: r.req,
          ...Object.fromEntries(
            items.flatMap((it) => [
              [`${it} Req`, r.items[it].req],
              ...stages.map((s) => [`${it} ${STAGE_OPTS.find((o) => o.value === s)!.short}`, stageValue(s, it, r.items[it])] as const),
            ])
          ),
        }))
      ),
    [days, items, stages]
  );

  return (
    <div className="space-y-3">
      <FilterBar
        count={shownRows}
        total={totalRows}
        hasActive={hasActive}
        onReset={() => { setQ(""); setStage(""); setHideDone(""); }}
      >
        <PlanViewToggle value="weekly" />
        <WeekPlanPicker plans={data.planNos} value={data.planNo} />
        <SearchBox value={q} onChange={setQ} placeholder="Search MO / BOM / SOI / KVA…" />
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
          <span className="text-muted text-[11px] font-bold uppercase tracking-wide">Hide covered</span>
        </label>
        <div className="col-span-2 flex items-center sm:col-span-1">
          <ExportButton rows={exportRows} filename={`weekly-plan-${data.planNo ?? "none"}.csv`} />
        </div>
      </FilterBar>

      <p className="text-[11px] text-muted">
        Every figure is <b>cumulative and uncapped</b> — all the pieces ever logged for that order, whatever week they were made in. So a
        cell can read higher than the day&apos;s <b>Req</b>: the work was already done. <b>Req</b> is what this plan promises for that day.
        Switch to the <b>Monthly</b> view for whole-order progress capped at the order quantity.
      </p>

      {data.planNo === null ? (
        <div className="bg-surface border rounded-xl p-8 text-center text-muted">
          No weekly plans have been imported yet. Import one from the <Link href="/import" className="text-brand font-bold underline">Import</Link> page.
        </div>
      ) : (
        <div className="bg-surface border rounded-xl overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="bg-brand text-white text-center">
                <th className="p-2 text-left">MO / Project</th>
                <th className="p-2" title="pcs this day's promise asks for">Req</th>
                <th className="p-2" title="how much of the day's promise its final stage has covered">Covered</th>
                {items.map((it) => (
                  <th key={it} colSpan={1 + stages.length} className="p-2 border-l border-border-strong">{it}</th>
                ))}
              </tr>
              <tr className="bg-brand-dark text-white text-[10px]">
                <th className="p-1" />
                <th className="p-1" />
                <th className="p-1" />
                {items.map((it) => (
                  <Fragment key={it}>
                    <th className="p-1 font-medium border-l border-border-strong">Req</th>
                    {stages.map((s) => (
                      <th key={s} className="p-1 font-medium">
                        {/* the core's finishing column reads as SHB — it is never painted */}
                        {s === "Painting" && isPaintExempt(it) ? "SHB" : STAGE_OPTS.find((o) => o.value === s)!.short}
                      </th>
                    ))}
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.length === 0 && (
                <tr><td colSpan={cols} className="p-6 text-center text-muted">Nothing matches these filters.</td></tr>
              )}
              {days.map((d) => {
                const isOpen = !collapsed.has(d.iso);
                return (
                  <Fragment key={d.iso}>
                    <tr
                      className={`cursor-pointer transition-colors ${d.isToday ? "bg-brand text-white" : d.isPast ? "bg-zebra" : "bg-brand-light/40"}`}
                      onClick={() => setCollapsed((s) => { const n = new Set(s); if (n.has(d.iso)) n.delete(d.iso); else n.add(d.iso); return n; })}
                    >
                      <td colSpan={cols} className="p-2 font-bold">
                        <span className={`inline-block mr-1 text-[10px] transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`}>▶</span>
                        {d.label}
                        {d.isToday && <span className="pill bg-white/20 text-white ml-2">today</span>}
                        <span className={`ml-2 text-xs font-medium ${d.isToday ? "opacity-90" : "text-muted"}`}>
                          {d.rows.length} order{d.rows.length === 1 ? "" : "s"} · {d.req} pcs due
                        </span>
                      </td>
                    </tr>
                    {isOpen && d.rows.map((r) => {
                      const cov = coverage(r);
                      return (
                        <tr key={`${d.iso}|${r.mo}`} className="text-center border-t hover:bg-brand-light/20 transition-colors">
                          <td className="p-2 text-left whitespace-nowrap">
                            {r.urgent && <span className="text-danger mr-1" title="Urgent">★</span>}
                            <Link href={`/trace?q=${encodeURIComponent(r.mo)}`} className="font-bold hover:underline">{r.mo}</Link>
                            <span className="block text-[11px] text-muted">
                              {r.bom}
                              {r.soi && ` · ${r.soi}`}
                              {!r.known && <span className="pill pill-warn ml-1" title="This MO is not in the order registry">unknown MO</span>}
                            </span>
                          </td>
                          <td className="p-2 tabnum font-bold">{r.req}</td>
                          <td className="p-2 tabnum font-bold" style={cov === null ? undefined : pctStyle(cov)}>
                            {cov === null ? <span className="text-muted opacity-40">—</span> : `${Math.round(cov * 100)}%`}
                          </td>
                          {items.map((it) => {
                            const c = r.items[it];
                            const off = !c.eligible || c.excluded; // N/A for this order
                            return (
                              <Fragment key={it}>
                                <td className="p-1 tabnum text-xs font-bold border-l">
                                  {off ? <span className="text-muted opacity-40" title={c.excluded ? "Marked N/A" : "Not required for this order"}>N/A</span> : c.req || <span className="text-muted opacity-40">—</span>}
                                </td>
                                {stages.map((s) => (
                                  <td key={s} className="p-1 tabnum text-xs" style={{ background: off ? undefined : TINT[s] }}>
                                    {off ? "" : stageValue(s, it, c) || <span className="text-muted opacity-40">—</span>}
                                  </td>
                                ))}
                              </Fragment>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
