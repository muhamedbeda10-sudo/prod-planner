"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { clearWords, loadTone, unassignedKey, type LinePlacement, type MachineCard, type MachineQueueLine } from "@/lib/domain/machineBoard";
import { CENTER_LABEL, machineWord, round1 } from "@/lib/domain/shifts";
import type { MachineDTO } from "@/lib/server/machines";
import type { MachineBoardData } from "@/lib/server/machineBoard";
import Link from "next/link";
import { assignLineMachine, clearMachineQueue, moveLineRank, resetMachinePlan, setLineQty, setLineRunning, unassignLineMachine } from "@/app/worklist/machineActions";
import { recordOutput } from "@/app/worklist/actions";
import { MachineTimeline } from "@/components/MachineTimeline";
import { LineMaterialChips } from "@/components/LineMaterialChips";
import { AddManualJob, ManualJobsList } from "@/components/ManualJobs";
import { recordManualDone } from "@/app/worklist/manualActions";
import { SHEET_COUNT_RULE, isSheetCount, jobsBySheet, manualIdOf, roundSheets, typedCount, type ManualJobView } from "@/lib/domain/manualJob";
import { SheetJobLine } from "@/components/SheetJobLine";
import { factoryDayISO } from "@/lib/domain/dates";

// 🏭 The machine load board on a department's worklist — one card per
// machine: what it is on NOW, what waits behind it, and how many hours the
// queue is against the hours the machine has today (its hours a day less the
// downtime the shift log recorded). Lines are put on a machine from the
// tables below (the Machine column) or from the unassigned list here; their
// order is moved on the card. A line need not go whole: a number typed
// beside the picker SPLITS it — those go to the machine picked, the rest
// stays put (or waits unassigned) — and ✂ on a card resizes a share. A line
// leaves the board by itself once nothing remains.
// The fabrication board carries SHEET JOBS only (typed with ✋ Add job):
// sheets of one thickness carrying several projects' parts. Their count is
// sheets — split over machines in sheets, closed in sheets, and a machine's
// load there reads in sheets (the jobs carry no standard hours).

function useAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState("");
  const run = (fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData) => {
    setErr("");
    startTransition(async () => {
      const res = await fn(fd);
      if (res.ok) router.refresh();
      else setErr(res.error ?? "Failed");
    });
  };
  return { pending, err, setErr, run };
}

function ddmm(iso: string) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

const TONE_BAR: Record<"ok" | "warn" | "bad", string> = { ok: "bg-ok-fg", warn: "bg-warn-fg", bad: "bg-bad-fg" };
const TONE_INK: Record<"ok" | "warn" | "bad", string> = { ok: "text-ok-fg", warn: "text-warn-fg", bad: "text-bad-fg" };

/** The board's sheet jobs by id — a queue line that is one is counted in sheets. */
function sheetJobsOf(board: MachineBoardData): Map<number, ManualJobView> {
  return new Map(board.manualJobs.filter((j) => j.bySheet).map((j) => [j.id, j]));
}

/** The sheet job a board line is, if it is one. */
function sheetJobOf(jobs: ReadonlyMap<number, ManualJobView>, mo: string): ManualJobView | undefined {
  const id = manualIdOf(mo);
  return id === null ? undefined : jobs.get(id);
}

/** The picker a table row carries: which machine this line is on, and a
 *  pieces box to put only some of it there. Saves at once. */
