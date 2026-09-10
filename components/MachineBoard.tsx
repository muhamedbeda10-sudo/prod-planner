"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { loadTone, type MachineCard } from "@/lib/domain/machineBoard";
import { CENTER_LABEL } from "@/lib/domain/shifts";
import type { MachineDTO } from "@/lib/server/machines";
import type { MachineBoardData } from "@/lib/server/machineBoard";
import { assignLineMachine, clearMachineQueue, moveLineRank } from "@/app/worklist/machineActions";

// 🏭 The machine load board on a department's worklist — one card per
// machine: what it is on NOW, what waits behind it, and how many hours the
// queue is against the hours the machine has today (its hours a day less the
// downtime the shift log recorded). Lines are put on a machine from the
// tables below (the Machine column) or from the unassigned list here; their
// order is moved on the card. Recording output never touches the board — a
// line leaves it by itself once nothing remains.

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
  return { pending, err, run };
}

function ddmm(iso: string) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

const TONE_BAR: Record<"ok" | "warn" | "bad", string> = { ok: "bg-ok-fg", warn: "bg-warn-fg", bad: "bg-bad-fg" };
const TONE_INK: Record<"ok" | "warn" | "bad", string> = { ok: "text-ok-fg", warn: "text-warn-fg", bad: "text-bad-fg" };

