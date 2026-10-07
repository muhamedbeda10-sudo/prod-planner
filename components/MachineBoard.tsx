"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { clearWords, loadTone, type LinePlacement, type MachineCard, type MachineQueueLine } from "@/lib/domain/machineBoard";
import { CENTER_LABEL, machineWord, round1 } from "@/lib/domain/shifts";
import type { MachineDTO } from "@/lib/server/machines";
import type { MachineBoardData } from "@/lib/server/machineBoard";
import Link from "next/link";
import { assignLineMachine, clearMachineQueue, getLineSheets, moveLineRank, optimizeMachines, recordSheetDone, resetMachinePlan, setLineQty, setLineRunning, unassignLineMachine } from "@/app/worklist/machineActions";
import { recordOutput } from "@/app/worklist/actions";
import { MachineTimeline } from "@/components/MachineTimeline";
import { LineMaterialChips } from "@/components/LineMaterialChips";
import { AddManualJob, ManualJobsList } from "@/components/ManualJobs";
import { recordManualDone } from "@/app/worklist/manualActions";
import { manualIdOf } from "@/lib/domain/manualJob";
import { runIdOf } from "@/lib/domain/nestRun";
import { AddNestRun, NestRunsList } from "@/components/NestRuns";
import { recordNestRunSheets } from "@/app/worklist/nestRunActions";
import { sheetKeyLabel, sheetKeyOf, thicknessLabel, sheetSizeLabel, type LineMaterial } from "@/lib/domain/machineMaterial";
import { Modal } from "@/components/Modal";

// 🏭 The machine load board on a department's worklist — one card per
// machine: what it is on NOW, what waits behind it, and how many hours the
// queue is against the hours the machine has today (its hours a day less the
// downtime the shift log recorded). Lines are put on a machine from the
// tables below (the Machine column) or from the unassigned list here; their
// order is moved on the card. A line need not go whole: a number of pieces
// typed beside the picker SPLITS it — those go to the machine picked, the
// rest stays put (or waits unassigned) — and ✂ on a card resizes a share.
// Recording output never touches the board — a line leaves it by itself once
// nothing remains. ⚡ Plan does the whole board in one go: every line in the
// order the weekly plan needs it, on the machine that finishes it soonest,
// along the routing (a tank is cut, then bent, then finned) — what is running
// now is never moved.

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

/** The picker a table row carries: which machine this line is on, and a
 *  pieces box to put only some of it there. Saves at once. */
