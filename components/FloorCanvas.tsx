"use client";

import { formatDateTime } from "@/lib/domain/format";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { deptLabel } from "@/lib/domain/constants";
import {
  FLOOR_COLORS, GRID, addNode, drawOrder, moveNode, placeMachine, removeNode, resizeNode, updateNode,
  type FloorColor, type FloorLayoutData, type FloorNode,
} from "@/lib/domain/floor";
import { clearWords, loadTone, type MachineCard } from "@/lib/domain/machineBoard";
import { CENTER_LABEL, SHIFT_DEPTS, machineWord, type ShiftDept } from "@/lib/domain/shifts";
import { mayScheduleLine, type BayAccess } from "@/lib/domain/permissions";
import type { MachineBoardData } from "@/lib/server/machineBoard";
import { assignLineMachine, moveLineRank, optimizeMachines, setLineQty, setLineRunning, unassignLineMachine } from "@/app/worklist/machineActions";
import { DoneBox, MachinePick } from "@/components/MachineBoard";
import { createPartition, saveFloorLayout } from "@/app/simulate/floorActions";

// 🗺 The Floor canvas — a department's bay as the planner draws it: the
// machines (or welding partitions) as blocks he drags into the places they
// stand, areas and labels around them. Every machine block is LIVE: what it
// is on now, how many wait, who the shift log put on it today, how loaded
// it is — the same board the worklist shows, seen from above. Click a
// block to work its queue. The drawing SAVES ITSELF a moment after every
// change, so it is there for everyone who opens the department's floor next
// (what runs where is saved the moment it is picked, like on the worklist).

type Tone = "ok" | "warn" | "bad";
const TONE_BORDER: Record<Tone, string> = { ok: "var(--ok-fg)", warn: "var(--warn-fg)", bad: "var(--bad-fg)" };
const TINT: Record<FloorColor, { bg: string; border: string }> = {
  slate: { bg: "color-mix(in srgb, var(--muted) 10%, transparent)", border: "var(--border-strong)" },
  green: { bg: "color-mix(in srgb, var(--viz-1) 12%, transparent)", border: "var(--viz-1)" },
  blue: { bg: "color-mix(in srgb, var(--viz-2) 12%, transparent)", border: "var(--viz-2)" },
  amber: { bg: "color-mix(in srgb, var(--viz-5) 14%, transparent)", border: "var(--viz-5)" },
  red: { bg: "color-mix(in srgb, var(--viz-7) 12%, transparent)", border: "var(--viz-7)" },
  violet: { bg: "color-mix(in srgb, var(--viz-4) 12%, transparent)", border: "var(--viz-4)" },
};
const ZOOMS = [0.5, 0.65, 0.8, 1, 1.25, 1.5];

function ddmm(iso: string) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

function useAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState("");
  const run = (fn: (fd: FormData) => Promise<{ ok: boolean; error?: string; id?: number }>, fd: FormData, after?: (id?: number) => void) => {
    setErr("");
    startTransition(async () => {
      const res = await fn(fd);
      if (res.ok) {
        after?.(res.id);
        router.refresh();
      } else setErr(res.error ?? "Failed");
    });
  };
  return { pending, err, setErr, run };
}

export function FloorDeptPicker({ dept }: { dept: ShiftDept }) {
  return (
    <nav className="seg" aria-label="Department">
      {SHIFT_DEPTS.map((d) => (
        <Link key={d} href={`/simulate?view=floor&dept=${d}`} className={d === dept ? "on" : ""}>{deptLabel(d)}</Link>
      ))}
    </nav>
  );
}

