"use client";

import { useState, type ReactNode } from "react";
import { Modal } from "@/components/Modal";
import { TableEmpty, TableFrame, Th } from "@/components/DataTable";
import { JobForm, jobFormHeading } from "@/components/ManualJobs";
import { jobSheetLabel, jobShares, manualMo, partNameSuggestions, roundSheets, type ManualJobView } from "@/lib/domain/manualJob";
import { ITEM_NAME } from "@/lib/domain/constants";
import { formatDate, formatDateTime } from "@/lib/domain/format";
import { machineWord } from "@/lib/domain/shifts";
import type { MachineBoardData } from "@/lib/server/machineBoard";

// 🧾 A sheet job's details, opened from its name on a machine card or on the
// floor: how many sheets it is for, how many are cut and left and on which
// machines, every project's part the sheets carry, the note, and every ✓
// recorded on it — with ✓, ✎ Edit and ⧉ Duplicate for whoever may change
// the board.

const HEAD = "field-label !mb-0";

export function SheetJobDetails({ job, board, canEdit, done, children }: {
  job: ManualJobView;
  board: MachineBoardData;
  canEdit: boolean;
  /** The ✓ box of the line it was opened from, its errors shown in the popup. */
  done?: (onErr: (m: string) => void) => ReactNode;
  /** What opens it — the job as the line shows it. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // ✎ / ⧉ open the job's form in place of the details — one popup, one Escape
  const [form, setForm] = useState<"edit" | "copy" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const label = jobSheetLabel(job);
  const close = () => { setOpen(false); setForm(null); setErr(""); };
  return (
    <>
      <button
        type="button"
        className="min-w-0 rounded-md text-start cursor-pointer hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand"
        onClick={() => { setErr(""); setOpen(true); }}
        aria-haspopup="dialog"
        title={`Job #${job.id} — its parts, what is cut, where and by whom`}
      >
        {children}
      </button>
      {/* outside the button: a click inside the popup must not bubble to it */}
      {open && (
        <Modal
          title={form ? jobFormHeading(form, job, board.dept).title : `🧾 ${label} · #${job.id}`}
          sub={form ? jobFormHeading(form, job, board.dept).sub
            : [job.title.trim(), `added ${formatDate(job.createdAtISO.slice(0, 10))}${job.createdBy ? ` by ${job.createdBy}` : ""}`].filter(Boolean).join(" · ")}
          // Escape on the form goes back to the details, not out of them
          onClose={() => (form ? setForm(null) : close())}
          busy={busy}
          width="max-w-3xl"
          // it opens on the details: the ✓ box is no field to start in
          focusField={false}
        >
          {form ? (
            <JobForm
              key={`${form}-${job.id}`} dept={board.dept} mode={form} job={job} machines={board.machines} boms={board.jobBoms}
              partNames={partNameSuggestions(board.manualJobs)} onDone={() => setForm(null)} onCancel={() => setForm(null)} onBusy={setBusy} backLabel="Back to the details"
            />
          ) : (
            <JobDetails job={job} board={board}>
              {canEdit && (
                // pinned under the details, so ✓ is in reach without scrolling
                <div className="sticky bottom-0 z-20 flex flex-wrap items-center gap-2 border-t bg-surface pt-3 pb-1">
                  {done?.(setErr)}
                  <span className="ms-auto flex flex-wrap gap-2">
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => setForm("edit")} title="Change the sheets, the parts on them, the name or the note">✎ Edit</button>
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => setForm("copy")} title={`A new job with the same details — pick the ${machineWord(board.dept)}, change what differs`}>⧉ Duplicate</button>
                  </span>
                  {err && <p role="alert" className="basis-full text-sm font-semibold text-bad-fg">{err}</p>}
                </div>
              )}
            </JobDetails>
          )}
        </Modal>
      )}
    </>
  );
}

/** What the popup shows of a job: the counts, where its sheets are, the
 *  parts, the note and the cut history; `children` are the actions under it. */