export function MachinePick({ dept, bom, mo, item, sheet, machines, current, canEdit, compact = false }: {
  dept: string; bom: string; mo: string; item: string; machines: MachineDTO[];
  current: LinePlacement | undefined; canEdit: boolean; compact?: boolean;
  /** The one sheet of the item still waiting — put on the machine as that sheet. */
  sheet?: string;
}) {
  const a = useAction();
  const qtyRef = useRef<HTMLInputElement>(null);
  // a cutting machine picked for an item cut from several sheets: which sheet
  // of it this machine takes (or the whole item), and how many pieces
  const [choose, setChoose] = useState<{ machineId: string; material: LineMaterial; qty: string } | null>(null);
  const [asking, startAsking] = useTransition();
  if (machines.length === 0) return null;
  const m = current ? machines.find((x) => x.id === current.machineId) : undefined;
  const share = current?.split ? ` ×${current.qty}` : "";
  const state = current ? `${current.running ? "running now" : `#${current.rank} in its queue`}${share ? `, ${current.qty} pcs of it` : ""}${current.others ? `, ${current.others} more ${machineWord(dept, current.others > 1)} hold a share` : ""}` : "";
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
          disabled={a.pending || asking}
          aria-label="Machine"
          title={m ? `On ${m.name} — ${state}. Pick another to move it there (with a number in the pieces box, only those pieces go), blank to take it off every ${machineWord(dept)}.` : `Put this line on a ${machineWord(dept)} — type pieces first to put only some of it`}
          onChange={(e) => {
            const machineId = e.target.value;
            const put = () => {
              const fd = base();
              fd.set("machineId", machineId);
              fd.set("qty", qtyRef.current?.value ?? "");
              if (sheet) fd.set("sheet", sheet);
              a.run(assignLineMachine, fd);
            };
            if (!machineId || sheet || dept !== "Cut") { put(); return; }
            startAsking(async () => {
              const r = await getLineSheets(base());
              if (r.ok && r.material && r.material.specs.length >= 2) setChoose({ machineId, material: r.material, qty: qtyRef.current?.value ?? "" });
              else put();
            });
          }}
          className={`border rounded-md px-1.5 py-1 bg-surface text-xs font-bold ltr ${compact ? "max-w-[7rem]" : "max-w-[10rem]"} ${current ? "" : "text-muted"}`}
        >
          <option value="">— {machineWord(dept)}</option>
          {machines.map((x) => <option key={x.id} value={x.id}>{x.code}{compact ? "" : ` · ${x.name}`}</option>)}
        </select>
        <input
          key={`${current?.machineId ?? ""}:${current?.split ? current.qty : ""}`}
          ref={qtyRef}
          type="number" min={1} step={1} inputMode="numeric" placeholder="all"
          defaultValue={current?.split ? current.qty : ""}
          disabled={a.pending}
          aria-label="Pieces for the machine"
          title={current ? `Pieces on ${m?.code ?? "the machine"} — blank = the whole line (the rest of it). Enter resizes its share; with another ${machineWord(dept)} picked, this many go there.` : `Pieces to put on the ${machineWord(dept)} picked — blank = the whole line`}
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
      {choose && (
        <SheetChoice
          code={machines.find((x) => String(x.id) === choose.machineId)?.code ?? ""}
          bom={bom} item={item} material={choose.material} defaultQty={choose.qty}
          busy={a.pending}
          onClose={() => setChoose(null)}
          onPick={(sheetKey, qty) => {
            const fd = base();
            fd.set("machineId", choose.machineId);
            fd.set("qty", qty);
            fd.set("sheet", sheetKey);
            a.run(assignLineMachine, fd);
            setChoose(null);
          }}
        />
      )}
    </span>
  );
}

/** Which sheet of the item goes on the machine picked: the BOM's sheets off
 *  the MATERIAL tab's nesting, each with what one piece takes, or the whole
 *  item. The same item can sit on several machines at once, each cutting its
 *  own sheet — the same pieces or a different number of them. */
function SheetChoice({ code, bom, item, material, defaultQty, busy, onClose, onPick }: {
  code: string; bom: string; item: string; material: LineMaterial; defaultQty: string; busy: boolean;
  onClose: () => void; onPick: (sheet: string, qty: string) => void;
}) {
  const [pick, setPick] = useState(sheetKeyOf(material.specs[0]));
  const [qty, setQty] = useState(defaultQty);
  return (
    <Modal title={`${bom} ${item} → ${code}`} sub={`Which sheet does ${code} cut? ${material.partName ? `${material.partName} is` : "It is"} cut from ${material.specs.length} sheets (nesting ${material.month}).`} onClose={onClose} busy={busy} width="max-w-lg">
      <div className="space-y-1.5">
        {material.specs.map((s) => {
          const k = sheetKeyOf(s);
          return (
            <label key={k} className={`flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer ${pick === k ? "border-brand bg-brand-light/40" : ""}`}>
              <input type="radio" name="sheet" checked={pick === k} onChange={() => setPick(k)} className="accent-[var(--brand)]" />
              <b className="tabnum">{thicknessLabel(s)}</b>
              <span className="text-muted tabnum">{sheetSizeLabel(s.sheetSize)}</span>
              <span className="ms-auto text-xs text-muted tabnum">{s.perUnit} sheet/pc{s.actual ? "" : " (BOM)"}</span>
            </label>
          );
        })}
        <label className={`flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer ${pick === "" ? "border-brand bg-brand-light/40" : ""}`}>
          <input type="radio" name="sheet" checked={pick === ""} onChange={() => setPick("")} className="accent-[var(--brand)]" />
          <b>Whole item</b><span className="text-xs text-muted">every sheet on {code}</span>
        </label>
      </div>
      <label className="flex items-center gap-2 mt-3 text-sm">
        <span className="text-muted text-xs font-semibold">Pieces</span>
        <input type="number" min={1} step={1} value={qty} onChange={(e) => setQty(e.target.value)} placeholder="all" className="border rounded-md px-2 py-1 bg-surface text-sm tabnum w-24" />
        <span className="text-[11px] text-muted">blank = all of it</span>
      </label>
      <div className="flex justify-end gap-2 mt-3">
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => onPick(pick, qty)}>Put on {code}</button>
      </div>
      <p className="text-[11px] text-muted mt-2">Pick the machine again for another sheet — each machine cuts its own sheet of the item at the same time.</p>
    </Modal>
  );
}

