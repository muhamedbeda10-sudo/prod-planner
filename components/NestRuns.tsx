"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/Modal";
import { createNestRun, deleteNestRun, type NestRunResult } from "@/app/worklist/nestRunActions";
import { assignLineMachine } from "@/app/worklist/machineActions";
import { RUN_BOM, RUN_ITEM, expectedSheets, runMo, runTitle, type NestRunView } from "@/lib/domain/nestRun";
import { sheetKeyLabel } from "@/lib/domain/machineMaterial";
import { MATERIAL_PRESETS, SHEET_SIZE_PRESETS } from "@/lib/domain/material";
import { formatDate } from "@/lib/domain/format";
import type { MachineDTO } from "@/lib/server/machines";
import type { RunCandidate, RunSheetOption } from "@/lib/server/machineBoard";

// 🧩 Nest runs: sheets of one material and thickness on a cutting machine,
// the nesting on them carrying parts of several jobs. Put together by hand
// here — the sheet, how many, and each job's part with its pieces — and
// recorded on the card by the sheets finished.

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState("");
  const run = (fn: (fd: FormData) => Promise<NestRunResult>, fd: FormData, after?: () => void) => {
    setErr("");
    start(async () => {
      const r = await fn(fd);
      if (!r.ok) { setErr(r.error ?? "Could not save."); return; }
      after?.();
      router.refresh();
    });
  };
  return { pending, err, setErr, run };
}

const OTHER = "__other";

interface PartRow { key: string; pcs: string }

