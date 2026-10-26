"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { WeldQueueRow } from "@/lib/domain/execution";
import type { QueueNoteDTO } from "@/lib/server/queueNotes";
import type { SoiLookup } from "@/lib/server/soi";
import { Soi, soiOf } from "@/components/ui";
import { recordOutput, recordGroupOutput, addQueueNote, setQueueNoteStatus, updateQueueNote, deleteQueueNote, returnToUpstream, hideWorklistLine } from "@/app/worklist/actions";
import { SearchBox, FilterBar, useSavedFilter } from "@/components/FilterControls";
import { Frac } from "@/components/Frac";
import { PrintButton } from "@/components/PrintButton";
import { ReturnsTable } from "@/components/ReturnsTable";
import type { ReturnRowDTO } from "@/lib/server/returns";
import { ITEMS, DEFAULTS, deptLabel } from "@/lib/domain/constants";
import { assessDeliveryRisk } from "@/lib/domain/insights";
import { TANK_ITEM } from "@/lib/domain/tanks";
import type { TankDTO } from "@/lib/server/tanks";
import type { WorkerDTO } from "@/lib/server/workers";
import { TankWorkerPicker, NO_WORKER, type WorkerPick } from "@/components/TankWorkerPicker";
import { TankSerialsPanel } from "@/components/TankSerialsPanel";
import { TankPaintPicker } from "@/components/TankPaintPicker";
import { Modal } from "@/components/Modal";
import { MachinePick, PlacementChips, placementPass, type PlacementMode } from "@/components/MachineBoard";
import type { MachineDTO } from "@/lib/server/machines";
import { machineWord } from "@/lib/domain/shifts";
import type { LinePlacement } from "@/lib/domain/machineBoard";

function ddmm(iso: string) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

