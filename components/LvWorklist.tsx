"use client";

import { traceHref } from "@/lib/domain/links";
import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExportButton } from "@/components/ExportButton";
import { SearchBox, FilterBar, useSavedFilter } from "@/components/FilterControls";
import { Soi } from "@/components/ui";
import { recordLvOutput } from "@/app/lv/actions";
import { LV_STAGES, LV_STAGE_DONE, LV_STAGE_LABEL, LV_STAGE_SHORT, lvFed, lvStageOf } from "@/lib/domain/lv";
import type { LvWorklist as LvWorklistData, LvWorklistRow } from "@/lib/server/lvWorklist";
import { HeldOrdersStrip } from "@/components/HeldOrdersStrip";

// One LV stage's worklist: the panel orders it owes something on, each with
// a box to record what was done today. The list is the monthly plan read
// against the ledger — no weekly promise per panel, so no dates: urgent
// first, then the plan's order, and the planner sequences by eye.

export function LvWorklist({ data, canEdit, todayISO, lineSwitch }: {
  data: LvWorklistData; canEdit: boolean; todayISO: string;
  /** The page's Transformers | LV Panels switch, first in the filter bar. */
  lineSwitch?: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useSavedFilter(`lvwl.${data.stage}.q`);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ mo: string; ok: boolean; text: string } | null>(null);
  const [showOthers, setShowOthers] = useState(false);

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return needle ? data.rows.filter((r) => `${r.mo} ${r.bom} ${r.soi ?? ""} ${r.customer ?? ""} ${r.product ?? ""}`.toUpperCase().includes(needle)) : data.rows;
  }, [data.rows, q]);
  const waiting = filtered.reduce((s, r) => s + r.waiting, 0);
  const idx = LV_STAGES.indexOf(data.stage);
  const prev = idx === 0 ? null : LV_STAGES[idx - 1];
  const others = data.upstream.length + data.finished.length + data.unplanned.length;

  /** Why an order waits on the stage before: nothing handed over yet, or
   *  everything handed over so far is already done here. */
  function upstreamTitle(r: LvWorklistRow): string {
    const fed = lvFed(r.state, data.stage);
    const before = prev ? LV_STAGE_DONE[prev] : "planned";
    if (fed === 0) return `${r.state.required} planned — nothing ${before} yet`;
    const ofPlan = r.state.required > 0 ? ` of ${r.state.required}` : "";
    return `${fed}${ofPlan} ${before} so far, ${r.done} ${LV_STAGE_DONE[data.stage]}${r.state.required > 0 ? "" : " — no quantity planned"}`;
  }

  function record(r: LvWorklistRow) {
    const n = Number(qty[r.mo] ?? "");
    const fd = new FormData();
    fd.set("mo", r.mo); fd.set("stage", data.stage); fd.set("qty", String(n)); fd.set("date", todayISO);
    setMsg(null);
    startTransition(async () => {
      const res = await recordLvOutput(fd);
      setMsg({ mo: r.mo, ok: res.ok, text: res.ok ? `Recorded ${n} ${data.stage.toLowerCase()} on ${r.mo}.` : (res.error ?? "Failed") });
      if (res.ok) { setQty((m) => ({ ...m, [r.mo]: "" })); router.refresh(); }
    });
  }

  const exportRows = filtered.map((r) => ({
    MO: r.mo, SOI: r.soi ?? "", Customer: r.customer ?? "", Product: r.product ?? "", BoM: r.bom, Required: r.state.required,
    [`${prev ? LV_STAGE_SHORT[prev] : "Order"} ready`]: prev ? lvStageOf(r.state, prev) : r.state.required, [`${LV_STAGE_SHORT[data.stage]} done`]: r.done, Waiting: r.waiting,
  }));

  return (
    <div className="space-y-4">
      <HeldOrdersStrip rows={data.held.map((r) => ({ mo: r.mo, bom: r.bom, description: [r.product, r.customer].filter(Boolean).join(" · "), hold: r.hold }))} />
      <FilterBar count={filtered.length} total={data.rows.length} onReset={() => setQ("")} hasActive={!!q}>
        {lineSwitch}
        <SearchBox value={q} onChange={setQ} placeholder="Search MO / BOM / SOI / customer…" />
        <span className="text-xs text-muted">Panels waiting for {data.stage.toLowerCase()}: <b className="text-foreground tabnum">{waiting}</b></span>
        <ExportButton rows={exportRows} filename={`lv-${data.stage.toLowerCase()}-worklist.xlsx`} sheetName={data.stage} />
      </FilterBar>

      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand-fill text-white text-left">
              <th className="p-2">MO</th>
              <th className="p-2">SOI</th>
              <th className="p-2">Customer</th>
              <th className="p-2 text-center">Product</th>
              <th className="p-2">BoM</th>
              <th className="p-2 text-center">Order</th>
              <th className="p-2 text-center" title={prev ? `Panels the ${prev.toLowerCase()} stage has finished — what this stage can take` : "The order quantity — punching starts from the plan"}>
                {prev ? `${LV_STAGE_SHORT[prev]}ed` : "Planned"}
              </th>
              <th className="p-2 text-center" title={`Panels already ${data.stage.toLowerCase()} on this order`}>{LV_STAGE_SHORT[data.stage]} done</th>
              <th className="p-2 text-center" title="What this stage still owes">Waiting</th>
              {canEdit && <th className="p-2 no-print" title={`Record today's ${data.stage.toLowerCase()} — the quantity done, not a total`}>Record today</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={canEdit ? 10 : 9} className="p-4 text-center text-muted">
                {data.rows.length === 0
                  ? `Nothing waiting for ${data.stage.toLowerCase()}${prev && data.upstream.length > 0 ? ` — ${data.upstream.length} order(s) are still at ${prev.toLowerCase()} or before` : ""}${data.unplanned.length > 0 ? ` — ${data.unplanned.length} order(s) have no quantity planned` : ""}.`
                  : "No rows match the search."}
              </td></tr>
            )}
            {filtered.map((r) => (
              <tr key={r.mo} className="border-t">
                <td className="p-2 font-bold whitespace-nowrap text-xs">
                  {r.mo}
                  {r.urgent && <span className="pill pill-bad ms-1">URGENT</span>}
                  {r.priority && <span className="pill pill-warn ms-1" title="Marked important by the admin">★</span>}
                </td>
                <td className="p-2 whitespace-nowrap"><Soi soi={r.soi} /></td>
                <td className="p-2 text-xs whitespace-nowrap">{r.customer ?? "—"}</td>
                <td className="p-2 text-center"><span className="pill pill-muted">{r.product ?? "—"}</span></td>
                <td className="p-2 font-semibold whitespace-nowrap text-xs">
                  <Link href={traceHref({ bom: r.bom, line: "LV" })} className="text-brand-ink hover:underline">{r.bom}</Link>
                </td>
                <td className="p-2 text-center tabnum">{r.state.required}</td>
                <td className="p-2 text-center tabnum">{prev ? lvStageOf(r.state, prev) : r.state.required}</td>
                <td className="p-2 text-center tabnum text-muted">{r.done}</td>
                <td className="p-2 text-center font-extrabold tabnum">{r.waiting}</td>
                {canEdit && (
                  <td className="p-2 no-print">
                    <span className="inline-flex flex-col gap-0.5">
                      <span className="inline-flex items-center gap-1">
                        <input
                          type="number" min={1} max={r.waiting} value={qty[r.mo] ?? ""} disabled={pending}
                          onChange={(e) => setQty((m) => ({ ...m, [r.mo]: e.target.value }))}
                          onKeyDown={(e) => { if (e.key === "Enter" && Number(qty[r.mo]) > 0) record(r); }}
                          placeholder={String(r.waiting)}
                          aria-label={`${data.stage} done today on ${r.mo}`}
                          className="w-20 border rounded-md px-2 py-1 text-center font-bold tabnum bg-surface"
                        />
                        <button type="button" className="btn btn-sm btn-primary" disabled={pending || !(Number(qty[r.mo]) > 0)} onClick={() => record(r)}>Save</button>
                        <button type="button" className="btn btn-sm btn-ghost" disabled={pending} title={`All ${r.waiting}`} onClick={() => setQty((m) => ({ ...m, [r.mo]: String(r.waiting) }))}>all</button>
                      </span>
                      {msg?.mo === r.mo && <span className={`text-[11px] font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</span>}
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {others > 0 && (
        <details className="text-sm" open={showOthers} onToggle={(e) => setShowOthers((e.target as HTMLDetailsElement).open)}>
          <summary className="cursor-pointer text-muted select-none">
            {[
              data.upstream.length > 0 && `${data.upstream.length} order(s) waiting on ${prev ? prev.toLowerCase() : "the plan"}`,
              data.finished.length > 0 && `${data.finished.length} finished at ${LV_STAGE_LABEL[data.stage].toLowerCase()}`,
              data.unplanned.length > 0 && `${data.unplanned.length} with no quantity planned`,
            ].filter(Boolean).join(" · ")}
          </summary>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {data.upstream.map((r) => <span key={r.mo} className="pill pill-muted" title={upstreamTitle(r)}>{r.mo}</span>)}
            {data.finished.map((r) => <span key={r.mo} className="pill pill-ok" title={`${r.done} of ${r.state.required} done here`}>{r.mo} ✓</span>)}
            {data.unplanned.map((r) => <span key={r.mo} className="pill pill-warn" title="No quantity planned — the plan sheet gives this order none yet">{r.mo}</span>)}
          </div>
        </details>
      )}
    </div>
  );
}
