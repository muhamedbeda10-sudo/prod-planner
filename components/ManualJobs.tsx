"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/Modal";
import { EmptyState } from "@/components/primitives";
import { ClipboardList } from "lucide-react";
import { createManualJob, deleteManualJob, reopenManualJob, updateManualJob, type ManualActionResult } from "@/app/worklist/manualActions";
import { assignLineMachine } from "@/app/worklist/machineActions";
import { MANUAL_BOM, MANUAL_ITEM, MAX_JOB_PARTS, jobName, jobSheetLabel, jobsBySheet, manualMo, partNameSuggestions, partRowsOf, partsText, type ManualJobView } from "@/lib/domain/manualJob";
import { MATERIAL_PRESETS, SHEET_SIZE_PRESETS } from "@/lib/domain/material";
import { ITEMS, ITEM_NAME } from "@/lib/domain/constants";
import { machineWord } from "@/lib/domain/shifts";
import { formatDate } from "@/lib/domain/format";
import type { MachineDTO } from "@/lib/server/machines";

// ✋ Jobs from outside the plan: typed in on the board and put on a machine
// to be worked like any plan line — and kept, in a list to come back to.
// On the fabrication board a job is SHEETS: one thickness, material and size,
// how many sheets, and every project's part the sheets carry; it is queued,
// split and closed in sheets.

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState("");
  const run = (fn: (fd: FormData) => Promise<ManualActionResult>, fd: FormData, after?: () => void) => {
    setErr("");
    start(async () => {
      const r = await fn(fd);
      if (!r.ok) { setErr(r.error ?? "Could not save."); return; }
      after?.();
      router.refresh();
    });
  };
  return { pending, err, run };
}

const FIELD = "border rounded-md px-2 py-1.5 bg-surface text-sm w-full";
const LABEL = "block text-xs font-semibold text-muted mb-0.5";

/** The job's own fields, as typed — the same form adds a job, changes one
 *  and copies one, so the three never drift apart. `job` fills it in;
 *  `doneQty` is the floor of the pieces when a job is changed; the machine
 *  picker is for a new job only (a job already made is moved with Move to…). */
function JobFields({ dept, job, doneQty = 0, machines, machineCode }: { dept: string; job?: ManualJobView; doneQty?: number; machines?: MachineDTO[]; machineCode?: string | null }) {
  const word = machineWord(dept);
  const num = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
  const preset = machines?.find((m) => m.code === machineCode)?.id ?? machines?.[0]?.id ?? "";
  return (
    <>
      <label className="sm:col-span-2"><span className={LABEL}>What is it? *</span>
        <input name="title" required maxLength={120} className={FIELD} defaultValue={job?.title} placeholder="e.g. Brackets for maintenance, sample tank cover…" autoFocus />
      </label>
      <label><span className={LABEL}>Pieces *</span>
        <input name="qty" type="number" min={Math.max(1, doneQty)} step={1} required className={`${FIELD} tabnum`} defaultValue={job?.qty} />
        {doneQty > 0 && <span className="block text-[11px] text-muted mt-0.5">{doneQty} done already — not fewer than that</span>}
      </label>
      {machines ? (
        <label><span className={LABEL}>{word[0].toUpperCase() + word.slice(1)}</span>
          <select name="machineId" defaultValue={preset} className={FIELD}>
            <option value="">— none yet, just save it —</option>
            {machines.map((m) => <option key={m.id} value={m.id}>{m.code} · {m.name}</option>)}
          </select>
        </label>
      ) : (
        <div className="text-xs text-muted self-end pb-2">
          {job?.doneAtISO ? "Finished — more pieces than are done opens it again, on no " + word + "."
            : job && job.onMachines.length > 0 ? `On ${job.onMachines.join(", ")} — Move to… in the list moves it.`
            : `On no ${word} — Put on… in the list puts it on one.`}
        </div>
      )}
      <label><span className={LABEL}>BOM (if any)</span>
        <input name="bom" maxLength={60} className={FIELD} defaultValue={job?.bom} />
      </label>
      <label><span className={LABEL}>Part / item (if any)</span>
        <input name="item" maxLength={60} className={FIELD} defaultValue={job?.item} placeholder="Tank, bracket…" />
      </label>
      <div className="sm:col-span-2 text-[11px] font-bold uppercase tracking-wide text-muted border-t pt-2">The sheet — for the technician</div>
      <label><span className={LABEL}>Thickness (mm)</span>
        <input name="thicknessMm" type="number" min={0} step="0.1" className={`${FIELD} tabnum`} defaultValue={num(job?.thicknessMm)} />
      </label>
      <label><span className={LABEL}>Material</span>
        <input name="material" list="manual-materials" className={FIELD} defaultValue={job?.material} placeholder="Steel, GI…" />
        <datalist id="manual-materials">{MATERIAL_PRESETS.map((m) => <option key={m} value={m} />)}</datalist>
      </label>
      <label><span className={LABEL}>Sheet size</span>
        <input name="sheetSize" list="manual-sizes" className={FIELD} defaultValue={job?.sheetSize} placeholder="1220*2440" />
        <datalist id="manual-sizes">{SHEET_SIZE_PRESETS.map((m) => <option key={m} value={m} />)}</datalist>
      </label>
      <label><span className={LABEL}>Sheets for the job</span>
        <input name="sheets" type="number" min={0} step="0.01" className={`${FIELD} tabnum`} defaultValue={num(job?.sheets)} />
      </label>
      <label className="sm:col-span-2"><span className={LABEL}>Note</span>
        <input name="note" maxLength={500} className={FIELD} defaultValue={job?.note ?? ""} placeholder="Who asked for it, drawing no., …" />
      </label>
    </>
  );
}

