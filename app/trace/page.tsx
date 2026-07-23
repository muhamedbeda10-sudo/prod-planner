import Link from "next/link";
import { getTrace } from "@/lib/server/trace";
import { PageHeader } from "@/components/ui";
import { TraceSearch } from "@/components/TraceSearch";
import { TraceTimeline } from "@/components/TraceTimeline";
import { ExportButton } from "@/components/ExportButton";
import { STAGE_COLOR, deptLabel } from "@/lib/domain/constants";

export const dynamic = "force-dynamic";

export default async function TracePage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; bom?: string; mo?: string }>;
}) {
  const sp = await searchParams;
  const planNo = Number(sp.plan) || 0;
  const mo = (sp.mo ?? "").trim();
  const bom = (sp.bom ?? "").trim();

  // no target yet → the search-first landing
  if (!bom && !mo) {
    return (
      <div className="space-y-6">
        <PageHeader title="Trace" sub="Follow one order (MO) or code (BOM) through its whole life." />
        <div className="bg-surface border rounded-xl p-6 flex flex-col items-center gap-3 text-center">
          <p className="text-sm text-muted">Type a code or an order number to trace it.</p>
          <TraceSearch />
        </div>
      </div>
    );
  }

  const t = await getTrace({ mo, bom });

  if (!t.exists) {
    return (
      <div className="space-y-6">
        <PageHeader title={`Trace — ${t.key}`} sub="This code or order does not appear in any plan, the registry, or the log yet.">
          <Link href={planNo ? `/tracker?plan=${planNo}` : "/tracker"} className="text-accent text-sm font-semibold">→ Back to tracker</Link>
        </PageHeader>
        <TraceSearch initial={t.key} initialMode={t.scope} />
      </div>
    );
  }

  const pctOf = (v: number, req: number) => (req > 0 ? Math.round((v / req) * 100) : 0);
  const finishedPct = t.requiredSets > 0 ? pctOf(t.completeSets, t.requiredSets) : null;
  const deliveredPct = t.requiredSets > 0 ? pctOf(t.deliveredSets, t.requiredSets) : null;
  const openIssues = t.openReturns + t.openNotes;
  const monthsAll = [...new Set(t.members.flatMap((m) => m.months))];
  const openOrders = t.members.filter((m) => m.status === "open").length;

  const exportLedger = t.ledger.map((l) => ({
    Date: l.dateISO, Plan: l.planLabel, Dept: deptLabel(l.dept), Item: l.item, Qty: l.qty,
    Source: l.source, By: l.by ?? "", "Corrected from": l.corrected ?? "",
  }));

  return (
    <div className="space-y-4">
      {/* ===== header band: breadcrumb + title + badges | search + back ===== */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-wider text-muted mb-0.5">
            Trace · {t.scope === "mo" ? "Manufacturing order" : "Code"}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-extrabold leading-none">{t.key}</h1>
            {t.anyUrgent && <span className="pill pill-bad">Urgent</span>}
            {t.members.some((m) => m.priority) && <span className="pill pill-warn">⭐ Priority</span>}
            {t.members.length > 0 && openOrders === 0 && <span className="pill pill-muted">Closed</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TraceSearch initialMode={t.scope} />
          <Link href={planNo ? `/tracker?plan=${planNo}` : "/tracker"} className="btn btn-ghost btn-sm whitespace-nowrap">
            ← Tracker
          </Link>
        </div>
      </div>

      {/* ===== KPI strip ===== */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Order quantity" value={t.requiredSets} sub={t.scope === "bom" ? `across ${t.members.length} order${t.members.length === 1 ? "" : "s"}` : "transformers"} />
        <Kpi label="Finished sets" value={t.completeSets} pct={finishedPct} good={finishedPct !== null && finishedPct >= 100} />
        <Kpi label="Delivered" value={t.deliveredSets} pct={deliveredPct} good={deliveredPct !== null && deliveredPct >= 100} />
        <Kpi
          label="Open issues"
          value={openIssues}
          sub={openIssues > 0 ? `${t.openReturns} return${t.openReturns === 1 ? "" : "s"} · ${t.openNotes} note${t.openNotes === 1 ? "" : "s"}` : "all clear"}
          bad={openIssues > 0}
          good={openIssues === 0}
        />
      </div>

      {/* ===== main grid: content | properties sidebar ===== */}
      <div className="grid lg:grid-cols-3 gap-4 items-start">
        <div className="lg:col-span-2 space-y-4">
          {/* component progress — tracker-style table, one row per component */}
          <Card title="Component progress" sub="net totals vs the order quantity — OSP counts as covered">
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-brand text-white text-center text-xs">
                    <th className="p-2 text-left">Component</th>
                    <th className="p-2">Required</th>
                    <th className="p-2" style={{ background: "color-mix(in srgb, var(--brand) 82%, #000)" }}>Fab</th>
                    <th className="p-2" style={{ background: "color-mix(in srgb, var(--brand) 82%, #000)" }}>Weld</th>
                    <th className="p-2" style={{ background: "color-mix(in srgb, var(--brand) 82%, #000)" }}>Paint / SHB</th>
                    <th className="p-2" style={{ background: "color-mix(in srgb, var(--brand) 82%, #000)" }}>Dlvd</th>
                    <th className="p-2 w-40">Finish %</th>
                  </tr>
                </thead>
                <tbody>
                  {t.pipeline.map((p) => {
                    if (!p.active) {
                      return (
                        <tr key={p.item} className="text-center text-muted border-t">
                          <td className="p-2 text-left font-bold">{p.item}</td>
                          <td className="p-2" colSpan={5}>— not required for this project —</td>
                          <td className="p-2"><span className="pill pill-muted">N/A</span></td>
                        </tr>
                      );
                    }
                    const fin = pctOf(p.finished, p.required);
                    return (
                      <tr key={p.item} className="text-center border-t">
                        <td className="p-2 text-left font-extrabold">
                          {p.item}
                          {p.osp > 0 && <span className="pill ml-1.5" style={{ background: "#ece3f7", color: "#6b45a8" }} title="outsourced — counts as covered">OSP {p.osp}</span>}
                        </td>
                        <td className="p-2 font-bold tabnum">{p.required}</td>
                        <td className="p-2 tabnum" style={{ background: "var(--cut-tint)" }}>{p.cut}</td>
                        <td className="p-2 tabnum" style={{ background: "var(--weld-tint)" }}>{p.weld}</td>
                        <td className="p-2 tabnum" style={{ background: p.finishLabel === "SHB" ? "var(--shp-tint)" : "var(--paint-tint)" }}>
                          {p.finished}
                          <span className="block text-[9px] text-muted leading-none">{p.finishLabel}</span>
                        </td>
                        <td className="p-2 tabnum" style={{ background: "var(--dlvd-tint)" }}>{p.delivered}</td>
                        <td className="p-2">
                          <div className="flex items-center gap-1.5">
                            <div className="h-1.5 flex-1 rounded bg-border overflow-hidden">
                              <div className="h-full" style={{ width: `${Math.min(100, fin)}%`, background: fin >= 100 ? "var(--ok-fg)" : STAGE_COLOR.Painting }} />
                            </div>
                            <span className="text-xs font-bold tabnum w-9 text-right">{fin}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* the story */}
          <Card title="Activity" sub="every movement, correction, return, note & move — newest first">
            <div className="p-4">
              {t.timeline.length === 0
                ? <p className="text-sm text-muted">Nothing recorded yet.</p>
                : <TraceTimeline events={t.timeline} showMo={t.scope === "bom"} />}
            </div>
          </Card>
        </div>

        {/* ===== properties sidebar ===== */}
        <div className="space-y-4">
          <Card title="Details">
            <dl className="text-sm divide-y divide-border">
              {t.scope === "mo" ? (
                <Prop k="BOM">
                  <Link href={`/trace?plan=${planNo}&bom=${encodeURIComponent(t.bom)}`} className="text-accent font-bold hover:underline">{t.bom}</Link>
                </Prop>
              ) : (
                <Prop k="Orders">{t.members.length || "—"}{t.members.length > 0 && openOrders < t.members.length ? ` (${openOrders} open)` : ""}</Prop>
              )}
              {t.kva && <Prop k="KVA">{t.kva}</Prop>}
              {t.rating && <Prop k="Rating">{t.rating}</Prop>}
              {monthsAll.length > 0 && <Prop k="Plan months">{monthsAll.join(" · ")}</Prop>}
              <Prop k="Planned in">{t.orderPlans.join(" · ") || "—"}</Prop>
              <Prop k="Ledger records">{t.ledgerCount}</Prop>
              {t.siblings.length > 0 && (
                <Prop k="Family">
                  <span className="flex flex-wrap gap-x-2">
                    {t.siblings.map((s) => (
                      <Link key={s} href={`/trace?plan=${planNo}&bom=${encodeURIComponent(s)}`} className="text-accent font-semibold hover:underline">{s}</Link>
                    ))}
                  </span>
                </Prop>
              )}
            </dl>
          </Card>

          {t.scope === "bom" && t.members.length > 0 && (
            <Card title="Orders in this code">
              <ul className="divide-y divide-border text-sm">
                {t.members.map((m) => {
                  const p = m.planQty > 0 ? Math.round((m.complete / m.planQty) * 100) : 0;
                  return (
                    <li key={m.mo} className="px-4 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <Link href={`/trace?plan=${planNo}&mo=${encodeURIComponent(m.mo)}`} className="font-bold text-accent hover:underline text-xs">{m.mo}</Link>
                        <span className="flex items-center gap-1">
                          {m.urgent && <span className="pill pill-bad">U</span>}
                          {m.priority && <span title="Priority">⭐</span>}
                          {m.status === "closed"
                            ? <span className="pill pill-muted">closed</span>
                            : <span className="text-xs tabnum text-muted">{m.complete}/{m.planQty}</span>}
                        </span>
                      </div>
                      {m.status !== "closed" && (
                        <div className="mt-1 h-1 rounded bg-border overflow-hidden">
                          <div className="h-full" style={{ width: `${Math.min(100, p)}%`, background: p >= 100 ? "var(--ok-fg)" : "var(--brand)" }} />
                        </div>
                      )}
                      {m.remarks && <div className="mt-1 text-[11px] text-muted">📝 {m.remarks}</div>}
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {t.scope === "mo" && t.members[0]?.remarks && (
            <Card title="Remarks">
              <p className="px-4 py-3 text-sm whitespace-pre-wrap">{t.members[0].remarks}</p>
            </Card>
          )}

          {t.contributors.length > 0 && (
            <Card title="Recorded by">
              <ul className="divide-y divide-border text-sm">
                {t.contributors.map((c) => (
                  <li key={c.name} className="px-4 py-2 flex items-center justify-between">
                    <span>{c.name}</span>
                    <span className="tabnum font-bold">{c.qty} <span className="text-muted font-normal text-xs">pcs</span></span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      {/* ===== raw records (secondary, collapsed) ===== */}
      <details className="bg-surface border rounded-xl">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-bold text-muted hover:text-foreground">
          Plan orders ({t.orders.length})
        </summary>
        <div className="overflow-x-auto border-t">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-brand text-white text-left">
                <th className="p-2 text-center">Plan</th><th className="p-2">MO</th><th className="p-2">Description</th>
                <th className="p-2 text-center">Item</th><th className="p-2 text-center">Required</th>
                <th className="p-2 text-center">Planner balance</th><th className="p-2 text-center">Target</th><th className="p-2">Remark</th>
              </tr>
            </thead>
            <tbody>
              {t.orders.length === 0 && <tr><td colSpan={8} className="p-4 text-center text-muted">Not in any imported plan.</td></tr>}
              {t.orders.map((o) => (
                <tr key={o.id} className="border-t">
                  <td className="p-2 text-center font-bold text-xs whitespace-nowrap">{o.planLabel}</td>
                  <td className="p-2 text-xs">{o.mo}</td>
                  <td className="p-2 text-xs text-muted">{o.description}</td>
                  <td className="p-2 text-center font-bold">{o.item}</td>
                  <td className="p-2 text-center tabnum">{o.requiredQty}</td>
                  <td className="p-2 text-center tabnum">{o.plannerBalance ?? "—"}</td>
                  <td className="p-2 text-center tabnum">{o.targetQty}</td>
                  <td className="p-2 text-xs">{o.remark || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <details className="bg-surface border rounded-xl">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-bold text-muted hover:text-foreground">
          Full ledger ({t.ledgerCount})
        </summary>
        <div className="border-t px-3 py-2 flex justify-end">
          <ExportButton rows={exportLedger} filename={`trace-${t.key}.xlsx`} sheetName="Trace" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-brand text-white text-left">
                <th className="p-2">Date</th><th className="p-2 text-center">Plan</th><th className="p-2">Dept</th>
                <th className="p-2 text-center">Item</th><th className="p-2 text-center">Qty</th><th className="p-2">Source</th><th className="p-2">By</th>
              </tr>
            </thead>
            <tbody>
              {t.ledger.length === 0 && <tr><td colSpan={7} className="p-4 text-center text-muted">No handover records yet.</td></tr>}
              {t.ledger.map((l, i) => (
                <tr key={l.id} className={i % 2 ? "bg-zebra" : ""}>
                  <td className="p-2 whitespace-nowrap">{l.dateISO}</td>
                  <td className="p-2 text-center font-bold text-xs whitespace-nowrap">{l.planLabel}</td>
                  <td className="p-2">{deptLabel(l.dept)}</td>
                  <td className="p-2 text-center font-bold">{l.item}</td>
                  <td className="p-2 text-center font-bold tabnum" style={{ color: l.qty < 0 ? "var(--bad-fg)" : undefined }}>{l.qty}</td>
                  <td className="p-2 text-xs text-muted">
                    {l.source}
                    {l.corrected && <span className="pill pill-ok ml-1" title={`corrected from ${l.corrected}`}>fixed</span>}
                  </td>
                  <td className="p-2 text-xs whitespace-nowrap">{l.by ?? <span className="text-muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/* ---------- building blocks ---------- */

function Kpi({ label, value, sub, pct, good = false, bad = false }: {
  label: string; value: number; sub?: string; pct?: number | null; good?: boolean; bad?: boolean;
}) {
  return (
    <div className="bg-surface border rounded-xl px-4 py-3">
      <div className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</div>
      <div className="flex items-baseline gap-2 mt-0.5">
        <span className="text-2xl font-extrabold tabnum leading-none" style={{ color: bad ? "var(--bad-fg)" : good ? "var(--ok-fg)" : undefined }}>
          {value}
        </span>
        {pct !== undefined && pct !== null && (
          <span className="pill pill-muted tabnum">{pct}%</span>
        )}
      </div>
      {sub && <div className="text-[11px] text-muted mt-1">{sub}</div>}
    </div>
  );
}

/** ERP-style section card with its own header bar. */
function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="bg-surface border rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b bg-brand-light/40 flex flex-wrap items-baseline gap-x-2">
        <h2 className="text-sm font-extrabold">{title}</h2>
        {sub && <span className="text-[11px] text-muted">{sub}</span>}
      </div>
      {children}
    </section>
  );
}

/** One field row inside the Details property list. */
function Prop({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-2 flex items-start justify-between gap-3">
      <dt className="text-[11px] font-bold uppercase tracking-wide text-muted pt-0.5 shrink-0">{k}</dt>
      <dd className="text-right min-w-0">{children}</dd>
    </div>
  );
}
