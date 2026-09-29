"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upsertLvStdTime, deleteLvStdTime } from "./actions";
import type { LvRate } from "@/lib/domain/lvStd";
import { Modal } from "@/components/Modal";

/* The LV panels' standard hours per unit, from the timings sheet's LV tab.
   Each open panel order shows which row prices it — by its FG code, or
   through its SEC item when the plan carries our own FG code. */

export interface LvOrderRateRow { mo: string; fgCode: string | null; secItem: string | null; product: string | null; planQty: number; status: string; fg: string | null; via: "fg" | "sec" | null }

const FIELDS = [
  ["cutH", "Cutting", "Punching / laser cutting — the LV punching section"],
  ["bendH", "Bending", "The LV bending section"],
  ["weldH", "Welding", "The USS/LV welding section"],
  ["shbH", "Shot blast", "Earned by the shot-blast crew — the transformers' crew blasts the panels too"],
  ["paintH", "Paint line", "The USS painting section"],
] as const;

const fmt = (v: number | null) => (v === null ? "—" : String(Math.round(v * 1000) / 1000));
const INPUT = "border rounded px-1.5 py-1 w-20 text-right tabnum bg-surface";

export function LvStdTimesManager({ rates, orders }: { rates: LvRate[]; orders: LvOrderRateRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState<string | null>(null); // fg, or "" for a new row
  const [draft, setDraft] = useState<Record<string, string>>({});

  const run = (action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData, after?: () => void) => {
    setErr("");
    startTransition(async () => {
      const res = await action(fd);
      if (!res.ok) setErr(res.error ?? "Failed");
      else { after?.(); router.refresh(); }
    });
  };
  const start = (r: LvRate | null) => {
    setEditing(r ? r.fg : "");
    setDraft(r
      ? { fg: r.fg, description: r.description ?? "", kind: r.kind, ...Object.fromEntries(FIELDS.map(([f]) => [f, fmt(r[f])])) }
      : { fg: "", description: "", kind: "USS", cutH: "", bendH: "", weldH: "", shbH: "", paintH: "" });
  };
  const save = () => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(draft)) fd.set(k, v);
    run(upsertLvStdTime, fd, () => setEditing(null));
  };

  const open = useMemo(() => orders.filter((o) => o.status === "open"), [orders]);
  const unpriced = open.filter((o) => !o.fg);
  const usedBy = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of open) if (o.fg) m.set(o.fg, (m.get(o.fg) ?? 0) + o.planQty);
    return m;
  }, [open]);
  const openUnits = open.reduce((s, o) => s + o.planQty, 0);
  const pricedUnits = open.reduce((s, o) => s + (o.fg ? o.planQty : 0), 0);

  const editRow = (key: string) => (
    <tr key={`edit-${key}`} className="border-t bg-surface-2">
      <td className="p-1.5">
        {key === "" ? <input value={draft.fg} onChange={(e) => setDraft({ ...draft, fg: e.target.value })} placeholder="FG-SUSA-8569105" className="border rounded px-1.5 py-1 w-44 ltr bg-surface" aria-label="FG code" /> : <b className="ltr">{key}</b>}
        <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Description" className="border rounded px-1.5 py-1 w-44 mt-1 block bg-surface text-xs" aria-label="Description" />
      </td>
      <td className="p-1.5">
        <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} className="border rounded px-1 py-1 bg-surface text-xs" aria-label="Kind">
          <option value="USS">USS</option><option value="MB">Meter box</option><option value="FP">Feeder pillar</option>
        </select>
      </td>
      {FIELDS.map(([f]) => (
        <td key={f} className="p-1.5 text-right"><input type="number" step="0.01" min="0" value={draft[f]} onChange={(e) => setDraft({ ...draft, [f]: e.target.value })} className={INPUT} aria-label={f} /></td>
      ))}
      <td />
      <td className="p-1.5 text-right whitespace-nowrap">
        <button type="button" className="btn btn-sm btn-primary" disabled={pending} onClick={save}>Save</button>{" "}
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
      </td>
    </tr>
  );

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="!mb-0">LV panels — standard hours per unit</h2>
        <span className="text-[11px] text-muted">from the timings sheet&apos;s LV tab · an order finds its row by FG code, or through its SEC item (908569105 → FG-SUSA-8569105)</span>
      </div>
      {err && <p className="text-sm font-semibold text-bad-fg bg-bad-bg rounded-lg px-3 py-2">{err}</p>}

      <div className={`text-sm rounded-lg px-3 py-2 ${unpriced.length ? "bg-warn-bg text-warn-fg" : "bg-ok-bg text-ok-fg"}`}>
        <b className="tabnum">{pricedUnits}</b> of <b className="tabnum">{openUnits}</b> units on the open panel orders have a row.
        {unpriced.length > 0 && (
          <> Not priced: {unpriced.map((o, i) => (
            <span key={o.mo}>{i > 0 && ", "}<b className="ltr">{o.mo}</b> ({o.fgCode ?? "no FG"}{o.secItem ? ` · SEC ${o.secItem}` : ""}, {o.planQty} units)</span>
          ))} — add its row below.</>
        )}
      </div>

      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand text-white text-center">
              <th className="p-2 text-left">FG code</th>
              <th className="p-2">Kind</th>
              {FIELDS.map(([f, label, tip]) => <th key={f} className="p-2 text-right" title={tip}>{label}</th>)}
              <th className="p-2 text-right" title="The sheet's full per-unit figure, assembly and wiring included">Sheet total</th>
              <th className="p-2 w-36" />
            </tr>
          </thead>
          <tbody>
            {rates.map((r) => editing === r.fg ? editRow(r.fg) : (
              <tr key={r.fg} className="border-t">
                <td className="p-2">
                  <div className="font-bold ltr text-xs">{r.fg}</div>
                  {r.description && <div className="text-[11px] text-muted truncate max-w-[18rem]" title={r.description}>{r.description}</div>}
                  {usedBy.has(r.fg) && <span className="pill pill-ok text-[10px]">{usedBy.get(r.fg)} units open</span>}
                </td>
                <td className="p-2 text-center text-xs">{r.kind === "MB" ? "Meter box" : r.kind === "FP" ? "Feeder pillar" : "USS"}</td>
                {FIELDS.map(([f]) => <td key={f} className="p-2 text-right tabnum">{fmt(r[f])}</td>)}
                <td className="p-2 text-right tabnum text-muted">{fmt(r.totalH)}</td>
                <td className="p-2 text-right whitespace-nowrap">
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => start(r)}>Edit</button>
                  <button
                    type="button" className="btn btn-sm btn-ghost text-bad-fg" disabled={pending}
                    onClick={() => {
                      if (!confirm(`Delete ${r.fg}?${usedBy.has(r.fg) ? ` ${usedBy.get(r.fg)} open units are priced by it.` : ""}`)) return;
                      const fd = new FormData(); fd.set("fg", r.fg); run(deleteLvStdTime, fd);
                    }}
                  >Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="btn btn-sm btn-secondary" disabled={editing !== null} onClick={() => start(null)}>＋ Add a panel</button>
      {editing === "" && (
        <Modal title="＋ Add a panel" sub="Standard hours for one unit, by stage." onClose={() => setEditing(null)} busy={pending} width="max-w-3xl">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-bold text-muted uppercase tracking-wide">FG code</span>
                <input value={draft.fg} onChange={(e) => setDraft({ ...draft, fg: e.target.value })} required placeholder="FG-SUSA-8569105" className="border rounded px-1.5 py-1 w-48 ltr bg-surface" />
              </label>
              <label className="flex flex-col gap-1 flex-1 min-w-48">
                <span className="text-[11px] font-bold text-muted uppercase tracking-wide">Description</span>
                <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Description" className="border rounded px-1.5 py-1 w-full bg-surface" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-bold text-muted uppercase tracking-wide">Kind</span>
                <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} className="border rounded px-1 py-1 bg-surface">
                  <option value="USS">USS</option><option value="MB">Meter box</option><option value="FP">Feeder pillar</option>
                </select>
              </label>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              {FIELDS.map(([f, label, tip]) => (
                <label key={f} className="flex flex-col gap-1" title={tip}>
                  <span className="text-[11px] font-bold text-muted uppercase tracking-wide">{label}</span>
                  <input type="number" step="0.01" min="0" value={draft[f]} onChange={(e) => setDraft({ ...draft, [f]: e.target.value })} className={INPUT} />
                </label>
              ))}
            </div>
            {err && <p className="text-sm font-semibold text-bad-fg">{err}</p>}
            <div className="flex justify-end gap-2 pt-3 border-t">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(null)} disabled={pending}>Cancel</button>
              <button type="submit" className="btn btn-sm btn-primary" disabled={pending}>Save</button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

