"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { deptLabel } from "@/lib/domain/constants";
import {
  FLOOR_COLORS, GRID, addNode, drawOrder, moveNode, placeMachine, removeNode, resizeNode, updateNode,
  type FloorColor, type FloorLayoutData, type FloorNode,
} from "@/lib/domain/floor";
import { loadTone, type MachineCard } from "@/lib/domain/machineBoard";
import { CENTER_LABEL, SHIFT_DEPTS, machineWord, type ShiftDept } from "@/lib/domain/shifts";
import type { MachineBoardData } from "@/lib/server/machineBoard";
import { assignLineMachine, moveLineRank } from "@/app/worklist/machineActions";
import { createPartition, saveFloorLayout } from "@/app/simulate/floorActions";

// 🗺 The Floor canvas — a department's bay as the planner draws it: the
// machines (or welding partitions) as blocks he drags into the places they
// stand, areas and labels around them. Every machine block is LIVE: what it
// is on now, how many wait, who the shift log put on it today, how loaded
// it is — the same board the worklist shows, seen from above. Click a
// block to work its queue; Save keeps the drawing (the drawing only — what
// runs where is saved the moment it is picked, like on the worklist).

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
  return { pending, err, run };
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
  dept: ShiftDept; initial: FloorLayoutData; board: MachineBoardData; canDraw: boolean; canAssign: boolean;
  updatedBy: string | null; updatedAtISO: string | null;
}) {
  const [layout, setLayout] = useState<FloorLayoutData>(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [savedAt, setSavedAt] = useState<FloorLayoutData>(initial);
  const dirty = useMemo(() => JSON.stringify(layout) !== JSON.stringify(savedAt), [layout, savedAt]);
  const save = useAction();
  const part = useAction();
  const [partName, setPartName] = useState("");

  const cardOf = useMemo(() => new Map(board.cards.map((c) => [c.machine.id, c])), [board.cards]);
  const allMachines = useMemo(() => {
    const m = new Map(board.machines.map((x) => [x.id, x]));
    for (const c of board.cards) if (!m.has(c.machine.id)) m.set(c.machine.id, { ...c.machine, dept, sortOrder: 0 });
    return m;
  }, [board, dept]);
  const placedIds = new Set(layout.nodes.filter((n) => n.kind === "machine").map((n) => n.machineId!));
  const unplaced = [...allMachines.values()].filter((m) => !placedIds.has(m.id) && m.active);
  const word = machineWord(dept);

  // leaving with an unsaved drawing is a real loss — ask
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

  // ---- dragging and resizing, straight from pointer events ----
  const drag = useRef<{ id: string; mode: "move" | "resize"; sx: number; sy: number; ox: number; oy: number } | null>(null);
  function onDown(e: React.PointerEvent, n: FloorNode, mode: "move" | "resize") {
    if (!canDraw) { setSelected(n.id); return; }
    if ((e.target as HTMLElement).closest("button, input, select, a")) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: n.id, mode, sx: e.clientX, sy: e.clientY, ox: mode === "move" ? n.x : n.w, oy: mode === "move" ? n.y : n.h };
    setSelected(n.id);
  }
  function onMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / zoom;
    const dy = (e.clientY - d.sy) / zoom;
    setLayout((l) => (d.mode === "move" ? moveNode(l, d.id, d.ox + dx, d.oy + dy) : resizeNode(l, d.id, d.ox + dx, d.oy + dy)));
  }
  function onUp() {
    drag.current = null;
  }

  function submitSave() {
    const fd = new FormData();
    fd.set("dept", dept);
    fd.set("layout", JSON.stringify(layout));
    save.run(saveFloorLayout, fd, () => setSavedAt(layout));
  }

  const sel = layout.nodes.find((n) => n.id === selected) ?? null;
  const selCard = sel?.kind === "machine" ? cardOf.get(sel.machineId!) ?? null : null;

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
        <span className="ms-auto inline-flex items-center gap-1 text-xs text-muted">
          zoom
          <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="border rounded-md px-1.5 py-1 bg-surface text-xs font-semibold" aria-label="Zoom">
            {ZOOMS.map((z) => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
          </select>
        </span>
        {canDraw && (
          <>
            {dirty && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setLayout(savedAt); setSelected(null); }}>Undo changes</button>}
            <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || save.pending} onClick={submitSave}>{dirty ? "Save floor" : "Saved"}</button>
          </>
        )}
        {save.err && <span className="text-xs text-bad-fg">{save.err}</span>}
        {!dirty && updatedAtISO && <span className="text-[11px] text-muted">drawn {updatedAtISO.slice(0, 10)}{updatedBy ? ` by ${updatedBy}` : ""}</span>}
      </div>

      <div className="flex gap-3 items-start">
        {/* ---- the floor ---- */}
        <div className="flex-1 min-w-0 overflow-auto border rounded-xl bg-surface" style={{ maxHeight: "72vh" }} onPointerDown={(e) => { if (e.target === e.currentTarget) setSelected(null); }}>
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
                  {canDraw ? `Place the ${machineWord(dept, true)} from the toolbar, drag them where they stand, draw areas around them, then Save.` : "The floor has not been drawn yet."}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ---- inspector ---- */}
        <aside className="w-72 shrink-0 bg-surface border rounded-xl p-3 space-y-2 no-print hidden md:block">
          {!sel ? (
            <div className="text-xs text-muted space-y-1">
              <div className="font-bold text-foreground text-sm">{deptLabel(dept)} floor</div>
              <div>{board.cards.length} {machineWord(dept, true)} · {board.totalHours} h queued{board.totalAvailableH !== null ? ` / ${board.totalAvailableH} h today` : ""}</div>
              {board.unassigned.length > 0 && <div className="text-warn-fg font-semibold">{board.unassigned.length} line(s) not on a {word}</div>}
              <div className="pt-1">Click a block to see and work its queue{canDraw ? "; drag to move, pull the corner to resize" : ""}.</div>
            </div>
          ) : sel.kind === "machine" ? (
            <MachineInspector n={sel} card={selCard} board={board} canAssign={canAssign} canDraw={canDraw} onRemove={() => { setLayout((l) => removeNode(l, sel.id)); setSelected(null); }} />
          ) : (
            <div className="space-y-2">
              <div className="text-sm font-bold">{sel.kind === "zone" ? "Area" : "Label"}</div>
              <input value={sel.text ?? ""} disabled={!canDraw} onChange={(e) => setLayout((l) => updateNode(l, sel.id, { text: e.target.value }))} className="w-full border rounded-md px-2 py-1.5 bg-surface text-sm font-semibold" aria-label="Text" />
              <div className="flex flex-wrap gap-1">
                {FLOOR_COLORS.map((c) => (
                  <button key={c} type="button" disabled={!canDraw} title={c} onClick={() => setLayout((l) => updateNode(l, sel.id, { color: c }))}
                    className={`w-6 h-6 rounded-md border-2 ${sel.color === c || (!sel.color && c === "slate") ? "ring-2 ring-brand" : ""}`} style={{ background: TINT[c].bg, borderColor: TINT[c].border }} />
                ))}
              </div>
              <div className="text-[11px] text-muted tabnum">{sel.w} × {sel.h} at {sel.x}, {sel.y}</div>
              {canDraw && <button type="button" className="btn btn-sm btn-danger" onClick={() => { setLayout((l) => removeNode(l, sel.id)); setSelected(null); }}>Delete</button>}
            </div>
          )}
        </aside>
      </div>
    </div>
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
      style={{ ...base, borderColor: tone ? TONE_BORDER[tone] : "var(--border-strong)", boxShadow: ring ?? "var(--shadow-sm)" }}
      className={`rounded-xl border-2 bg-surface p-2 overflow-hidden flex flex-col ${card && !card.machine.active ? "opacity-60" : ""}`}
      onPointerDown={(e) => onDown(e, n, "move")} onPointerMove={onMove} onPointerUp={onUp}
      title={m ? `${m.code} · ${m.name}` : "Unknown machine"}
    >
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="font-extrabold text-xs ltr tabnum shrink-0">{m?.code ?? "?"}</span>
        <span className="text-xs font-semibold truncate">{m?.name ?? "not on the list"}</span>
        {card && card.load !== null && <span className={`ms-auto text-[10px] font-extrabold tabnum shrink-0 ${tone === "ok" ? "text-ok-fg" : tone === "warn" ? "text-warn-fg" : "text-bad-fg"}`}>{card.load === Infinity ? "∞" : `${Math.round(card.load * 100)}%`}</span>}
      </div>
      {card?.now ? (
        <div className="mt-1 rounded-md bg-brand-light/40 border border-brand/30 px-1.5 py-1 min-w-0">
          <div className="flex items-baseline gap-1 text-[11px] leading-tight min-w-0">
            <span className="text-brand font-extrabold shrink-0">▶</span>
            <span className="font-extrabold truncate">{card.now.bom}</span>
            <span className="font-bold shrink-0">{card.now.item}</span>
            <span className="font-extrabold tabnum text-brand shrink-0">×{card.now.remaining}</span>
          </div>
          {!compact && <div className="text-[10px] text-muted truncate">{card.now.mo}{card.now.deliveryISO ? ` · 📅 ${ddmm(card.now.deliveryISO)}` : ""}</div>}
        </div>
      ) : (
        <div className="mt-1 text-[11px] text-muted">idle — nothing on it</div>
      )}
      <div className="mt-auto flex items-center gap-2 text-[10px] text-muted tabnum pt-1 whitespace-nowrap">
        {card && card.queue.length > 1 && <span title="Waiting behind the running line">+{card.queue.length - 1} waiting</span>}
        {card && <span title="Standard hours queued">{card.hours} h</span>}
        {card && card.crew.length > 0 && <span className="ms-auto font-bold text-foreground" title={`${dept === "Welding" ? "Welders" : "Crew"} today: ${card.crew.join(", ")}`}>👷 {card.crew.length}</span>}
      </div>
      {handle}
    </div>
  );
}