/** One row of a sheet job's parts: its key, and what it opens with. The
 *  fields themselves are uncontrolled — read off the form on Save — so a
 *  tablet's keyboard types and deletes in them without the page re-drawing
 *  under it at every key. */
type PartRow = { key: number; bom: string; item: string; part: string; pcs: string };

let partKey = 0;
const newPart = (p?: Partial<Omit<PartRow, "key">>): PartRow => ({ key: ++partKey, bom: p?.bom ?? "", item: p?.item ?? "", part: p?.part ?? "", pcs: p?.pcs ?? "" });

/** The form's part fields, one name per column — read back in row order. */
const PART_FIELD = { bom: "partBom", item: "partItem", part: "partName", pcs: "partPcs" } as const;

/** A sheet job's parts off the submitted form, as the JSON field the action reads. */
function partsField(fd: FormData): string {
  const col = (k: keyof typeof PART_FIELD) => fd.getAll(PART_FIELD[k]).map(String);
  return JSON.stringify(partRowsOf({ bom: col("bom"), item: col("item"), part: col("part"), pcs: col("pcs") }));
}

/** No keyboard help where it fights the floor's codes and counts. */
const PLAIN = { autoComplete: "off", autoCorrect: "off", spellCheck: false } as const;

/** A sheet job's fields: the sheet (thickness, material, size), how many
 *  sheets, then the parts the sheets carry — a project (BOM), its component,
 *  the part in the planner's words and, if known, the pieces of it — and a
 *  name and note if wanted. */
