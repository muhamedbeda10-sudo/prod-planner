"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/Modal";
import { createNestRun, deleteNestRun, type NestRunResult } from "@/app/worklist/nestRunActions";
import { assignLineMachine } from "@/app/worklist/machineActions";
import { RUN_BOM, RUN_ITEM, expectedSheets, minutesPerSheet, minutesText, runMo, runTitle, type NestRunView } from "@/lib/domain/nestRun";
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
const MAX_SHEET_TIMES = 60;

/** One job the run can carry: a BOM's part, every open order of it together
 *  (the floor knows a job by its BOM and the plan's Required, not its MO). */
interface JobChoice {
  key: string; // bom|item
  bom: string;
  item: string;
  required: number;
  material: string;
  materialCode: string;
  jobSheets: number | null;
  perUnit: number | null;
  free: number;
  /** The orders behind it, in the order their pieces are filled. */
  lines: { key: string; free: number }[];
}

interface PartRow { job: string; pcs: string }

const fmt = (n: number) => String(Math.round(n * 100) / 100);

function groupJobs(opt: RunSheetOption | undefined, candidates: RunCandidate[]): JobChoice[] {
  const by = new Map<string, JobChoice>();
  const add = (l: { key: string; bom: string; item: string; required: number; free: number; material?: string; materialCode?: string; jobSheets?: number | null; perUnit?: number | null }) => {
    const k = `${l.bom}|${l.item}`;
    const cur = by.get(k) ?? { key: k, bom: l.bom, item: l.item, required: l.required, material: l.material ?? "", materialCode: l.materialCode ?? "", jobSheets: l.jobSheets ?? null, perUnit: l.perUnit ?? null, free: 0, lines: [] };
    cur.free += l.free;
    cur.lines.push({ key: l.key, free: l.free });
    if (cur.jobSheets === null && l.jobSheets != null) cur.jobSheets = l.jobSheets;
    by.set(k, cur);
  };
  if (opt) for (const l of opt.lines) add(l);
  else for (const c of candidates) add({ key: c.key, bom: c.bom, item: c.item, required: c.required, free: c.remaining });
  return [...by.values()];
}

/** A job's pieces over the orders behind it: each takes what it has free,
 *  in turn; anything past that lands on the last. */
function spread(job: JobChoice, pcs: number): { key: string; pcs: number }[] {
  const out: { key: string; pcs: number }[] = [];
  let left = pcs;
  job.lines.forEach((l, i) => {
    if (left <= 0) return;
    const take = i === job.lines.length - 1 ? left : Math.min(left, l.free);
    if (take > 0) out.push({ key: l.key, pcs: take });
    left -= take;
  });
  return out;
}