export function WeldingQueueTable({
  rows,
  day,
  dept = "Welding",
  upstream = "Cut",
  notes = {},
  returns = [],
  capacity = DEFAULTS.capacityPerItem,
  canEdit = false,
  isAdmin = false,
  workers = [],
  paintableTanks = {},
  tankTracking = false,
  before,
  after,
  soi,
  machines = [],
  assigned = {},
}: {
  rows: WeldQueueRow[];
  day: string;
  dept?: "Welding" | "Painting";
  upstream?: string;
  notes?: Record<string, QueueNoteDTO[]>; // keyed by bom|mo|item
  returns?: ReturnRowDTO[]; // pieces sent back TO this dept (shown under the filter)
  capacity?: number; // pcs/item/working day — feeds the at-risk early warning
  canEdit?: boolean; // user holds this dept's edit permission — otherwise view-only
  isAdmin?: boolean; // admins may remove a line from the worklist (restorable)
  soi?: SoiLookup; // the SOI shown beside each MO
  /** TANKS ONLY — the people this dept can credit (welders here, painters on
   *  the painting worklist). Empty on every other component. */
  workers?: WorkerDTO[];
  /** PAINTING ONLY — tanks that passed the leak test, keyed by MO. The tank
   *  rows are painted by picking from these instead of typing a quantity. */
  paintableTanks?: Record<string, TankDTO[]>;
  /** Master switch: with it off a tank is just a quantity, like every other
   *  component — no serial, no welder box, no leak-test gate on painting. */
  tankTracking?: boolean;
  before?: React.ReactNode; // page sections rendered inside the scroll area, above the queue (priority / pushed)
  after?: React.ReactNode; // page sections at the bottom of the scroll area (hidden-lines panel)
  /** PAINTING — the paint lines; with any, every row carries a Machine picker. */
  machines?: MachineDTO[];
  assigned?: Record<string, LinePlacement>;
}) {
  const hasMachines = machines.length > 0;
  const verb = dept === "Welding" ? "weld" : "paint";
  // display name for the upstream dept ("Cut" shows as "Fabrication")
  const upLabel = upstream === "Welded" ? "Welding" : deptLabel(upstream);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [savedFlash, setSavedFlash] = useState<Record<string, boolean>>({});
  // search + item card filter survive navigating away and back
  const [q, setQ] = useSavedFilter(`queue.${dept}.q`);
  const [item, setItem] = useSavedFilter(`queue.${dept}.item`);
  // 🏭 only the lines already on a machine / partition, or only those still to place
  const [savedPlace, setPlace] = useSavedFilter(`queue.${dept}.place`);
  // a remembered "on a machine" filter means nothing with no machines shown
  // (machine planning off) — it must not hide every line
  const place = hasMachines ? savedPlace : "";
  // tanks: the welder picked for a line's batch, the serials the last save
  // minted (shown so they can be written on the steel), and which line has its
  // tank picker open on the painting worklist
  const [worker, setWorker] = useState<Record<string, WorkerPick>>({});
  const [minted, setMinted] = useState<Record<string, string[]>>({});
  const [openTanks, setOpenTanks] = useState<string | null>(null);
  const [openNotes, setOpenNotes] = useState<string | null>(null); // note panel per line (bom|mo|item)
  const [noteMsg, setNoteMsg] = useState("");
  const [editingNote, setEditingNote] = useState<number | null>(null);
  const [editText, setEditText] = useState("");

  function saveNoteEdit(id: number) {
    const fd = new FormData();
    fd.set("id", String(id));
    fd.set("text", editText);
    setNoteMsg("");
    startTransition(async () => {
      const res = await updateQueueNote(fd);
      if (res.ok) {
        setEditingNote(null);
        router.refresh();
      } else {
        setNoteMsg(res.error ?? "Failed");
      }
    });
  }

  function removeNote(id: number) {
    if (!confirm("Delete this note (and its photos) permanently?")) return;
    const fd = new FormData();
    fd.set("id", String(id));
    startTransition(async () => {
      const res = await deleteQueueNote(fd);
      if (res.ok) router.refresh();
      else setNoteMsg(res.error ?? "Failed");
    });
  }
  const [openReturn, setOpenReturn] = useState<string | null>(null); // return panel per line
  const [retMsg, setRetMsg] = useState("");

  function submitReturn(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setRetMsg("");
    startTransition(async () => {
      const res = await returnToUpstream(fd);
      if (res.ok) {
        form.reset();
        setOpenReturn(null);
        router.refresh();
      } else {
        setRetMsg(res.error ?? "Failed");
      }
    });
  }

  function submitNote(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setNoteMsg("");
    startTransition(async () => {
      const res = await addQueueNote(fd);
      if (res.ok) {
        form.reset();
        router.refresh();
      } else {
        setNoteMsg(res.error ?? "Failed");
      }
    });
  }

  function toggleNoteStatus(id: number, next: "open" | "resolved") {
    const fd = new FormData();
    fd.set("id", String(id));
    fd.set("status", next);
    setNoteMsg("");
    startTransition(async () => {
      const res = await setQueueNoteStatus(fd);
      if (res.ok) router.refresh();
      else setNoteMsg(res.error ?? "Failed");
    });
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return rows.filter(
      (r) =>
        (!needle || `${r.bom} ${r.mo} ${r.description}`.toUpperCase().includes(needle)) &&
        (!item || r.item === item) &&
        placementPass(place as PlacementMode, assigned, r)
    );
  }, [rows, q, item, place, assigned]);

  // how many of the queue's lines are on a machine already — the chips' counts
  const placed = useMemo(() => {
    let on = 0, off = 0;
    for (const r of rows) if (assigned[`${r.bom}|${r.mo}|${r.item}`]) on += 1; else off += 1;
    return { on, off };
  }, [rows, assigned]);

  const keyOf = (r: WeldQueueRow) => `${r.planNo}|${r.bom}|${r.mo}|${r.item}`;

  // Tanks are the one component tracked piece by piece: welding them mints a
  // serial each (so the line asks who welded them), and painting them means
  // picking the individual tanks that passed the leak test — a plain quantity
  // could say neither, so the tank rows get their own controls.
  const mintsTanks = (r: { item: string; mo: string }) => tankTracking && dept === "Welding" && r.item === TANK_ITEM && !!r.mo;
  const picksTanks = (r: { item: string; mo: string }) => tankTracking && dept === "Painting" && r.item === TANK_ITEM && !!r.mo;
  const pickOf = (k: string) => worker[k] ?? NO_WORKER;
  const workerName = (k: string) => workers.find((w) => w.id === pickOf(k).id)?.name ?? null;

  // per-item workload — the WHOLE queue (unfiltered): what's waiting per component
  const perItem = ITEMS.map((it) => {
    const lines = rows.filter((r) => r.item === it);
    const avail = lines.reduce((s, r) => s + r.available, 0);
    const maxAge = lines.reduce<number | null>(
      (m, r) => (r.available > 0 && r.ageDays !== null && (m === null || r.ageDays > m) ? r.ageDays : m),
      null
    );
    return { it, avail, maxAge };
  });
  const plansShown = new Set(rows.map((r) => r.planNo));
  const cols = (plansShown.size > 1 ? 12 : 11) + (hasMachines ? 1 : 0);

  // shared BOMs: one summary row per BOM × item, expandable to its MOs
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (gk: string) =>
    setOpenGroups((s) => {
      const n = new Set(s);
      if (n.has(gk)) n.delete(gk);
      else n.add(gk);
      return n;
    });
  const groups = useMemo(() => {
    const map = new Map<string, WeldQueueRow[]>();
    for (const r of filtered) {
      const gk = `${r.bom}|${r.item}`;
      if (!map.has(gk)) map.set(gk, []);
      map.get(gk)!.push(r);
    }
    return [...map.entries()];
  }, [filtered]);

  function save(r: WeldQueueRow) {
    const k = keyOf(r);
    const n = Number(qty[k]);
    if (!qty[k] || !Number.isFinite(n) || n <= 0) {
      setMsg((s) => ({ ...s, [k]: "Enter a quantity > 0" }));
      return;
    }
    if (n > r.available) {
      setMsg((s) => ({ ...s, [k]: `Only ${r.available} available from ${upLabel}` }));
      return;
    }
    // tanks are minted one serial per piece — the batch needs a named welder
    if (mintsTanks(r) && pickOf(k).id === null) {
      setMsg((s) => ({
        ...s,
        [k]: pickOf(k).empId ? "No worker has that ID." : "Enter the ID of the welder who made these tanks.",
      }));
      return;
    }
    const fd = new FormData();
    fd.set("date", day);
    fd.set("dept", dept);
    fd.set("bom", r.bom);
    fd.set("mo", r.mo);
    fd.set("item", r.item);
    fd.set("qty", String(n));
    fd.set("planNo", String(r.planNo));
    if (pickOf(k).id !== null) fd.set("workerId", String(pickOf(k).id));
    startTransition(async () => {
      const res = await recordOutput(fd);
      if (res.ok) {
        setQty((s) => ({ ...s, [k]: "" }));
        setMsg((s) => ({ ...s, [k]: "" }));
        if (res.serials) setMinted((s) => ({ ...s, [k]: res.serials! }));
        setSavedFlash((s) => ({ ...s, [k]: true }));
        setTimeout(() => setSavedFlash((s) => ({ ...s, [k]: false })), 1800);
        router.refresh();
      } else {
        setMsg((s) => ({ ...s, [k]: res.error ?? "Failed" }));
      }
    });
  }

  // record on the WHOLE BOM group: the qty is distributed over the member MOs
  // in the order shown — each fills up to its available, the rest flows on
  function saveGroup(gk: string, gBom: string, gItem: string, members: WeldQueueRow[], gAvailable: number) {
    const k = `g|${gk}`;
    const n = Number(qty[k]);
    if (!qty[k] || !Number.isFinite(n) || n <= 0) {
      setMsg((s) => ({ ...s, [k]: "Enter a quantity > 0" }));
      return;
    }
    if (n > gAvailable) {
      setMsg((s) => ({ ...s, [k]: `Only ${gAvailable} available from ${upLabel}` }));
      return;
    }
    if (tankTracking && dept === "Welding" && gItem === TANK_ITEM && pickOf(k).id === null) {
      setMsg((s) => ({
        ...s,
        [k]: pickOf(k).empId ? "No worker has that ID." : "Enter the ID of the welder who made these tanks.",
      }));
      return;
    }
    const fd = new FormData();
    fd.set("source", "worklist");
    fd.set("dept", dept);
    fd.set("bom", gBom);
    fd.set("item", gItem);
    fd.set("qty", String(n));
    // BOM-level lines (no MO) can't take part in the split — real MOs only
    fd.set("mos", [...new Set(members.map((m) => m.mo).filter(Boolean))].join(","));
    if (pickOf(k).id !== null) fd.set("workerId", String(pickOf(k).id));
    startTransition(async () => {
      const res = await recordGroupOutput(fd);
      if (res.ok) {
        setQty((s) => ({ ...s, [k]: "" }));
        setMsg((s) => ({ ...s, [k]: "" }));
        if (res.serials) setMinted((s) => ({ ...s, [k]: res.serials! }));
        setSavedFlash((s) => ({ ...s, [k]: true }));
        setTimeout(() => setSavedFlash((s) => ({ ...s, [k]: false })), 1800);
        router.refresh();
      } else {
        setMsg((s) => ({ ...s, [k]: res.error ?? "Failed" }));
      }
    });
  }

  // admin: remove this line from the worklist (restorable from the page footer)
  function hideLine(r: WeldQueueRow) {
    if (!confirm(`Remove ${r.mo || r.bom} · ${r.item} from this worklist? Plans and logs stay untouched — you can restore it from "Hidden lines" at the bottom of the page.`)) return;
    const fd = new FormData();
    fd.set("dept", dept);
    fd.set("bom", r.bom);
    fd.set("mo", r.mo);
    fd.set("item", r.item);
    startTransition(async () => {
      const res = await hideWorklistLine(fd);
      if (res.ok) router.refresh();
      else setMsg((s) => ({ ...s, [keyOf(r)]: res.error ?? "Failed" }));
    });
  }

  const renderRow = (r: WeldQueueRow, inGroup = false, lastInGroup = false) => {
    const k = keyOf(r);
    const cleared = r.available === 0;
    const overdue = !!r.dueISO && r.dueISO < day;
    const dueToday = r.dueISO === day;
    // early warning: still on time, but the open qty exceeds what full capacity
    // can produce before the due date — it WILL slip unless output rises today
    const atRisk = !cleared && !overdue && assessDeliveryRisk(r, day, capacity) === "at-risk";
    const noteKey = `${r.bom}|${r.mo}|${r.item}`;
    const lineNotes = notes[noteKey] ?? [];
    const openCount = lineNotes.filter((n) => n.status === "open").length;
    // frame: open groups get a clear border so their extent is obvious
    const frame = inGroup ? `border-x-2 border-brand ${lastInGroup ? "border-b-2" : ""}` : "";
    return (
      <Fragment key={k}>
        <tr className={`${cleared ? "opacity-60" : ""} ${inGroup ? "bg-brand-light/10" : ""} ${frame}`}>
          <td className="p-2 whitespace-nowrap">
            {r.deliveryISO ? (
              <span className={`pill ${overdue ? "pill-bad" : dueToday ? "pill-warn" : "pill-ok"}`}>
                📅 {ddmm(r.deliveryISO)}
              </span>
            ) : (
              <span className="pill pill-muted">—</span>
            )}
            {atRisk && (
              <span
                className="pill pill-bad ml-1"
                title={`Likely to slip: ${r.dueQty} pcs due ${r.dueISO ? ddmm(r.dueISO) : ""} exceeds the remaining capacity window (${capacity}/day)`}
              >
                ⚠ at risk
              </span>
            )}
            {isAdmin && (
              <button
                type="button"
                onClick={() => hideLine(r)}
                disabled={pending}
                className="text-muted text-xs px-1 hover:text-bad-fg align-middle"
                title="Remove this line from the worklist (admin) — restorable from the bottom of the page"
              >
                🗑
              </button>
            )}
          </td>
          <td className={`p-2 text-xs font-semibold whitespace-nowrap ${inGroup ? "pl-6" : ""}`}>
            {inGroup && <span className="text-muted mr-1">↳</span>}
            {r.mo || "—"}
          </td>
          <td className="p-2 whitespace-nowrap"><Soi soi={soiOf(soi, r.mo, r.bom)} /></td>
          <td className="p-2 font-bold whitespace-nowrap">{r.bom}</td>
          <td className="p-2 text-xs text-muted whitespace-nowrap">{r.description}</td>
          {plansShown.size > 1 && <td className="p-2 text-center text-xs tabnum">{r.planNo}</td>}
          <td className="p-2 text-center font-bold">{r.item}</td>
          <td className="p-2 text-center">
            <Frac num={r.cutToDate} den={r.orderQty ?? null} />
          </td>
          <td className="p-2 text-center font-extrabold tabnum" style={{ color: r.available > 0 ? "var(--ok-fg)" : "var(--muted)" }}>
            {r.available}
          </td>
          <td className="p-2 text-center whitespace-nowrap">
            {r.ageDays === null ? (
              <span className="text-muted">—</span>
            ) : (
              <span
                className={`pill ${r.ageDays > 6 ? "pill-bad" : r.ageDays > 2 ? "pill-warn" : "pill-ok"}`}
                title={r.waitingSinceISO ? `oldest piece waiting since ${r.waitingSinceISO}` : undefined}
              >
                ⏳ {r.ageDays === 0 ? "today" : `${r.ageDays}d`}
              </span>
            )}
          </td>
          <td className="p-2">
            {cleared ? (
              <span className="pill pill-ok">✓ Cleared</span>
            ) : !canEdit ? (
              <span className="text-muted text-xs" title="View only — you don't have this department's edit permission">—</span>
            ) : tankTracking && (dept === "Welding" || dept === "Painting") && r.item === TANK_ITEM && !r.mo ? (
              // a serial carries its order — a BOM-level line has no MO to carry
              <span className="text-[11px] text-muted whitespace-normal" title="A tank's serial carries the order it belongs to">
                Tanks are recorded under an MO — this line has none.
              </span>
            ) : picksTanks(r) ? (
              // painting a tank = picking the tanks that passed the leak test
              <button
                type="button"
                onClick={() => setOpenTanks(openTanks === k ? null : k)}
                disabled={pending}
                className="rounded-md px-2.5 py-1 text-xs font-bold text-white bg-brand-fill hover:bg-brand-dark disabled:opacity-50"
                title="Tanks are painted by serial — pick the tanks and who painted them"
              >
                🛢 Pick tanks ({(paintableTanks[r.mo] ?? []).length})
              </button>
            ) : (
              <div className="flex items-center gap-1.5 flex-wrap justify-center">
                <input
                  type="number"
                  min={1}
                  max={r.available}
                  step={mintsTanks(r) ? 1 : undefined}
                  placeholder="qty"
                  value={qty[k] ?? ""}
                  onChange={(e) => setQty((s) => ({ ...s, [k]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && save(r)}
                  className="w-16 border rounded-md px-1.5 py-1 text-center font-bold tabnum"
                  disabled={pending}
                />
                {mintsTanks(r) && (
                  <TankWorkerPicker
                    workers={workers}
                    value={pickOf(k)}
                    onChange={(v) => setWorker((s) => ({ ...s, [k]: v }))}
                    disabled={pending}
                    label="Welder ID"
                    emptyHint="No welders on file — the admin adds them under Production Workers."
                  />
                )}
                <button
                  type="button"
                  onClick={() => save(r)}
                  disabled={pending}
                  className={`rounded-md px-2.5 py-1 text-xs font-bold text-white transition-colors ${savedFlash[k] ? "bg-ok-fill" : "bg-brand-fill hover:bg-brand-dark"} disabled:opacity-50`}
                >
                  {savedFlash[k] ? "✓ Saved" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => { setOpenReturn(openReturn === noteKey ? null : noteKey); setRetMsg(""); }}
                  disabled={pending}
                  className="rounded-md px-1.5 py-1 text-xs font-bold border text-bad-fg hover:bg-bad-bg transition-colors"
                  title={`Send back to ${upLabel} — the piece is not actually finished`}
                >
                  ↩
                </button>
              </div>
            )}
            {msg[k] && <div className="text-[11px] text-bad-fg mt-0.5">{msg[k]}</div>}
          </td>
          {hasMachines && (
            <td className="p-2 whitespace-nowrap">
              <MachinePick dept={dept} bom={r.bom} mo={r.mo} item={r.item} machines={machines} current={assigned[`${r.bom}|${r.mo}|${r.item}`]} canEdit={canEdit} compact />
            </td>
          )}
          <td className="p-2 text-center whitespace-nowrap">
            <button
              type="button"
              onClick={() => { setOpenNotes(openNotes === noteKey ? null : noteKey); setNoteMsg(""); }}
              className={`pill ${openCount > 0 ? "pill-bad" : lineNotes.length > 0 ? "pill-muted" : "pill-ok"} cursor-pointer hover:opacity-80`}
              title={openCount > 0 ? `${openCount} open note(s) — check before trusting the numbers` : "Add a note / photo"}
            >
              📝 {lineNotes.length > 0 ? lineNotes.length : "+"}
            </button>
          </td>
        </tr>
        {minted[k] && minted[k].length > 0 && (
          <tr className={inGroup ? "border-x-2 border-brand" : ""}>
            <td colSpan={cols} className="p-3 bg-brand-light/20 border-y">
              <TankSerialsPanel
                serials={minted[k]}
                welders={workers}
                batchWelder={workerName(k)}
                onClose={() => setMinted((s) => ({ ...s, [k]: [] }))}
              />
            </td>
          </tr>
        )}
        {openTanks === k && picksTanks(r) && (
          <Modal title={`Record painted tanks — ${r.mo || r.bom}`} onClose={() => setOpenTanks(null)} width="max-w-3xl">
              <TankPaintPicker
                tanks={paintableTanks[r.mo] ?? []}
                painters={workers}
                day={day}
                label={`${r.mo} · ${r.bom}`}
                onDone={() => setOpenTanks(null)}
              />
          </Modal>
        )}
        {openReturn === noteKey && (
          <Modal title={`↩ Return ${r.mo || r.bom} ${r.item}`} onClose={() => setOpenReturn(null)} busy={pending}>
              <form onSubmit={submitReturn} className="space-y-2">
                <p className="text-xs font-bold text-bad-fg">
                  ↩ Return {r.mo || r.bom} {r.item} to {dept === "Welding" ? deptLabel("Cut") : "Welding"} — the qty comes OFF their delivered total and lands in their Returns table until re-delivered.
                </p>
                <input type="hidden" name="fromDept" value={dept} />
                <input type="hidden" name="bom" value={r.bom} />
                <input type="hidden" name="mo" value={r.mo} />
                <input type="hidden" name="item" value={r.item} />
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="number"
                    name="qty"
                    min={1}
                    max={r.available}
                    required
                    placeholder="qty"
                    className="w-20 border rounded-md px-1.5 py-1 text-center font-bold tabnum"
                    disabled={pending}
                  />
                  <input
                    type="text"
                    name="reason"
                    required
                    placeholder="Why is it going back? (missing weld, wrong size, damaged…)"
                    className="flex-1 min-w-52 border rounded-md px-2 py-1 text-sm bg-surface"
                    disabled={pending}
                  />
                  <button
                    type="submit"
                    disabled={pending}
                    className="rounded-md px-3 py-1.5 text-xs font-bold text-white bg-bad-fg hover:opacity-90 disabled:opacity-50 transition-opacity"
                  >
                    {pending ? "Returning…" : "↩ Return"}
                  </button>
                  <button type="button" onClick={() => setOpenReturn(null)} className="text-muted text-xs px-1 hover:underline">Cancel</button>
                </div>
                {retMsg && <div className="text-[11px] text-bad-fg">{retMsg}</div>}
              </form>
          </Modal>
        )}
        {openNotes === noteKey && (
          <Modal title={`📝 Notes — ${r.mo || r.bom} · ${r.item}`} onClose={() => setOpenNotes(null)} busy={pending} width="max-w-4xl">
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted">
                  📝 Notes — {r.mo || r.bom} · {r.item}
                  {lineNotes.length > 0 && <span className="pill pill-muted normal-case">{lineNotes.length}</span>}
                </div>

                {lineNotes.length > 0 && (
                  <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
                    {lineNotes.map((n) => (
                      <div
                        key={n.id}
                        className={`bg-surface border rounded-xl p-3 shadow-sm ${n.status === "resolved" ? "opacity-60" : "border-l-4"} `}
                        style={n.status === "open" ? { borderLeftColor: "var(--warn-fg)" } : undefined}
                      >
                        <div className="flex flex-wrap items-center gap-2 text-xs mb-1.5">
                          <span className={`pill ${n.status === "open" ? "pill-warn" : "pill-ok"}`}>
                            {n.status === "open" ? "⚠ open" : "✓ resolved"}
                          </span>
                          <span className="font-bold">{n.dept}</span>
                          <span className="text-muted tabnum">{n.createdISO}</span>
                          {canEdit && (
                            <span className="ml-auto flex items-center gap-2.5">
                              {editingNote !== n.id && (
                                <button
                                  type="button"
                                  onClick={() => { setEditingNote(n.id); setEditText(n.text); setNoteMsg(""); }}
                                  disabled={pending}
                                  className="text-brand-ink hover:underline"
                                >
                                  ✏️ Edit
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => toggleNoteStatus(n.id, n.status === "open" ? "resolved" : "open")}
                                disabled={pending}
                                className="text-brand-ink hover:underline"
                              >
                                {n.status === "open" ? "Mark resolved" : "Reopen"}
                              </button>
                              <button
                                type="button"
                                onClick={() => removeNote(n.id)}
                                disabled={pending}
                                className="text-bad-fg hover:underline"
                              >
                                🗑 Delete
                              </button>
                            </span>
                          )}
                        </div>

                        {editingNote === n.id ? (
                          <div className="space-y-1.5">
                            <textarea
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              rows={2}
                              autoFocus
                              className="w-full border rounded-md px-2 py-1.5 text-sm bg-surface"
                              disabled={pending}
                            />
                            <div className="flex items-center justify-end gap-2 text-xs">
                              <button type="button" onClick={() => setEditingNote(null)} className="text-muted hover:underline">Cancel</button>
                              <button
                                type="button"
                                onClick={() => saveNoteEdit(n.id)}
                                disabled={pending}
                                className="rounded-md px-3 py-1 font-bold text-white bg-brand-fill hover:bg-brand-dark disabled:opacity-50"
                              >
                                {pending ? "Saving…" : "Save"}
                              </button>
                            </div>
                          </div>
                        ) : (
                          n.text && <p className="text-sm whitespace-pre-wrap leading-relaxed">{n.text}</p>
                        )}

                        {n.photos.length > 0 && (
                          <div className="flex flex-wrap gap-2 mt-2">
                            {n.photos.map((p) => (
                              <a key={p} href={p} target="_blank" rel="noreferrer" title="Open full size">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={p} alt="note photo" className="h-20 w-20 object-cover rounded-lg border shadow-sm hover:opacity-80 transition-opacity" />
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {canEdit && (
                <form onSubmit={submitNote} className="bg-surface border rounded-xl p-3 shadow-sm">
                  <input type="hidden" name="bom" value={r.bom} />
                  <input type="hidden" name="mo" value={r.mo} />
                  <input type="hidden" name="item" value={r.item} />
                  <input type="hidden" name="dept" value={dept} />
                  <div className="flex flex-col md:flex-row gap-2.5">
                    <textarea
                      name="text"
                      rows={2}
                      placeholder={`What's really going on with ${r.mo || r.bom} ${r.item}? (optional when attaching photos)`}
                      className="flex-1 border rounded-md px-2 py-1.5 text-sm bg-surface"
                      disabled={pending}
                    />
                    <div className="flex md:flex-col items-end justify-between gap-2 md:w-60">
                      <label className="w-full text-xs text-muted border border-dashed rounded-md px-2 py-1.5 cursor-pointer hover:border-brand transition-colors">
                        📷 Attach photos
                        <input type="file" name="photos" accept="image/*" multiple className="block w-full text-xs mt-1" disabled={pending} />
                      </label>
                      <button
                        type="submit"
                        disabled={pending}
                        className="rounded-md px-4 py-1.5 text-xs font-bold text-white bg-brand-fill hover:bg-brand-dark disabled:opacity-50 transition-colors whitespace-nowrap"
                      >
                        {pending ? "Saving…" : "Save note"}
                      </button>
                    </div>
                  </div>
                  {noteMsg && <div className="text-[11px] text-bad-fg mt-1.5">{noteMsg}</div>}
                </form>
                )}
              </div>
          </Modal>
        )}
      </Fragment>
    );
  };

  return (
    // On desktop the page fills the viewport below the nav and does not
    // scroll itself: the filter bar stays put and everything else (priority /
    // pushed / returns + the queue) scrolls inside its own box, with the
    // queue's header row pinned — same pattern as the Plan Tracker.
    <div className="md:flex md:flex-col md:h-[calc(100vh-7.75rem)]">
      <FilterBar count={filtered.length} total={rows.length} showCount={false} onReset={() => { setQ(""); setItem(""); setPlace(""); }} hasActive={!!q || !!item || !!place}>
        <SearchBox value={q} onChange={setQ} placeholder="Search MO / BOM…" />
        {/* per-component workload — tap a card to filter the queue to it */}
        <div className="col-span-2 flex flex-wrap items-center gap-1.5">
          {perItem.map(({ it, avail, maxAge }) => (
            <button
              key={it}
              type="button"
              onClick={() => setItem(item === it ? "" : it)}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition-all hover:border-brand hover:shadow-sm ${item === it ? "border-brand bg-brand-light shadow-sm" : "bg-surface"}`}
              title={
                item === it
                  ? "Click to clear the filter"
                  : `${it}: ${avail} to ${verb}${maxAge !== null ? ` · oldest waiting ${maxAge === 0 ? "today" : `${maxAge}d`}` : " · queue clear"}`
              }
            >
              <span className="text-muted">{it}</span>
              <b className={`text-sm tabnum ${avail > 0 ? "text-brand-ink" : "text-muted"}`}>{avail}</b>
              {maxAge !== null && (
                <span className={`tabnum font-semibold ${maxAge > 6 ? "text-bad-fg" : "text-muted"}`}>
                  ⏳{maxAge === 0 ? "0d" : `${maxAge}d`}
                </span>
              )}
            </button>
          ))}
          {machines.length > 0 && <PlacementChips value={place as PlacementMode} onChange={setPlace} word={machineWord(dept)} on={placed.on} off={placed.off} />}
        </div>
        <PrintButton />
      </FilterBar>

      <div className="md:flex-1 md:min-h-0 md:overflow-auto">
      {before}

      {/* pieces sent back TO this dept: fix first, they re-enter the flow */}
      <ReturnsTable rows={returns} dept={dept} canEdit={canEdit} />

      {/* overflow-x only below md — on desktop the wrapper must stay visible so
          the sticky header pins against the outer scroll box */}
      <div className="bg-surface border rounded-xl overflow-x-auto md:overflow-x-visible">
        <table className="w-full text-sm border-collapse">
          <thead className="md:sticky md:top-0 md:z-10">
            <tr className="bg-brand-fill text-white text-left">
              <th className="p-2">Deliver on</th>
              <th className="p-2">MO</th>
              <th className="p-2" title="Sales order item">SOI</th>
              <th className="p-2">BOM</th>
              <th className="p-2">Description</th>
              {plansShown.size > 1 && <th className="p-2 text-center">Plan</th>}
              <th className="p-2 text-center">Item</th>
              <th className="p-2 text-center" title={`${upLabel} output on the whole order / order qty`}>{upstream === "Welded" ? "Welded" : "Fab"} / Order</th>
              <th className="p-2 text-center" title={`Ready to ${verb} now (delivered by ${upLabel})`}>Available</th>
              <th className="p-2 text-center">Waiting</th>
              <th className="p-2 text-center w-44">Record {dept === "Welding" ? "welded" : "painted"}</th>
              {hasMachines && <th className="p-2" title="Which line the work is on, and its place in that line's queue">Machine</th>}
              <th className="p-2 text-center">Notes</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={cols} className="p-4 text-center text-muted">
                {rows.length === 0 ? "Nothing fabricated is waiting for welding — the queue is clear." : "No lines match the search."}
              </td></tr>
            )}
            {groups.map(([gk, members]) => {
              if (members.length === 1) return renderRow(members[0]);
              const open = openGroups.has(gk);
              const [gBom, gItem] = gk.split("|");
              const sum = (f: (r: WeldQueueRow) => number) => members.reduce((s, r) => s + f(r), 0);
              const minDel = members.map((m) => m.deliveryISO).filter((d): d is string => !!d).sort()[0] ?? null;
              const minDue = members.map((m) => m.dueISO).filter((d): d is string => !!d).sort()[0] ?? null;
              const maxAge = members.reduce<number | null>(
                (m, r) => (r.ageDays !== null && (m === null || r.ageDays > m) ? r.ageDays : m),
                null
              );
              const gDesc = members.find((m) => m.description)?.description ?? "";
              const openNoteCount = members.reduce(
                (s, r) => s + (notes[`${r.bom}|${r.mo}|${r.item}`] ?? []).filter((n) => n.status === "open").length,
                0
              );
              const gAvailable = sum((r) => r.available);
              const gOverdue = !!minDue && minDue < day;
              const gDueToday = minDue === day;
              return (
                <Fragment key={`g|${gk}`}>
                  <tr
                    className={`cursor-pointer bg-brand-light/30 hover:bg-brand-light/60 transition-colors font-semibold ${open ? "border-x-2 border-t-2 border-brand" : ""}`}
                    onClick={() => toggleGroup(gk)}
                    title={open ? "Collapse MOs" : "Show the MOs inside this BOM"}
                  >
                    <td className="p-2 whitespace-nowrap">
                      {minDel ? (
                        <span className={`pill ${gOverdue ? "pill-bad" : gDueToday ? "pill-warn" : "pill-ok"}`}>
                          📅 {ddmm(minDel)}
                        </span>
                      ) : (
                        <span className="pill pill-muted">—</span>
                      )}
                    </td>
                    <td className="p-2 text-xs font-bold whitespace-nowrap">
                      <span className={`inline-block mr-1 transition-transform duration-150 ${open ? "rotate-90" : ""}`}>▶</span>
                      {members.length} MOs
                    </td>
                    <td className="p-2 font-bold whitespace-nowrap">{gBom}</td>
                    <td className="p-2 text-xs text-muted whitespace-nowrap">{gDesc}</td>
                    {plansShown.size > 1 && <td className="p-2 text-center text-xs">—</td>}
                    <td className="p-2 text-center font-bold">{gItem}</td>
                    <td className="p-2 text-center font-bold">
                      <Frac num={sum((r) => r.cutToDate)} den={members.some((m) => m.orderQty != null) ? sum((r) => r.orderQty ?? 0) : null} />
                    </td>
                    <td className="p-2 text-center font-extrabold tabnum" style={{ color: gAvailable > 0 ? "var(--ok-fg)" : "var(--muted)" }}>
                      {gAvailable}
                    </td>
                    <td className="p-2 text-center whitespace-nowrap">
                      {maxAge === null ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <span className={`pill ${maxAge > 6 ? "pill-bad" : maxAge > 2 ? "pill-warn" : "pill-ok"}`}>
                          ⏳ {maxAge === 0 ? "today" : `${maxAge}d`}
                        </span>
                      )}
                    </td>
                    <td className="p-2 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      {/* painting tanks happens per PIECE — the group row can
                          only send the user into the MOs, where the picker is */}
                      {tankTracking && dept === "Painting" && gItem === TANK_ITEM ? (
                        <span className="text-xs text-muted">{open ? "▲ collapse" : "▼ open MOs"}</span>
                      ) : canEdit && gAvailable > 0 && members.some((m) => m.mo) ? (
                        <>
                          <div className="flex items-center gap-1.5 justify-center flex-wrap">
                            <input
                              type="number"
                              min={1}
                              max={gAvailable}
                              step={tankTracking && gItem === TANK_ITEM ? 1 : undefined}
                              placeholder="qty"
                              value={qty[`g|${gk}`] ?? ""}
                              onChange={(e) => setQty((s) => ({ ...s, [`g|${gk}`]: e.target.value }))}
                              onKeyDown={(e) => e.key === "Enter" && saveGroup(gk, gBom, gItem, members, gAvailable)}
                              className="w-16 border rounded-md px-1.5 py-1 text-center font-bold tabnum"
                              disabled={pending}
                              title="Record on the WHOLE BOM — the quantity is distributed over its MOs in order"
                            />
                            {tankTracking && dept === "Welding" && gItem === TANK_ITEM && (
                              <TankWorkerPicker
                                workers={workers}
                                value={pickOf(`g|${gk}`)}
                                onChange={(v) => setWorker((s) => ({ ...s, [`g|${gk}`]: v }))}
                                disabled={pending}
                                label="Welder ID"
                                emptyHint="No welders on file."
                              />
                            )}
                            <button
                              type="button"
                              onClick={() => saveGroup(gk, gBom, gItem, members, gAvailable)}
                              disabled={pending}
                              className={`rounded-md px-2.5 py-1 text-xs font-bold text-white transition-colors ${savedFlash[`g|${gk}`] ? "bg-ok-fill" : "bg-brand-fill hover:bg-brand-dark"} disabled:opacity-50`}
                              title={`Distributes over the MOs in order — each fills up to its available, the rest flows to the next`}
                            >
                              {savedFlash[`g|${gk}`] ? "✓ Saved" : "Save all"}
                            </button>
                          </div>
                          {msg[`g|${gk}`] && <div className="text-[11px] text-bad-fg mt-0.5 whitespace-normal max-w-48">{msg[`g|${gk}`]}</div>}
                        </>
                      ) : gAvailable === 0 ? (
                        <span className="pill pill-ok">✓ Cleared</span>
                      ) : (
                        <span className="text-xs text-muted">{open ? "▲ collapse" : "▼ open MOs"}</span>
                      )}
                    </td>
                    {hasMachines && (
                      <td className="p-2 text-xs text-muted whitespace-nowrap">
                        {(() => {
                          const on = [...new Set(members.map((m) => assigned[`${m.bom}|${m.mo}|${m.item}`]?.machineId).filter((x): x is number => x !== undefined))];
                          return on.length > 0 ? on.map((id) => machines.find((x) => x.id === id)?.code ?? id).join(", ") : "—";
                        })()}
                      </td>
                    )}
                    <td className="p-2 text-center whitespace-nowrap">
                      {openNoteCount > 0 ? <span className="pill pill-bad">📝 {openNoteCount}</span> : <span className="text-muted text-xs">—</span>}
                    </td>
                  </tr>
                  {minted[`g|${gk}`] && minted[`g|${gk}`].length > 0 && (
                    <tr className="border-x-2 border-brand">
                      <td colSpan={cols} className="p-3 bg-brand-light/20 border-y">
                        <TankSerialsPanel
                          serials={minted[`g|${gk}`]}
                          welders={workers}
                          batchWelder={workerName(`g|${gk}`)}
                          onClose={() => setMinted((s) => ({ ...s, [`g|${gk}`]: [] }))}
                        />
                      </td>
                    </tr>
                  )}
                  {open && members.map((m, i) => renderRow(m, true, i === members.length - 1))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {after}
      </div>
    </div>
  );
}
