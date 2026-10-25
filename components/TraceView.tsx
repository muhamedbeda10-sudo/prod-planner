"use client";

import { formatDate, formatDateTime } from "@/lib/domain/format";
import { Fragment, useState, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Package, CheckCircle2, Truck, Hourglass, Gauge, AlertTriangle, RotateCw,
  ChevronRight, PanelRightClose, PanelRightOpen, LayoutGrid, Rows3,
  StickyNote, Undo2,
} from "lucide-react";
import type { TraceResult, TracePipelineRow, TraceOdooRow } from "@/lib/server/trace";
import { trackerHref, traceHref } from "@/lib/domain/links";
import { deptLabel, FINISHING_LABEL } from "@/lib/domain/constants";
import { TraceSearch } from "@/components/TraceSearch";
import { ExportButton } from "@/components/ExportButton";
import { LaserCutterIcon, WeldingIcon, PowderCoatIcon } from "@/components/icons";
import { Soi } from "@/components/ui";

/* ============================================================================
   Trace — premium ERP record view.
   Layout: sticky header band → KPI row → stage pipeline → component progress
   (grid/table) → activity feed | collapsible properties sidebar → raw records.
   Neutral surfaces, colour only for status; all figures come straight from
   lib/server/trace (master-tracker netted numbers — nothing is re-derived).
   ========================================================================== */

const pctOf = (v: number, req: number) => (req > 0 ? Math.round((v / req) * 100) : 0);