/** The picker a table row carries: which machine this line is on. Saves at once. */
export function MachinePick({ dept, bom, mo, item, machines, current, canEdit, compact = false }: {
  dept: string; bom: string; mo: string; item: string; machines: MachineDTO[];
  current: { machineId: number; rank: number } | undefined; canEdit: boolean; compact?: boolean;
}) {
  const a = useAction();
  if (machines.length === 0) return null;
  const m = current ? machines.find((x) => x.id === current.machineId) : undefined;
  if (!canEdit) {
    return m ? <span className="pill pill-muted ltr tabnum" title={`On ${m.name}, ${current!.rank === 1 ? "running now" : `#${current!.rank} in its queue`}`}>{m.code}{current!.rank === 1 ? " ▶" : ` #${current!.rank}`}</span> : <span className="text-muted text-xs">—</span>;
  }
  return (
    <span className="inline-flex flex-col items-start" onClick={(e) => e.stopPropagation()}>
      <span className="inline-flex items-center gap-1">
        <select
          value={current?.machineId ?? ""}
          disabled={a.pending}
          aria-label="Machine"
          title={m ? `On ${m.name} — ${current!.rank === 1 ? "running now" : `#${current!.rank} in its queue`}. Pick another to move it, blank to take it off.` : "Put this line on a machine"}
          onChange={(e) => {
            const fd = new FormData();
            fd.set("dept", dept); fd.set("bom", bom); fd.set("mo", mo); fd.set("item", item);
            fd.set("machineId", e.target.value);
            a.run(assignLineMachine, fd);
          }}
          className={`border rounded-md px-1.5 py-1 bg-surface text-xs font-bold ltr ${compact ? "max-w-[7rem]" : "max-w-[10rem]"} ${current ? "" : "text-muted"}`}
        >
          <option value="">— machine</option>
          {machines.map((x) => <option key={x.id} value={x.id}>{x.code}{compact ? "" : ` · ${x.name}`}</option>)}
        </select>
        {current && (
          <span className={`pill ${current.rank === 1 ? "pill-ok" : "pill-muted"} tabnum`} title={current.rank === 1 ? "Running on it now" : `#${current.rank} in the machine's queue`}>
            {current.rank === 1 ? "▶ now" : `#${current.rank}`}
          </span>
        )}
      </span>
      {a.err && <span className="text-[10px] text-bad-fg">{a.err}</span>}
    </span>
  );
}

function Card({ c, dept, canEdit }: { c: MachineCard; dept: string; canEdit: boolean }) {
  const a = useAction();
  const tone = loadTone(c.load);
  const pct = c.load === null ? null : Math.min(100, Math.round(Math.min(c.load, 9) * 100));
  const line = (bom: string, mo: string, item: string) => {
    const fd = new FormData();
    fd.set("dept", dept); fd.set("bom", bom); fd.set("mo", mo); fd.set("item", item);
    return fd;
  };
  return (
    <div className={`bg-surface border rounded-xl p-3 flex flex-col gap-2 ${c.machine.active ? "" : "opacity-70"}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-extrabold ltr tabnum">{c.machine.code} <span className="font-semibold text-sm">· {c.machine.name}</span></div>
          <div className="text-[11px] text-muted">
            {c.machine.center && <span>{CENTER_LABEL[c.machine.center] ?? c.machine.center} · </span>}
            {c.availableH !== null ? <span className="tabnum">{c.availableH} h today{c.downtimeH > 0 ? ` (${c.downtimeH} h down)` : ""}</span> : "hours/day not set"}
            {c.crewH > 0 && <span className="tabnum"> · crew {c.crewH} mh</span>}
            {!c.machine.active && <span className="pill pill-muted ms-1">retired</span>}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={`text-lg font-extrabold tabnum leading-tight ${tone ? TONE_INK[tone] : ""}`} title="Standard hours of the whole queue">{c.hours} h</div>
          <div className="text-[11px] text-muted tabnum">{c.pcs} pcs · {c.queue.length} line(s){c.days !== null ? ` · ${c.days} day(s)` : ""}</div>
        </div>
      </div>
      {pct !== null && (
        <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden" title={c.load === Infinity ? "Nothing available today" : `Loaded to ${Math.round(c.load! * 100)}% of today's hours`}>
          <div className={`h-full ${tone ? TONE_BAR[tone] : "bg-muted"}`} style={{ width: `${c.load === Infinity ? 100 : pct}%` }} />
        </div>
      )}
      {c.unpricedPcs > 0 && <div className="text-[10px] text-warn-fg">{c.unpricedPcs} pcs with no standard time — hours undercounted</div>}

      {c.now ? (
        <div className="rounded-lg border border-brand/40 bg-brand-light/30 px-2.5 py-2">
          <div className="text-[10px] font-bold uppercase tracking-wide text-brand">▶ Now</div>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-extrabold">{c.now.bom}</span>
            <span className="font-bold">{c.now.item}</span>
            <span className="tabnum font-extrabold text-brand">×{c.now.remaining}</span>
            {c.now.hours !== null && <span className="text-xs text-muted tabnum">{c.now.hours} h</span>}
            {c.now.deliveryISO && <span className={`pill tabnum ${c.now.deliveryISO < new Date().toISOString().slice(0, 10) ? "pill-bad" : "pill-muted"}`}>📅 {ddmm(c.now.deliveryISO)}</span>}
          </div>
          <div className="text-[11px] text-muted truncate">{c.now.mo}{c.now.description ? ` · ${c.now.description}` : ""}</div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed px-2.5 py-2 text-xs text-muted">Nothing on it — pick this machine on a line below.</div>
      )}

      {c.queue.length > 1 && (
        <ol className="space-y-1">
          {c.queue.slice(1).map((q, i) => (
            <li key={q.key} className="flex items-center gap-1.5 text-xs">
              <span className="w-5 text-center font-extrabold tabnum text-muted">{q.rank}</span>
              <span className="font-bold">{q.bom}</span>
              <span className="font-semibold">{q.item}</span>
              <span className="tabnum font-bold">×{q.remaining}</span>
              {q.hours !== null && <span className="text-muted tabnum">{q.hours} h</span>}
              {q.deliveryISO && <span className="text-muted tabnum">📅 {ddmm(q.deliveryISO)}</span>}
              {canEdit && (
                <span className="ms-auto inline-flex gap-0.5 no-print">
                  <button type="button" className="btn btn-sm btn-ghost px-1" title="Run this next" disabled={a.pending} onClick={() => { const fd = line(q.bom, q.mo, q.item); fd.set("dir", "top"); a.run(moveLineRank, fd); }}>⏫</button>
                  <button type="button" className="btn btn-sm btn-ghost px-1" title="Up" disabled={a.pending || i === 0} onClick={() => { const fd = line(q.bom, q.mo, q.item); fd.set("dir", "up"); a.run(moveLineRank, fd); }}>▲</button>
                  <button type="button" className="btn btn-sm btn-ghost px-1" title="Down" disabled={a.pending || i === c.queue.length - 2} onClick={() => { const fd = line(q.bom, q.mo, q.item); fd.set("dir", "down"); a.run(moveLineRank, fd); }}>▼</button>
                  <button type="button" className="btn btn-sm btn-ghost px-1 text-bad-fg" title="Take off this machine" disabled={a.pending} onClick={() => { const fd = line(q.bom, q.mo, q.item); fd.set("machineId", ""); a.run(assignLineMachine, fd); }}>✕</button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {canEdit && c.now && (
        <div className="flex items-center gap-1 text-[11px] no-print">
          {c.queue.length > 1 && <span className="text-muted">{c.queue.length - 1} waiting</span>}
          <button type="button" className="btn btn-sm btn-ghost ms-auto text-bad-fg" disabled={a.pending} title="Take every line off this machine" onClick={() => { if (!confirm(`Empty ${c.machine.code}'s queue?`)) return; const fd = new FormData(); fd.set("dept", dept); fd.set("machineId", String(c.machine.id)); a.run(clearMachineQueue, fd); }}>Empty</button>
        </div>
      )}
      {a.err && <div className="text-[11px] text-bad-fg">{a.err}</div>}
    </div>
  );
}

export function MachineBoard({ board, canEdit }: { board: MachineBoardData; canEdit: boolean }) {
  const [showAll, setShowAll] = useState(false);
  if (board.cards.length === 0 && board.machines.length === 0) return null;
  const tone = board.totalAvailableH === null || board.totalAvailableH === 0 ? null : loadTone(board.totalHours / board.totalAvailableH);
  const list = showAll ? board.unassigned : board.unassigned.slice(0, 6);
  return (
    <section className="mb-6">
      <h2>
        🏭 Machines — who is on what
        <span className={`pill ms-2 normal-case tabnum ${tone ? (tone === "ok" ? "pill-ok" : tone === "warn" ? "pill-warn" : "pill-bad") : "pill-muted"}`} title="Standard hours queued on the machines against the hours they have today">
          {board.totalHours} h queued{board.totalAvailableH !== null ? ` / ${board.totalAvailableH} h today` : ""}
        </span>
        {board.unassigned.length > 0 && (
          <span className="pill pill-warn ms-1 normal-case tabnum" title="Open lines not on any machine">{board.unassigned.length} line(s) not on a machine</span>
        )}
      </h2>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {board.cards.map((c) => <Card key={c.machine.id} c={c} dept={board.dept} canEdit={canEdit} />)}
      </div>
      {board.unassigned.length > 0 && (
        <div className="mt-3 bg-surface border rounded-xl px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-bold text-muted">Not on a machine yet — most urgent first:</span>
            {board.unassigned.length > 6 && (
              <button type="button" className="btn btn-sm btn-ghost ms-auto" onClick={() => setShowAll((v) => !v)}>{showAll ? "Show fewer" : `Show all ${board.unassigned.length}`}</button>
            )}
          </div>
          <ul className="mt-1 grid gap-x-4 gap-y-1 md:grid-cols-2 xl:grid-cols-3">
            {list.map((u) => (
              <li key={u.key} className="flex items-center gap-2 text-xs">
                <span className="font-bold">{u.bom}</span>
                <span className="font-semibold">{u.item}</span>
                <span className="tabnum font-bold">×{u.remaining}</span>
                {u.hours !== null && <span className="text-muted tabnum">{u.hours} h</span>}
                {u.deliveryISO ? <span className="text-muted tabnum">📅 {ddmm(u.deliveryISO)}</span> : <span className="text-muted">no date</span>}
                <span className="ms-auto">
                  <MachinePick dept={board.dept} bom={u.bom} mo={u.mo} item={u.item} machines={board.machines} current={undefined} canEdit={canEdit} compact />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[11px] text-muted mt-1">
        Hours are the standard times of what is left on each line. A machine&apos;s hours today are its hours a day less the downtime on the shift log. A line leaves the board by itself once nothing remains on it.
      </p>
    </section>
  );
}