function SheetJobFields({ dept, job, doneQty = 0, machines, machineCode, boms, partNames }: {
  dept: string; job?: ManualJobView; doneQty?: number; machines?: MachineDTO[]; machineCode?: string | null; boms: string[]; partNames: string[];
}) {
  const word = machineWord(dept);
  const preset = machines?.find((m) => m.code === machineCode)?.id ?? machines?.[0]?.id ?? "";
  const [parts, setParts] = useState<PartRow[]>(() =>
    job && job.parts.length > 0 ? job.parts.map((p) => newPart({ bom: p.bom, item: p.item, part: p.part, pcs: p.pcs === null ? "" : String(p.pcs) })) : [newPart()]);
  // a new row takes the last row's project and component, as they are typed now
  const addPart = (e: React.MouseEvent<HTMLButtonElement>) => {
    const form = e.currentTarget.form;
    const last = (name: string) => {
      const all = form ? [...form.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)] : [];
      return all[all.length - 1]?.value ?? "";
    };
    const bom = last(PART_FIELD.bom);
    const item = last(PART_FIELD.item);
    setParts((rows) => [...rows, newPart({ bom, item })]);
  };
  const num = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
  return (
    <>
      <div className="sm:col-span-2 text-[11px] font-bold uppercase tracking-wide text-muted">The sheets</div>
      <div className="sm:col-span-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label><span className={LABEL}>Thickness (mm) *</span>
          <input name="thicknessMm" type="text" inputMode="decimal" required className={`${FIELD} tabnum`} defaultValue={num(job?.thicknessMm)} autoFocus {...PLAIN} />
        </label>
        <label><span className={LABEL}>Material *</span>
          <input name="material" list="manual-materials" required className={FIELD} defaultValue={job?.material} placeholder="Steel, GI…" {...PLAIN} />
          <datalist id="manual-materials">{MATERIAL_PRESETS.map((m) => <option key={m} value={m} />)}</datalist>
        </label>
        <label><span className={LABEL}>Sheet size</span>
          <input name="sheetSize" list="manual-sizes" className={FIELD} defaultValue={job?.sheetSize} placeholder="1250*2500" {...PLAIN} />
          <datalist id="manual-sizes">{SHEET_SIZE_PRESETS.map((m) => <option key={m} value={m} />)}</datalist>
        </label>
        <label><span className={LABEL}>Sheets *</span>
          {/* a job copied from one typed in pieces brings its sheet, not its count */}
          {/* part of a sheet is a count too — 2.5, or 2,5 off a phone keypad */}
          <input name="qty" type="text" inputMode="decimal" required className={`${FIELD} tabnum`} defaultValue={job?.bySheet ? job.qty : undefined} placeholder="e.g. 2.5" {...PLAIN} />
          {doneQty > 0 && <span className="block text-[11px] text-muted mt-0.5">{doneQty} cut already — not fewer</span>}
        </label>
      </div>

      <div className="sm:col-span-2 flex items-center gap-2 border-t pt-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-muted">On the sheets — every project&apos;s part</span>
        <span className="text-[11px] text-muted">{parts.length}/{MAX_JOB_PARTS}</span>
      </div>
      <div className="sm:col-span-2">
        {/* one grid row a part: four fields across on a wide screen, two by
            two on a phone or a tablet held upright — never a sideways scroll */}
        <div className="hidden sm:grid sm:grid-cols-[minmax(0,1fr)_9rem_minmax(0,1fr)_6rem_2.25rem] gap-2 pb-1 text-xs font-semibold text-muted">
          <span>Project (BOM)</span><span>Component</span><span>Part *</span><span>Pieces</span><span />
        </div>
        <div className="space-y-2 sm:space-y-1">
          {parts.map((r) => (
            <div key={r.key} className="grid grid-cols-2 gap-2 rounded-lg border p-2 sm:grid-cols-[minmax(0,1fr)_9rem_minmax(0,1fr)_6rem_2.25rem] sm:border-0 sm:p-0">
              <input name={PART_FIELD.bom} list="job-boms" defaultValue={r.bom} maxLength={60} className={FIELD} placeholder="BOM (if any)" aria-label="Project (BOM)" autoCapitalize="characters" {...PLAIN} />
              <select name={PART_FIELD.item} defaultValue={r.item} className={FIELD} aria-label="Component">
                <option value="">—</option>
                {ITEMS.map((it) => <option key={it} value={it}>{it} · {ITEM_NAME[it]}</option>)}
              </select>
              <input name={PART_FIELD.part} list="job-parts" defaultValue={r.part} maxLength={60} className={FIELD} placeholder="Part * — Bottom…" aria-label="Part" {...PLAIN} />
              <div className="flex items-center gap-1 sm:contents">
                <input name={PART_FIELD.pcs} type="text" inputMode="numeric" pattern="[0-9]*" defaultValue={r.pcs} className={`${FIELD} tabnum`} placeholder="Pieces" aria-label="Pieces" {...PLAIN} />
                <button type="button" className="btn btn-sm btn-ghost text-bad-fg px-1.5 shrink-0" title="Remove this part" aria-label="Remove this part" disabled={parts.length === 1} onClick={() => setParts((rows) => rows.filter((x) => x.key !== r.key))}>✕</button>
              </div>
            </div>
          ))}
        </div>
        <datalist id="job-boms">{boms.map((b) => <option key={b} value={b} />)}</datalist>
        <datalist id="job-parts">{partNames.map((n) => <option key={n} value={n} />)}</datalist>
        <button type="button" className="btn btn-sm btn-secondary mt-2" disabled={parts.length >= MAX_JOB_PARTS} onClick={addPart}>
          + Part
        </button>
      </div>

      <div className="sm:col-span-2 border-t pt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {machines ? (
          <label><span className={LABEL}>{word[0].toUpperCase() + word.slice(1)}</span>
            <select name="machineId" defaultValue={preset} className={FIELD}>
              <option value="">— none yet, just save it —</option>
              {machines.map((m) => <option key={m.id} value={m.id}>{m.code} · {m.name}</option>)}
            </select>
          </label>
        ) : (
          <div className="text-xs text-muted self-end pb-2">
            {job?.doneAtISO ? "Finished — more sheets than are cut opens it again, on no " + word + "."
              : job && job.onMachines.length > 0 ? `On ${job.onMachines.join(", ")} — Move to… in the list moves it.`
              : `On no ${word} — Put on… in the list puts it on one.`}
          </div>
        )}
        <label><span className={LABEL}>Name (if any)</span>
          <input name="title" maxLength={120} className={FIELD} defaultValue={job?.title} placeholder="e.g. Nest 14 — tanks of week 42" />
        </label>
        <label className="sm:col-span-2"><span className={LABEL}>Note</span>
          <input name="note" maxLength={500} className={FIELD} defaultValue={job?.note ?? ""} placeholder="Nesting file, program no., …" />
        </label>
      </div>
    </>
  );
}