export function MachinePick({ dept, bom, mo, item, machines, current, canEdit, compact = false, unit = "pcs" }: {
  dept: string; bom: string; mo: string; item: string; machines: MachineDTO[];
  current: LinePlacement | undefined; canEdit: boolean; compact?: boolean;
  /** What the line is counted in — a sheet job's sheets, any other line's pieces. */
  unit?: "pcs" | "sheets";
}) {
  const a = useAction();
  const qtyRef = useRef<HTMLInputElement>(null);
  if (machines.length === 0) return null;
  const units = unit === "sheets" ? "sheets" : "pieces";
  const m = current ? machines.find((x) => x.id === current.machineId) : undefined;
  const share = current?.split ? ` ×${current.qty}` : "";
  const state = current ? `${current.running ? "running now" : `#${current.rank} in its queue`}${share ? `, ${current.qty} ${units} of it` : ""}${current.others ? `, ${current.others} more ${machineWord(dept, current.others > 1)} hold a share` : ""}` : "";
  // the rest of the route: where the line goes after this machine, and the
  // centres of its route nothing is on yet
  const rest = (
    <>
      {current?.next?.map((n) => (
        <span key={n.center} className="pill pill-muted tabnum ltr" title={`Then ${CENTER_LABEL[n.center] ?? n.center} — ${n.code}, ${n.running ? "running now" : `#${n.rank} in its queue`}`}>→ {n.code}</span>
      ))}
      {current?.missing?.map((c) => (
        <span key={c} className="pill pill-warn" title={`Nothing on ${CENTER_LABEL[c] ?? c} yet — this line still needs it`}>needs {c.toLowerCase()}</span>
      ))}
    </>
  );
  if (!canEdit) {
    return m ? (
      <span className="inline-flex items-center gap-1 flex-wrap">
        <span className="pill pill-muted ltr tabnum" title={`On ${m.name}, ${state}`}>{m.code}{share}{current!.running ? " ▶" : ` #${current!.rank}`}</span>
        {current!.others ? <span className="pill pill-muted tabnum" title={state}>+{current!.others}</span> : null}
        {rest}
      </span>
    ) : <span className="text-muted text-xs">—</span>;
  }
  const base = () => {
    const fd = new FormData();
    fd.set("dept", dept); fd.set("bom", bom); fd.set("mo", mo); fd.set("item", item);
    return fd;
  };
  return (
    <span className="inline-flex flex-col items-start" onClick={(e) => e.stopPropagation()}>
      <span className="inline-flex items-center gap-1">
        <select
          value={current?.machineId ?? ""}
          disabled={a.pending}
          aria-label="Machine"
          title={m ? `On ${m.name} — ${state}. Pick another to move it there (with a number in the box, only those ${units} go), blank to take it off every ${machineWord(dept)}.` : `Put this line on a ${machineWord(dept)} — type a number first to put only some of its ${units} there`}
          onChange={(e) => {
            const fd = base();
            fd.set("machineId", e.target.value);
            fd.set("qty", qtyRef.current?.value ?? "");
            a.run(assignLineMachine, fd);
          }}
          className={`border rounded-md px-1.5 py-1 bg-surface text-xs font-bold ltr ${compact ? "max-w-[7rem]" : "max-w-[10rem]"} ${current ? "" : "text-muted"}`}
        >
          <option value="">— {machineWord(dept)}</option>
          {machines.map((x) => <option key={x.id} value={x.id}>{x.code}{compact ? "" : ` · ${x.name}`}</option>)}
        </select>
        <input
          key={`${current?.machineId ?? ""}:${current?.split ? current.qty : ""}`}
          ref={qtyRef}
          type="number" min={unit === "sheets" ? 0.01 : 1} step={unit === "sheets" ? 0.01 : 1} inputMode={unit === "sheets" ? "decimal" : "numeric"} placeholder="all"
          defaultValue={current?.split ? current.qty : ""}
          disabled={a.pending}
          aria-label={unit === "sheets" ? "Sheets for the machine" : "Pieces for the machine"}
          title={current ? `${units[0].toUpperCase() + units.slice(1)} on ${m?.code ?? "the machine"} — blank = the whole line (the rest of it). Enter resizes its share; with another ${machineWord(dept)} picked, this many go there.` : `${units[0].toUpperCase() + units.slice(1)} to put on the ${machineWord(dept)} picked — blank = the whole line`}
          className="border rounded-md px-1 py-1 bg-surface text-xs tabnum w-12 ltr"
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !current) return;
            e.preventDefault();
            const fd = base();
            fd.set("machineId", String(current.machineId));
            fd.set("qty", e.currentTarget.value);
            a.run(setLineQty, fd);
          }}
        />
        {current && (
          <button
            type="button"
            className={`pill ${current.running ? "pill-ok" : "pill-muted"} tabnum cursor-pointer`}
            title={current.running ? "Running on it now — click to put it back to waiting" : `#${current.rank} in the machine's queue — click to start it now, alongside what runs`}
            disabled={a.pending}
            onClick={() => {
              const fd = base();
              fd.set("machineId", String(current.machineId));
              fd.set("running", current.running ? "false" : "true");
              a.run(setLineRunning, fd);
            }}
          >
            {current.running ? "▶ now" : `#${current.rank}`}
          </button>
        )}
        {current?.others ? <span className="pill pill-muted tabnum" title={`Split — ${state}`}>+{current.others}</span> : null}
        {rest}
      </span>
      {a.err && <span className="text-[10px] text-bad-fg">{a.err}</span>}
    </span>
  );
}

/** ✓ Done straight off the card: the whole share in one click, or what was
 *  actually finished — the rest stays in the machine's queue. A sheet job
 *  is closed in SHEETS cut on this machine; any other line in pieces. */