function MachineInspector({ n, card, board, canAssign, canDraw, onRemove }: {
  n: FloorNode; card: MachineCard | null; board: MachineBoardData; canAssign: boolean; canDraw: boolean; onRemove: () => void;
}) {
  const a = useAction();
  const m = card?.machine;
  const line = (bom: string, mo: string, item: string) => {
    const fd = new FormData();
    fd.set("dept", board.dept); fd.set("bom", bom); fd.set("mo", mo); fd.set("item", item);
    return fd;
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
  return (
    <div className="space-y-2">
      <div>
        <div className="font-extrabold ltr tabnum">{m.code} <span className="font-semibold text-sm">· {m.name}</span></div>
        <div className="text-[11px] text-muted">
          {m.center ? `${CENTER_LABEL[m.center] ?? m.center} · ` : ""}
          {card.availableH !== null ? `${card.availableH} h today${card.downtimeH ? ` (${card.downtimeH} h down)` : ""}` : "hours/day not set"}
        </div>
      </div>
      <div className={`text-sm font-extrabold tabnum ${tone === "ok" ? "text-ok-fg" : tone === "warn" ? "text-warn-fg" : tone === "bad" ? "text-bad-fg" : ""}`}>
        {card.hours} h queued · {card.pcs} pcs{card.days !== null ? ` · ${card.days} day(s)` : ""}
      </div>
      <div className="text-xs">
        <div className="font-bold text-muted mb-0.5">Today&apos;s crew{card.crewH ? ` · ${card.crewH} mh` : ""}</div>
        {card.crew.length === 0 ? <div className="text-muted">nobody on the shift log yet</div> : <div className="flex flex-wrap gap-1">{card.crew.map((w) => <span key={w} className="pill pill-muted">{w}</span>)}</div>}
      </div>
      <div className="text-xs">
        <div className="font-bold text-muted mb-0.5">Queue</div>
        {card.queue.length === 0 ? <div className="text-muted">nothing on it</div> : (
          <ol className="space-y-1">
            {card.queue.map((q, i) => (
              <li key={q.key} className={`flex items-center gap-1 rounded-md px-1.5 py-1 ${i === 0 ? "bg-brand-light/40 border border-brand/30" : "border"}`}>
                <span className="w-4 text-center font-extrabold tabnum text-muted">{i === 0 ? "▶" : q.rank}</span>
                <span className="min-w-0 flex-1 truncate"><b>{q.bom}</b> {q.item} <b className="tabnum">×{q.remaining}</b>{q.hours !== null ? <span className="text-muted"> {q.hours} h</span> : null}{q.deliveryISO ? <span className="text-muted"> 📅 {ddmm(q.deliveryISO)}</span> : null}</span>
                {canAssign && (
                  <span className="inline-flex shrink-0">
                    {i > 0 && <button type="button" className="btn btn-sm btn-ghost px-1" title="Run this next" disabled={a.pending} onClick={() => { const fd = line(q.bom, q.mo, q.item); fd.set("dir", "top"); a.run(moveLineRank, fd); }}>⏫</button>}
                    <button type="button" className="btn btn-sm btn-ghost px-1 text-bad-fg" title="Take off" disabled={a.pending} onClick={() => { const fd = line(q.bom, q.mo, q.item); fd.set("machineId", ""); a.run(assignLineMachine, fd); }}>✕</button>
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
      {canAssign && board.unassigned.length > 0 && (
        <select
          className="w-full border rounded-md px-2 py-1.5 bg-surface text-xs font-semibold" value="" disabled={a.pending} aria-label="Put a line on it"
          onChange={(e) => { const u = board.unassigned[Number(e.target.value)]; if (!u) return; const fd = line(u.bom, u.mo, u.item); fd.set("machineId", String(m.id)); a.run(assignLineMachine, fd); }}
        >
          <option value="">＋ Put a line on it… ({board.unassigned.length} waiting)</option>
          {board.unassigned.map((u, i) => <option key={u.key} value={i}>{u.bom} {u.item} ×{u.remaining}{u.deliveryISO ? ` · ${ddmm(u.deliveryISO)}` : ""}</option>)}
        </select>
      )}
      {a.err && <div className="text-[11px] text-bad-fg">{a.err}</div>}
      <div className="flex items-center gap-2 pt-1">
        <Link href={board.dept === "ShotBlast" ? "/shifts?dept=ShotBlast" : `/worklist/${board.dept === "Cut" ? "cut" : board.dept.toLowerCase()}`} className="text-xs text-accent font-semibold hover:underline">Open the worklist →</Link>
        {canDraw && <button type="button" className="btn btn-sm btn-ghost text-bad-fg ms-auto" onClick={onRemove} title="Off the drawing only — the machine stays on the list">Remove from floor</button>}
      </div>
    </div>
  );
}
