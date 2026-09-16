import Link from "next/link";
import { PageHeader, Soi } from "@/components/ui";
import { TraceSearch } from "@/components/TraceSearch";
import { ExportButton } from "@/components/ExportButton";
import { LV_CHAIN, LV_STAGE_LABEL, LV_STAGE_SHORT, lvStageOf } from "@/lib/domain/lv";
import type { LvTraceResult } from "@/lib/server/lvTrace";

// One LV panel order, or one panel code, through its whole life: the orders
// on the chain, the stages' totals, every ledger row that moved them, and
// who recorded what. The panels' /trace.

const fmt = (n: number) => n.toLocaleString();
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export function LvTraceView({ t }: { t: LvTraceResult }) {
  const open = t.members.filter((m) => m.status === "open");
  const urgent = t.members.filter((m) => m.urgent).length;
  const exportRows = t.timeline.map((e) => ({
    Date: e.dateISO, MO: e.mo ?? "", Stage: e.stage, Qty: e.qty, By: e.by ?? "", Source: e.source, Note: e.note ?? "",
  }));

  return (
    <div className="space-y-6">
      <PageHeader title={`Trace — ${t.key}`} sub={t.scope === "mo" ? "One panel order" : "One panel code, every order on it"}>
        <TraceSearch initial={t.key} initialMode={t.scope} />
        <Link href="/tracker" className="text-accent text-sm font-semibold">→ Back to tracker</Link>
      </PageHeader>

      {/* what the scope is */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="pill pill-muted">LV Panels</span>
        <span className="font-bold">{t.bom}</span>
        <span className="text-muted">·</span>
        <span>{t.members.length} order(s), {open.length} open{urgent > 0 ? `, ${urgent} urgent` : ""}</span>
        <span className="text-muted">·</span>
        <span className="tabnum">{fmt(t.requiredPanels)} panels planned</span>
        {[...new Set(t.members.map((m) => m.product).filter(Boolean))].map((p) => <span key={p} className="pill pill-muted">{p}</span>)}
      </div>

      {/* the chain, over every order in scope */}
      <section className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand text-white text-left">
              <th className="p-2">Stage</th>
              <th className="p-2 text-center">Done</th>
              <th className="p-2 text-center">of</th>
              <th className="p-2 text-center">%</th>
              <th className="p-2 text-center">Left</th>
            </tr>
          </thead>
          <tbody>
            {t.pipeline.map((p) => (
              <tr key={p.stage} className="border-t">
                <td className="p-2 font-bold">{LV_STAGE_LABEL[p.stage]}</td>
                <td className="p-2 text-center font-extrabold tabnum">{fmt(p.done)}</td>
                <td className="p-2 text-center tabnum text-muted">{fmt(p.required)}</td>
                <td className="p-2 text-center tabnum">{p.required > 0 ? `${Math.round((p.done / p.required) * 100)}%` : "—"}</td>
                <td className="p-2 text-center tabnum">{fmt(Math.max(0, p.required - p.done))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* the orders */}
      <section className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand text-white text-left">
              <th className="p-2">MO</th>
              <th className="p-2">SOI</th>
              <th className="p-2">Customer</th>
              <th className="p-2 text-center">Product</th>
              <th className="p-2 text-center">Required</th>
              {LV_CHAIN.map((s) => <th key={s} className="p-2 text-center">{LV_STAGE_SHORT[s]}</th>)}
              <th className="p-2">Months</th>
              <th className="p-2">Status</th>
              <th className="p-2">Remarks</th>
            </tr>
          </thead>
          <tbody>
            {t.members.length === 0 && <tr><td colSpan={13} className="p-4 text-center text-muted">No panel order carries this code — only ledger rows.</td></tr>}
            {t.members.map((m) => (
              <tr key={m.mo} className={`border-t ${m.status === "closed" ? "opacity-60" : ""}`}>
                <td className="p-2 font-bold whitespace-nowrap text-xs">
                  <Link href={`/trace?mo=${encodeURIComponent(m.mo)}`} className="text-accent hover:underline">{m.mo}</Link>
                  {m.urgent && <span className="pill pill-bad ms-1">URGENT</span>}
                </td>
                <td className="p-2 whitespace-nowrap"><Soi soi={m.soi} /></td>
                <td className="p-2 text-xs">{m.customer ?? "—"}</td>
                <td className="p-2 text-center"><span className="pill pill-muted">{m.product ?? "—"}</span></td>
                <td className="p-2 text-center font-bold tabnum">{m.state.required}</td>
                {LV_CHAIN.map((s) => <td key={s} className="p-2 text-center tabnum">{lvStageOf(m.state, s)}</td>)}
                <td className="p-2 text-xs text-muted whitespace-nowrap">{m.months.join(", ") || "—"}</td>
                <td className="p-2"><span className={`pill ${m.status === "closed" ? "pill-muted" : "pill-ok"}`}>{m.status}</span></td>
                <td className="p-2 text-xs max-w-[16rem]">{[m.remarks, m.materialsRemarks].filter(Boolean).join(" · ") || <span className="text-muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* every ledger row, newest first */}
      <section className="bg-surface border rounded-xl overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b bg-surface-2/60">
          <b className="text-sm">Daily log — {t.ledgerCount} row(s)</b>
          <span className="inline-flex items-center gap-3 text-xs text-muted">
            {t.contributors.length > 0 && <span>{t.contributors.map((c) => `${c.name} ${fmt(c.qty)}`).join(" · ")}</span>}
            <ExportButton rows={exportRows} filename={`lv-trace-${t.key.replace(/[^A-Za-z0-9-]+/g, "_")}.xlsx`} sheetName="Log" />
          </span>
        </div>
        {t.timeline.length === 0 ? (
          <p className="text-sm text-muted p-4">Nothing recorded on this yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-muted text-xs">
                  <th className="p-2">Date</th>
                  <th className="p-2">Stage</th>
                  <th className="p-2">MO</th>
                  <th className="p-2 text-center">Qty</th>
                  <th className="p-2">By</th>
                  <th className="p-2">From</th>
                  <th className="p-2">Note</th>
                </tr>
              </thead>
              <tbody>
                {t.timeline.map((e, i) => (
                  <tr key={i} className={`border-t ${e.kind === "correction" ? "text-bad-fg" : ""}`}>
                    <td className="p-2 tabnum ltr whitespace-nowrap">{ddmmyyyy(e.dateISO)}</td>
                    <td className="p-2 font-semibold">{e.stage}</td>
                    <td className="p-2 text-xs whitespace-nowrap">{e.mo ?? "—"}</td>
                    <td className="p-2 text-center font-bold tabnum">{e.qty > 0 ? `+${e.qty}` : e.qty}</td>
                    <td className="p-2 text-xs">{e.by ?? "—"}</td>
                    <td className="p-2 text-xs text-muted">{e.source}</td>
                    <td className="p-2 text-xs text-muted">{e.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