function JobDetails({ job, board, children }: { job: ManualJobView; board: MachineBoardData; children?: ReactNode }) {
  const word = machineWord(board.dept);
  const { shares, waiting } = jobShares(manualMo(job.id), board.cards, board.unassigned);
  const left = roundSheets(job.qty - job.doneQty);
  const pct = job.qty > 0 ? Math.min(100, Math.round((job.doneQty / job.qty) * 100)) : 0;
  const cuts = board.jobCuts[job.id] ?? [];
  // the log and the job's count can differ: sheets ticked before the log was
  // kept are in the count only; a ✓ the assistant undid before its undo took
  // the ✓'s row off the log too stays in the log only.
  // Say so rather than show a history that does not add up
  const logged = roundSheets(cuts.reduce((n, c) => n + c.qty, 0));
  const unlogged = roundSheets(job.doneQty - logged);
  return (
    <div className="space-y-4">
      <div className="kpi-strip kpi-strip-tight">
        <div className="kpi">
          <div className="kpi-label">Sheets</div>
          <div className="kpi-value">{roundSheets(job.qty)}</div>
          <div className="kpi-sub">whole job</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Cut</div>
          <div className="kpi-value">{roundSheets(job.doneQty)}</div>
          <div className="kpi-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Share of the job cut"><span style={{ width: `${pct}%` }} /></div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Left</div>
          <div className="kpi-value">{left}</div>
          <div className="kpi-sub">{pct}% cut so far</div>
        </div>
      </div>

      <section className="space-y-1.5">
        <div className={HEAD}>Where it is</div>
        {shares.length === 0 && waiting <= 0 ? (
          <p className="text-[13px] text-muted">On no {word} — Put on… in 📋 Jobs puts it on one.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {shares.map((s, i) => (
              <span key={`${s.machine}#${i}`} className={`pill tabnum ${s.running ? "pill-ok" : "pill-muted"}`} title={s.running ? `Being cut on ${s.machine} now` : `Waiting on ${s.machine}`}>
                {s.running ? "▶ " : ""}{s.machine} · {s.left} sh
              </span>
            ))}
            {waiting > 0 && <span className="pill pill-warn tabnum" title={`Sheets of this job on no ${word} yet`}>on no {word} · {waiting} sh</span>}
          </div>
        )}
      </section>

      <section className="space-y-1.5">
        <div className={HEAD}>On the sheets — {job.parts.length} part{job.parts.length === 1 ? "" : "s"}</div>
        {job.parts.length === 0 ? (
          <p className="text-[13px] text-muted">No parts were typed for this job.</p>
        ) : (
          <TableFrame>
            <table className="w-full border-collapse">
              <thead>
                <tr><Th label="Project (BOM)" /><Th label="Component" /><Th label="Part" /><Th label="Pieces" num className="text-end" /></tr>
              </thead>
              <tbody>
                {job.parts.map((p) => (
                  <tr key={p.id}>
                    <td className="px-2 font-bold ltr whitespace-nowrap">{p.bom || "—"}</td>
                    <td className="px-2">{p.item ? `${p.item} · ${ITEM_NAME[p.item as keyof typeof ITEM_NAME] ?? p.item}` : "—"}</td>
                    <td className="px-2">{p.part}</td>
                    <td className="px-2 text-end tabnum">{p.pcs ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
      </section>

      {job.note && (
        <section className="space-y-1">
          <div className={HEAD}>Note</div>
          <p className="text-[13px] whitespace-pre-wrap">{job.note}</p>
        </section>
      )}

      <section className="space-y-1.5">
        <div className={HEAD}>Cut so far</div>
        {cuts.length === 0 && unlogged <= 0 ? (
          <TableEmpty title="Nothing cut yet" hint={`✓ on the job's line records the sheets a ${word} cut.`} />
        ) : cuts.length > 0 && (
          <TableFrame>
            <table className="w-full border-collapse">
              <thead>
                <tr><Th label="When" /><Th label={word[0].toUpperCase() + word.slice(1)} /><Th label="Sheets" num className="text-end" /><Th label="Recorded by" /></tr>
              </thead>
              <tbody>
                {cuts.map((c) => (
                  <tr key={c.id}>
                    <td className="px-2 tabnum whitespace-nowrap">{formatDateTime(c.atISO)}</td>
                    <td className="px-2 font-bold ltr whitespace-nowrap">{c.machine ?? "—"}</td>
                    <td className="px-2 text-end tabnum font-bold">{roundSheets(c.qty)}</td>
                    <td className="px-2 text-muted">{c.by ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
        {unlogged > 0 && (
          <p className="text-[13px] text-muted">
            {cuts.length > 0 ? `Besides these, ${unlogged}` : `${unlogged}`} sheet(s) were recorded as cut with no entry here — ticked before each ✓ was kept with its machine and time.
          </p>
        )}
        {unlogged < 0 && (
          <p className="text-[13px] text-warn-fg">
            These add up to {logged} sheet(s), but the job counts {roundSheets(job.doneQty)} cut — a ✓ was undone since.
          </p>
        )}
      </section>

      {children}
    </div>
  );
}
