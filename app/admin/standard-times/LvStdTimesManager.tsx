"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Layers, Plus } from "lucide-react";
import { upsertLvStdTime, deleteLvStdTime } from "./actions";
import type { LvRate } from "@/lib/domain/lvStd";
import { Modal } from "@/components/Modal";
import { SectionCard } from "@/components/primitives";

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
const INPUT = "px-1.5 py-1 w-20 text-right tabnum";
const KIND_LABEL: Record<string, string> = { USS: "USS", MB: "Meter box", FP: "Feeder pillar" };

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
    <tr key={`edit-${key}`} className="bg-surface-2/50">
      <td className="ps-4 md:ps-5 py-1.5">
        {key === "" ? <input value={draft.fg} onChange={(e) => setDraft({ ...draft, fg: e.target.value })} placeholder="FG-SUSA-8569105" className="px-1.5 py-1 w-44 ltr" aria-label="FG code" /> : <b className="ltr">{key}</b>}
        <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Description" className="px-1.5 py-1 w-44 mt-1 block text-xs" aria-label="Description" />
      </td>
      <td className="py-1.5">
        <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} className="ctl" aria-label="Kind">
          <option value="USS">USS</option><option value="MB">Meter box</option><option value="FP">Feeder pillar</option>
        </select>
      </td>
      {FIELDS.map(([f]) => (
        <td key={f} className="py-1.5 text-end"><input type="number" step="0.01" min="0" value={draft[f]} onChange={(e) => setDraft({ ...draft, [f]: e.target.value })} className={INPUT} aria-label={f} /></td>
      ))}
      <td />
      <td className="py-1.5 pe-4 md:pe-5 text-end whitespace-nowrap">
        <span className="inline-flex gap-1">
          <button type="button" className="btn btn-sm btn-primary" disabled={pending} onClick={save}>Save</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
        </span>
      </td>
    </tr>
  );

  return (
    <SectionCard
      icon={Layers}
      title="LV panels — standard hours per unit"
      description="From the timings sheet's LV tab. An order finds its row by FG code, or through its SEC item (908569105 → FG-SUSA-8569105)."
      padded={false}
      end={
        <button type="button" className="btn btn-sm btn-secondary" disabled={editing !== null} onClick={() => start(null)}>
          <Plus size={14} aria-hidden /> Panel
        </button>
      }
    >
      <div className="px-4 md:px-5 pb-3 space-y-2">
        {err && <p className="alert alert-bad">{err}</p>}
        <div className={`alert ${unpriced.length ? "alert-warn" : "alert-ok"}`}>
          <span>
            <b className="tabnum">{pricedUnits}</b> of <b className="tabnum">{openUnits}</b> units on the open panel orders have a row.
            {unpriced.length > 0 && (
              <> Not priced: {unpriced.map((o, i) => (
                <span key={o.mo}>{i > 0 && ", "}<b className="ltr">{o.mo}</b> ({o.fgCode ?? "no FG"}{o.secItem ? ` · SEC ${o.secItem}` : ""}, {o.planQty} units)</span>
              ))} — add its row below.</>
            )}
          </span>
        </div>
      </div>

      <div className="overflow-x-auto border-t">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="text-start ps-4 md:ps-5">FG code</th>
              <th className="text-center">Kind</th>
              {FIELDS.map(([f, label, tip]) => <th key={f} className="text-end" title={tip}>{label}</th>)}
              <th className="text-end" title="The sheet's full per-unit figure, assembly and wiring included">Sheet total</th>
              <th className="text-end pe-4 md:pe-5 w-32" />
            </tr>
          </thead>
          <tbody>
            {rates.map((r) => editing === r.fg ? editRow(r.fg) : (
              <tr key={r.fg}>
                <td className="ps-4 md:ps-5">
                  <div className="font-bold ltr text-xs">{r.fg}</div>
                  {r.description && <div className="text-[11px] text-muted truncate max-w-[18rem]" title={r.description}>{r.description}</div>}
                  {usedBy.has(r.fg) && <span className="pill pill-ok text-[11px]">{usedBy.get(r.fg)} units open</span>}
                </td>
                <td className="text-center text-xs">{KIND_LABEL[r.kind] ?? r.kind}</td>
                {FIELDS.map(([f]) => <td key={f} className="text-end tabnum">{fmt(r[f])}</td>)}
                <td className="text-end tabnum text-muted">{fmt(r.totalH)}</td>
                <td className="text-end pe-4 md:pe-5 whitespace-nowrap">
                  <span className="inline-flex gap-1">
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => start(r)}>Edit</button>
                    <button
                      type="button" className="btn btn-sm btn-ghost text-bad-fg" disabled={pending}
                      onClick={() => {
                        if (!confirm(`Delete ${r.fg}?${usedBy.has(r.fg) ? ` ${usedBy.get(r.fg)} open units are priced by it.` : ""}`)) return;
                        const fd = new FormData(); fd.set("fg", r.fg); run(deleteLvStdTime, fd);
                      }}
                    >Delete</button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing === "" && (
        <Modal title="Add a panel" sub="Standard hours for one unit, by stage." onClose={() => setEditing(null)} busy={pending} width="max-w-3xl">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
            <div className="flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="field-label">FG code</span>
                <input value={draft.fg} onChange={(e) => setDraft({ ...draft, fg: e.target.value })} required placeholder="FG-SUSA-8569105" className="px-1.5 py-1 w-48 ltr" />
              </label>
              <label className="block flex-1 min-w-48">
                <span className="field-label">Description</span>
                <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Description" className="px-1.5 py-1 w-full" />
              </label>
              <label className="block">
                <span className="field-label">Kind</span>
                <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} className="ctl w-full">
                  <option value="USS">USS</option><option value="MB">Meter box</option><option value="FP">Feeder pillar</option>
                </select>
              </label>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              {FIELDS.map(([f, label, tip]) => (
                <label key={f} className="block" title={tip}>
                  <span className="field-label">{label}</span>
                  <input type="number" step="0.01" min="0" value={draft[f]} onChange={(e) => setDraft({ ...draft, [f]: e.target.value })} className={INPUT} />
                </label>
              ))}
            </div>
            {err && <p className="alert alert-bad">{err}</p>}
            <div className="flex justify-end gap-2 pt-3 border-t">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(null)} disabled={pending}>Cancel</button>
              <button type="submit" className="btn btn-sm btn-primary" disabled={pending}>Save</button>
            </div>
          </form>
        </Modal>
      )}
    </SectionCard>
  );
}