export function FloorCanvas({ dept, initial, board, canDraw, canAssign, updatedBy, updatedAtISO }: {
  dept: ShiftDept; initial: FloorLayoutData; board: MachineBoardData; canDraw: boolean;
  /** The lines this account schedules here — the machines are shared: a
   *  panel by its LV key, a transformer part by the bay's. */
  canAssign: BayAccess;
  updatedBy: string | null; updatedAtISO: string | null;
}) {
  const [layout, setLayout] = useState<FloorLayoutData>(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [savedAt, setSavedAt] = useState<FloorLayoutData>(initial);
  const dirty = useMemo(() => JSON.stringify(layout) !== JSON.stringify(savedAt), [layout, savedAt]);
  const [saving, startSaving] = useTransition();
  const [saveErr, setSaveErr] = useState("");
  const part = useAction();
  const [partName, setPartName] = useState("");
  const [showAllUndated, setShowAllUndated] = useState(false);
  // the floor is the point of this screen: the list of lines still to place
  // stays folded until the planner asks for it
  const [showQueue, setShowQueue] = useState(false);
  const router = useRouter();
  const [planning, startPlanning] = useTransition();
  const [planNote, setPlanNote] = useState("");
  // the block whose details are open — the floor itself keeps the whole width
  const [opened, setOpened] = useState<string | null>(null);

  const cardOf = useMemo(() => new Map(board.cards.map((c) => [c.machine.id, c])), [board.cards]);
  const allMachines = useMemo(() => {
    const m = new Map(board.machines.map((x) => [x.id, x]));
    for (const c of board.cards) if (!m.has(c.machine.id)) m.set(c.machine.id, { ...c.machine, dept, sortOrder: 0 });
    return m;
  }, [board, dept]);
  const placedIds = new Set(layout.nodes.filter((n) => n.kind === "machine").map((n) => n.machineId!));
  const unplaced = [...allMachines.values()].filter((m) => !placedIds.has(m.id) && m.active);
  const word = machineWord(dept);
  const assignsAny = canAssign.tr || canAssign.lv;
  // one line's keys only: ⚡ plans that line, around the other's work
  const onlyKind = canAssign.tr && canAssign.lv ? null : canAssign.lv ? "panel" : "transformer";

  // the drawing saves itself: a moment after the last change (a drag fires
  // dozens of changes — only the settled one is written), so switching tab
  // never loses it
  useEffect(() => {
    if (!canDraw || !dirty) return;
    const snapshot = layout;
    const t = setTimeout(() => {
      const fd = new FormData();
      fd.set("dept", dept);
      fd.set("layout", JSON.stringify(snapshot));
      startSaving(async () => {
        const res = await saveFloorLayout(fd);
        if (res.ok) { setSavedAt(snapshot); setSaveErr(""); }
        else setSaveErr(res.error ?? "Could not save the floor");
      });
    }, 700);
    return () => clearTimeout(t);
  }, [layout, dirty, canDraw, dept]);

  // Escape closes the open block
  useEffect(() => {
    if (!opened) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpened(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opened]);

  // the browser's own leave-page prompt while a save is still in flight
  useEffect(() => {
    if (!dirty && !saving) return;
    const onLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty, saving]);

  // ---- dragging, resizing and opening, straight from pointer events ----
  // A press that does not MOVE is a click: it opens the block's details. Only
  // once the pointer has travelled a few pixels does it become a drag, so the
  // floor can be worked and re-drawn with the same hand.
  const drag = useRef<{ id: string; mode: "move" | "resize"; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  function onDown(e: React.PointerEvent, n: FloorNode, mode: "move" | "resize") {
    if ((e.target as HTMLElement).closest("button, input, select, a")) return;
    setSelected(n.id);
    drag.current = { id: n.id, mode, sx: e.clientX, sy: e.clientY, ox: mode === "move" ? n.x : n.w, oy: mode === "move" ? n.y : n.h, moved: false };
    if (!canDraw) return; // read-only: the press can still open the details
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / zoom;
    const dy = (e.clientY - d.sy) / zoom;
    if (!d.moved && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 4) d.moved = true;
    if (!canDraw || !d.moved) return;
    setLayout((l) => (d.mode === "move" ? moveNode(l, d.id, d.ox + dx, d.oy + dy) : resizeNode(l, d.id, d.ox + dx, d.oy + dy)));
  }
  function onUp() {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved && d.mode === "move") setOpened(d.id);
  }

  const sel = layout.nodes.find((n) => n.id === selected) ?? null;
  const selCard = sel?.kind === "machine" ? cardOf.get(sel.machineId!) ?? null : null;
  const shown = layout.nodes.find((n) => n.id === opened) ?? null;
  const shownCard = shown?.kind === "machine" ? cardOf.get(shown.machineId!) ?? null : null;
  // the unassigned lines, the weekly plan's dated ones first — the ones that matter
  const dated = board.unassigned.filter((u) => u.deliveryISO);
  const undated = board.unassigned.filter((u) => !u.deliveryISO);

  return (
    <div className="space-y-3">
      {/* ---- toolbar ---- */}
      <div className="flex flex-wrap items-center gap-2 no-print">
        {canDraw && (
          <>
            <select
              className="border rounded-md px-2 py-1.5 bg-surface text-sm font-semibold"
              value=""
              aria-label={`Add a ${word}`}
              onChange={(e) => { const id = Number(e.target.value); if (id) setLayout((l) => placeMachine(l, id)); }}
            >
              <option value="">{unplaced.length ? `＋ Place a ${word}…` : `Every ${word} is on the floor`}</option>
              {unplaced.map((m) => <option key={m.id} value={m.id}>{m.code} · {m.name}</option>)}
            </select>
            {unplaced.length > 1 && (
              <button type="button" className="btn btn-sm" title={`Put every ${word} not on the floor yet onto it`} onClick={() => setLayout((l) => unplaced.reduce((acc, m) => placeMachine(acc, m.id), l))}>＋ Place all</button>
            )}
            <button type="button" className="btn btn-sm" onClick={() => setLayout((l) => addNode(l, "zone", "Area", "slate"))}>＋ Area</button>
            <button type="button" className="btn btn-sm" onClick={() => setLayout((l) => addNode(l, "label", "Label"))}>＋ Label</button>
            <form
              className="inline-flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData();
                fd.set("dept", dept);
                fd.set("name", partName);
                part.run(createPartition, fd, (id) => { if (id) setLayout((l) => placeMachine(l, id)); setPartName(""); });
              }}
            >
              <input value={partName} onChange={(e) => setPartName(e.target.value)} placeholder={dept === "Welding" ? "New partition name…" : `New ${word} name…`} className="border rounded-md px-2 py-1.5 bg-surface text-sm w-44" disabled={part.pending} />
              <button type="submit" className="btn btn-sm btn-secondary" disabled={part.pending || !partName.trim()} title={dept === "Welding" ? "A partition of the bay — a group of welders on the same orders; it joins the shift log and the worklist like a machine" : `Adds it to the ${dept} list in Tools → Machines as well`}>＋ New {word}</button>
            </form>
            {part.err && <span className="text-xs text-bad-fg">{part.err}</span>}
          </>
        )}
        {assignsAny && (
          <button
            type="button"
            className="btn btn-sm btn-primary ms-auto"
            disabled={planning}
            title={`Work out what every ${word} should run and in what order, from the weekly plan — earliest date first, each line on the ${word} that finishes it soonest. What is running now stays.`}
            onClick={() => {
              if (!confirm(onlyKind
                ? `Plan the ${onlyKind} lines on every ${word} from the weekly plan?\n\nThey are re-ordered. What is RUNNING now stays where it is, and so do the other lines — these queue behind them.`
                : `Plan every ${word} from the weekly plan?\n\nEvery waiting line is re-ordered. What is RUNNING now stays where it is.`)) return;
              setPlanNote("");
              startPlanning(async () => {
                const fd = new FormData();
                fd.set("dept", dept);
                const res = await optimizeMachines(fd);
                setPlanNote(res.ok ? [res.summary, res.lateNote].filter(Boolean).join(" ") : res.error ?? "Failed");
                if (res.ok) router.refresh();
              });
            }}
          >
            {planning ? "Planning…" : "⚡ Plan"}
          </button>
        )}
        {board.unassigned.length > 0 && (
          <button
            type="button"
            className={`btn btn-sm ${showQueue ? "btn-secondary" : "btn-ghost"} ${assignsAny ? "" : "ms-auto"}`}
            title={showQueue ? "Back to the floor alone" : `Open the ${board.unassigned.length} line(s) no ${word} has yet, to place them from here`}
            onClick={() => setShowQueue((v) => !v)}
          >
            {showQueue ? "▾" : "▸"} {board.unassigned.length} to place
          </button>
        )}
        <span className={`${board.unassigned.length > 0 || assignsAny ? "" : "ms-auto "}inline-flex items-center gap-1 text-xs text-muted`}>
          zoom
          <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="border rounded-md px-1.5 py-1 bg-surface text-xs font-semibold" aria-label="Zoom">
            {ZOOMS.map((z) => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
          </select>
        </span>
        {canDraw && (
          saveErr ? <span className="pill pill-bad" title={saveErr}>not saved — {saveErr}</span>
          : saving || dirty ? <span className="pill pill-warn">saving…</span>
          : <span className="pill pill-ok" title="The drawing is kept for everyone who opens this floor">saved</span>
        )}
        {!dirty && !saving && updatedAtISO && <span className="text-[11px] text-muted">drawn {formatDateTime(updatedAtISO)}{updatedBy ? ` by ${updatedBy}` : ""}</span>}
      </div>

      {/* ---- the floor: the whole width of the screen ---- */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs no-print">
        <span className="font-bold text-sm">{deptLabel(dept)} floor</span>
        <span className="text-muted tabnum">{board.cards.length} {machineWord(dept, true)} · {board.totalHours} h queued{board.totalAvailableH !== null ? ` / ${board.totalAvailableH} h today` : ""}</span>
        {board.unassigned.length > 0 && <span className="text-warn-fg font-semibold">{board.unassigned.length} line(s) not on a {word}</span>}
        {planNote && <span className="font-semibold">⚡ {planNote}</span>}
        <span className="text-muted">Click a block for its orders{canDraw ? "; drag it to move, pull the corner to resize" : ""}.</span>
      </div>
      <div
        className="overflow-auto border rounded-xl bg-surface"
        style={{ height: "calc(100vh - 210px)", minHeight: 420 }}
        onPointerDown={(e) => { if (e.target === e.currentTarget) setSelected(null); }}
      >
        <div style={{ width: layout.w * zoom, height: layout.h * zoom }}>
          <div
            className="relative select-none"
            style={{
              width: layout.w, height: layout.h, transform: `scale(${zoom})`, transformOrigin: "0 0",
              backgroundImage: "linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
              backgroundSize: `${GRID * 5}px ${GRID * 5}px`,
            }}
            onPointerDown={(e) => { if (e.target === e.currentTarget) setSelected(null); }}
          >
            {drawOrder(layout.nodes).map((n) => (
              <Node key={n.id} n={n} card={n.kind === "machine" ? cardOf.get(n.machineId!) ?? null : null} machineName={n.kind === "machine" ? allMachines.get(n.machineId!) : undefined}
                selected={selected === n.id} canDraw={canDraw} onDown={onDown} onMove={onMove} onUp={onUp} dept={dept} />
            ))}
            {layout.nodes.length === 0 && (
              <div className="absolute inset-0 grid place-items-center text-sm text-muted">
                {canDraw ? `Place the ${machineWord(dept, true)} from the toolbar, drag them where they stand, draw areas around them — it saves by itself.` : "The floor has not been drawn yet."}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ---- a block's details, over the floor: everything at full width ---- */}
      {shown && (
        <div className="fixed inset-0 z-50 flex items-start justify-center p-2 sm:p-6 no-print" role="dialog" aria-modal="true">
          <button type="button" aria-label="Close" className="absolute inset-0 cursor-default" style={{ background: "rgba(0,0,0,0.55)" }} onClick={() => setOpened(null)} />
          <div className="relative bg-surface border rounded-xl shadow-lg flex flex-col" style={{ width: "min(96vw, 1000px)", maxHeight: "88vh" }}>
            <div className="flex items-center gap-2 border-b px-4 py-2 shrink-0">
              <div className="min-w-0 truncate">
                {shown.kind === "machine" ? (
                  <>
                    <span className="font-extrabold ltr tabnum">{shownCard?.machine.code ?? allMachines.get(shown.machineId!)?.code ?? `#${shown.machineId}`}</span>
                    <span className="font-semibold text-sm"> · {shownCard?.machine.name ?? allMachines.get(shown.machineId!)?.name ?? ""}</span>
                  </>
                ) : (
                  <span className="font-bold">{shown.kind === "zone" ? "Area" : "Label"}</span>
                )}
              </div>
              <button type="button" className="btn btn-sm btn-secondary shrink-0" style={{ marginInlineStart: "auto" }} title="Close (Esc)" onClick={() => setOpened(null)}>✕ Close</button>
            </div>
            <div className="p-4" style={{ overflow: "auto" }}>
              {shown.kind === "machine" ? (
                <MachineInspector n={shown} card={shownCard} board={board} canAssign={canAssign} canDraw={canDraw} onRemove={() => { setLayout((l) => removeNode(l, shown.id)); setOpened(null); setSelected(null); }} />
              ) : (
                <div className="space-y-2">
                  <input value={shown.text ?? ""} disabled={!canDraw} onChange={(e) => setLayout((l) => updateNode(l, shown.id, { text: e.target.value }))} className="w-full border rounded-md px-2 py-1.5 bg-surface text-sm font-semibold" aria-label="Text" />
                  <div className="flex flex-wrap gap-1">
                    {FLOOR_COLORS.map((c) => (
                      <button key={c} type="button" disabled={!canDraw} title={c} onClick={() => setLayout((l) => updateNode(l, shown.id, { color: c }))}
                        className={`w-6 h-6 rounded-md border-2 ${shown.color === c || (!shown.color && c === "slate") ? "ring-2 ring-brand" : ""}`} style={{ background: TINT[c].bg, borderColor: TINT[c].border }} />
                    ))}
                  </div>
                  <div className="text-[11px] text-muted tabnum">{shown.w} × {shown.h} at {shown.x}, {shown.y}</div>
                  {canDraw && <button type="button" className="btn btn-sm btn-danger" onClick={() => { setLayout((l) => removeNode(l, shown.id)); setOpened(null); setSelected(null); }}>Delete from the floor</button>}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---- what is not on a machine yet: the weekly plan first, then the rest of the month ---- */}
      {showQueue && board.unassigned.length > 0 && (
        <section className="bg-surface border rounded-xl px-3 py-2 no-print">
          <div className="flex flex-wrap items-center gap-2 text-xs mb-1">
            <span className="font-bold">Not on a {word} yet</span>
            <span className="text-muted">— {dated.length} from the weekly plan, {undated.length} open with no date.</span>
            {assignsAny && selCard && <span className="pill pill-ok">click → to put a line on {selCard.machine.code}</span>}
            {assignsAny && !selCard && <span className="text-muted">Click a {word} block first to send lines to it in one click, or pick the {word} on each line.</span>}
          </div>
          {dated.length > 0 && (
            <>
              <div className="text-[11px] font-bold uppercase tracking-wide text-brand mt-1">📅 Weekly plan — dated, earliest first</div>
              <UnassignedList lines={dated} board={board} canAssign={canAssign} target={selCard?.machine ?? null} />
            </>
          )}
          {undated.length > 0 && (
            <>
              <div className="flex items-center gap-2 mt-2">
                <span className="text-[11px] font-bold uppercase tracking-wide text-muted">Open orders — no date yet (the month)</span>
                {undated.length > 8 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowAllUndated((v) => !v)}>{showAllUndated ? "Show fewer" : `Show all ${undated.length}`}</button>}
              </div>
              <UnassignedList lines={showAllUndated ? undated : undated.slice(0, 8)} board={board} canAssign={canAssign} target={selCard?.machine ?? null} />
            </>
          )}
        </section>
      )}
    </div>
  );
}

/** The lines on no machine, each with a one-click send to the selected
 *  block and a picker for any other. */
/** Fabrication runs several work centres, so a line shows once per centre it
 *  still owes work at; everywhere else there is only one. */
const multiCentre = (board: MachineBoardData) => new Set(board.machines.map((m) => m.center)).size > 1;
/** The machines that can take this step — its own centre, or all of them when
 *  the centre has none. */
const machinesAt = (board: MachineBoardData, center: string) => {
  const at = board.machines.filter((m) => m.center === center);
  return at.length > 0 ? at : board.machines;
};

function UnassignedList({ lines, board, canAssign, target }: { lines: MachineBoardData["unassigned"]; board: MachineBoardData; canAssign: BayAccess; target: { id: number; code: string; center: string } | null }) {
  const a = useAction();
  return (
    <ul className="grid grid-cols-1 gap-x-4 gap-y-1 md:grid-cols-2 xl:grid-cols-3">
      {lines.map((u) => (
        <li key={`${u.key}#${u.center}`} className="flex items-center gap-2 text-xs min-w-0">
          <span className="font-bold truncate">{u.bom}</span>
          <span className="font-semibold shrink-0">{u.item}</span>
          <span className="tabnum font-bold shrink-0">×{u.remaining}</span>
          {multiCentre(board) && <span className="pill pill-muted shrink-0" title={`${CENTER_LABEL[u.center] ?? u.center} — step ${u.stepNo} of ${u.stepCount} on this line's route`}>{u.center}</span>}
          {u.partial && <span className="text-[10px] text-muted tabnum shrink-0" title="The rest of a split line — the other pieces are on a machine already">✂ rest of {u.lineRemaining}</span>}
          {u.hours !== null && <span className="text-muted tabnum shrink-0">{u.hours} h</span>}
          {u.deliveryISO && <span className="text-muted tabnum shrink-0">📅 {ddmm(u.deliveryISO)}</span>}
          {mayScheduleLine(canAssign, u.item) && (
            <span className="ms-auto inline-flex items-center gap-1 shrink-0">
              {target && target.center === u.center && (
                <button
                  type="button" className="btn btn-sm btn-primary px-2" disabled={a.pending} title={`Put it on ${target.code}, at the back of its queue`}
                  onClick={() => { const fd = new FormData(); fd.set("dept", board.dept); fd.set("bom", u.bom); fd.set("mo", u.mo); fd.set("item", u.item); fd.set("sheet", u.sheet ?? ""); fd.set("machineId", String(target.id)); a.run(assignLineMachine, fd); }}
                >
                  → {target.code}
                </button>
              )}
              <MachinePick dept={board.dept} bom={u.bom} mo={u.mo} item={u.item} sheet={u.sheet} machines={machinesAt(board, u.center)} current={undefined} canEdit compact />
            </span>
          )}
        </li>
      ))}
      {a.err && <li className="text-[11px] text-bad-fg">{a.err}</li>}
    </ul>
  );
}

function Node({ n, card, machineName, selected, canDraw, onDown, onMove, onUp, dept }: {
  n: FloorNode; card: MachineCard | null; machineName?: { code: string; name: string } | undefined; selected: boolean; canDraw: boolean; dept: string;
  onDown: (e: React.PointerEvent, n: FloorNode, mode: "move" | "resize") => void; onMove: (e: React.PointerEvent) => void; onUp: () => void;
}) {
  const tone = card ? loadTone(card.load) : null;
  const tint = TINT[(n.color ?? "slate") as FloorColor] ?? TINT.slate;
  const base: React.CSSProperties = { position: "absolute", left: n.x, top: n.y, width: n.w, height: n.h, cursor: canDraw ? "grab" : "pointer", touchAction: "none" };
  const ring = selected ? "0 0 0 3px var(--brand)" : undefined;
  const handle = canDraw && (
    <span
      onPointerDown={(e) => { e.stopPropagation(); onDown(e, n, "resize"); }} onPointerMove={onMove} onPointerUp={onUp}
      className="absolute right-0 bottom-0 w-3.5 h-3.5 rounded-tl-md bg-brand/70 cursor-nwse-resize" title="Resize" style={{ touchAction: "none" }}
    />
  );
  if (n.kind === "label") {
    return (
      <div style={{ ...base, boxShadow: ring }} className="rounded-md px-2 flex items-center text-sm font-extrabold whitespace-nowrap overflow-hidden" onPointerDown={(e) => onDown(e, n, "move")} onPointerMove={onMove} onPointerUp={onUp}>
        <span style={{ color: tint.border === "var(--border-strong)" ? "var(--foreground)" : tint.border }}>{n.text || "Label"}</span>
        {handle}
      </div>
    );
  }
  if (n.kind === "zone") {
    return (
      <div style={{ ...base, background: tint.bg, border: `2px dashed ${tint.border}`, boxShadow: ring }} className="rounded-xl p-2" onPointerDown={(e) => onDown(e, n, "move")} onPointerMove={onMove} onPointerUp={onUp}>
        <div className="text-xs font-extrabold uppercase tracking-wide truncate" style={{ color: tint.border === "var(--border-strong)" ? "var(--muted)" : tint.border }}>{n.text || "Area"}</div>
        {handle}
      </div>
    );
  }
  const m = card?.machine ?? machineName;
  const compact = n.h < 100;
  return (
    <div
      data-node={m?.code ?? n.id}
      style={{ ...base, borderColor: tone ? TONE_BORDER[tone] : "var(--border-strong)", boxShadow: ring ?? "var(--shadow-sm)" }}
      className={`rounded-xl border-2 bg-surface p-2 overflow-hidden flex flex-col ${card && !card.machine.active ? "opacity-60" : ""}`}
      onPointerDown={(e) => onDown(e, n, "move")} onPointerMove={onMove} onPointerUp={onUp}
      title={m ? `${m.code} · ${m.name} — click for its orders` : "Unknown machine"}
    >
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="font-extrabold text-xs ltr tabnum shrink-0">{m?.code ?? "?"}</span>
        <span className="text-xs font-semibold truncate">{m?.name ?? "not on the list"}</span>
        {card && card.queue.length > 0 && (
          <span className={`ms-auto text-[10px] font-extrabold tabnum shrink-0 ${tone === "ok" ? "text-ok-fg" : tone === "warn" ? "text-warn-fg" : tone === "bad" ? "text-bad-fg" : "text-muted"}`} title={card.clearsISO ? `Its queue is finished on ${card.clearsISO}` : "How long the work on it takes"}>
            {clearWords(card.hours, card.availableH)}
          </span>
        )}
      </div>
      {card && card.running.length > 0 ? (
        <div className="mt-1 rounded-md bg-brand-light/40 border border-brand/30 px-1.5 py-1 min-w-0 space-y-0.5">
          {card.running.slice(0, compact ? 1 : 2).map((q) => (
            <div key={`${q.key}#${q.sheet}`} className="flex items-baseline gap-1 text-[11px] leading-tight min-w-0">
              <span className="text-brand font-extrabold shrink-0">▶</span>
              <span className="font-extrabold truncate">{q.bom}</span>
              <span className="font-bold shrink-0">{q.item}</span>
              <span className="font-extrabold tabnum text-brand shrink-0">×{q.remaining}</span>
              {!compact && q.deliveryISO && <span className="text-[10px] text-muted shrink-0">📅 {ddmm(q.deliveryISO)}</span>}
            </div>
          ))}
          {card.running.length > (compact ? 1 : 2) && <div className="text-[10px] text-brand font-bold">+{card.running.length - (compact ? 1 : 2)} more running</div>}
        </div>
      ) : (
        <div className="mt-1 text-[11px] text-muted">{card && card.waiting.length > 0 ? "nothing running yet" : "idle — nothing on it"}</div>
      )}
      <div className="mt-auto flex items-center gap-2 text-[10px] text-muted tabnum pt-1 whitespace-nowrap">
        {card && card.waiting.length > 0 && <span title="Waiting behind what runs">+{card.waiting.length} waiting</span>}
        {card && <span title="Standard hours queued">{card.hours} h</span>}
        {card?.clearsISO && !compact && <span title="The working day this queue is finished">→ {ddmm(card.clearsISO)}</span>}
        {card && card.crew.length > 0 && <span className="ms-auto font-bold text-foreground" title={`${dept === "Welding" ? "Welders" : "Crew"} today: ${card.crew.join(", ")}`}>👷 {card.crew.length}</span>}
      </div>
      {handle}
    </div>
  );
}

function MachineInspector({ n, card, board, canAssign, canDraw, onRemove }: {
  n: FloorNode; card: MachineCard | null; board: MachineBoardData; canAssign: BayAccess; canDraw: boolean; onRemove: () => void;
}) {
  const a = useAction();
  const [showAll, setShowAll] = useState(false);
  const m = card?.machine;
  const line = (bom: string, mo: string, item: string, sheet = "") => {
    const fd = new FormData();
    fd.set("dept", board.dept); fd.set("bom", bom); fd.set("mo", mo); fd.set("item", item); fd.set("sheet", sheet);
    fd.set("machineId", String(n.machineId ?? ""));
    return fd;
  };
  // ✂ — how many pieces of the line stay on this machine; the rest waits
  // for another machine (or comes back whole with a blank)
  const resize = (q: { bom: string; mo: string; item: string; sheet: string; remaining: number; lineRemaining: number }) => {
    const v = prompt(`Pieces of ${q.bom} ${q.item} on ${m?.code ?? "this machine"} — of ${q.lineRemaining} (blank = the rest of the line):`, String(q.remaining));
    if (v === null) return;
    const fd = line(q.bom, q.mo, q.item, q.sheet);
    fd.set("qty", v.trim());
    a.run(setLineQty, fd);
  };
  if (!card || !m) {
    return (
      <div className="space-y-2 text-xs text-muted">
        <div className="text-sm font-bold text-foreground">Machine #{n.machineId}</div>
        <div>Not on this department&apos;s list any more (retired, or being added — refresh).</div>
        {canDraw && <button type="button" className="btn btn-sm btn-danger" onClick={onRemove}>Remove from floor</button>}
      </div>
    );
  }
  const tone = loadTone(card.load);
  // the lines this machine's own work centre still owes — a bender is never
  // offered a job that wants a laser — of the ones this account schedules
  const mine = board.unassigned.filter((u) => (u.center === m.center || board.machines.every((x) => x.center !== u.center)) && mayScheduleLine(canAssign, u.item));
  const assignsAny = canAssign.tr || canAssign.lv;
  // ⏫ passes this account's own lines only — on a shared machine the other
  // line's keep their places
  const waiting = card.waiting;
  const canGoNext = (q: (typeof waiting)[number]) => waiting.slice(0, waiting.indexOf(q)).some((x) => mayScheduleLine(canAssign, x.item));
  const today = new Date().toISOString().slice(0, 10);
  const rows = showAll ? card.queue : card.queue.slice(0, 30);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <div className="text-xs text-muted">
          {m.center ? `${CENTER_LABEL[m.center] ?? m.center} · ` : ""}
          {card.availableH !== null ? `${card.availableH} h today${card.downtimeH ? ` (${card.downtimeH} h down)` : ""}` : "hours a day not set"}
        </div>
        <div className={`ms-auto text-sm font-extrabold tabnum ${tone === "ok" ? "text-ok-fg" : tone === "warn" ? "text-warn-fg" : tone === "bad" ? "text-bad-fg" : ""}`}>
          {clearWords(card.hours, card.availableH)} of work · {card.hours} h · {card.pcs} pcs
          {card.clearsISO ? <span className="text-muted font-semibold"> · clears {ddmm(card.clearsISO)}</span> : null}
        </div>
      </div>

      <div className="text-xs flex flex-wrap items-center gap-1">
        <span className="font-bold text-muted">Today&apos;s crew{card.crewH ? ` · ${card.crewH} mh` : ""}:</span>
        {card.crew.length === 0 ? <span className="text-muted">nobody on the shift log yet</span> : card.crew.map((w) => <span key={w} className="pill pill-muted">{w}</span>)}
      </div>

      <div>
        <div className="text-xs font-bold text-muted mb-1">
          Queue — {card.running.length} running, {card.waiting.length} waiting
        </div>
        {card.queue.length === 0 ? (
          <div className="text-xs text-muted">nothing on it</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-start text-[10px] uppercase tracking-wide text-muted">
                  <th className="p-1 w-8 text-center">#</th>
                  <th className="p-1 text-start">BOM</th>
                  <th className="p-1 text-center">Item</th>
                  <th className="p-1 text-center">Pcs</th>
                  <th className="p-1 text-center">Hours</th>
                  <th className="p-1 text-center">Deliver</th>
                  <th className="p-1 text-start">MO · description</th>
                  {assignsAny && <th className="p-1 text-end">Do</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((q) => (
                  <tr key={`${q.key}#${q.sheet}`} className={`border-t ${q.running ? "bg-brand-light/40" : ""}`}>
                    <td className="p-1 text-center font-extrabold tabnum text-muted">{q.running ? "▶" : card.waiting.indexOf(q) + 1}</td>
                    <td className="p-1 font-extrabold ltr whitespace-nowrap">{q.bom}</td>
                    <td className="p-1 text-center font-bold">{q.item}</td>
                    <td className="p-1 text-center tabnum font-extrabold whitespace-nowrap">
                      {q.remaining}
                      {q.split && <span className="block text-[10px] font-semibold text-muted" title="Part of the line — the rest is on another machine or waits">of {q.lineRemaining}</span>}
                    </td>
                    <td className="p-1 text-center tabnum">{q.hours !== null ? q.hours : "—"}</td>
                    <td className={`p-1 text-center tabnum whitespace-nowrap ${q.deliveryISO && q.deliveryISO < today ? "text-bad-fg font-bold" : ""}`}>{q.deliveryISO ? ddmm(q.deliveryISO) : "—"}</td>
                    <td className="p-1 text-muted truncate max-w-[18rem]" title={`${q.mo}${q.description ? ` · ${q.description}` : ""}`}>{q.mo || "—"}{q.description ? ` · ${q.description}` : ""}</td>
                    {assignsAny && (
                      <td className="p-1">
                        {mayScheduleLine(canAssign, q.item) && <span className="flex items-center justify-end gap-0.5">
                          <DoneBox board={board} q={q} machineId={m.id} onErr={a.setErr} />
                          {q.running
                            ? <button type="button" className="btn btn-sm btn-ghost px-1" title="Put it back to waiting" disabled={a.pending} onClick={() => { const fd = line(q.bom, q.mo, q.item, q.sheet); fd.set("running", "false"); a.run(setLineRunning, fd); }}>⏸</button>
                            : <button type="button" className="btn btn-sm btn-ghost px-1 text-ok-fg" title="Start it now, alongside what runs" disabled={a.pending} onClick={() => { const fd = line(q.bom, q.mo, q.item, q.sheet); fd.set("running", "true"); a.run(setLineRunning, fd); }}>▶</button>}
                          {!q.running && canGoNext(q) && <button type="button" className="btn btn-sm btn-ghost px-1" title="Next in line" disabled={a.pending} onClick={() => { const fd = line(q.bom, q.mo, q.item, q.sheet); fd.set("dir", "top"); a.run(moveLineRank, fd); }}>⏫</button>}
                          <button type="button" className="btn btn-sm btn-ghost px-1" title="Split — keep only some pieces here" disabled={a.pending} onClick={() => resize(q)}>✂</button>
                          <button type="button" className="btn btn-sm btn-ghost px-1 text-bad-fg" title="Take off this machine" disabled={a.pending} onClick={() => a.run(unassignLineMachine, line(q.bom, q.mo, q.item, q.sheet))}>✕</button>
                        </span>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {card.queue.length > rows.length && (
              <button type="button" className="btn btn-sm btn-ghost mt-1" onClick={() => setShowAll(true)}>Show all {card.queue.length} lines</button>
            )}
          </div>
        )}
      </div>

      {mine.length > 0 && (
        <select
          className="w-full border rounded-md px-2 py-1.5 bg-surface text-sm font-semibold" value="" disabled={a.pending} aria-label="Put a line on it"
          onChange={(e) => { const u = mine[Number(e.target.value)]; if (!u) return; const fd = line(u.bom, u.mo, u.item); fd.set("machineId", String(m.id)); a.run(assignLineMachine, fd); }}
        >
          <option value="">＋ Put a line on it… ({mine.length} waiting{multiCentre(board) ? ` for ${CENTER_LABEL[m.center] ?? m.center}` : ""})</option>
          {mine.map((u, i) => <option key={`${u.key}#${u.center}`} value={i}>{u.bom} {u.item} ×{u.remaining}{u.partial ? ` (rest of ${u.lineRemaining})` : ""}{u.deliveryISO ? ` · ${ddmm(u.deliveryISO)}` : ""}</option>)}
        </select>
      )}
      {a.err && <div className="text-[11px] text-bad-fg">{a.err}</div>}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Link href={`/worklist/machines?dept=${board.dept}&machine=${m.id}`} className="btn btn-sm btn-secondary" title="A sheet for the technician: what runs now, then what is next">🖨 Print sheet</Link>
        <Link href={board.dept === "ShotBlast" ? "/shifts?dept=ShotBlast" : `/worklist/${board.dept === "Cut" ? "cut" : board.dept.toLowerCase()}`} className="text-xs text-accent font-semibold hover:underline">Open the worklist →</Link>
        {canDraw && <button type="button" className="btn btn-sm btn-ghost text-bad-fg ms-auto" onClick={onRemove} title="Off the drawing only — the machine stays on the list">Remove from floor</button>}
      </div>
    </div>
  );
}