/** "🧩 Nest run" — sheets of one thickness, carrying parts of several jobs. */
export function AddNestRun({ machines, options, candidates }: { machines: MachineDTO[]; options: RunSheetOption[]; candidates: RunCandidate[] }) {
  const [open, setOpen] = useState(false);
  const a = useRun();
  const [sheet, setSheet] = useState(options[0]?.sheet ?? OTHER);
  const [other, setOther] = useState({ thicknessMm: "", material: "Steel", sheetSize: "" });
  const [sheets, setSheets] = useState("");
  const [identical, setIdentical] = useState(true);
  const [minutes, setMinutes] = useState<string[]>([]);
  const [parts, setParts] = useState<PartRow[]>([]);
  const [q, setQ] = useState("");
  const opt = options.find((o) => o.sheet === sheet);
  const jobs = useMemo(() => groupJobs(opt, candidates), [opt, candidates]);
  const byJob = new Map(jobs.map((j) => [j.key, j]));
  const nSheets = Number(sheets);
  const sheetCount = Number.isInteger(nSheets) && nSheets > 0 ? Math.min(nSheets, MAX_SHEET_TIMES) : 0;

  // the time: one sheet's minutes × the sheets, or every sheet's own
  const mins = identical ? [minutes[0] ?? ""] : Array.from({ length: sheetCount }, (_, i) => minutes[i] ?? "");
  const totalMin = identical
    ? (Number(minutes[0]) || 0) * (nSheets > 0 ? nSheets : 0)
    : mins.reduce((s, m) => s + (Number(m) || 0), 0);
  const setMin = (i: number, v: string) => setMinutes((cur) => { const next = [...cur]; next[i] = v; return next; });

  const est = expectedSheets(parts.map((p) => ({ pcs: Number(p.pcs) || 0, perUnit: byJob.get(p.job)?.perUnit ?? null })));
  const off = est !== null && nSheets > 0 && Math.abs(nSheets - est) / Math.max(est, 1) > 0.25;
  const chosen = new Set(parts.map((p) => p.job));
  const needle = q.trim().toUpperCase();
  const browse = jobs.filter((j) => !chosen.has(j.key) && (!needle || `${j.bom} ${j.item} ${j.material} ${j.materialCode}`.toUpperCase().includes(needle)));

  const pickSheet = (v: string) => { setSheet(v); setParts([]); setQ(""); };
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const spec = opt ? { thicknessMm: String(opt.thicknessMm), material: opt.material, sheetSize: opt.sheetSize } : other;
    fd.set("thicknessMm", spec.thicknessMm); fd.set("material", spec.material); fd.set("sheetSize", spec.sheetSize);
    fd.set("identical", identical ? "true" : "false");
    fd.set("minutes", JSON.stringify(mins));
    const out: { bom: string; mo: string; item: string; pcs: number }[] = [];
    for (const p of parts) {
      const job = byJob.get(p.job);
      if (!job) continue;
      for (const s of spread(job, Number(p.pcs) || 0)) { const [bom, mo, item] = s.key.split("|"); out.push({ bom, mo, item, pcs: s.pcs }); }
    }
    fd.set("parts", JSON.stringify(out));
    a.run(createNestRun, fd, () => { setOpen(false); setParts([]); setSheets(""); setMinutes([]); setQ(""); });
  };
  const field = "border rounded-md px-2 py-1.5 bg-surface text-sm";
  const label = "block text-xs font-semibold text-muted mb-0.5";
  const th = "p-1.5 text-left text-[11px] font-bold uppercase tracking-wide text-muted";
  const matCell = (j: JobChoice) => (j.material ? <span>{j.material}{j.materialCode && <span className="text-muted"> · {j.materialCode}</span>}</span> : <span className="text-muted">—</span>);
  return (
    <>
      <button type="button" className="btn btn-sm btn-secondary ms-1 normal-case no-print" onClick={() => setOpen(true)} title="Sheets of one thickness carrying parts of several jobs — put them on a laser as one run">
        🧩 Nest run
      </button>
      {open && (
        <Modal title="🧩 New nest run" sub="Sheets of one material and thickness, the nesting on them carrying parts of several jobs. The technician records it by the sheets finished." onClose={() => setOpen(false)} busy={a.pending} width="max-w-5xl">
          <form onSubmit={submit} className="space-y-4">
            {/* the sheet */}
            <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
              <label className="col-span-2 sm:col-span-3"><span className={label}>Sheet</span>
                <select value={sheet} onChange={(e) => pickSheet(e.target.value)} className={`${field} w-full`}>
                  {options.map((o) => <option key={o.sheet} value={o.sheet}>{sheetKeyLabel(o.sheet)} — {new Set(o.lines.map((l) => `${l.bom}|${l.item}`)).size} job(s)</option>)}
                  <option value={OTHER}>Another sheet — type it</option>
                </select>
              </label>
              <label><span className={label}>Sheets *</span>
                <input name="sheets" type="number" min={1} step={1} required value={sheets} onChange={(e) => setSheets(e.target.value)} className={`${field} w-full tabnum`} />
              </label>
              <label className="col-span-1 sm:col-span-2"><span className={label}>Laser</span>
                <select name="machineId" defaultValue={machines[0]?.id ?? ""} className={`${field} w-full`}>
                  <option value="">— none yet —</option>
                  {machines.map((m) => <option key={m.id} value={m.id}>{m.code} · {m.name}</option>)}
                </select>
              </label>
              {!opt && (
                <>
                  <label className="col-span-1 sm:col-span-2"><span className={label}>Thickness (mm) *</span>
                    <input type="number" min={0} step="0.1" required value={other.thicknessMm} onChange={(e) => setOther({ ...other, thicknessMm: e.target.value })} className={`${field} w-full tabnum`} />
                  </label>
                  <label className="col-span-1 sm:col-span-2"><span className={label}>Material *</span>
                    <input list="run-materials" required value={other.material} onChange={(e) => setOther({ ...other, material: e.target.value })} className={`${field} w-full`} />
                    <datalist id="run-materials">{MATERIAL_PRESETS.map((m) => <option key={m} value={m} />)}</datalist>
                  </label>
                  <label className="col-span-2"><span className={label}>Sheet size</span>
                    <input list="run-sizes" value={other.sheetSize} onChange={(e) => setOther({ ...other, sheetSize: e.target.value })} className={`${field} w-full`} placeholder="1220*2440" />
                    <datalist id="run-sizes">{SHEET_SIZE_PRESETS.map((m) => <option key={m} value={m} />)}</datalist>
                  </label>
                </>
              )}
            </div>

            {/* the time */}
            <div className="rounded-lg border px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-[11px] font-bold uppercase tracking-wide text-muted">Cutting time</span>
                <span className="inline-flex rounded-lg border p-0.5 text-xs font-bold">
                  <button type="button" onClick={() => setIdentical(true)} className={`rounded-md px-2.5 py-1 ${identical ? "bg-brand text-white" : "text-muted"}`}>Identical sheets</button>
                  <button type="button" onClick={() => setIdentical(false)} className={`rounded-md px-2.5 py-1 ${!identical ? "bg-brand text-white" : "text-muted"}`}>Different sheets</button>
                </span>
                {identical && (
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input type="number" min={0} step="0.5" value={minutes[0] ?? ""} onChange={(e) => setMin(0, e.target.value)} className={`${field} w-24 tabnum`} placeholder="min" />
                    <span className="text-muted">min a sheet</span>
                  </label>
                )}
                <span className="ms-auto text-sm">{totalMin > 0 ? <>Run: <b className="tabnum">{minutesText(totalMin)}</b></> : <span className="text-xs text-muted">optional — without it the parts&apos; standard times stand in</span>}</span>
              </div>
              {!identical && (
                sheetCount === 0 ? <p className="text-xs text-muted mt-2">Put the number of sheets first — then each sheet&apos;s time.</p> : (
                  <div className="mt-2 grid grid-cols-3 sm:grid-cols-6 lg:grid-cols-8 gap-2">
                    {mins.map((m, i) => (
                      <label key={i} className="text-xs"><span className="block text-muted mb-0.5">Sheet {i + 1}</span>
                        <input type="number" min={0} step="0.5" value={m} onChange={(e) => setMin(i, e.target.value)} className={`${field} w-full tabnum`} placeholder="min" />
                      </label>
                    ))}
                  </div>
                )
              )}
            </div>

            {/* what is on the sheets */}
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wide text-muted mb-1">On the sheets</div>
              {parts.length === 0 ? (
                <p className="text-xs text-muted rounded-lg border border-dashed px-3 py-2">Pick the jobs the nesting put on these sheets from the list below.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-sm border-collapse">
                    <thead className="bg-surface-2"><tr><th className={th}>BOM ref</th><th className={th}>Item</th><th className={`${th} text-right`}>Required</th><th className={th}>Material</th><th className={`${th} text-right`}>No. of sheets</th><th className={`${th} w-24`}>Pieces</th><th className={`${th} text-right`}>≈ sheets</th><th className="w-8"></th></tr></thead>
                    <tbody>
                      {parts.map((p, i) => {
                        const j = byJob.get(p.job);
                        if (!j) return null;
                        const sh = j.perUnit ? (Number(p.pcs) || 0) * j.perUnit : null;
                        return (
                          <tr key={p.job} className="border-t">
                            <td className="p-1.5 font-bold whitespace-nowrap">{j.bom}</td>
                            <td className="p-1.5 font-semibold">{j.item}</td>
                            <td className="p-1.5 text-right tabnum">{fmt(j.required)}</td>
                            <td className="p-1.5 text-xs">{matCell(j)}</td>
                            <td className="p-1.5 text-right tabnum">{j.jobSheets !== null ? fmt(j.jobSheets) : "—"}</td>
                            <td className="p-1.5"><input type="number" min={1} step={1} value={p.pcs} onChange={(e) => setParts(parts.map((x, k) => (k === i ? { ...x, pcs: e.target.value } : x)))} className={`${field} w-full tabnum`} title={`${j.free} free on this job`} /></td>
                            <td className="p-1.5 text-right tabnum text-muted">{sh !== null ? fmt(sh) : "—"}</td>
                            <td className="p-1.5"><button type="button" className="btn btn-sm btn-ghost text-bad-fg" onClick={() => setParts(parts.filter((_, k) => k !== i))} aria-label="Remove">✕</button></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {est !== null && (
                <p className={`text-xs mt-1 ${off ? "text-warn-fg font-semibold" : "text-muted"}`}>
                  By the nesting&apos;s rates these parts take ≈ <b className="tabnum">{est}</b> sheet(s){nSheets > 0 ? ` — the run says ${nSheets}` : ""}{off ? ". Worth a second look." : "."}
                </p>
              )}
            </div>

            {/* the jobs that can go on them */}
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[11px] font-bold uppercase tracking-wide text-muted">Jobs that need {opt ? sheetKeyLabel(opt.sheet) : "a sheet"}</span>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search BOM / item / material…" className={`${field} ms-auto w-64 py-1`} />
              </div>
              <div className="rounded-lg border max-h-64 overflow-y-auto">
                {browse.length === 0 ? (
                  <p className="text-xs text-muted px-3 py-2">{jobs.length === 0 ? "No open job needs this sheet." : "Nothing more to add."}</p>
                ) : (
                  <table className="w-full text-sm border-collapse">
                    <thead className="sticky top-0 bg-surface-2 z-10"><tr><th className={th}>BOM ref</th><th className={th}>Item</th><th className={`${th} text-right`}>Required</th><th className={th}>Material</th><th className={`${th} text-right`}>No. of sheets</th><th className={`${th} text-right`}>Free</th><th className="w-10"></th></tr></thead>
                    <tbody>
                      {browse.map((j) => (
                        <tr key={j.key} className="border-t cursor-pointer hover:bg-brand-light/40" onClick={() => setParts([...parts, { job: j.key, pcs: String(j.free) }])} title="Add to the run">
                          <td className="p-1.5 font-bold whitespace-nowrap">{j.bom}</td>
                          <td className="p-1.5 font-semibold">{j.item}</td>
                          <td className="p-1.5 text-right tabnum">{fmt(j.required)}</td>
                          <td className="p-1.5 text-xs">{matCell(j)}</td>
                          <td className="p-1.5 text-right tabnum">{j.jobSheets !== null ? fmt(j.jobSheets) : "—"}</td>
                          <td className="p-1.5 text-right tabnum text-muted">{j.free}</td>
                          <td className="p-1.5 text-center text-accent font-bold">＋</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <label className="block"><span className={label}>Note</span>
              <input name="note" maxLength={500} className={`${field} w-full`} placeholder="Nest no., program…" />
            </label>

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
                      {(() => { const m = minutesPerSheet(r); return m ? <span className="text-xs text-muted tabnum" title={r.identical ? "Identical sheets" : `Per sheet: ${m.join(", ")} min`}>⏱ {minutesText(m.reduce((x, y) => x + y, 0))}{r.identical ? ` (${m[0]} min a sheet)` : ""}</span> : null; })()}
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
                      {groupParts(r.parts).map((p) => (
                        <li key={`${p.bom}|${p.item}`} className="flex gap-2"><b>{p.bom}</b><span className="font-semibold">{p.item}</span><span className="ms-auto tabnum">{p.donePcs} / {p.pcs} cut</span></li>
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

/** A run's parts as the floor reads them: one line per BOM's part, its
 *  orders together. */
function groupParts(parts: NestRunView["parts"]) {
  const by = new Map<string, { bom: string; item: string; pcs: number; donePcs: number }>();
  for (const p of parts) {
    const k = `${p.bom}|${p.item}`;
    const cur = by.get(k) ?? { bom: p.bom, item: p.item, pcs: 0, donePcs: 0 };
    cur.pcs += p.pcs; cur.donePcs += p.donePcs;
    by.set(k, cur);
  }
  return [...by.values()];
}
