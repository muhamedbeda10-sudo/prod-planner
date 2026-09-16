"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExportButton } from "@/components/ExportButton";
import { SearchBox, SelectFilter, FilterBar, useSavedFilter } from "@/components/FilterControls";
import { Num, Soi } from "@/components/ui";
import { recordLvGroupTotal, recordLvTotal } from "@/app/lv/actions";
import { closeDeliveredOrders, setOrderStatus } from "@/app/orders/actions";
import { spreadOverGroup, spreadWords } from "@/lib/domain/groupSpread";
import { LV_CHAIN, LV_STAGE_LABEL, LV_STAGE_SHORT, lvGroupMembers, lvStageOf, type LvChainStage } from "@/lib/domain/lv";
import type { LvTrackerRow } from "@/lib/server/lvTracker";

// The Plan Tracker's LV PANELS side.
//
// A panel is one thing that passes four stages in order, so its row is five
// cells — punched, bent, welded, painted, delivered — where a transformer's
// is a grid. The cells record the way the transformer tracker's do: click,
// type the NEW total, the difference lands in today's daily log; a merged
// BOM row spreads a total over its MOs in order and shows which before it
// is saved. Same ledger, same corrections, same guard.

const STAGE_TINT: Record<LvChainStage, string> = {
  Punching: "var(--item-cf)",
  Bending: "var(--item-tc)",
  Welding: "var(--item-tn)",
  Painting: "var(--item-cb)",
  Delivered: "var(--item-ar)",
};