export function DoneBox({ board, q, machineId, onErr }: { board: MachineBoardData; q: MachineQueueLine; machineId?: number; onErr: (m: string) => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [val, setVal] = useState("");
  // a welded tank carries a serial and the welder's name — that recording
  // belongs on the queue table, not on a card
  if (board.tankSerials && q.item === "TN") return null;
  const manual = manualIdOf(q.mo);
  const bySheet = manual !== null && !!board.manualJobs.find((j) => j.id === manual)?.bySheet;
  const save = () => {
    const qty = val.trim() ? typedCount(val) : q.remaining;
    if (bySheet ? !isSheetCount(qty) : !Number.isFinite(qty) || qty <= 0) { onErr(bySheet ? `Enter the sheets cut — ${SHEET_COUNT_RULE}.` : "Enter pieces above 0."); return; }
    if (qty > q.remaining) { onErr(bySheet ? `Only ${q.remaining} sheet(s) of this job on this ${machineWord(board.dept)}.` : `Only ${q.remaining} left on this ${board.dept === "Welding" ? "partition" : "machine"}.`); return; }
    onErr("");
    const fd = new FormData();
    fd.set("date", board.dayISO); fd.set("dept", board.dept); fd.set("bom", q.bom); fd.set("mo", q.mo); fd.set("item", q.item);
    fd.set("qty", String(qty)); fd.set("planNo", String(board.planNo));
    // what was finished on WHICH machine — the only place the app learns it
    if (machineId !== undefined) fd.set("machineId", String(machineId));
    // a job from outside the plan records on itself, never in the plan's ledger
    if (manual !== null) fd.set("id", String(manual));
    startTransition(async () => {
      const res = manual !== null ? await recordManualDone(fd) : await recordOutput(fd);
      if (res.ok) { setVal(""); router.refresh(); } else onErr(res.error ?? "Failed");
    });
  };
  if (bySheet) return (
    <span className="inline-flex items-center no-print rounded-md border border-brand/50 bg-surface overflow-hidden" title={`Sheets of this job cut on this ${machineWord(board.dept)} — blank = all ${q.remaining} left here.`}>
      <span className="ps-1.5 pe-1 text-[10px] font-bold uppercase text-muted">Sheets</span>
      <input
        type="number" min={0.01} max={q.remaining} step={0.01} inputMode="decimal" placeholder={String(q.remaining)}
        value={val} disabled={pending} aria-label="Sheets cut"
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }}
        className="w-12 border-x px-1 py-0.5 bg-surface text-xs tabnum ltr text-center outline-none"
      />
      <span className="px-1 text-[10px] text-muted tabnum">/ {q.remaining}</span>
      <button type="button" className="bg-brand text-white px-1.5 py-0.5 text-xs font-bold disabled:opacity-50" disabled={pending} onClick={save} title="Record the sheets cut">✓</button>
    </span>
  );
  return (
    <span className="inline-flex items-center gap-0.5 no-print">
      <input
        type="number" min={1} max={q.remaining} step={1} inputMode="numeric" placeholder={String(q.remaining)}
        value={val} disabled={pending} aria-label="Pieces done"
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }}
        className="border rounded-md px-1 py-0.5 bg-surface text-xs tabnum w-12 ltr"
        title={`Pieces finished — blank records all ${q.remaining}. What is left stays in the queue.`}
      />
      <button type="button" className="btn btn-sm btn-primary px-1.5" disabled={pending} title={`Record what is done (blank = all ${q.remaining}); the rest stays in the queue`} onClick={save}>✓</button>
    </span>
  );
}

/** What a card's queue holds: a sheet job's sheets apart from other lines'
 *  pieces — the fabrication board's load reads in sheets. */
function queueCounts(c: MachineCard, jobs: ReadonlyMap<number, ManualJobView>) {
  let sheets = 0, pcs = 0;
  for (const q of c.queue) if (sheetJobOf(jobs, q.mo)) sheets += q.remaining; else pcs += q.remaining;
  return { sheets: roundSheets(sheets), pcs, priced: c.queue.some((q) => !sheetJobOf(jobs, q.mo)) };
}