/** One job's form: add (with a machine), change one (`edit`), or copy one
 *  into a new job (`copy`, with a machine — its done count starts at 0). */
function JobForm({ dept, mode, job, machines, boms, partNames, onDone, onCancel, onBusy }: {
  dept: string;
  mode: "add" | "edit" | "copy";
  job?: ManualJobView;
  machines: MachineDTO[];
  /** The open projects — a sheet job's BOM suggestions. */
  boms: string[];
  /** Part names typed before — so one spelling is kept. */
  partNames: string[];
  onDone: () => void;
  onCancel: () => void;
  /** A save in flight — the popup around it stays until it answers. */
  onBusy: (busy: boolean) => void;
}) {
  const a = useRun();
  // a form that goes away (saved, back to the list) holds the popup no longer
  useEffect(() => {
    onBusy(a.pending);
    return () => onBusy(false);
  }, [a.pending, onBusy]);
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    if (jobsBySheet(dept)) fd.set("parts", partsField(fd));
    if (mode === "edit" && job) {
      fd.set("id", String(job.id));
      a.run(updateManualJob, fd, onDone);
    } else {
      fd.set("dept", dept);
      a.run(createManualJob, fd, onDone);
    }
  };
  const editing = mode === "edit";
  const fields = {
    dept,
    job,
    doneQty: editing ? job?.doneQty : 0,
    machines: editing ? undefined : machines,
    machineCode: job ? job.onMachines[0] ?? job.lastMachine : null,
  };
  return (
    <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {jobsBySheet(dept) ? <SheetJobFields {...fields} boms={boms} partNames={partNames} /> : <JobFields {...fields} />}
      {a.err && <p className="sm:col-span-2 text-sm font-semibold text-bad-fg">{a.err}</p>}
      <div className="sm:col-span-2 flex justify-end gap-2">
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel} disabled={a.pending}>{mode === "add" ? "Cancel" : "Back to the list"}</button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={a.pending}>{a.pending ? "Saving…" : editing ? "Save changes" : mode === "copy" ? "Save the copy" : "Save job"}</button>
      </div>
    </form>
  );
}

/** "+ Job" — a job straight onto a machine: on the fabrication board the
 *  sheets and the parts on them, elsewhere a job the plan does not carry. */
export function AddManualJob({ dept, machines, boms = [], jobs = [] }: { dept: string; machines: MachineDTO[]; boms?: string[]; jobs?: ManualJobView[] }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const word = machineWord(dept);
  const sheets = jobsBySheet(dept);
  return (
    <>
      <button
        type="button"
        className={`btn btn-sm ${sheets ? "btn-primary" : "btn-secondary"} ms-1 normal-case no-print`}
        onClick={() => setOpen(true)}
        title={sheets ? `Sheets for a ${word}: their thickness, material and size, how many, and every project's part on them` : `Put a job that is not in the plan on a ${word} — a repair, a sample, a spare part. It is kept in the list.`}
      >
        ✋ Add job
      </button>
      {open && (
        <Modal
          title={sheets ? "✋ Add a sheet job" : "✋ Add a job from outside the plan"}
          sub={sheets ? `The sheets, and the parts of each project they carry. It queues on the ${word} and is closed sheet by sheet.` : `It queues on the ${word} like any plan line, and stays in the Manual jobs list.`}
          onClose={() => setOpen(false)}
          busy={busy}
          width={sheets ? "max-w-3xl" : "max-w-xl"}
        >
          <JobForm dept={dept} mode="add" machines={machines} boms={boms} partNames={partNameSuggestions(jobs)} onDone={() => setOpen(false)} onCancel={() => setOpen(false)} onBusy={setBusy} />
        </Modal>
      )}
    </>
  );
}