/** ✅ Items cut on EVERY one of their sheets: those pieces are whole. One
 *  click records them as cut — the item's Cut record, the same one the
 *  worklist writes — and takes them off the sheets' figures on the cards. */
function ReadyCutPanel({ board, canEdit }: { board: MachineBoardData; canEdit: boolean }) {
  const a = useAction();
  const record = (r: MachineBoardData["readyCut"][number]) => {
    if (!confirm(`Record ${r.qty} × ${r.bom} ${r.item} as cut?\n\nEvery sheet of it is cut for ${r.qty} piece(s).`)) return;
    const fd = new FormData();
    fd.set("date", board.dayISO); fd.set("dept", board.dept); fd.set("bom", r.bom); fd.set("mo", r.mo); fd.set("item", r.item);
    fd.set("qty", String(r.qty)); fd.set("planNo", String(board.planNo));
    a.run(recordOutput, fd);
  };
  return (
    <div className="mb-3 rounded-xl border border-ok-fg/40 bg-ok-bg/40 px-3 py-2">
      <div className="text-[11px] font-bold uppercase tracking-wide text-ok-fg">✅ Cut on every sheet — ready to record</div>
      <ul className="mt-1 space-y-1">
        {board.readyCut.map((r) => (
          <li key={r.key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
            <b>{r.bom}</b><b>{r.item}</b>
            <span className="text-xs text-muted">{r.mo}</span>
            <span className="tabnum font-extrabold text-ok-fg">{r.qty} pcs whole</span>
            <span className="text-xs text-muted tabnum">{r.sheets.map((x) => `${sheetKeyLabel(x.sheet)}: ${x.cut}`).join(" · ")}</span>
            {canEdit && (
              <button type="button" className="btn btn-sm btn-primary ms-auto no-print" disabled={a.pending} onClick={() => record(r)} title="Record these pieces as cut — the item's Cut record on the worklist">
                Record {r.qty} as cut
              </button>
            )}
          </li>
        ))}
      </ul>
      {a.err && <div className="text-xs text-bad-fg mt-1">{a.err}</div>}
    </div>
  );
}

/** ✓ Done straight off the card: the whole share in one click, or the pieces
 *  actually finished — the rest stays in the machine's queue. */
export function DoneBox({ board, q, machineId, onErr }: { board: MachineBoardData; q: MachineQueueLine; machineId?: number; onErr: (m: string) => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [val, setVal] = useState("");
  // a welded tank carries a serial and the welder's name — that recording
  // belongs on the queue table, not on a card
  if (board.tankSerials && q.item === "TN") return null;
  const save = () => {
    const qty = Number(val.trim() || q.remaining);
    if (!Number.isFinite(qty) || qty <= 0) { onErr("Enter pieces above 0."); return; }
    if (qty > q.remaining) { onErr(`Only ${q.remaining} left on this ${board.dept === "Welding" ? "partition" : "machine"}.`); return; }
    onErr("");
    const fd = new FormData();
    fd.set("date", board.dayISO); fd.set("dept", board.dept); fd.set("bom", q.bom); fd.set("mo", q.mo); fd.set("item", q.item);
    fd.set("qty", String(qty)); fd.set("planNo", String(board.planNo));
    // what was finished on WHICH machine — the only place the app learns it
    if (machineId !== undefined) fd.set("machineId", String(machineId));
    // a job from outside the plan records on itself, never in the plan's
    // ledger; one sheet of an item records that sheet's cutting only
    const manual = manualIdOf(q.mo);
    const run = runIdOf(q.mo);
    if (manual !== null) fd.set("id", String(manual));
    if (run !== null) fd.set("id", String(run));
    fd.set("sheet", q.sheet);
    startTransition(async () => {
      const res = manual !== null ? await recordManualDone(fd) : run !== null ? await recordNestRunSheets(fd) : q.sheet ? await recordSheetDone(fd) : await recordOutput(fd);
      if (res.ok) { setVal(""); router.refresh(); } else onErr(res.error ?? "Failed");
    });
  };
  return (
    <span className="inline-flex items-center gap-0.5 no-print">
      <input
        type="number" min={1} max={q.remaining} step={1} inputMode="numeric" placeholder={String(q.remaining)}
        value={val} disabled={pending} aria-label="Pieces done"
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }}
        className="border rounded-md px-1 py-0.5 bg-surface text-xs tabnum w-12 ltr"
        title={runIdOf(q.mo) !== null ? `Sheets of the run finished — blank = all ${q.remaining}. Each job's pieces follow.` : q.sheet ? `Pieces' worth of this sheet cut — blank = all ${q.remaining}. Once every sheet of the item is cut, the board offers to record the whole pieces.` : `Pieces finished — blank records all ${q.remaining}. What is left stays in the queue.`}
      />
      <button type="button" className="btn btn-sm btn-primary px-1.5" disabled={pending} title={`Record what is done (blank = all ${q.remaining}); the rest stays in the queue`} onClick={save}>✓</button>
    </span>
  );
}