export function LvTrackerTable({ rows, editableStages, canStatus, viewTabs }: {
  rows: LvTrackerRow[];
  /** The stages this user may record — each behind its own tracker permission. */
  editableStages: LvChainStage[];
  canStatus: boolean;
  viewTabs?: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useSavedFilter("lvtracker.q");
  const [product, setProduct] = useSavedFilter("lvtracker.product");
  const [status, setStatus] = useSavedFilter("lvtracker.status");
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [cellErr, setCellErr] = useState("");
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState("");

  const products = useMemo(() => [...new Set(rows.map((r) => r.product ?? ""))].filter(Boolean).sort(), [rows]);
  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    const want = status || "open";
    return rows.filter((r) => {
      if (needle && !(`${r.mo} ${r.bom} ${r.soi ?? ""} ${r.fgCode ?? ""} ${r.secItem ?? ""} ${r.customer ?? ""}`.toUpperCase().includes(needle))) return false;
      if (product && r.product !== product) return false;
      if (want !== "all" && r.status !== want) return false;
      return true;
    });
  }, [rows, q, product, status]);

  // shared BOMs: one summary row per BOM, expandable to its MOs — the way the
  // planner reads the transformer tracker
  const groups = useMemo(() => {
    const by = new Map<string, LvTrackerRow[]>();
    for (const r of filtered) (by.get(r.bom) ?? by.set(r.bom, []).get(r.bom)!).push(r);
    return [...by.entries()];
  }, [filtered]);

  const required = filtered.reduce((s, r) => s + r.state.required, 0);
  const complete = filtered.reduce((s, r) => s + r.complete, 0);
  const doneCount = rows.filter((r) => r.status === "open" && r.state.required > 0 && r.state.delivered >= r.state.required).length;

  const exportRows = filtered.map((r) => ({
    MO: r.mo, SOI: r.soi ?? "", Customer: r.customer ?? "", Product: r.product ?? "", BoM: r.bom, "SEC Item": r.secItem ?? "",
    Required: r.state.required, Punched: r.state.punch, Bent: r.state.bend, Welded: r.state.weld, Painted: r.state.paint,
    Delivered: r.state.delivered, Left: r.remaining, Status: r.status,
  }));

  function run(fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData, after?: () => void) {
    setCellErr("");
    startTransition(async () => {
      const res = await fn(fd);
      if (res.ok) { setEditKey(null); after?.(); router.refresh(); }
      else setCellErr(res.error ?? "Failed");
    });
  }

  const toggleGroup = (bom: string) => setOpenGroups((s) => { const n = new Set(s); if (n.has(bom)) n.delete(bom); else n.add(bom); return n; });

  /** One stage cell — a single MO's, or a merged BOM row's (then `members`). */
  function cell(key: string, value: number, stage: LvChainStage, save: (total: string) => void, preview?: (delta: number) => string) {
    const editing = editKey === key;
    const editable = editableStages.includes(stage);
    const added = editing ? Number(editVal) - value : 0;
    return (
      <td key={key} className="p-1 text-center tabnum" style={{ background: STAGE_TINT[stage] }} onClick={(e) => e.stopPropagation()}>
        {editing ? (
          <span className="inline-flex flex-col items-center gap-0.5">
            <span className="inline-flex items-center gap-1">
              <input
                type="number" min={0} value={editVal} autoFocus disabled={pending}
                onChange={(e) => { setEditVal(e.target.value); setCellErr(""); }}
                onKeyDown={(e) => { if (e.key === "Enter") save(editVal); if (e.key === "Escape") setEditKey(null); }}
                className="w-16 border rounded-md px-1 py-0.5 text-center font-bold tabnum bg-surface text-foreground"
              />
              <button type="button" onClick={() => save(editVal)} disabled={pending} className="text-ok-fg font-extrabold px-0.5" title="Save — the difference lands in today's Daily Log">✓</button>
              <button type="button" onClick={() => setEditKey(null)} disabled={pending} className="text-muted px-0.5" title="Cancel">✕</button>
            </span>
            {added !== 0 && !cellErr && (
              <span className={`text-[10px] font-bold whitespace-nowrap ${added > 0 ? "text-ok-fg" : "text-bad-fg"}`}>
                {(preview && preview(added)) || (added > 0 ? `+${added} today` : `−${-added} correction`)}
              </span>
            )}
            {cellErr && <span className="text-[10px] text-bad-fg whitespace-normal max-w-48 text-start leading-tight font-normal">{cellErr}</span>}
          </span>
        ) : editable ? (
          <button
            type="button" disabled={pending}
            onClick={() => { setEditKey(key); setEditVal(String(value)); setCellErr(""); }}
            className="print-as-text w-full min-w-8 rounded px-1 py-1 tabnum hover:ring-2 hover:ring-brand/60 hover:font-bold transition-all cursor-text"
            title={`${LV_STAGE_LABEL[stage]} — type the new total; the difference is recorded in today's Daily Log`}
          >
            {value}
          </button>
        ) : value}
      </td>
    );
  }

  function moRow(r: LvTrackerRow, inGroup: boolean) {
    const pct = r.achievement === null ? "—" : `${Math.round(r.achievement * 100)}%`;
    return (
      <tr key={r.mo} className={`border-t ${r.status === "closed" ? "opacity-60" : ""} ${inGroup ? "bg-surface-2/40" : ""}`}>
        <td className={`p-2 font-bold whitespace-nowrap text-xs ${inGroup ? "ps-6" : ""}`}>
          {inGroup && <span className="text-muted me-1">↳</span>}{r.mo}
          {r.urgent && <span className="pill pill-bad ms-1">U</span>}
        </td>
        <td className="p-2 whitespace-nowrap"><Soi soi={r.soi} /></td>
        <td className="p-2 text-xs whitespace-nowrap">{r.customer ?? "—"}</td>
        <td className="p-2 text-center"><span className="pill pill-muted">{r.product ?? "—"}</span></td>
        <td className="p-2 font-semibold whitespace-nowrap text-xs">
          {inGroup ? <span className="text-muted">{r.bom}</span> : <Link href={`/trace?bom=${encodeURIComponent(r.bom)}`} className="text-accent hover:underline">{r.bom}</Link>}
        </td>
        <td className="p-2 text-xs whitespace-nowrap tabnum text-muted">{r.secItem ?? "—"}</td>
        <td className="p-2 text-center font-bold tabnum">{r.state.required}</td>
        {LV_CHAIN.map((stage) =>
          cell(`${r.mo}|${stage}`, lvStageOf(r.state, stage), stage, (total) => {
            const fd = new FormData();
            fd.set("mo", r.mo); fd.set("stage", stage); fd.set("total", total);
            run(recordLvTotal, fd);
          })
        )}
        <td className="p-2 text-center font-bold tabnum">{r.remaining}</td>
        <td className="p-2 text-center text-xs tabnum">{pct}</td>
        <td className="p-2 text-center whitespace-nowrap no-print">
          {canStatus ? (
            <button
              type="button" disabled={pending}
              className={`pill ${r.status === "closed" ? "pill-muted" : "pill-ok"} cursor-pointer`}
              title={r.status === "closed" ? "Reopen this order" : "Close this order — it leaves the open screens; the log is untouched"}
              onClick={() => { const fd = new FormData(); fd.set("mo", r.mo); fd.set("status", r.status === "closed" ? "open" : "closed"); run(setOrderStatus, fd); }}
            >
              {r.status}
            </button>
          ) : <span className={`pill ${r.status === "closed" ? "pill-muted" : "pill-ok"}`}>{r.status}</span>}
        </td>
      </tr>
    );
  }

  return (
    <div className="space-y-4">
      <FilterBar count={filtered.length} total={rows.length} onReset={() => { setQ(""); setProduct(""); setStatus(""); }} hasActive={!!(q || product || (status && status !== "open"))}>
        {viewTabs}
        <SearchBox value={q} onChange={setQ} placeholder="Search MO / BOM / SOI / FG / SEC…" />
        {products.length > 1 && <SelectFilter label="Product" value={product} onChange={setProduct} options={products.map((p) => ({ value: p, label: p }))} />}
        <SelectFilter label="Status" value={status || "open"} onChange={setStatus} options={[{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }, { value: "all", label: "All" }]} />
        <span className="text-xs text-muted">
          Panels: <b className="text-foreground tabnum">{complete}</b> / <b className="text-foreground tabnum">{required}</b> painted
        </span>
        <ExportButton rows={exportRows} filename="lv-panels-tracker.xlsx" sheetName="LV Panels" />
        {canStatus && doneCount > 0 && (
          <button
            type="button" className="btn btn-sm" disabled={pending}
            title="Close every open panel order whose panels have all been delivered"
            onClick={() => startTransition(async () => {
              const res = await closeDeliveredOrders();
              setMsg(res.ok ? `Closed ${res.closed} order(s).` : (res.error ?? "Failed"));
              if (res.ok) router.refresh();
            })}
          >
            ✓ Close {doneCount} delivered
          </button>
        )}
        {msg && <span className="text-xs font-semibold text-ok-fg">{msg}</span>}
      </FilterBar>

      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand text-white text-left">
              <th className="p-2">MO</th>
              <th className="p-2">SOI</th>
              <th className="p-2">Customer</th>
              <th className="p-2 text-center" title="LSS or USS">Product</th>
              <th className="p-2">BoM</th>
              <th className="p-2">SEC Item</th>
              <th className="p-2 text-center">Required</th>
              {LV_CHAIN.map((s) => (
                <th key={s} className="p-2 text-center on-tint" style={{ background: STAGE_TINT[s] }} title={LV_STAGE_LABEL[s]}>{LV_STAGE_SHORT[s]}</th>
              ))}
              <th className="p-2 text-center" title="Required − painted">Left</th>
              <th className="p-2 text-center" title="Painted ÷ required">%</th>
              <th className="p-2 text-center no-print">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={15} className="p-4 text-center text-muted">
                {rows.length === 0 ? "No LV panel orders yet — import their monthly plan from Tools → Orders & plan imports." : "No rows match the filters."}
              </td></tr>
            )}
            {groups.map(([bom, members]) => {
              if (members.length === 1) return moRow(members[0], false);
              const open = openGroups.has(bom);
              const sum = (f: (r: LvTrackerRow) => number) => members.reduce((s, r) => s + f(r), 0);
              const gReq = sum((r) => r.state.required);
              const gComplete = sum((r) => r.complete);
              const urgent = members.filter((m) => m.urgent).length;
              return (
                <Fragment key={`g|${bom}`}>
                  <tr
                    className={`cursor-pointer bg-brand-light/30 hover:bg-brand-light/60 transition-colors font-semibold ${open ? "border-x-2 border-t-2 border-brand" : ""}`}
                    onClick={() => toggleGroup(bom)}
                    title={open ? "Collapse MOs" : "Show the MOs inside this BOM"}
                  >
                    <td className="p-2 font-bold whitespace-nowrap text-xs">
                      <span className={`inline-block mr-1 transition-transform duration-150 ${open ? "rotate-90" : ""}`}>▶</span>
                      {members.length} MOs
                      {urgent > 0 && <span className="pill pill-bad ml-1">U×{urgent}</span>}
                    </td>
                    <td className="p-2 whitespace-nowrap"><Soi soi={null} /></td>
                    <td className="p-2 text-xs text-muted">{[...new Set(members.map((m) => m.customer).filter(Boolean))].join(" · ") || "—"}</td>
                    <td className="p-2 text-center">{[...new Set(members.map((m) => m.product).filter(Boolean))].map((p) => <span key={p} className="pill pill-muted me-1">{p}</span>)}</td>
                    <td className="p-2 font-bold whitespace-nowrap text-xs">
                      <Link href={`/trace?bom=${encodeURIComponent(bom)}`} onClick={(e) => e.stopPropagation()} className="text-accent hover:underline">{bom}</Link>
                    </td>
                    <td className="p-2 text-xs text-muted tabnum">{[...new Set(members.map((m) => m.secItem).filter(Boolean))].join(", ") || "—"}</td>
                    <td className="p-2 text-center font-bold"><Num v={gReq} /></td>
                    {LV_CHAIN.map((stage) =>
                      cell(
                        `g|${bom}|${stage}`,
                        sum((r) => lvStageOf(r.state, stage)),
                        stage,
                        (total) => {
                          const fd = new FormData();
                          fd.set("bom", bom); fd.set("stage", stage); fd.set("total", total); fd.set("mos", members.map((m) => m.mo).join(","));
                          run(recordLvGroupTotal, fd);
                        },
                        // which MOs the number lands on, before it is saved —
                        // the same rule the server writes with
                        (delta) => spreadWords(spreadOverGroup(lvGroupMembers(members.map((m) => ({ mo: m.mo, state: m.state })), stage), delta))
                      )
                    )}
                    <td className="p-2 text-center font-bold"><Num v={Math.max(0, gReq - gComplete)} /></td>
                    <td className="p-2 text-center text-xs tabnum">{gReq > 0 ? `${Math.round((gComplete / gReq) * 100)}%` : "—"}</td>
                    <td className="p-2 no-print" />
                  </tr>
                  {open && members.map((m) => moRow(m, true))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