/** "🧩 Nest run" — sheets of one thickness, carrying parts of several jobs. */
export function AddNestRun({ machines, options, candidates }: { machines: MachineDTO[]; options: RunSheetOption[]; candidates: RunCandidate[] }) {
  const [open, setOpen] = useState(false);
  const a = useRun();
  const [sheet, setSheet] = useState(options[0]?.sheet ?? OTHER);
  const [other, setOther] = useState({ thicknessMm: "", material: "Steel", sheetSize: "" });
  const [sheets, setSheets] = useState("");
  const [parts, setParts] = useState<PartRow[]>([]);
  const opt = options.find((o) => o.sheet === sheet);
  // the lines a part can come from: the ones whose nesting has this sheet,
  // or any open line for a sheet the nesting does not list
  const choices = useMemo(
    () => (opt ? opt.lines.map((l) => ({ key: l.key, label: `${l.bom} ${l.item} · ${l.mo || "no MO"} — ${l.free} free`, free: l.free, perUnit: l.perUnit as number | null }))
      : candidates.map((c) => ({ key: c.key, label: `${c.bom} ${c.item} · ${c.mo || "no MO"} — ${c.remaining} left`, free: c.remaining, perUnit: null as number | null }))),
    [opt, candidates]
  );
  const byKey = new Map(choices.map((c) => [c.key, c]));
  const est = expectedSheets(parts.map((p) => ({ pcs: Number(p.pcs) || 0, perUnit: byKey.get(p.key)?.perUnit ?? null })));
  const nSheets = Number(sheets);
  const off = est !== null && nSheets > 0 && Math.abs(nSheets - est) / Math.max(est, 1) > 0.25;

  const pickSheet = (v: string) => { setSheet(v); setParts([]); };
  const addPart = () => {
    const used = new Set(parts.map((p) => p.key));
    const next = choices.find((c) => !used.has(c.key));
    if (next) setParts([...parts, { key: next.key, pcs: String(next.free) }]);
  };
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const spec = opt ? { thicknessMm: String(opt.thicknessMm), material: opt.material, sheetSize: opt.sheetSize } : other;
    fd.set("thicknessMm", spec.thicknessMm); fd.set("material", spec.material); fd.set("sheetSize", spec.sheetSize);
    fd.set("parts", JSON.stringify(parts.map((p) => { const [bom, mo, item] = p.key.split("|"); return { bom, mo, item, pcs: Number(p.pcs) }; })));
    a.run(createNestRun, fd, () => { setOpen(false); setParts([]); setSheets(""); });
  };
  const field = "border rounded-md px-2 py-1.5 bg-surface text-sm";
  const label = "block text-xs font-semibold text-muted mb-0.5";
  return (
    <>
      <button type="button" className="btn btn-sm btn-secondary ms-1 normal-case no-print" onClick={() => setOpen(true)} title="Sheets of one thickness carrying parts of several jobs — put them on a laser as one run">
        🧩 Nest run
      </button>
      {open && (
        <Modal title="🧩 New nest run" sub="Sheets of one material and thickness, the nesting on them carrying parts of several jobs. The technician records it by the sheets finished." onClose={() => setOpen(false)} busy={a.pending} width="max-w-3xl">
          <form onSubmit={submit} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="sm:col-span-2"><span className={label}>Sheet</span>
                <select value={sheet} onChange={(e) => pickSheet(e.target.value)} className={`${field} w-full`}>
                  {options.map((o) => <option key={o.sheet} value={o.sheet}>{sheetKeyLabel(o.sheet)} — {o.lines.length} line(s) need it</option>)}
                  <option value={OTHER}>Another sheet — type it</option>
                </select>
              </label>
              <label><span className={label}>Sheets *</span>
                <input name="sheets" type="number" min={1} step={1} required value={sheets} onChange={(e) => setSheets(e.target.value)} className={`${field} w-full tabnum`} />
              </label>
              {!opt && (
                <>
                  <label><span className={label}>Thickness (mm) *</span>
                    <input type="number" min={0} step="0.1" required value={other.thicknessMm} onChange={(e) => setOther({ ...other, thicknessMm: e.target.value })} className={`${field} w-full tabnum`} />
                  </label>
                  <label><span className={label}>Material *</span>
                    <input list="run-materials" required value={other.material} onChange={(e) => setOther({ ...other, material: e.target.value })} className={`${field} w-full`} />
                    <datalist id="run-materials">{MATERIAL_PRESETS.map((m) => <option key={m} value={m} />)}</datalist>
                  </label>
                  <label><span className={label}>Sheet size</span>
                    <input list="run-sizes" value={other.sheetSize} onChange={(e) => setOther({ ...other, sheetSize: e.target.value })} className={`${field} w-full`} placeholder="1250*2500" />
                    <datalist id="run-sizes">{SHEET_SIZE_PRESETS.map((m) => <option key={m} value={m} />)}</datalist>
                  </label>
                </>
              )}
              <label className="sm:col-span-2"><span className={label}>Laser</span>
                <select name="machineId" defaultValue={machines[0]?.id ?? ""} className={`${field} w-full`}>
                  <option value="">— none yet, just save it —</option>
                  {machines.map((m) => <option key={m.id} value={m.id}>{m.code} · {m.name}</option>)}
                </select>
              </label>
              <label><span className={label}>Note</span>
                <input name="note" maxLength={500} className={`${field} w-full`} placeholder="Nest no., program…" />
              </label>
            </div>

            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[11px] font-bold uppercase tracking-wide text-muted">What is on the sheets</span>
                <button type="button" className="btn btn-sm btn-ghost ms-auto" onClick={addPart} disabled={choices.length === parts.length}>+ Add a job&apos;s part</button>
              </div>
              {choices.length === 0 ? (
                <p className="text-xs text-muted">No open line needs this sheet.</p>
              ) : parts.length === 0 ? (
                <p className="text-xs text-muted">Add the parts the nesting put on these sheets — {choices.length} line(s) can.</p>
              ) : (
                <table className="w-full text-sm border-collapse">
                  <thead><tr className="text-left text-xs text-muted border-b"><th className="p-1.5">Job · part</th><th className="p-1.5 w-24">Pieces</th><th className="p-1.5 w-24 text-right">≈ sheets</th><th className="w-8"></th></tr></thead>
                  <tbody>
                    {parts.map((p, i) => {
                      const c = byKey.get(p.key);
                      const sh = c?.perUnit ? Math.round((Number(p.pcs) || 0) * c.perUnit * 100) / 100 : null;
                      return (
                        <tr key={i} className="border-b">
                          <td className="p-1.5">
                            <select value={p.key} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { key: e.target.value, pcs: String(byKey.get(e.target.value)?.free ?? x.pcs) } : x)))} className={`${field} w-full`}>
                              {choices.filter((ch) => ch.key === p.key || !parts.some((x) => x.key === ch.key)).map((ch) => <option key={ch.key} value={ch.key}>{ch.label}</option>)}
                            </select>
                          </td>
                          <td className="p-1.5"><input type="number" min={1} step={1} value={p.pcs} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, pcs: e.target.value } : x)))} className={`${field} w-full tabnum`} /></td>
                          <td className="p-1.5 text-right tabnum text-muted">{sh ?? "—"}</td>
                          <td className="p-1.5"><button type="button" className="btn btn-sm btn-ghost text-bad-fg" onClick={() => setParts(parts.filter((_, j) => j !== i))} aria-label="Remove">✕</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {est !== null && (
                <p className={`text-xs mt-1 ${off ? "text-warn-fg font-semibold" : "text-muted"}`}>
                  By the nesting&apos;s rates these parts take ≈ <b className="tabnum">{est}</b> sheet(s){nSheets > 0 ? ` — the run says ${nSheets}` : ""}{off ? ". Worth a second look." : "."}
                </p>
              )}
            </div>

            {a.err && <p className="text-sm font-semibold text-bad-fg">{a.err}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)} disabled={a.pending}>Cancel</button>
              <button type="submit" className="btn btn-sm btn-primary" disabled={a.pending || parts.length === 0}>{a.pending ? "Saving…" : "Save run"}</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