/** The sheets a line takes are counted where it is CUT — the first step of
 *  the cutting route; a bend, a weld or a coat only needs the thickness. */
function sheetsHere(dept: string, q: MachineQueueLine): boolean {
  return dept === "Cut" && q.stepNo === 1;
}

function Card({ c, board, canEdit }: { c: MachineCard; board: MachineBoardData; canEdit: boolean }) {
  const dept = board.dept;
  const a = useAction();
  const tone = loadTone(c.load);
  // the bar reads as WORK AHEAD, five days wide — a full bar is a week of it
  const pct = c.days === null ? null : Math.min(100, Math.round((c.days / 5) * 100));
  const line = (bom: string, mo: string, item: string, sheet = "") => {
    const fd = new FormData();
    fd.set("dept", dept); fd.set("bom", bom); fd.set("mo", mo); fd.set("item", item); fd.set("sheet", sheet);
    fd.set("machineId", String(c.machine.id));
    return fd;
  };
  // ✂ — how many pieces of the line stay on this machine; the rest waits
  // for another machine (or goes back to it whole with a blank)
  const resize = (q: { bom: string; mo: string; item: string; sheet: string; remaining: number; lineRemaining: number }) => {
    const v = prompt(`Pieces of ${q.bom} ${q.item} on ${c.machine.code} — of ${q.lineRemaining} (blank = the rest of the line):`, String(q.remaining));
    if (v === null) return;
    const fd = line(q.bom, q.mo, q.item, q.sheet);
    fd.set("qty", v.trim());
    a.run(setLineQty, fd);
  };
  const done = (q: MachineQueueLine) => (canEdit ? <DoneBox board={board} q={q} machineId={c.machine.id} onErr={a.setErr} /> : null);
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
          <div
            className={`text-lg font-extrabold tabnum leading-tight ${tone ? TONE_INK[tone] : ""}`}
            title={c.availableH ? `${c.hours} standard hours of work at ${c.availableH} h a day` : "No hours a day set for this machine — set it in Tools → Machines"}
          >
            {clearWords(c.hours, c.availableH)}
          </div>
          <div className="text-[11px] text-muted tabnum">{c.hours} h · {c.pcs} pcs · {c.queue.length} line(s)</div>
          {c.clearsISO && <div className="text-[11px] text-muted tabnum" title="The working day this queue is finished — Fridays and the calendar's days off skipped">clears {ddmm(c.clearsISO)}</div>}
        </div>
      </div>
      {pct !== null && (
        <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden" title={c.days === null ? "" : `${c.days} working day(s) of work ahead — the bar is five days wide`}>
          <div className={`h-full ${tone ? TONE_BAR[tone] : "bg-muted"}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      {c.unpricedPcs > 0 && <div className="text-[10px] text-warn-fg">{c.unpricedPcs} pcs with no standard time — hours undercounted</div>}

      {c.running.length > 0 ? (
        <div className="rounded-lg border border-brand/40 bg-brand-light/30 px-2.5 py-2 space-y-1">
          <div className="text-[10px] font-bold uppercase tracking-wide text-brand">▶ Now{c.running.length > 1 ? ` · ${c.running.length} together` : ""}</div>
          {c.running.map((q) => (
            <div key={`${q.key}#${q.sheet}`} className="flex items-baseline gap-2 flex-wrap">
              {manualIdOf(q.mo) !== null || runIdOf(q.mo) !== null ? <span className="font-extrabold">{q.description}</span> : <>
              <span className="font-extrabold">{q.bom}</span>
              <span className="font-bold">{q.item}</span></>}
              <span className="tabnum font-extrabold text-brand">×{q.remaining}</span>
              {q.split && <span className="text-[11px] text-muted tabnum whitespace-nowrap" title="Part of the line — the rest is on another machine or waits">✂ of {q.lineRemaining}</span>}
              {q.hours !== null && <span className="text-xs text-muted tabnum whitespace-nowrap">{q.hours} h</span>}
              {q.deliveryISO && <span className={`pill tabnum ${q.deliveryISO < new Date().toISOString().slice(0, 10) ? "pill-bad" : "pill-muted"}`}>📅 {ddmm(q.deliveryISO)}</span>}
              <span className="text-[11px] text-muted truncate">{q.mo}{q.description ? ` · ${q.description}` : ""}</span>
              <LineMaterialChips m={board.material[q.key]} pcs={q.remaining} sheets={sheetsHere(board.dept, q)} sheet={q.sheet} />
              {q.sheetDone > 0 && <span className="text-[10px] text-ok-fg tabnum whitespace-nowrap" title="Pieces' worth of this sheet already cut here — once every sheet is cut, the board offers to record the whole pieces">✓ {q.sheetDone} cut</span>}
              {canEdit && (
                <span className="ms-auto inline-flex items-center gap-1 no-print">
                  {done(q)}
                  <button type="button" className="btn btn-sm btn-ghost px-1" title="Put it back to waiting" disabled={a.pending} onClick={() => { const fd = line(q.bom, q.mo, q.item, q.sheet); fd.set("running", "false"); a.run(setLineRunning, fd); }}>⏸</button>
                  <button type="button" className="btn btn-sm btn-ghost px-1" title="Split — keep only some pieces here" disabled={a.pending} onClick={() => resize(q)}>✂</button>
                  <button type="button" className="btn btn-sm btn-ghost px-1 text-bad-fg" title="Take off this machine" disabled={a.pending} onClick={() => a.run(unassignLineMachine, line(q.bom, q.mo, q.item, q.sheet))}>✕</button>
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed px-2.5 py-2 text-xs text-muted">{c.waiting.length > 0 ? "Nothing running — press ▶ on a waiting line." : `Nothing on it — pick this ${machineWord(dept)} on a line below.`}</div>
      )}

      {c.waiting.length > 0 && (
        <ol className="space-y-1">
          {c.waiting.map((q, i) => (
            <li key={`${q.key}#${q.sheet}`} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
              <span className="w-5 text-center font-extrabold tabnum text-muted">{i + 1}</span>
              {manualIdOf(q.mo) !== null || runIdOf(q.mo) !== null ? <span className="font-bold">{q.description}</span> : <>
              <span className="font-bold">{q.bom}</span>
              <span className="font-semibold">{q.item}</span></>}
              <span className="tabnum font-bold">×{q.remaining}</span>
              {q.split && <span className="text-[10px] text-muted tabnum whitespace-nowrap" title="Part of the line — the rest is on another machine or waits">✂ of {q.lineRemaining}</span>}
              {q.hours !== null && <span className="text-muted tabnum whitespace-nowrap">{q.hours} h</span>}
              {q.deliveryISO && <span className="text-muted tabnum whitespace-nowrap">📅 {ddmm(q.deliveryISO)}</span>}
              <LineMaterialChips m={board.material[q.key]} pcs={q.remaining} sheets={sheetsHere(board.dept, q)} sheet={q.sheet} />
              {q.sheetDone > 0 && <span className="text-[10px] text-ok-fg tabnum whitespace-nowrap" title="Pieces' worth of this sheet already cut here — once every sheet is cut, the board offers to record the whole pieces">✓ {q.sheetDone} cut</span>}
              {canEdit && (
                <span className="ms-auto inline-flex items-center gap-1 no-print">
                  {done(q)}
                  <button type="button" className="btn btn-sm btn-ghost px-1 text-ok-fg" title="Start it now, alongside what runs" disabled={a.pending} onClick={() => { const fd = line(q.bom, q.mo, q.item, q.sheet); fd.set("running", "true"); a.run(setLineRunning, fd); }}>▶</button>
                  <button type="button" className="btn btn-sm btn-ghost px-1" title="Next in line" disabled={a.pending || i === 0} onClick={() => { const fd = line(q.bom, q.mo, q.item, q.sheet); fd.set("dir", "top"); a.run(moveLineRank, fd); }}>⏫</button>
                  <button type="button" className="btn btn-sm btn-ghost px-1" title="Up" disabled={a.pending || i === 0} onClick={() => { const fd = line(q.bom, q.mo, q.item, q.sheet); fd.set("dir", "up"); a.run(moveLineRank, fd); }}>▲</button>
                  <button type="button" className="btn btn-sm btn-ghost px-1" title="Down" disabled={a.pending || i === c.waiting.length - 1} onClick={() => { const fd = line(q.bom, q.mo, q.item, q.sheet); fd.set("dir", "down"); a.run(moveLineRank, fd); }}>▼</button>
                  <button type="button" className="btn btn-sm btn-ghost px-1" title="Split — keep only some pieces here" disabled={a.pending} onClick={() => resize(q)}>✂</button>
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
  const [note, setNote] = useState<{ summary?: string; late?: string; error?: string } | null>(null);
  // the cards say what is on each machine; the timeline says WHEN it comes off
  const [timeline, setTimeline] = useState(false);
  const router = useRouter();
  const [planning, startPlanning] = useTransition();
  if (board.cards.length === 0 && board.machines.length === 0) return null;
  const word = machineWord(board.dept);
  // fabrication runs several work centres (cutting, bending, fins), so a line
  // shows once per centre it still owes work at
  const centres = new Set(board.machines.map((m) => m.center));
  const multi = centres.size > 1;
  const machinesAt = (center: string) => {
    const at = board.machines.filter((m) => m.center === center);
    return at.length > 0 ? at : board.machines;
  };
  const reset = () => {
    if (!confirm(`Take every line off every ${word}?\n\nThe board goes back to empty — the work itself is untouched, only the plan of what runs where. ⚡ Plan fills it again.`)) return;
    setNote(null);
    startPlanning(async () => {
      const fd = new FormData();
      fd.set("dept", board.dept);
      const res = await resetMachinePlan(fd);
      if (res.ok) {
        setNote({ summary: res.summary });
        router.refresh();
      } else setNote({ error: res.error });
    });
  };
  const plan = () => {
    if (!confirm(`Plan every ${word} from the weekly plan?\n\nEvery waiting line is re-ordered: earliest date first, each on the ${word} that finishes it soonest. What is RUNNING now stays where it is.`)) return;
    setNote(null);
    startPlanning(async () => {
      const fd = new FormData();
      fd.set("dept", board.dept);
      const res = await optimizeMachines(fd);
      if (res.ok) {
        setNote({ summary: res.summary, late: res.lateNote });
        router.refresh();
      } else setNote({ error: res.error });
    });
  };
  // the department clears when its LAST machine does — the queue is worked in
  // parallel, so the longest one is the answer, not the sum
  const slowest = board.cards.reduce((d, c) => (c.days !== null && c.days > d ? c.days : d), 0);
  const clearsISO = board.cards.reduce<string | null>((iso, c) => (c.clearsISO && (!iso || c.clearsISO > iso) ? c.clearsISO : iso), null);
  const tone = board.cards.some((c) => c.days === null) ? null : loadTone(slowest);
  // the weekly plan's dated lines are the ones to place first; the month's
  // undated backlog folds behind its own "show all"
  const dated = board.unassigned.filter((u) => u.deliveryISO);
  const undated = board.unassigned.filter((u) => !u.deliveryISO);
  const datedShown = showAllDated ? dated : dated.slice(0, 12);
  const undatedShown = showAll ? undated : undated.slice(0, 6);
  const row = (u: MachineBoardData["unassigned"][number]) => (
    <li key={`${u.key}#${u.center}`} className="flex items-center gap-2 text-xs min-w-0">
      {manualIdOf(u.mo) !== null || runIdOf(u.mo) !== null ? <span className="font-bold truncate">{u.description}</span> : <>
      <span className="font-bold truncate">{u.bom}</span>
      <span className="font-semibold shrink-0">{u.item}</span></>}
      <span className="tabnum font-bold shrink-0">×{u.remaining}</span>
      {multi && <span className="pill pill-muted shrink-0" title={`${CENTER_LABEL[u.center] ?? u.center} — step ${u.stepNo} of ${u.stepCount} on this line's route`}>{u.center}</span>}
      {u.partial && <span className="text-[10px] text-muted tabnum shrink-0" title="The rest of a split line — the other pieces are on a machine already">✂ rest of {u.lineRemaining}</span>}
      {u.sheet && <span className="pill pill-warn shrink-0" title="This sheet of the item has no machine yet — its other sheets do">{sheetKeyLabel(u.sheet)}</span>}
      {u.hours !== null && <span className="text-muted tabnum shrink-0">{u.hours} h</span>}
      {u.deliveryISO ? <span className="text-muted tabnum shrink-0">📅 {ddmm(u.deliveryISO)}</span> : <span className="text-muted shrink-0">no date</span>}
      <span className="ms-auto shrink-0">
        <MachinePick dept={board.dept} bom={u.bom} mo={u.mo} item={u.item} sheet={u.sheet} machines={machinesAt(u.center)} current={undefined} canEdit={canEdit} compact />
      </span>
    </li>
  );
  return (
    <section className="mb-6">
      <h2>
        🏭 {machineWord(board.dept, true)[0].toUpperCase() + machineWord(board.dept, true).slice(1)} — who is on what
        <span
          className={`pill ms-2 normal-case tabnum ${tone ? (tone === "ok" ? "pill-ok" : tone === "warn" ? "pill-warn" : "pill-bad") : "pill-muted"}`}
          title={`${board.totalHours} standard hours queued over ${board.cards.length} ${machineWord(board.dept, true)}${board.totalAvailableH !== null ? `, ${board.totalAvailableH} h a day between them` : ""} — the department is done when its slowest ${word} is`}
        >
          {slowest >= 1 ? `clears in ${round1(slowest)} day(s)` : slowest > 0 ? "clears today" : `${board.totalHours} h queued`}
          {slowest >= 1 && clearsISO ? ` · ${ddmm(clearsISO)}` : ""}
        </span>
        {board.unassigned.length > 0 && (
          <button
            type="button"
            className={`pill ms-1 normal-case tabnum no-print cursor-pointer ${open ? "pill-muted" : "pill-warn"}`}
            title={open ? "Fold the list away" : `Open the lines on no ${word} yet — ${dated.length} from the weekly plan, ${undated.length} open with no date`}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "▾" : "▸"} {board.unassigned.length} not on a {word}
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            className="btn btn-sm btn-primary ms-2 normal-case no-print"
            disabled={planning}
            onClick={plan}
            title={`Work out what every ${word} should run, and in what order, from the weekly plan — earliest date first, each line on the ${word} that finishes it soonest. What is running now stays.`}
          >
            {planning ? "Planning…" : "⚡ Plan the " + machineWord(board.dept, true)}
          </button>
        )}
        {canEdit && board.cards.some((c) => c.queue.length > 0) && (
          <button type="button" className="btn btn-sm btn-ghost ms-1 normal-case no-print text-bad-fg" disabled={planning} onClick={reset} title={`Take every line off every ${word} — the plan is cleared, the work is not touched`}>
            ⟲ Reset
          </button>
        )}
        {(board.days?.length ?? 0) > 0 && (
          <button
            type="button"
            className={`btn btn-sm ms-1 normal-case no-print ${timeline ? "btn-secondary" : "btn-ghost"}`}
            onClick={() => setTimeline((v) => !v)}
            title={`Lay every ${word}'s queue on the days ahead — when each job comes off, and which one misses its date`}
          >
            📊 Timeline
          </button>
        )}
        {canEdit && board.dept === "Cut" && <AddNestRun machines={board.machines} options={board.runOptions} candidates={board.runCandidates} />}
        {board.dept === "Cut" && (canEdit || board.nestRuns.length > 0) && <NestRunsList runs={board.nestRuns} machines={board.machines} canEdit={canEdit} />}
        {canEdit && <AddManualJob dept={board.dept} machines={board.machines} />}
        {(canEdit || board.manualJobs.length > 0) && <ManualJobsList dept={board.dept} jobs={board.manualJobs} machines={board.machines} canEdit={canEdit} />}
        <Link href={`/worklist/machines?dept=${board.dept}`} className="btn btn-sm btn-secondary ms-2 normal-case no-print" title={`One sheet per ${word}, each on its own page — hand them to the technicians`}>🖨 Print all sheets</Link>
        {canManage && (
          <>
            <Link href="/admin/machine-times" className="btn btn-sm btn-ghost ms-1 normal-case no-print" title={`What one piece of each item takes on each ${word}, in hours — the figure every number on this board is priced with`}>⏱ Times</Link>
            <Link href="/admin/machines" className="btn btn-sm btn-ghost ms-1 normal-case no-print" title={`Add or retire a ${word}, and set its hours a day`}>⚙ Machines</Link>
          </>
        )}
      </h2>
      {note && (
        <div className={`text-xs rounded-lg px-3 py-2 mb-2 border no-print ${note.error ? "bg-bad-light border-bad-fg/30 text-bad-fg" : "bg-brand-light/40 border-brand/30"}`}>
          {note.error ?? note.summary}
          {note.late && <div className="text-warn-fg font-semibold mt-0.5">⚠ {note.late}</div>}
        </div>
      )}
      {board.readyCut.length > 0 && <ReadyCutPanel board={board} canEdit={canEdit} />}
      {timeline && <div className="mb-3"><MachineTimeline board={board} /></div>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {board.cards.map((c) => <Card key={c.machine.id} c={c} board={board} canEdit={canEdit} />)}
      </div>
      {open && board.unassigned.length > 0 && (
        <div className="mt-3 bg-surface border rounded-xl px-3 py-2 no-print">
          <div className="text-xs font-bold text-muted">Not on a {word} yet — {dated.length} from the weekly plan, {undated.length} open with no date</div>
          {dated.length > 0 && (
            <>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[11px] font-bold uppercase tracking-wide text-brand">📅 Weekly plan — dated, earliest first</span>
                {dated.length > 12 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowAllDated((v) => !v)}>{showAllDated ? "Show fewer" : `Show all ${dated.length}`}</button>}
              </div>
              <ul className="mt-0.5 grid gap-x-4 gap-y-1 md:grid-cols-2 xl:grid-cols-3">{datedShown.map(row)}</ul>
            </>
          )}
          {undated.length > 0 && (
            <>
              <div className="flex items-center gap-2 mt-2">
                <span className="text-[11px] font-bold uppercase tracking-wide text-muted">Open orders — no date yet (the month)</span>
                {undated.length > 6 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowAll((v) => !v)}>{showAll ? "Show fewer" : `Show all ${undated.length}`}</button>}
              </div>
              <ul className="mt-0.5 grid gap-x-4 gap-y-1 md:grid-cols-2 xl:grid-cols-3">{undatedShown.map(row)}</ul>
            </>
          )}
        </div>
      )}
      <p className="text-[11px] text-muted mt-1">
        Hours are the standard times of what is left on each line{multi ? ", split over the work centres its routing names (a tank is cut, then bent, then its fins folded — so it queues once on each)" : ""}. A {word}&apos;s hours today are its hours a day less the downtime on the shift log. A line leaves the board by itself once nothing remains on it.
        ✓ records what a {word} finished (blank = the whole share, the rest stays in its queue). To split a line, type the pieces in the box beside the picker before choosing the {word}; ✂ on a card resizes a share.
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