const sheetText = (j: ManualJobView) =>
  j.bySheet ? jobSheetLabel(j)
  : [j.thicknessMm !== null ? `${j.thicknessMm} mm` : "", j.material, j.sheetSize.replace(/\*/g, "×"), j.sheets !== null ? `${j.sheets} sh` : ""].filter(Boolean).join(" · ");

/** 📋 The jobs typed in — open ones first, then the finished ones — to come
 *  back to: put one on a machine again, open a finished one for more
 *  (pieces, or a sheet job's sheets), change or copy one, or delete a mistake. */
export function ManualJobsList({ dept, jobs, machines, canEdit, boms = [] }: { dept: string; jobs: ManualJobView[]; machines: MachineDTO[]; canEdit: boolean; boms?: string[] }) {
  const [open, setOpen] = useState(false);
  // ✎ / ⧉ open the job's form in place of the table — one popup, one Escape
  const [form, setForm] = useState<{ mode: "edit" | "copy"; job: ManualJobView } | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const a = useRun();
  const word = machineWord(dept);
  const sheets = jobsBySheet(dept);
  const partNames = partNameSuggestions(jobs);
  const openCount = jobs.filter((j) => !j.doneAtISO).length;
  /** A fabrication job typed in pieces, before the board counted sheets — kept as it was. */
  const oldPieces = (j: ManualJobView) => sheets && !j.bySheet;
  const unit = (j: ManualJobView) => (j.bySheet ? "sheets" : "pieces");
  const putOn = (j: ManualJobView, machineId: string) => {
    const fd = new FormData();
    fd.set("dept", dept); fd.set("bom", MANUAL_BOM); fd.set("mo", manualMo(j.id)); fd.set("item", MANUAL_ITEM); fd.set("machineId", machineId);
    a.run(assignLineMachine, fd);
  };
  const byId = (fn: (fd: FormData) => Promise<ManualActionResult>, id: number, extra?: Record<string, string>) => {
    const fd = new FormData();
    fd.set("id", String(id));
    for (const [k, v] of Object.entries(extra ?? {})) fd.set(k, v);
    a.run(fn, fd);
  };
  return (
    <>
      <button type="button" className="btn btn-sm btn-ghost ms-1 normal-case no-print" onClick={() => { setForm(null); setOpen(true); }} title={sheets ? "Every sheet job — open and finished" : "Every job typed in from outside the plan — open and finished"}>
        📋 {sheets ? "Jobs" : "Manual jobs"}{openCount > 0 ? ` (${openCount})` : ""}
      </button>
      {open && (
        <Modal
          title={form ? (form.mode === "edit" ? `✎ Edit “${jobName(form.job)}”` : `⧉ Duplicate “${jobName(form.job)}”`) : sheets ? "📋 Jobs" : "📋 Manual jobs"}
          sub={form
            ? form.mode === "edit"
              ? `${form.job.doneQty} of ${form.job.qty} ${form.job.bySheet ? "sheets cut" : "done"} · added ${formatDate(form.job.createdAtISO.slice(0, 10))}${form.job.createdBy ? ` by ${form.job.createdBy}` : ""}`
              : `A new job with the same details — nothing of it done yet. Pick the ${word} and change what differs.`
            : sheets ? `The sheet jobs put on the ${machineWord(dept, true)} — kept here, cut or not.` : `Jobs put on a ${word} from outside the plan — kept here, done or not.`}
          // Escape on a job's form goes back to the list, not out of it
          onClose={() => (form ? setForm(null) : setOpen(false))}
          busy={a.pending || formBusy}
          width={form ? (sheets ? "max-w-3xl" : "max-w-xl") : "max-w-5xl"}
        >
          {form ? (
            <JobForm key={`${form.mode}-${form.job.id}`} dept={dept} mode={form.mode} job={form.job} machines={machines} boms={boms} partNames={partNames} onDone={() => setForm(null)} onCancel={() => setForm(null)} onBusy={setFormBusy} />
          ) : jobs.length === 0 ? (
            <EmptyState compact icon={ClipboardList} title="No jobs yet" hint={`✋ Add job puts one on a ${word}.`} />
          ) : (
            <div className="overflow-x-auto max-h-[65vh] overflow-y-auto">
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 bg-surface">
                  <tr className="text-left text-xs text-muted border-b">
                    <th className="p-2">Job</th>
                    <th className="p-2 text-center">{sheets ? "Sheets cut" : "Done"}</th>
                    <th className="p-2">Sheet</th>
                    <th className="p-2">Where</th>
                    <th className="p-2">Added</th>
                    {canEdit && <th className="p-2"></th>}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {jobs.map((j) => {
                    const done = !!j.doneAtISO;
                    return (
                      <tr key={j.id} className={done ? "opacity-70" : ""}>
                        <td className="p-2">
                          <div className="font-bold">{jobName(j)} <span className="text-[10px] font-normal text-muted tabnum">#{j.id}</span></div>
                          <div className="text-xs text-muted">
                            {j.bySheet ? [partsText(j.parts), j.note].filter(Boolean).join(" · ") || "—" : [j.bom && `BOM ${j.bom}`, j.item, j.note].filter(Boolean).join(" · ") || "—"}
                          </div>
                          {oldPieces(j) && <div className="text-[11px] text-muted">typed in pieces, before jobs were counted in sheets</div>}
                        </td>
                        <td className="p-2 text-center tabnum whitespace-nowrap"><b>{j.doneQty}</b> / {j.qty}{oldPieces(j) ? " pcs" : ""}</td>
                        <td className="p-2 text-xs whitespace-nowrap">{sheetText(j) || "—"}</td>
                        <td className="p-2 text-xs whitespace-nowrap">
                          {done ? <span className="pill pill-ok">✓ done {formatDate(j.doneAtISO!.slice(0, 10))}</span>
                            : j.onMachines.length > 0 ? <span className="pill pill-muted">on {j.onMachines.join(", ")}</span>
                            : <span className="pill pill-warn">on no {word}</span>}
                          {j.lastMachine && <div className="text-muted mt-0.5">last on {j.lastMachine}</div>}
                        </td>
                        <td className="p-2 text-xs text-muted whitespace-nowrap">{formatDate(j.createdAtISO.slice(0, 10))}{j.createdBy ? ` · ${j.createdBy}` : ""}</td>
                        {canEdit && (
                          <td className="p-2 whitespace-nowrap text-right">
                            {!done && (
                              <select
                                className="border rounded-md px-1.5 py-1 bg-surface text-xs me-1"
                                value=""
                                disabled={a.pending}
                                onChange={(e) => { if (e.target.value) putOn(j, e.target.value); }}
                                title={`Put it on a ${word} — at the back of its queue`}
                              >
                                <option value="">{j.onMachines.length > 0 ? "Move to…" : "Put on…"}</option>
                                {machines.map((m) => <option key={m.id} value={m.id}>{m.code}</option>)}
                              </select>
                            )}
                            {done && !oldPieces(j) && (
                              <button type="button" className="btn btn-sm btn-secondary me-1" disabled={a.pending} title={`Open it again for more ${unit(j)}`}
                                onClick={() => { const v = prompt(`More ${unit(j)} of “${jobName(j)}” wanted:`, "1"); if (v === null) return; byId(reopenManualJob, j.id, { more: v.trim() || "0" }); }}>
                                ↺ Again
                              </button>
                            )}
                            {!oldPieces(j) && (
                              <button type="button" className="btn btn-sm btn-secondary me-1" disabled={a.pending} title={j.bySheet ? "Change the sheets, the parts on them, the name or the note" : "Change what it is, the pieces, the sheet or the note"}
                                onClick={() => setForm({ mode: "edit", job: j })}>
                                ✎ Edit
                              </button>
                            )}
                            <button type="button" className="btn btn-sm btn-secondary me-1" disabled={a.pending} title={`A new job with the same details — pick the ${word}, change what differs`}
                              onClick={() => setForm({ mode: "copy", job: j })}>
                              ⧉ Duplicate
                            </button>
                            <button type="button" className="btn btn-sm btn-ghost text-bad-fg" disabled={a.pending} title="Delete — typed by mistake"
                              onClick={() => { if (confirm(`Delete “${jobName(j)}”? It goes off every ${word} and out of the list.`)) byId(deleteManualJob, j.id); }}>
                              ✕
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {a.err && <p className="text-sm font-semibold text-bad-fg mt-2">{a.err}</p>}
        </Modal>
      )}
    </>
  );
}