/** 📋 The nest runs — open ones first, then the finished — with what each
 *  carried and how far it got. */
export function NestRunsList({ runs, machines, canEdit }: { runs: NestRunView[]; machines: MachineDTO[]; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const a = useRun();
  const openCount = runs.filter((r) => !r.doneAtISO).length;
  const putOn = (r: NestRunView, machineId: string) => {
    const fd = new FormData();
    fd.set("dept", "Cut"); fd.set("bom", RUN_BOM); fd.set("mo", runMo(r.id)); fd.set("item", RUN_ITEM); fd.set("machineId", machineId);
    a.run(assignLineMachine, fd);
  };
  const del = (r: NestRunView) => {
    if (!confirm(`Delete the run ${runTitle(r)}?`)) return;
    const fd = new FormData();
    fd.set("id", String(r.id));
    a.run(deleteNestRun, fd);
  };
  return (
    <>
      <button type="button" className="btn btn-sm btn-ghost ms-1 normal-case no-print" onClick={() => setOpen(true)} title="Every nest run — open and finished">
        📋 Runs{openCount > 0 ? ` (${openCount})` : ""}
      </button>
      {open && (
        <Modal title="📋 Nest runs" sub="Sheets of one thickness carrying parts of several jobs — what each carried and how far it got." onClose={() => setOpen(false)} busy={a.pending} width="max-w-5xl">
          {runs.length === 0 ? (
            <p className="text-sm text-muted">None yet — 🧩 Nest run puts one together.</p>
          ) : (
            <div className="space-y-2 max-h-[65vh] overflow-y-auto pe-1">
              {runs.map((r) => {
                const done = !!r.doneAtISO;
                return (
                  <div key={r.id} className={`rounded-lg border px-3 py-2 ${done ? "opacity-70" : ""}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <b>{runTitle(r)}</b>
                      <span className="tabnum text-sm"><b>{r.sheetsDone}</b> / {r.sheets} sheets cut</span>
                      {done ? <span className="pill pill-ok">✓ done {formatDate(r.doneAtISO!.slice(0, 10))}</span>
                        : r.onMachines.length > 0 ? <span className="pill pill-muted">on {r.onMachines.join(", ")}</span>
                        : <span className="pill pill-warn">on no laser</span>}
                      <span className="text-xs text-muted">{formatDate(r.createdAtISO.slice(0, 10))}{r.createdBy ? ` · ${r.createdBy}` : ""}{r.note ? ` · ${r.note}` : ""}</span>
                      {canEdit && !done && (
                        <span className="ms-auto inline-flex items-center gap-1">
                          <select className="border rounded-md px-1.5 py-1 bg-surface text-xs" value="" disabled={a.pending} onChange={(e) => { if (e.target.value) putOn(r, e.target.value); }} title="Put it on a laser — at the back of its queue">
                            <option value="">{r.onMachines.length > 0 ? "Move to…" : "Put on…"}</option>
                            {machines.map((m) => <option key={m.id} value={m.id}>{m.code}</option>)}
                          </select>
                          {r.sheetsDone === 0 && <button type="button" className="btn btn-sm btn-ghost text-bad-fg" disabled={a.pending} onClick={() => del(r)} title="Delete — put together by mistake">✕</button>}
                        </span>
                      )}
                    </div>
                    <ul className="mt-1 grid gap-x-4 sm:grid-cols-2 text-xs">
                      {r.parts.map((p) => (
                        <li key={p.id} className="flex gap-2"><b>{p.bom} {p.item}</b><span className="text-muted">{p.mo || "no MO"}</span><span className="ms-auto tabnum">{p.donePcs} / {p.pcs} cut</span></li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
          {a.err && <p className="text-sm font-semibold text-bad-fg mt-2">{a.err}</p>}
        </Modal>
      )}
    </>
  );
}
