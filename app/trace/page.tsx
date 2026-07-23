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

  const back = (
    <Link href={planNo ? `/tracker?plan=${planNo}` : "/tracker"} className="text-accent text-sm font-semibold">
      → Back to tracker
    </Link>
  );

  if (!t.exists) {
    return (
      <div className="space-y-6">
        <PageHeader title={`Trace — ${t.key}`} sub="This code or order does not appear in any plan, the registry, or the log yet.">
          {back}
        </PageHeader>
        <TraceSearch initial={t.key} initialMode={t.scope} />
      </div>
    );
  }

  const pct = (v: number, req: number) => (req > 0 ? Math.min(100, Math.round((v / req) * 100)) : 0);
  const setsPct = t.requiredSets > 0 ? Math.round((t.completeSets / t.requiredSets) * 100) : null;

  const exportLedger = t.ledger.map((l) => ({
    Date: l.dateISO, Plan: l.planLabel, Dept: deptLabel(l.dept), Item: l.item, Qty: l.qty,
    Source: l.source, By: l.by ?? "", "Corrected from": l.corrected ?? "",
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Trace — ${t.key}`}
        sub={`${t.scope === "mo" ? "Manufacturing order" : "Code"} · ${t.ledgerCount} ledger records · plans: ${t.orderPlans.join(" · ") || "—"}`}
      >
        {back}
      </PageHeader>

      <TraceSearch initial={t.key} initialMode={t.scope} />

      {/* ===== identity ===== */}
      <section className="bg-surface border rounded-xl p-4">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="text-lg font-extrabold">{t.scope === "mo" ? t.key : t.bom}</span>
          {t.scope === "mo" && t.bom && (
            <Link href={`/trace?plan=${planNo}&bom=${encodeURIComponent(t.bom)}`} className="pill pill-muted hover:underline">
              BOM: {t.bom}
            </Link>
          )}
          {t.kva && <span className="pill pill-muted">KVA {t.kva}</span>}
          {t.rating && <span className="pill pill-muted">{t.rating}</span>}
          {t.anyUrgent && <span className="pill pill-bad">Urgent</span>}
          {t.members.some((m) => m.priority) && <span className="pill pill-warn">⭐ Priority</span>}
          {t.openReturns > 0 && <span className="pill pill-bad">↩ {t.openReturns} open return{t.openReturns === 1 ? "" : "s"}</span>}
          {t.openNotes > 0 && <span className="pill pill-warn">📝 {t.openNotes} open note{t.openNotes === 1 ? "" : "s"}</span>}
        </div>

        {/* where is it now */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          <span>
            <b className="tabnum text-lg">{t.completeSets}</b>
            <span className="text-muted">/{t.requiredSets} sets finished</span>
            {setsPct !== null && <span className="pill pill-ok ml-1.5 tabnum">{setsPct}%</span>}
          </span>
          <span className="text-muted">
            Delivered: <b className="text-foreground tabnum">{t.deliveredSets}</b>
          </span>
          {t.scope === "bom" && t.members.length > 0 && (
            <span className="text-muted">
              Orders: <b className="text-foreground tabnum">{t.members.length}</b>
            </span>
          )}
        </div>

        {/* remarks + months for the order(s) */}
        {t.members.some((m) => m.remarks || m.months.length) && (
          <div className="mt-2 space-y-1 text-xs text-muted">
            {t.members.filter((m) => m.remarks || m.months.length).map((m) => (
              <div key={m.mo}>
                <b className="text-foreground">{m.mo}</b>
                {m.months.length > 0 && <> · {m.months.join(" · ")}</>}
                {m.status === "closed" && <span className="pill pill-muted ml-1">closed</span>}
                {m.remarks && <> · 📝 {m.remarks}</>}
              </div>
            ))}
          </div>
        )}

        {t.siblings.length > 0 && (
          <div className="mt-2 text-xs">
            <span className="text-muted">Same family: </span>
            {t.siblings.map((s, i) => (
              <span key={s}>
                {i > 0 && " · "}
                <Link href={`/trace?plan=${planNo}&bom=${encodeURIComponent(s)}`} className="text-accent font-semibold hover:underline">{s}</Link>
              </span>
            ))}
          </div>
        )}
      </section>

      {/* ===== where is it now — per-component pipeline ===== */}
      <section>
        <h2 className="text-lg font-bold mb-2">Where is it now — per component</h2>
        <div className="grid gap-2.5 md:grid-cols-2">
          {t.pipeline.map((p) => {
            const stages = [
              { key: "Cut", label: "Fab", val: p.cut, color: STAGE_COLOR.Cut },
              { key: "Welding", label: "Weld", val: p.weld, color: STAGE_COLOR.Welding },
              { key: "Painting", label: p.finishLabel, val: p.finished, color: STAGE_COLOR.Painting },
              { key: "Delivered", label: "Dlvd", val: p.delivered, color: STAGE_COLOR.Delivered },
            ];
            return (
              <div key={p.item} className={`bg-surface border rounded-xl px-3 py-2.5 ${!p.active ? "opacity-50" : ""}`}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-extrabold">{p.item}</span>
                  {p.active ? (
                    <span className="text-xs text-muted tabnum">
                      of <b className="text-foreground">{p.required}</b>
                      {p.osp > 0 && <span className="ml-1" title="outsourced — counts as covered">· OSP {p.osp}</span>}
                    </span>
                  ) : (
                    <span className="pill pill-muted">N/A</span>
                  )}
                </div>
                {p.active && (
                  <div className="grid grid-cols-4 gap-1.5">
                    {stages.map((s) => (
                      <div key={s.key}>
                        <div className="flex items-baseline justify-between text-[10px] text-muted mb-0.5">
                          <span className="font-bold">{s.label}</span>
                          <span className="tabnum">{pct(s.val, p.required)}%</span>
                        </div>
                        <div className="text-sm font-extrabold tabnum leading-none mb-1">{s.val}</div>
                        <div className="h-1.5 rounded bg-border overflow-hidden">
                          <div className="h-full transition-all" style={{ width: `${pct(s.val, p.required)}%`, background: s.color }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ===== the story ===== */}
      <section>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h2 className="text-lg font-bold">Timeline</h2>
          <span className="text-xs text-muted">every movement, correction, return, note & move — newest first</span>
        </div>
        {t.timeline.length === 0 ? (
          <p className="text-sm text-muted">Nothing recorded yet.</p>
        ) : (
          <div className="bg-surface border rounded-xl p-4">
            <TraceTimeline events={t.timeline} showMo={t.scope === "bom"} />
          </div>
        )}
      </section>

      {/* ===== contributors ===== */}
      {t.contributors.length > 0 && (
        <section>
          <h2 className="text-lg font-bold mb-2">Recorded by</h2>
          <div className="flex flex-wrap gap-2">
            {t.contributors.map((c) => (
              <span key={c.name} className="bg-surface border rounded-lg px-3 py-1.5 text-sm">
                {c.name} <b className="tabnum ml-1">{c.qty}</b> <span className="text-muted text-xs">pcs</span>
              </span>
            ))}
          </div>
        </section>
      )}

      {/* ===== raw detail (secondary, collapsed) ===== */}
      <details className="bg-surface border rounded-xl">
        <summary className="cursor-pointer select-none px-4 py-3 font-bold">Plan orders — every plan this code was planned in ({t.orders.length})</summary>
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
        <summary className="cursor-pointer select-none px-4 py-3 font-bold">Full ledger — every handover record ({t.ledgerCount})</summary>
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