function Card({ c, board, canEdit }: { c: MachineCard; board: MachineBoardData; canEdit: boolean }) {
  const dept = board.dept;
  const a = useAction();
  const jobs = sheetJobsOf(board);
  const counts = queueCounts(c, jobs);
  // a queue of sheet jobs alone carries no standard hours: it reads in sheets
  const bySheets = jobsBySheet(dept) && !counts.priced;
  const tone = bySheets ? null : loadTone(c.load);
  // the bar reads as WORK AHEAD, five days wide — a full bar is a week of it
  const pct = bySheets || c.days === null ? null : Math.min(100, Math.round((c.days / 5) * 100));
  const line = (bom: string, mo: string, item: string, sheet = "") => {
    const fd = new FormData();
    fd.set("dept", dept); fd.set("bom", bom); fd.set("mo", mo); fd.set("item", item); fd.set("sheet", sheet);
    fd.set("machineId", String(c.machine.id));
    return fd;
  };
  // ✂ — how much of the line stays on this machine (a sheet job's sheets,
  // another line's pieces); the rest waits for another machine (or goes
  // back to it whole with a blank)
  const resize = (q: MachineQueueLine) => {
    const job = sheetJobOf(jobs, q.mo);
    const what = job ? `Sheets of job #${job.id}` : `Pieces of ${q.bom} ${q.item}`;
    const v = prompt(`${what} on ${c.machine.code} — of ${q.lineRemaining} (blank = the rest of it):`, String(q.remaining));
    if (v === null) return;
    const fd = line(q.bom, q.mo, q.item, q.sheet);
    fd.set("qty", v.trim());
    a.run(setLineQty, fd);
  };
  const done = (q: MachineQueueLine) => (canEdit ? <DoneBox board={board} q={q} machineId={c.machine.id} onErr={a.setErr} /> : null);
  /** The line itself: a sheet job's sheet and parts, a manual job's words, or a plan line's BOM and item. */
  const what = (q: MachineQueueLine, strong: boolean) => {
    const job = sheetJobOf(jobs, q.mo);
    if (job) return <SheetJobLine job={job} left={q.remaining} />;
    return (
      <>
        {manualIdOf(q.mo) !== null ? <span className={strong ? "font-extrabold" : "font-bold"}>{q.description}</span> : <>
        <span className={strong ? "font-extrabold" : "font-bold"}>{q.bom}</span>
        <span className={strong ? "font-bold" : "font-semibold"}>{q.item}</span></>}
        <span className={`tabnum ${strong ? "font-extrabold text-brand" : "font-bold"}`}>×{q.remaining}</span>
        {q.split && <span className="text-[11px] text-muted tabnum whitespace-nowrap" title="Part of the line — the rest is on another machine or waits">✂ of {q.lineRemaining}</span>}
        {q.hours !== null && <span className="text-xs text-muted tabnum whitespace-nowrap">{q.hours} h</span>}
        {q.deliveryISO && (strong
          ? <span className={`pill tabnum ${q.deliveryISO < factoryDayISO(new Date()) ? "pill-bad" : "pill-muted"}`}>📅 {ddmm(q.deliveryISO)}</span>
          : <span className="text-muted tabnum whitespace-nowrap">📅 {ddmm(q.deliveryISO)}</span>)}
        {strong && <span className="text-[11px] text-muted truncate">{q.mo}{q.description ? ` · ${q.description}` : ""}</span>}
        <LineMaterialChips m={board.material[q.key]} pcs={q.remaining} sheets={dept === "Cut" && q.stepNo === 1} sheet={q.sheet} />
      </>
    );
  };
  return (
    <div className={`bg-surface border rounded-xl p-3 flex flex-col gap-2 ${c.machine.active ? "" : "opacity-70"}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-extrabold ltr tabnum">{c.machine.code} <span className="font-semibold text-sm">· {c.machine.name}</span></div>
          <div className="text-[11px] text-muted">
            {c.machine.center && <span>{CENTER_LABEL[c.machine.center] ?? c.machine.center} · </span>}
            {c.availableH !== null ? <span className="tabnum">{c.availableH} h today{c.downtimeH > 0 ? ` (${c.downtimeH} h down)` : ""}</span> : "hours/day not set"}
            {c.crew.length > 0 && <span className="tabnum" title={c.crew.join(", ")}> · 👷 {c.crew.length} · {c.crewH} mh</span>}
            {!c.machine.active && <span className="pill pill-muted ms-1">retired</span>}
          </div>
        </div>
        <div className="text-right shrink-0">
          {bySheets ? (
            <div className="text-lg font-extrabold tabnum leading-tight" title={`Sheets of the jobs on this ${machineWord(dept)} still to cut`}>{counts.sheets} sh</div>
          ) : (
            <div
              className={`text-lg font-extrabold tabnum leading-tight ${tone ? TONE_INK[tone] : ""}`}
              title={c.availableH ? `${c.hours} standard hours of work at ${c.availableH} h a day` : "No hours a day set for this machine — set it in Tools → Machines"}
            >
              {clearWords(c.hours, c.availableH)}
            </div>
          )}
          <div className="text-[11px] text-muted tabnum">
            {bySheets ? `${c.queue.length} job(s)` : [`${c.hours} h`, counts.pcs > 0 && `${counts.pcs} pcs`, counts.sheets > 0 && `${counts.sheets} sh`, `${c.queue.length} line(s)`].filter(Boolean).join(" · ")}
          </div>
          {!bySheets && c.clearsISO && <div className="text-[11px] text-muted tabnum" title="The working day this queue is finished — Fridays and the calendar's days off skipped">clears {ddmm(c.clearsISO)}</div>}
        </div>
      </div>
      {pct !== null && (
        <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden" title={c.days === null ? "" : `${c.days} working day(s) of work ahead — the bar is five days wide`}>
          <div className={`h-full ${tone ? TONE_BAR[tone] : "bg-muted"}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      {!bySheets && roundSheets(c.unpricedPcs - counts.sheets) > 0 && <div className="text-[10px] text-warn-fg">{roundSheets(c.unpricedPcs - counts.sheets)} pcs with no standard time — hours undercounted</div>}

      {c.running.length > 0 ? (
        <div className="rounded-lg border border-brand/40 bg-brand-light/30 px-2.5 py-2 space-y-1">
          <div className="text-[10px] font-bold uppercase tracking-wide text-brand">▶ Now{c.running.length > 1 ? ` · ${c.running.length} together` : ""}</div>
          {c.running.map((q) => (
            <div key={`${q.key}#${q.sheet}`} className="flex items-baseline gap-2 flex-wrap">
              {what(q, true)}
              {canEdit && (
                <span className="ms-auto inline-flex flex-wrap justify-end items-center gap-1 no-print">
                  {done(q)}
                  <button type="button" className="btn btn-sm btn-ghost px-1" title="Put it back to waiting" disabled={a.pending} onClick={() => { const fd = line(q.bom, q.mo, q.item, q.sheet); fd.set("running", "false"); a.run(setLineRunning, fd); }}>⏸</button>
                  <button type="button" className="btn btn-sm btn-ghost px-1" title={sheetJobOf(jobs, q.mo) ? "Split — keep only some sheets here" : "Split — keep only some pieces here"} disabled={a.pending} onClick={() => resize(q)}>✂</button>
                  <button type="button" className="btn btn-sm btn-ghost px-1 text-bad-fg" title="Take off this machine" disabled={a.pending} onClick={() => a.run(unassignLineMachine, line(q.bom, q.mo, q.item, q.sheet))}>✕</button>
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed px-2.5 py-2 text-xs text-muted">
          {c.waiting.length > 0 ? "Nothing running — press ▶ on a waiting line." : jobsBySheet(dept) ? `Nothing on it — ✋ Add job puts sheets on this ${machineWord(dept)}.` : `Nothing on it — pick this ${machineWord(dept)} on a line below.`}
        </div>
      )}

      {c.waiting.length > 0 && (
        <ol className="space-y-1">
          {c.waiting.map((q, i) => (
            <li key={`${q.key}#${q.sheet}`} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
              <span className="w-5 text-center font-extrabold tabnum text-muted">{i + 1}</span>
              {what(q, false)}
              {canEdit && (
                <span className="ms-auto inline-flex flex-wrap justify-end items-center gap-1 no-print">
                  {done(q)}
                  <button type="button" className="btn btn-sm btn-ghost px-1 text-ok-fg" title="Start it now, alongside what runs" disabled={a.pending} onClick={() => { const fd = line(q.bom, q.mo, q.item, q.sheet); fd.set("running", "true"); a.run(setLineRunning, fd); }}>▶</button>
                  <button type="button" className="btn btn-sm btn-ghost px-1" title="Next in line" disabled={a.pending || i === 0} onClick={() => { const fd = line(q.bom, q.mo, q.item, q.sheet); fd.set("dir", "top"); a.run(moveLineRank, fd); }}>⏫</button>
                  <button type="button" className="btn btn-sm btn-ghost px-1" title="Up" disabled={a.pending || i === 0} onClick={() => { const fd = line(q.bom, q.mo, q.item, q.sheet); fd.set("dir", "up"); a.run(moveLineRank, fd); }}>▲</button>
                  <button type="button" className="btn btn-sm btn-ghost px-1" title="Down" disabled={a.pending || i === c.waiting.length - 1} onClick={() => { const fd = line(q.bom, q.mo, q.item, q.sheet); fd.set("dir", "down"); a.run(moveLineRank, fd); }}>▼</button>
                  <button type="button" className="btn btn-sm btn-ghost px-1" title={sheetJobOf(jobs, q.mo) ? "Split — keep only some sheets here" : "Split — keep only some pieces here"} disabled={a.pending} onClick={() => resize(q)}>✂</button>
                  <button type="button" className="btn btn-sm btn-ghost px-1 text-bad-fg" title="Take off this machine" disabled={a.pending} onClick={() => a.run(unassignLineMachine, line(q.bom, q.mo, q.item, q.sheet))}>✕</button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {c.queue.length > 0 && (
        <div className="flex items-center gap-1 text-[11px] no-print">
          {c.waiting.length > 0 && <span className="text-muted">{c.waiting.length} waiting</span>}
          <Link href={`/worklist/machines?dept=${dept}&machine=${c.machine.id}`} className="btn btn-sm btn-secondary ms-auto" title="A sheet for the technician: what runs now, then what is next">🖨 Print sheet</Link>
          {canEdit && <button type="button" className="btn btn-sm btn-ghost text-bad-fg" disabled={a.pending} title="Take every line off this machine" onClick={() => { if (!confirm(`Empty ${c.machine.code}'s queue?`)) return; const fd = new FormData(); fd.set("dept", dept); fd.set("machineId", String(c.machine.id)); a.run(clearMachineQueue, fd); }}>Empty</button>}
        </div>
      )}
      {a.err && <div className="text-[11px] text-bad-fg">{a.err}</div>}
    </div>
  );
}

export function MachineBoard({ board, canEdit, canManage = false }: {
  board: MachineBoardData;
  canEdit: boolean;
  /** "machines.manage" — shows the two settings this board is read against,
   *  where the planner is looking when he wants to change them. They used to
   *  be reachable only from the Admin menu, which is not where anyone thinks
   *  "this machine's rate is wrong". */
  canManage?: boolean;
}) {
  // the backlog is long (a month of open orders): it stays FOLDED so the
  // worklist's own tables are what the page shows, and opens on demand
  const [open, setOpen] = useState(false);
  const [showAllDated, setShowAllDated] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [note, setNote] = useState<{ summary?: string; error?: string } | null>(null);
  // the cards say what is on each machine; the timeline says WHEN it comes off
  const [timeline, setTimeline] = useState(false);
  const router = useRouter();
  const [resetting, startReset] = useTransition();
  if (board.cards.length === 0 && board.machines.length === 0) return null;
  const word = machineWord(board.dept);
  const jobs = sheetJobsOf(board);
  // the fabrication board: sheet jobs only — its load reads in sheets
  const sheetBoard = jobsBySheet(board.dept);
  // fabrication runs several work centres (cutting, bending, fins), so a line
  // shows once per centre it still owes work at
  const centres = new Set(board.machines.map((m) => m.center));
  const multi = centres.size > 1 && !sheetBoard;
  const machinesAt = (center: string) => {
    const at = board.machines.filter((m) => m.center === center);
    return at.length > 0 && !sheetBoard ? at : board.machines;
  };
  const reset = () => {
    if (!confirm(`Take every line off every ${word}?\n\nThe board goes back to empty — the work itself is untouched, only the plan of what runs where.`)) return;
    setNote(null);
    startReset(async () => {
      const fd = new FormData();
      fd.set("dept", board.dept);
      const res = await resetMachinePlan(fd);
      if (res.ok) {
        setNote({ summary: res.summary });
        router.refresh();
      } else setNote({ error: res.error });
    });
  };
  // the department clears when its LAST machine does — the queue is worked in
  // parallel, so the longest one is the answer, not the sum
  const slowest = board.cards.reduce((d, c) => (c.days !== null && c.days > d ? c.days : d), 0);
  const clearsISO = board.cards.reduce<string | null>((iso, c) => (c.clearsISO && (!iso || c.clearsISO > iso) ? c.clearsISO : iso), null);
  const tone = board.cards.some((c) => c.days === null) ? null : loadTone(slowest);
  // the sheet board's idle machines fold into one line of chips — a card each
  // would push the weekly plan under them off the screen
  const idleCards = sheetBoard ? board.cards.filter((c) => c.queue.length === 0 && c.machine.active) : [];
  const busyCards = board.cards.filter((c) => !idleCards.includes(c));
  const sheetsQueued = roundSheets(board.cards.reduce((n, c) => n + queueCounts(c, jobs).sheets, 0));
  const jobsQueued = new Set(board.cards.flatMap((c) => c.queue.filter((q) => sheetJobOf(jobs, q.mo)).map((q) => q.key))).size;
  // the weekly plan's dated lines are the ones to place first; the month's
  // undated backlog folds behind its own "show all"
  const dated = board.unassigned.filter((u) => u.deliveryISO);
  const undated = board.unassigned.filter((u) => !u.deliveryISO);
  const datedShown = showAllDated ? dated : dated.slice(0, 12);
  const undatedShown = showAll ? undated : undated.slice(0, 6);
  const row = (u: MachineBoardData["unassigned"][number]) => {
    const job = sheetJobOf(jobs, u.mo);
    return (
      <li key={unassignedKey(u)} className="flex items-center gap-2 text-xs min-w-0">
        {job ? <SheetJobLine job={job} left={u.remaining} /> : <>
        {manualIdOf(u.mo) !== null ? <span className="font-bold truncate">{u.description}</span> : <>
        <span className="font-bold truncate">{u.bom}</span>
        <span className="font-semibold shrink-0">{u.item}</span></>}
        <span className="tabnum font-bold shrink-0">×{u.remaining}</span>
        {multi && <span className="pill pill-muted shrink-0" title={`${CENTER_LABEL[u.center] ?? u.center} — step ${u.stepNo} of ${u.stepCount} on this line's route`}>{u.center}</span>}
        {u.partial && <span className="text-[10px] text-muted tabnum shrink-0" title="The rest of a split line — the other pieces are on a machine already">✂ rest of {u.lineRemaining}</span>}
        {u.hours !== null && <span className="text-muted tabnum shrink-0">{u.hours} h</span>}
        {u.deliveryISO ? <span className="text-muted tabnum shrink-0">📅 {ddmm(u.deliveryISO)}</span> : <span className="text-muted shrink-0">no date</span>}</>}
        <span className="ms-auto shrink-0">
          <MachinePick dept={board.dept} bom={u.bom} mo={u.mo} item={u.item} machines={machinesAt(u.center)} current={undefined} canEdit={canEdit} compact unit={job ? "sheets" : "pcs"} />
        </span>
      </li>
    );
  };
  return (
    <section className="mb-6">
      <h2>
        🏭 {machineWord(board.dept, true)[0].toUpperCase() + machineWord(board.dept, true).slice(1)} — who is on what
        {sheetBoard ? (
          <span className="pill ms-2 normal-case tabnum pill-muted" title={`Sheets of the jobs on the ${machineWord(board.dept, true)} still to cut`}>
            {sheetsQueued} sheet(s) · {jobsQueued} job(s) queued
          </span>
        ) : (
          <span
            className={`pill ms-2 normal-case tabnum ${tone ? (tone === "ok" ? "pill-ok" : tone === "warn" ? "pill-warn" : "pill-bad") : "pill-muted"}`}
            title={`${board.totalHours} standard hours queued over ${board.cards.length} ${machineWord(board.dept, true)}${board.totalAvailableH !== null ? `, ${board.totalAvailableH} h a day between them` : ""} — the department is done when its slowest ${word} is`}
          >
            {slowest >= 1 ? `clears in ${round1(slowest)} day(s)` : slowest > 0 ? "clears today" : `${board.totalHours} h queued`}
            {slowest >= 1 && clearsISO ? ` · ${ddmm(clearsISO)}` : ""}
          </span>
        )}
        {board.unassigned.length > 0 && (
          <button
            type="button"
            className={`pill ms-1 normal-case tabnum no-print cursor-pointer ${open ? "pill-muted" : "pill-warn"}`}
            title={open ? "Fold the list away" : sheetBoard ? `Open the jobs on no ${word} yet` : `Open the lines on no ${word} yet — ${dated.length} from the weekly plan, ${undated.length} open with no date`}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "▾" : "▸"} {board.unassigned.length} not on a {word}
          </button>
        )}
        {canEdit && <AddManualJob dept={board.dept} machines={board.machines} boms={board.jobBoms} jobs={board.manualJobs} />}
        {(canEdit || board.manualJobs.length > 0) && <ManualJobsList dept={board.dept} jobs={board.manualJobs} machines={board.machines} canEdit={canEdit} boms={board.jobBoms} />}
        {canEdit && board.cards.some((c) => c.queue.length > 0) && (
          <button type="button" className="btn btn-sm btn-ghost ms-1 normal-case no-print text-bad-fg" disabled={resetting} onClick={reset} title={`Take every line off every ${word} — the plan is cleared, the work is not touched`}>
            ⟲ Reset
          </button>
        )}
        {!sheetBoard && (board.days?.length ?? 0) > 0 && (
          <button
            type="button"
            className={`btn btn-sm ms-1 normal-case no-print ${timeline ? "btn-secondary" : "btn-ghost"}`}
            onClick={() => setTimeline((v) => !v)}
            title={`Lay every ${word}'s queue on the days ahead — when each job comes off, and which one misses its date`}
          >
            📊 Timeline
          </button>
        )}
        <Link href={`/worklist/machines?dept=${board.dept}`} className="btn btn-sm btn-secondary ms-2 normal-case no-print" title={`One sheet per ${word}, each on its own page — hand them to the technicians`}>🖨 Print all sheets</Link>
        {canManage && (
          <>
            {!sheetBoard && <Link href="/admin/machine-times" className="btn btn-sm btn-ghost ms-1 normal-case no-print" title={`What one piece of each item takes on each ${word}, in hours — the figure every number on this board is priced with`}>⏱ Times</Link>}
            <Link href="/admin/machines" className="btn btn-sm btn-ghost ms-1 normal-case no-print" title={`Add or retire a ${word}, and set its hours a day`}>⚙ Machines</Link>
          </>
        )}
      </h2>
      {note && (
        <div className={`text-xs rounded-lg px-3 py-2 mb-2 border no-print ${note.error ? "bg-bad-light border-bad-fg/30 text-bad-fg" : "bg-brand-light/40 border-brand/30"}`}>
          {note.error ?? note.summary}
        </div>
      )}
      {timeline && <div className="mb-3"><MachineTimeline board={board} /></div>}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {busyCards.map((c) => <Card key={c.machine.id} c={c} board={board} canEdit={canEdit} />)}
      </div>
      {idleCards.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-[11px] font-bold uppercase tracking-wide text-muted">Free — nothing on them</span>
          {idleCards.map((c) => (
            <span key={c.machine.id} className="pill pill-muted ltr tabnum" title={`${c.machine.name}${c.machine.center ? ` · ${CENTER_LABEL[c.machine.center] ?? c.machine.center}` : ""}${c.availableH !== null ? ` · ${c.availableH} h today` : ""}`}>
              {c.machine.code}
            </span>
          ))}
        </div>
      )}
      {open && board.unassigned.length > 0 && (
        <div className="mt-3 bg-surface border rounded-xl px-3 py-2 no-print">
          {sheetBoard ? (
            <>
              <div className="text-xs font-bold text-muted">Jobs on no {word} yet — pick one for each (a number first puts only those sheets there)</div>
              <ul className="mt-1 grid grid-cols-1 gap-x-4 gap-y-1.5 md:grid-cols-2 xl:grid-cols-3">{board.unassigned.map(row)}</ul>
            </>
          ) : (
            <>
              <div className="text-xs font-bold text-muted">Not on a {word} yet — {dated.length} from the weekly plan, {undated.length} open with no date</div>
              {dated.length > 0 && (
                <>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[11px] font-bold uppercase tracking-wide text-brand">📅 Weekly plan — dated, earliest first</span>
                    {dated.length > 12 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowAllDated((v) => !v)}>{showAllDated ? "Show fewer" : `Show all ${dated.length}`}</button>}
                  </div>
                  <ul className="mt-0.5 grid grid-cols-1 gap-x-4 gap-y-1 md:grid-cols-2 xl:grid-cols-3">{datedShown.map(row)}</ul>
                </>
              )}
              {undated.length > 0 && (
                <>
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-[11px] font-bold uppercase tracking-wide text-muted">Open orders — no date yet (the month)</span>
                    {undated.length > 6 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowAll((v) => !v)}>{showAll ? "Show fewer" : `Show all ${undated.length}`}</button>}
                  </div>
                  <ul className="mt-0.5 grid grid-cols-1 gap-x-4 gap-y-1 md:grid-cols-2 xl:grid-cols-3">{undatedShown.map(row)}</ul>
                </>
              )}
            </>
          )}
        </div>
      )}
      <p className="text-[11px] text-muted mt-1">
        {sheetBoard ? (
          <>
            Each job is sheets of one thickness, material and size, carrying the parts of the projects on them — ✋ Add job types it in and puts it on a {word}. ✓ records the sheets a {word} cut (blank = all its sheets of the job, the rest stays in its queue); a job leaves the board once every sheet is cut. To share a job between {machineWord(board.dept, true)}, type the sheets in the box beside the picker before choosing the {word}; ✂ on a card resizes a share. The pieces cut are recorded on the weekly plan below.
          </>
        ) : (
          <>
            Hours are the standard times of what is left on each line{multi ? ", split over the work centres its routing names (a tank is cut, then bent, then its fins folded — so it queues once on each)" : ""}. A {word}&apos;s hours today are its hours a day less the downtime on the shift log. A line leaves the board by itself once nothing remains on it.
            ✓ records what a {word} finished (blank = the whole share, the rest stays in its queue). To split a line, type the pieces in the box beside the picker before choosing the {word}; ✂ on a card resizes a share.
          </>
        )}
      </p>
    </section>
  );
}

/** Show only the lines that are on a machine, or only those that are not —
 *  the chip pair every worklist filter bar carries. */
export type PlacementMode = "" | "on" | "off";

export function PlacementChips({ value, onChange, word, on, off }: { value: PlacementMode; onChange: (v: PlacementMode) => void; word: string; on: number; off: number }) {
  const chip = (mode: PlacementMode, label: string, n: number, title: string) => (
    <button
      type="button"
      onClick={() => onChange(value === mode ? "" : mode)}
      title={title}
      className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition-all hover:border-brand hover:shadow-sm ${value === mode ? "border-brand bg-brand-light shadow-sm" : "bg-surface"}`}
    >
      <span className="text-muted">{label}</span>
      <b className="text-sm tabnum">{n}</b>
    </button>
  );
  return (
    <>
      {chip("on", `🏭 on a ${word}`, on, `Show only the lines already on a ${word}`)}
      {chip("off", `not on a ${word}`, off, `Show only the lines no ${word} has yet`)}
    </>
  );
}

/** Does this line pass the on-a-machine filter? */
export function placementPass(mode: PlacementMode, assigned: Record<string, LinePlacement>, r: { bom: string; mo: string; item: string }): boolean {
  if (!mode) return true;
  const on = !!assigned[`${r.bom}|${r.mo}|${r.item}`];
  return mode === "on" ? on : !on;
}