export function TraceView({ t, planNo, view = "" }: { t: TraceResult; planNo: number; view?: string }) {
  const router = useRouter();
  const [sidebar, setSidebar] = useState(true);

  // every link out of here keeps the origin, so hopping BOM → sibling → MO and
  // then back still lands on the tracker table the reader started from
  const trace = (target: { mo?: string | null; bom?: string | null }) => traceHref(target, planNo, view);

  const remaining = Math.max(0, t.requiredSets - t.completeSets);
  const completion = t.requiredSets > 0 ? pctOf(t.completeSets, t.requiredSets) : null;
  const openIssues = t.openReturns + t.openNotes;
  const openOrders = t.members.filter((m) => m.status === "open").length;
  const monthsAll = [...new Set(t.members.flatMap((m) => m.months))];
  const active = t.pipeline.filter((p) => p.active);

  // stage totals — capped per component at its required so a stage can never
  // read over 100% (OSP-covered pieces are outside "required")
  const sum = (f: (p: TracePipelineRow) => number) => active.reduce((s, p) => s + Math.min(f(p), p.required), 0);
  const totalReq = active.reduce((s, p) => s + p.required, 0);
  const stages = [
    { key: "Cut", name: "Fabrication", icon: <LaserCutterIcon size={17} />, done: sum((p) => p.cut) },
    { key: "Welding", name: "Welding", icon: <WeldingIcon size={17} />, done: sum((p) => p.weld) },
    { key: "Painting", name: FINISHING_LABEL, icon: <PowderCoatIcon size={17} />, done: sum((p) => p.finished) },
    { key: "Delivered", name: "Delivery", icon: <Truck size={17} />, done: sum((p) => p.delivered) },
  ].map((s) => ({ ...s, pct: pctOf(s.done, totalReq), left: Math.max(0, totalReq - s.done) }));

  const exportLedger = t.ledger.map((l) => ({
    Date: l.dateISO, Plan: l.planLabel, Dept: deptLabel(l.dept), Item: l.item, Qty: l.qty,
    Source: l.source, By: l.by ?? "", "Corrected from": l.corrected ?? "",
  }));

  return (
    <div className="space-y-6">
      {/* ================= sticky header ================= */}
      <div className="md:sticky md:top-16 z-20 -mx-4 px-4 py-3 bg-background/85 backdrop-blur border-b border-border/60">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">
              Trace · {t.scope === "mo" ? "Manufacturing order" : "Code"}
            </div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl md:text-2xl font-extrabold leading-tight tracking-tight">{t.key}</h1>
              {t.members.length > 0 && (openOrders > 0
                ? <Chip tone="ok">Open</Chip>
                : <Chip tone="muted">Closed</Chip>)}
              {t.anyUrgent && <Chip tone="bad">Urgent</Chip>}
              {t.members.some((m) => m.priority) && <Chip tone="warn">⭐ Priority</Chip>}
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <TraceSearch initialMode={t.scope} />
            <button type="button" onClick={() => router.refresh()} className="btn btn-ghost btn-sm" title="Refresh the data">
              <RotateCw size={14} />
            </button>
            <ExportButton rows={exportLedger} filename={`trace-${t.key}.xlsx`} sheetName="Trace" />
            <Link href={trackerHref(planNo, view)} className="btn btn-ghost btn-sm whitespace-nowrap">← Tracker</Link>
            <button
              type="button"
              onClick={() => setSidebar((s) => !s)}
              className="btn btn-ghost btn-sm hidden lg:inline-flex"
              title={sidebar ? "Hide the details panel" : "Show the details panel"}
            >
              {sidebar ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
            </button>
          </div>
        </div>
      </div>

      {/* ================= KPI row ================= */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Kpi icon={<Package size={16} />} label="Order quantity" value={t.requiredSets}
          sub={t.scope === "bom" ? `${t.members.length} order${t.members.length === 1 ? "" : "s"}` : "transformers"} />
        <Kpi icon={<CheckCircle2 size={16} />} label="Finished" value={t.completeSets} pct={completion} tone={completion !== null && completion >= 100 ? "ok" : undefined} />
        <Kpi icon={<Truck size={16} />} label="Delivered" value={t.deliveredSets}
          pct={t.requiredSets > 0 ? pctOf(t.deliveredSets, t.requiredSets) : null}
          tone={t.requiredSets > 0 && t.deliveredSets >= t.requiredSets ? "ok" : undefined} />
        <Kpi icon={<Hourglass size={16} />} label="Remaining" value={remaining} tone={remaining > 0 ? "warn" : "ok"} />
        <Kpi icon={<Gauge size={16} />} label="Completion" value={completion ?? 0} suffix="%" bar={completion ?? 0} />
        <Kpi icon={<AlertTriangle size={16} />} label="Open issues" value={openIssues}
          sub={openIssues > 0 ? `${t.openReturns} returns · ${t.openNotes} notes` : "all clear"}
          tone={openIssues > 0 ? "bad" : "ok"} />
      </div>

      {/* ================= body: main | sidebar ================= */}
      <div className={`grid gap-6 items-start ${sidebar ? "lg:grid-cols-[minmax(0,1fr)_320px]" : ""}`}>
        <div className="min-w-0 space-y-6">
          <StagePipeline stages={stages} totalReq={totalReq} pipeline={t.pipeline} />
          <ComponentProgress pipeline={t.pipeline} />
          <OnOdoo rows={t.odoo} />
          <Records t={t} />
        </div>

        {sidebar && (
          <aside className="space-y-4 lg:sticky lg:top-36">
            <SideCard title="Order details">
              <dl className="divide-y divide-border/60">
                {t.scope === "mo" ? (
                  <Prop k="BOM">
                    <Link href={trace({ bom: t.bom })} className="text-brand-ink font-bold hover:underline">{t.bom}</Link>
                  </Prop>
                ) : (
                  <Prop k="Orders">{t.members.length || "—"}{t.members.length > 0 && openOrders < t.members.length ? ` · ${openOrders} open` : ""}</Prop>
                )}
                {t.kva && <Prop k="KVA">{t.kva}</Prop>}
                {t.rating && <Prop k="Rating">{t.rating}</Prop>}
                {monthsAll.length > 0 && <Prop k="Plan months">{monthsAll.join(" · ")}</Prop>}
                <Prop k="Planned in">
                  {t.orderPlans.length === 0 ? "—" : (
                    <span className="flex flex-wrap justify-end gap-1">
                      {t.orderPlans.map((p) => <span key={p} className="pill pill-muted text-[10px]">{p}</span>)}
                    </span>
                  )}
                </Prop>
                <Prop k="Ledger records">{t.ledgerCount}</Prop>
                {t.odoo.length > 0 && (
                  <Prop k="On ODOO">
                    {t.odoo.filter((r) => r.done).reduce((n, r) => n + r.qty, 0)} / {t.odoo.reduce((n, r) => n + r.qty, 0)} closed
                  </Prop>
                )}
                {t.siblings.length > 0 && (
                  <Prop k="Family">
                    <span className="flex flex-wrap justify-end gap-x-2">
                      {t.siblings.map((s) => (
                        <Link key={s} href={trace({ bom: s })} className="text-brand-ink font-semibold hover:underline">{s}</Link>
                      ))}
                    </span>
                  </Prop>
                )}
              </dl>
            </SideCard>

            {t.scope === "bom" && t.members.length > 0 && (
              <SideCard title="Linked orders">
                <ul className="divide-y divide-border/60">
                  {t.members.map((m) => {
                    const p = m.planQty > 0 ? pctOf(m.complete, m.planQty) : 0;
                    return (
                      <li key={m.mo} className="px-4 py-2.5 hover:bg-brand-light/20 transition-colors">
                        <div className="flex items-center justify-between gap-2">
                          <Link href={trace({ mo: m.mo })} className="font-bold text-brand-ink hover:underline text-xs">{m.mo}</Link>
                          <span className="flex items-center gap-1.5">
                            {m.urgent && <Chip tone="bad">U</Chip>}
                            {m.priority && <span title="Priority">⭐</span>}
                            {m.status === "closed"
                              ? <Chip tone="muted">closed</Chip>
                              : <span className="text-xs tabnum text-muted">{m.complete}/{m.planQty}</span>}
                          </span>
                        </div>
                        {m.soi && <div className="mt-0.5 text-[11px] text-muted ltr">SOI {m.soi}</div>}
                        {m.status !== "closed" && <MiniBar pct={p} className="mt-1.5" />}
                        {m.remarks && <div className="mt-1 text-[11px] text-muted line-clamp-2">📝 {m.remarks}</div>}
                      </li>
                    );
                  })}
                </ul>
              </SideCard>
            )}

            {(openIssues > 0 || t.timeline.some((e) => e.kind === "note" || e.kind === "return")) && (
              <SideCard title="Issues & notes">
                <div className="px-4 py-3 space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 text-muted"><Undo2 size={13} /> Open returns</span>
                    <b className={`tabnum ${t.openReturns > 0 ? "text-bad-fg" : ""}`}>{t.openReturns}</b>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 text-muted"><StickyNote size={13} /> Open notes</span>
                    <b className={`tabnum ${t.openNotes > 0 ? "text-warn-fg" : ""}`}>{t.openNotes}</b>
                  </div>
                  {t.timeline.filter((e) => e.kind === "note").slice(0, 2).map((n, i) => (
                    <div key={i} className="rounded-lg bg-brand-light/25 px-2.5 py-1.5 text-[11px] leading-snug">
                      <span className="font-bold">{n.item}</span> · {n.text ? (n.text.length > 90 ? n.text.slice(0, 90) + "…" : n.text) : "photo note"}
                    </div>
                  ))}
                </div>
              </SideCard>
            )}

            {t.scope === "mo" && t.members[0]?.remarks && (
              <SideCard title="Remarks">
                <p className="px-4 py-3 text-sm whitespace-pre-wrap leading-relaxed">{t.members[0].remarks}</p>
              </SideCard>
            )}

            {t.contributors.length > 0 && (
              <SideCard title="Recorded by">
                <ul className="divide-y divide-border/60">
                  {t.contributors.map((c) => (
                    <li key={c.name} className="px-4 py-2 flex items-center gap-2.5">
                      <Avatar name={c.name} />
                      <span className="text-sm flex-1 truncate">{c.name}</span>
                      <span className="tabnum text-sm font-bold">{c.qty}<span className="text-muted font-normal text-xs ml-0.5">pcs</span></span>
                    </li>
                  ))}
                </ul>
              </SideCard>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

/* ============================ stage pipeline ============================ */

function StagePipeline({ stages, totalReq, pipeline }: {
  stages: { key: string; name: string; icon: React.ReactNode; done: number; pct: number; left: number }[];
  totalReq: number;
  pipeline: TracePipelineRow[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  const active = pipeline.filter((p) => p.active);
  const valOf = (p: TracePipelineRow, key: string) =>
    key === "Cut" ? p.cut : key === "Welding" ? p.weld : key === "Painting" ? p.finished : p.delivered;

  return (
    <Card title="Production pipeline">
      <div className="p-4">
        <div className="flex flex-col md:flex-row md:items-stretch gap-2">
          {stages.map((s, i) => {
            const status = totalReq === 0 ? "muted" : s.pct >= 100 ? "ok" : s.done > 0 ? "brand" : "muted";
            const isOpen = open === s.key;
            return (
              <Fragment key={s.key}>
                {i > 0 && (
                  <div className="self-center text-muted/60 rotate-90 md:rotate-0 shrink-0">
                    <ChevronRight size={16} />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : s.key)}
                  className={`flex-1 min-w-0 text-left rounded-2xl border p-3.5 transition-all hover:shadow-md hover:-translate-y-px ${isOpen ? "border-brand ring-1 ring-brand/40 shadow-md" : "border-border/60 shadow-sm"} bg-surface`}
                  title="Click for the per-component breakdown"
                >
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">
                      {s.icon}<span className="truncate">{s.name}</span>
                    </span>
                    {status === "ok" ? <Chip tone="ok">Done</Chip>
                      : status === "brand" ? <Chip tone="brand">In progress</Chip>
                      : <Chip tone="muted">Not started</Chip>}
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-2xl font-extrabold tabnum leading-none">{s.done}</span>
                    <span className="text-xs text-muted tabnum">/ {totalReq}</span>
                    <span className="ml-auto text-xs font-bold tabnum">{s.pct}%</span>
                  </div>
                  <MiniBar pct={s.pct} className="mt-2" />
                  <div className="mt-1.5 text-[11px] text-muted tabnum">{s.left > 0 ? `${s.left} remaining` : "stage clear"}</div>
                </button>
              </Fragment>
            );
          })}
        </div>

        {open && (
          <div className="mt-3 rounded-xl bg-brand-light/25 p-3">
            <div className="text-[11px] font-bold uppercase tracking-wide text-muted mb-2">
              {stages.find((s) => s.key === open)?.name} — per component
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              {active.map((p) => {
                const v = valOf(p, open);
                const pc = pctOf(Math.min(v, p.required), p.required);
                return (
                  <div key={p.item} className="rounded-lg bg-surface border border-border/60 px-2.5 py-2">
                    <div className="flex items-baseline justify-between text-xs">
                      <b>{p.item}</b>
                      <span className="tabnum text-muted">{pc}%</span>
                    </div>
                    <div className="tabnum font-extrabold">{v}<span className="text-[10px] text-muted font-normal">/{p.required}</span></div>
                    <MiniBar pct={pc} className="mt-1" />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

/* ========================== component progress ========================== */

function componentStatus(p: TracePipelineRow): { label: string; tone: "ok" | "brand" | "warn" | "muted" } {
  if (!p.active) return { label: "N/A", tone: "muted" };
  if (p.required > 0 && p.delivered >= p.required) return { label: "Delivered", tone: "ok" };
  if (p.required > 0 && p.finished >= p.required) return { label: "Awaiting delivery", tone: "brand" };
  if (p.finished > 0 || p.weld > 0) return { label: p.weld >= p.required ? `In ${p.finishLabel === "SHB" ? "Shot Blast" : "Painting"}` : "In Welding", tone: "brand" };
  if (p.cut > 0) return { label: p.cut >= p.required ? "In Welding" : "In Fabrication", tone: "brand" };
  return { label: "Not started", tone: "muted" };
}

function ComponentProgress({ pipeline }: { pipeline: TracePipelineRow[] }) {
  const [view, setView] = useState<"grid" | "table">("grid");
  return (
    <Card
      title="Component progress"
      actions={
        <div className="inline-flex rounded-lg border border-border/60 overflow-hidden">
          {(["grid", "table"] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)}
              className={`px-2 py-1 transition-colors ${view === v ? "bg-brand-fill text-white" : "bg-surface text-muted hover:text-foreground"}`}
              title={v === "grid" ? "Card view" : "Table view"}>
              {v === "grid" ? <LayoutGrid size={14} /> : <Rows3 size={14} />}
            </button>
          ))}
        </div>
      }
    >
      {view === "grid" ? (
        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {pipeline.map((p) => {
            const st = componentStatus(p);
            const fin = pctOf(Math.min(p.finished, p.required), p.required);
            return (
              <div key={p.item} className={`rounded-2xl border border-border/60 bg-surface shadow-sm p-4 transition-all hover:shadow-md ${!p.active ? "opacity-50" : ""}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-extrabold text-lg leading-none">{p.item}</div>
                    <div className="mt-1"><Chip tone={st.tone}>{st.label}</Chip></div>
                  </div>
                  {p.active && <Ring pct={fin} />}
                </div>
                {p.active && (
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <MiniStat label="Required" value={p.required} />
                    <MiniStat label="Finished" value={p.finished} />
                    <MiniStat label="Remaining" value={Math.max(0, p.required - p.finished)} warn={p.required - p.finished > 0} />
                  </div>
                )}
                {p.active && p.osp > 0 && (
                  <div className="mt-2 text-[11px] text-muted">OSP {p.osp} pcs — outsourced, counts as covered</div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted border-b border-border/60">
                <th className="px-4 py-2.5 font-bold">Component</th>
                <th className="px-3 py-2.5 font-bold text-center">Required</th>
                <th className="px-3 py-2.5 font-bold text-center">Fab</th>
                <th className="px-3 py-2.5 font-bold text-center">Weld</th>
                <th className="px-3 py-2.5 font-bold text-center">Paint / SHB</th>
                <th className="px-3 py-2.5 font-bold text-center">Dlvd</th>
                <th className="px-3 py-2.5 font-bold w-44">Finish</th>
                <th className="px-3 py-2.5 font-bold text-right pr-4">Status</th>
              </tr>
            </thead>
            <tbody>
              {pipeline.map((p) => {
                const st = componentStatus(p);
                const fin = pctOf(Math.min(p.finished, p.required), p.required);
                return (
                  <tr key={p.item} className={`border-b border-border/40 last:border-0 hover:bg-brand-light/20 transition-colors ${!p.active ? "opacity-45" : ""}`}>
                    <td className="px-4 py-2.5 font-extrabold">
                      {p.item}
                      {p.osp > 0 && <span className="ml-1.5 text-[10px] font-semibold text-muted" title="outsourced — counts as covered">OSP {p.osp}</span>}
                    </td>
                    {p.active ? (
                      <>
                        <td className="px-3 py-2.5 text-center font-bold tabnum">{p.required}</td>
                        <td className="px-3 py-2.5 text-center tabnum">{p.cut}</td>
                        <td className="px-3 py-2.5 text-center tabnum">{p.weld}</td>
                        <td className="px-3 py-2.5 text-center tabnum">{p.finished}<span className="block text-[9px] text-muted leading-none">{p.finishLabel}</span></td>
                        <td className="px-3 py-2.5 text-center tabnum">{p.delivered}</td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <MiniBar pct={fin} className="flex-1" />
                            <span className="text-xs font-bold tabnum w-9 text-right">{fin}%</span>
                          </div>
                        </td>
                      </>
                    ) : (
                      <td colSpan={6} className="px-3 py-2.5 text-center text-muted text-xs">— not required for this project —</td>
                    )}
                    <td className="px-3 py-2.5 text-right pr-4"><Chip tone={st.tone}>{st.label}</Chip></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ============================== records (tabbed) ============================== */

function Records({ t }: { t: TraceResult }) {
  // the plan rows name an MO; its SOI already sits on the linked order card
  const soiOfMo = (mo: string) => t.members.find((m) => m.mo === mo)?.soi ?? null;
  const [tab, setTab] = useState<"ledger" | "orders">("ledger");
  // newest first — what happened last is what the page is opened for
  const ledger = useMemo(() => [...t.ledger].reverse(), [t.ledger]);
  // a code's page spans several orders: each record says which
  const byOrder = t.scope === "bom";
  const exportLedger = t.ledger.map((l) => ({
    Date: l.dateISO, MO: l.mo ?? "", Plan: l.planLabel, Dept: deptLabel(l.dept), Item: l.item, Qty: l.qty,
    Source: l.source, By: l.by ?? "", "Corrected from": l.corrected ?? "",
  }));
  const TABS = [
    { key: "ledger", label: "Full ledger", count: t.ledgerCount },
    { key: "orders", label: "Plan orders", count: t.orders.length },
  ] as const;

  return (
    <Card
      title="Records"
      actions={
        <div className="flex items-center gap-2">
          {tab === "ledger" && <ExportButton rows={exportLedger} filename={`trace-${t.key}.xlsx`} sheetName="Trace" />}
          <div className="inline-flex rounded-lg border border-border/60 overflow-hidden text-xs font-bold">
            {TABS.map((tb) => (
              <button key={tb.key} type="button" onClick={() => setTab(tb.key)}
                className={`px-3 py-1.5 transition-colors ${tab === tb.key ? "bg-brand-fill text-white" : "bg-surface text-muted hover:text-foreground"}`}>
                {tb.label}<span className="ml-1.5 tabnum opacity-70">{tb.count}</span>
              </button>
            ))}
          </div>
        </div>
      }
    >
      {tab === "ledger" ? (
        <div className="overflow-x-auto max-h-[34rem] overflow-y-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted bg-surface/95 backdrop-blur border-b border-border/60">
                <th className="px-4 py-2 font-bold">Date</th>
                {byOrder && <th className="px-3 py-2 font-bold">MO</th>}
                <th className="px-3 py-2 font-bold">Stage</th><th className="px-3 py-2 font-bold text-center">Item</th>
                <th className="px-3 py-2 font-bold text-center">Qty</th><th className="px-3 py-2 font-bold">Source</th>
                <th className="px-3 py-2 font-bold pr-4">By</th>
              </tr>
            </thead>
            <tbody>
              {ledger.length === 0 && (
                <tr><td colSpan={byOrder ? 7 : 6} className="p-8 text-center text-muted">No records yet.</td></tr>
              )}
              {ledger.map((l, i) => (
                <tr key={l.id} className={`border-b border-border/30 last:border-0 hover:bg-brand-light/25 transition-colors ${i % 2 ? "bg-brand-light/[0.06]" : ""}`}>
                  <td className="px-4 py-1.5 whitespace-nowrap tabnum text-muted">{formatDate(l.dateISO)}</td>
                  {byOrder && (
                    <td className="px-3 py-1.5 text-xs whitespace-nowrap ltr">
                      {l.mo ? <Link href={`/trace?mo=${encodeURIComponent(l.mo)}`} className="text-brand-ink hover:underline">{l.mo}</Link> : <span className="text-muted">—</span>}
                    </td>
                  )}
                  <td className="px-3 py-1.5">{deptLabel(l.dept)}</td>
                  <td className="px-3 py-1.5 text-center font-bold">{l.item}</td>
                  <td className="px-3 py-1.5 text-center">
                    <span className={`inline-block min-w-9 rounded-md px-1.5 py-0.5 font-bold tabnum text-xs ${l.qty < 0 ? "bg-bad-bg text-bad-fg" : "bg-brand-light text-brand-ink"}`}>
                      {l.qty > 0 ? `+${l.qty}` : l.qty}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-xs text-muted">
                    {l.source}
                    {l.corrected && <Chip tone="ok" className="ml-1">fixed</Chip>}
                  </td>
                  <td className="px-3 py-1.5 pr-4 text-xs whitespace-nowrap">
                    {l.by ? <span className="inline-flex items-center gap-1.5"><Avatar name={l.by} />{l.by}</span> : <span className="text-muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-x-auto max-h-[34rem] overflow-y-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted bg-surface/95 backdrop-blur border-b border-border/60">
                <th className="px-4 py-2.5 font-bold">Plan</th><th className="px-3 py-2.5 font-bold">MO</th>
                <th className="px-3 py-2.5 font-bold" title="Sales order item">SOI</th>
                <th className="px-3 py-2.5 font-bold">Description</th><th className="px-3 py-2.5 font-bold text-center">Item</th>
                <th className="px-3 py-2.5 font-bold text-center">Required</th><th className="px-3 py-2.5 font-bold text-center">Planner balance</th>
                <th className="px-3 py-2.5 font-bold text-center">Target</th><th className="px-3 py-2.5 font-bold pr-4">Remark</th>
              </tr>
            </thead>
            <tbody>
              {t.orders.length === 0 && (
                <tr><td colSpan={9} className="p-10 text-center text-muted">
                  <div className="text-2xl mb-1">📄</div>Not in any imported plan.
                </td></tr>
              )}
              {t.orders.map((o, i) => (
                <tr key={o.id} className={`border-b border-border/30 last:border-0 hover:bg-brand-light/25 transition-colors ${i % 2 ? "bg-brand-light/[0.06]" : ""}`}>
                  <td className="px-4 py-2 font-bold text-xs whitespace-nowrap">{o.planLabel}</td>
                  <td className="px-3 py-2 text-xs">{o.mo}</td>
                  <td className="px-3 py-2"><Soi soi={soiOfMo(o.mo)} /></td>
                  <td className="px-3 py-2 text-xs text-muted max-w-56 truncate" title={o.description ?? ""}>{o.description}</td>
                  <td className="px-3 py-2 text-center font-bold">{o.item}</td>
                  <td className="px-3 py-2 text-center tabnum font-bold">{o.requiredQty}</td>
                  <td className="px-3 py-2 text-center tabnum text-muted">{o.plannerBalance ?? "—"}</td>
                  <td className="px-3 py-2 text-center tabnum text-muted">{o.targetQty}</td>
                  <td className="px-3 py-2 pr-4 text-xs text-muted">{o.remark || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ============================ building blocks ============================ */

function Card({ title, sub, actions, children }: { title: string; sub?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-surface border border-border/60 shadow-sm overflow-hidden">
      <div className="px-4 pt-3.5 pb-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40">
        <div className="min-w-0">
          <h2 className="text-sm font-extrabold tracking-tight">{title}</h2>
          {sub && <p className="text-[11px] text-muted mt-0.5">{sub}</p>}
        </div>
        {actions && <div className="ml-auto">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** What of this order reached the ODOO tab: every row born from its
 *  painting / shot-blast closings, with Odoo's MO the clerk typed (the child
 *  MO), and whether it is closed. */
function OnOdoo({ rows }: { rows: TraceOdooRow[] }) {
  const total = rows.reduce((n, r) => n + r.qty, 0);
  const closed = rows.filter((r) => r.done).reduce((n, r) => n + r.qty, 0);
  const needMo = rows.filter((r) => !r.odooMo.trim() && !r.done).length;
  // per component: closed of booked
  const byItem = new Map<string, { qty: number; closed: number }>();
  for (const r of rows) {
    const k = r.item || r.product;
    const v = byItem.get(k) ?? { qty: 0, closed: 0 };
    v.qty += r.qty;
    if (r.done) v.closed += r.qty;
    byItem.set(k, v);
  }
  return (
    <section id="on-odoo" className="rounded-2xl bg-surface border border-border/60 shadow-sm overflow-hidden scroll-mt-28">
      <div className="px-5 py-3 border-b border-border/40 flex flex-wrap items-center gap-x-3 gap-y-1">
        <div>
          <h2 className="text-sm font-extrabold uppercase tracking-wide">On ODOO</h2>
        </div>
        {rows.length > 0 && (
          <div className="ms-auto flex flex-wrap items-center gap-1.5">
            {[...byItem.entries()].map(([k, v]) => (
              <Chip key={k} tone={v.closed >= v.qty ? "ok" : "muted"}>{k} {v.closed}/{v.qty}</Chip>
            ))}
            <Chip tone={closed >= total ? "ok" : "warn"}>closed {closed}/{total}</Chip>
            {needMo > 0 && <Chip tone="bad">{needMo} need an MO</Chip>}
          </div>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted text-center">Not on the ODOO tab yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted border-b border-border/40">
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">Item</th>
                <th className="px-4 py-2">Odoo MO</th>
                <th className="px-4 py-2">FG-CODE</th>
                <th className="px-4 py-2 text-end">Qty</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Closed on</th>
                <th className="px-4 py-2">By</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border/40 hover:bg-brand-light/20">
                  <td className="px-4 py-2 tabnum ltr whitespace-nowrap">{formatDate(r.dateISO)}</td>
                  <td className="px-4 py-2 whitespace-nowrap"><b>{r.item || "—"}</b> <span className="text-muted text-xs">{r.product}</span></td>
                  <td className="px-4 py-2 ltr font-bold whitespace-nowrap select-all">{r.odooMo || <Chip tone="warn">needs MO</Chip>}</td>
                  <td className="px-4 py-2 ltr text-xs text-muted whitespace-nowrap">{r.fgCode || "—"}</td>
                  <td className="px-4 py-2 text-end tabnum font-bold">{r.qty}</td>
                  <td className="px-4 py-2"><Chip tone={r.done ? "ok" : r.status === "Blocked" ? "bad" : r.status === "Cancelled" ? "muted" : "warn"}>{r.status}</Chip></td>
                  <td className="px-4 py-2 tabnum ltr whitespace-nowrap">{formatDateTime(r.doneAtISO)}</td>
                  <td className="px-4 py-2 text-xs text-muted whitespace-nowrap">{r.by ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SideCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-surface border border-border/60 shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border/40">
        <h3 className="text-[11px] font-extrabold uppercase tracking-wide text-muted">{title}</h3>
      </div>
      {children}
    </section>
  );
}

function Kpi({ icon, label, value, suffix, sub, pct, bar, tone }: {
  icon: React.ReactNode; label: string; value: number; suffix?: string; sub?: string;
  pct?: number | null; bar?: number; tone?: "ok" | "warn" | "bad";
}) {
  const color = tone === "ok" ? "var(--ok-fg)" : tone === "warn" ? "var(--warn-fg)" : tone === "bad" ? "var(--bad-fg)" : undefined;
  return (
    <div className="rounded-2xl bg-surface border border-border/60 shadow-sm px-4 py-3.5 transition-all hover:shadow-md">
      <div className="flex items-center gap-1.5 text-muted">
        <span className="grid place-items-center w-6 h-6 rounded-lg bg-brand-light/60 text-brand-ink">{icon}</span>
        <span className="text-[10px] font-bold uppercase tracking-wide">{label}</span>
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="text-[26px] font-extrabold tabnum leading-none tracking-tight" style={{ color }}>{value}{suffix}</span>
        {pct !== undefined && pct !== null && <span className="text-[11px] font-bold tabnum text-muted">{pct}%</span>}
      </div>
      {bar !== undefined && <MiniBar pct={bar} className="mt-2" />}
      {sub && <div className="mt-1.5 text-[11px] text-muted truncate">{sub}</div>}
    </div>
  );
}

function Chip({ tone, className = "", children }: { tone: "ok" | "bad" | "warn" | "muted" | "brand"; className?: string; children: React.ReactNode }) {
  if (tone === "brand") {
    return <span className={`pill bg-brand-light text-brand-ink ${className}`}>{children}</span>;
  }
  return <span className={`pill pill-${tone} ${className}`}>{children}</span>;
}

function MiniBar({ pct, className = "" }: { pct: number; className?: string }) {
  return (
    <div className={`h-1.5 rounded-full bg-border/70 overflow-hidden ${className}`}>
      <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, pct)}%`, background: pct >= 100 ? "var(--ok-fg)" : "var(--brand)" }} />
    </div>
  );
}

function MiniStat({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-xl bg-brand-light/25 px-2 py-1.5">
      <div className="text-[10px] font-bold uppercase tracking-wide text-muted">{label}</div>
      <div className="text-base font-extrabold tabnum" style={{ color: warn ? "var(--warn-fg)" : undefined }}>{value}</div>
    </div>
  );
}

function Ring({ pct, size = 56 }: { pct: number; size?: number }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={5.5} fill="none" stroke="var(--border)" />
        <circle
          cx={size / 2} cy={size / 2} r={r} strokeWidth={5.5} fill="none" strokeLinecap="round"
          stroke={pct >= 100 ? "var(--ok-fg)" : "var(--brand)"}
          strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(100, pct) / 100)}
          className="transition-all"
        />
      </svg>
      <span className="absolute inset-0 grid place-items-center text-[11px] font-extrabold tabnum">{pct}%</span>
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  const initials = name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  return (
    <span className="grid place-items-center w-7 h-7 rounded-full bg-brand-fill text-white text-[10px] font-extrabold shrink-0" title={name}>
      {initials || "?"}
    </span>
  );
}


function Prop({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-2 flex items-start justify-between gap-3 text-sm">
      <dt className="text-[11px] font-bold uppercase tracking-wide text-muted pt-0.5 shrink-0">{k}</dt>
      <dd className="text-right min-w-0">{children}</dd>
    </div>
  );
}
