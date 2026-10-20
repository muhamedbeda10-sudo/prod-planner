"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CascadeRow } from "@/lib/domain/execution";
import type { QueueNoteDTO } from "@/lib/server/queueNotes";
import { recordOutput, recordGroupOutput, setWorklistDate, hideWorklistLine } from "@/app/worklist/actions";
import { SearchBox, FilterBar } from "@/components/FilterControls";
import { NotesButton, NotesPanelRow } from "@/components/QueueNotes";
import { Frac } from "@/components/Frac";
import { MachinePick } from "@/components/MachineBoard";
import type { MachineDTO } from "@/lib/server/machines";
import type { LinePlacement } from "@/lib/domain/machineBoard";

function ddmm(iso: string) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

export function CascadeTable({
  rows,
  day,
  planNo,
  hideFilter = false, // the cut page has ONE shared filter above all tables
  notes = {}, // keyed by bom|mo|item
  canEdit = false,
  isAdmin = false,
  dept = "Cut", // which dept records output on these rows (Cut | Welding | Painting)
  allowDate = true, // admins may give a date-less line a delivery date (cut page only)
  machines = [],
  assigned = {},
}: {
  rows: CascadeRow[];
  day: string; // ISO (today — computed by the app)
  planNo: number;
  hideFilter?: boolean;
  notes?: Record<string, QueueNoteDTO[]>;
  canEdit?: boolean; // user holds the dept's edit permission — otherwise view-only
  isAdmin?: boolean; // admins may date / remove lines
  dept?: string;
  allowDate?: boolean;
  /** The department's machines — with any, every row carries a Machine picker. */
  machines?: MachineDTO[];
  assigned?: Record<string, LinePlacement>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const hasMachines = machines.length > 0;
  const cols = hasMachines ? 10 : 9;
  const [qty, setQty] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [savedFlash, setSavedFlash] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");
  const [openNotes, setOpenNotes] = useState<string | null>(null); // per row key (bom|mo|item)
  const [dateEdit, setDateEdit] = useState<string | null>(null); // row key being dated (admin)
  const [dateVal, setDateVal] = useState("");
  const [dateQty, setDateQty] = useState(""); // how many pieces get that date

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    if (!needle) return rows;
    return rows.filter((r) => `${r.bom} ${r.mo} ${r.description}`.toUpperCase().includes(needle));
  }, [rows, q]);

  const keyOf = (r: CascadeRow) => `${r.bom}|${r.mo}|${r.item}`;
  const totalPool = filtered.reduce((s, r) => s + r.available, 0);

  // admin: remove this line from the worklist (restorable from the page footer)
  function hideLine(r: CascadeRow) {
    if (!confirm(`Remove ${r.mo} · ${r.item} from this worklist? Plans and logs stay untouched — you can restore it from "Hidden lines" at the bottom of the page.`)) return;
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

  // admin: schedule a PART of this date-less line — pick the date AND how many
  // pieces (≤ the pool); the rest stays here. Reverting from the dated tables
  // returns the part to the pool.
  function saveDate(r: CascadeRow) {
    const n = Number(dateQty);
    if (!dateQty || !Number.isFinite(n) || n <= 0 || n > r.available) {
      setMsg((s) => ({ ...s, [keyOf(r)]: `Quantity must be 1–${r.available}` }));
      return;
    }
    const fd = new FormData();
    fd.set("bom", r.bom);
    fd.set("mo", r.mo);
    fd.set("item", r.item);
    fd.set("origISO", "");
    fd.set("date", dateVal);
    fd.set("qty", dateQty);
    startTransition(async () => {
      const res = await setWorklistDate(fd);
      if (res.ok) {
        setDateEdit(null);
        setMsg((s) => ({ ...s, [keyOf(r)]: "" }));
        router.refresh();
      } else {
        setMsg((s) => ({ ...s, [keyOf(r)]: res.error ?? "Failed" }));
      }
    });
  }

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
    const map = new Map<string, CascadeRow[]>();
    for (const r of filtered) {
      const gk = `${r.bom}|${r.item}`;
      if (!map.has(gk)) map.set(gk, []);
      map.get(gk)!.push(r);
    }
    return [...map.entries()];
  }, [filtered]);

  // record on the WHOLE BOM group: the qty is distributed over the member MOs
  // in the order shown — each fills up to its own headroom, the rest flows on
  function saveGroup(gk: string, gBom: string, gItem: string, members: CascadeRow[]) {
    const k = `g|${gk}`;
    const n = Number(qty[k]);
    if (!qty[k] || !Number.isFinite(n) || n <= 0) {
      setMsg((s) => ({ ...s, [k]: "Enter a quantity > 0" }));
      return;
    }
    const fd = new FormData();
    fd.set("source", "worklist");
    fd.set("dept", dept);
    fd.set("bom", gBom);
    fd.set("item", gItem);
    fd.set("qty", String(n));
    fd.set("mos", [...new Set(members.map((m) => m.mo).filter(Boolean))].join(","));
    startTransition(async () => {
      const res = await recordGroupOutput(fd);
      if (res.ok) {
        setQty((s) => ({ ...s, [k]: "" }));
        setMsg((s) => ({ ...s, [k]: "" }));
        setSavedFlash((s) => ({ ...s, [k]: true }));
        setTimeout(() => setSavedFlash((s) => ({ ...s, [k]: false })), 1800);
        router.refresh();
      } else {
        setMsg((s) => ({ ...s, [k]: res.error ?? "Failed" }));
      }
    });
  }

  function save(r: CascadeRow) {
    const k = keyOf(r);
    const n = Number(qty[k]);
    if (!qty[k] || !Number.isFinite(n) || n <= 0) {
      setMsg((s) => ({ ...s, [k]: "Enter a quantity > 0" }));
      return;
    }
    const fd = new FormData();
    fd.set("date", day);
    fd.set("dept", dept);
    fd.set("bom", r.bom);
    fd.set("mo", r.mo);
    fd.set("item", r.item);
    fd.set("qty", String(n));
    fd.set("planNo", String(planNo));
    startTransition(async () => {
      const res = await recordOutput(fd);
      if (res.ok) {
        setQty((s) => ({ ...s, [k]: "" }));
        setMsg((s) => ({ ...s, [k]: "" }));
        setSavedFlash((s) => ({ ...s, [k]: true }));
        setTimeout(() => setSavedFlash((s) => ({ ...s, [k]: false })), 1800);
        router.refresh();
      } else {
        setMsg((s) => ({ ...s, [k]: res.error ?? "Failed" }));
      }
    });
  }

  return (
    <>
      {!hideFilter && (
        <FilterBar count={filtered.length} total={rows.length} onReset={() => setQ("")} hasActive={!!q}>
          <SearchBox value={q} onChange={setQ} placeholder="Search MO / BOM…" />
          <span className="text-xs text-muted">
            Open pool (shown): <b className="text-foreground tabnum">{totalPool}</b> pcs
          </span>
        </FilterBar>
      )}

      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-accent-gray/90 text-white text-left">
              <th className="p-2">Deliver on</th>
              <th className="p-2">MO</th>
              <th className="p-2">BOM</th>
              <th className="p-2">Description</th>
              <th className="p-2 text-center">Item</th>
              <th className="p-2 text-center" title="Whole order: cut so far / order qty">Done / Order</th>
              <th className="p-2 text-center" title="Unscheduled pool you can pull from">Pool</th>
              <th className="p-2 text-center w-44">Pull &amp; record</th>
              {hasMachines && <th className="p-2" title="Which machine the line is on, and its place in that machine's queue">Machine</th>}
              <th className="p-2 text-center">Notes</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={cols} className="p-4 text-center text-muted">
                {rows.length === 0 ? "Nothing here — every open order is scheduled or remarked." : "No lines match the search."}
              </td></tr>
            )}
            {groups.map(([gk, members]) => {
              if (members.length === 1) return renderRow(members[0]);
              const open = openGroups.has(gk);
              const [gBom, gItem] = gk.split("|");
              const gDesc = members.find((m) => m.description)?.description ?? "";
              const sum = (f: (r: CascadeRow) => number) => members.reduce((s, r) => s + f(r), 0);
              const minDel = members.map((m) => m.deliveryISO).filter((d): d is string => !!d).sort()[0] ?? null;
              return (
                <Fragment key={`g|${gk}`}>
                  <tr
                    className={`cursor-pointer bg-brand-light/30 hover:bg-brand-light/60 transition-colors font-semibold ${open ? "border-x-2 border-t-2 border-brand" : ""}`}
                    onClick={() => toggleGroup(gk)}
                    title={open ? "Collapse MOs" : "Show the MOs inside this BOM"}
                  >
                    <td className="p-2 whitespace-nowrap">
                      {minDel ? (
                        <span className={`pill ${minDel < day ? "pill-bad" : minDel === day ? "pill-warn" : "pill-ok"}`}>📅 {ddmm(minDel)}</span>
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
                    <td className="p-2 text-center font-bold">{gItem}</td>
                    <td className="p-2 text-center font-bold">
                      <Frac num={sum((r) => r.done)} den={sum((r) => r.target)} />
                    </td>
                    <td className="p-2 text-center font-extrabold tabnum" style={{ color: "var(--warn-fg)" }}>{sum((r) => r.available)}</td>
                    <td className="p-2 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      {canEdit ? (
                        <>
                          <div className="flex items-center gap-1.5 justify-center">
                            <input
                              type="number"
                              min={1}
                              placeholder="qty"
                              value={qty[`g|${gk}`] ?? ""}
                              onChange={(e) => setQty((s) => ({ ...s, [`g|${gk}`]: e.target.value }))}
                              onKeyDown={(e) => e.key === "Enter" && saveGroup(gk, gBom, gItem, members)}
                              className="w-16 border rounded-md px-1.5 py-1 text-center font-bold tabnum"
                              disabled={pending}
                              title="Record on the WHOLE BOM — the quantity is distributed over its MOs in order"
                            />
                            <button
                              type="button"
                              onClick={() => saveGroup(gk, gBom, gItem, members)}
                              disabled={pending}
                              className={`rounded-md px-2.5 py-1 text-xs font-bold text-white transition-colors ${savedFlash[`g|${gk}`] ? "bg-ok-fill" : "bg-brand-fill hover:bg-brand-dark"} disabled:opacity-50`}
                              title={`Distributes over the ${members.length} MOs in order — each fills up to its own limit, the rest flows to the next`}
                            >
                              {savedFlash[`g|${gk}`] ? "✓ Saved" : "Save all"}
                            </button>
                          </div>
                          {msg[`g|${gk}`] && <div className="text-[11px] text-bad-fg mt-0.5 whitespace-normal max-w-48">{msg[`g|${gk}`]}</div>}
                        </>
                      ) : (
                        <span className="text-xs text-muted">{open ? "▲ collapse" : "▼ open MOs"}</span>
                      )}
                    </td>
                    {hasMachines && (
                      <td className="p-2 text-xs text-muted whitespace-nowrap">
                        {(() => {
                          const on = [...new Set(members.map((m) => assigned[keyOf(m)]?.machineId).filter((x): x is number => x !== undefined))];
                          return on.length > 0 ? on.map((id) => machines.find((x) => x.id === id)?.code ?? id).join(", ") : "—";
                        })()}
                      </td>
                    )}
                    <td className="p-2 text-center whitespace-nowrap">
                      {(() => {
                        const openNoteCount = members.reduce(
                          (s, m) => s + (notes[`${m.bom}|${m.mo}|${m.item}`] ?? []).filter((n) => n.status === "open").length,
                          0
                        );
                        return openNoteCount > 0 ? <span className="pill pill-bad">📝 {openNoteCount}</span> : <span className="text-muted text-xs">—</span>;
                      })()}
                    </td>
                  </tr>
                  {open && members.map((m, i) => renderRow(m, true, i === members.length - 1))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );

  function renderRow(r: CascadeRow, inGroup = false, lastInGroup = false) {
    const k = keyOf(r);
    const lineNotes = notes[k] ?? []; // cascade key IS bom|mo|item
    // frame: open groups get a clear border so their extent is obvious
    const frame = inGroup ? `bg-brand-light/10 border-x-2 border-brand ${lastInGroup ? "border-b-2" : ""}` : "";
    return (
              <Fragment key={k}>
                <tr className={frame}>
                  <td className="p-2 whitespace-nowrap">
                    {dateEdit === k ? (
                      <span className="inline-flex items-center gap-1">
                        <input
                          type="date"
                          value={dateVal}
                          autoFocus
                          onChange={(e) => setDateVal(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveDate(r);
                            if (e.key === "Escape") setDateEdit(null);
                          }}
                          className="border rounded-md px-1 py-0.5 text-xs bg-surface"
                          disabled={pending}
                        />
                        <input
                          type="number"
                          min={1}
                          max={r.available}
                          value={dateQty}
                          onChange={(e) => setDateQty(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveDate(r);
                            if (e.key === "Escape") setDateEdit(null);
                          }}
                          className="w-14 border rounded-md px-1 py-0.5 text-center text-xs font-bold tabnum bg-surface"
                          disabled={pending}
                          title={`How many pieces get this date (up to ${r.available}) — the rest stays here`}
                        />
                        <span className="text-[10px] text-muted tabnum">/{r.available}</span>
                        <button type="button" onClick={() => saveDate(r)} disabled={pending} className="text-ok-fg font-extrabold px-0.5" title="Save — that quantity moves to the dated tables, the rest stays here">✓</button>
                        <button type="button" onClick={() => setDateEdit(null)} disabled={pending} className="text-muted px-0.5" title="Cancel">✕</button>
                      </span>
                    ) : (
                      <>
                        {r.deliveryISO ? (
                          <span className={`pill ${r.deliveryISO < day ? "pill-bad" : r.deliveryISO === day ? "pill-warn" : "pill-ok"}`}>
                            📅 {ddmm(r.deliveryISO)}
                          </span>
                        ) : (
                          <span className="pill pill-muted">—</span>
                        )}
                        {isAdmin && allowDate && !r.deliveryISO && (
                          <button
                            type="button"
                            onClick={() => { setDateEdit(k); setDateVal(day); setDateQty(String(r.available)); }}
                            disabled={pending}
                            className="text-muted text-xs px-1 hover:text-brand-ink align-middle"
                            title="Schedule (part of) this line: pick a date and a quantity — repeat for more dates; the rest stays here"
                          >
                            📅✎
                          </button>
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
                      </>
                    )}
                  </td>
                  <td className={`p-2 text-xs font-semibold whitespace-nowrap ${inGroup ? "pl-6" : ""}`}>
                    {inGroup && <span className="text-muted mr-1">↳</span>}
                    {r.mo}
                  </td>
                  <td className="p-2 font-bold whitespace-nowrap">{r.bom}</td>
                  <td className="p-2 text-xs text-muted whitespace-nowrap">
                    {r.description}
                    {r.remark && (
                      <div className="text-[11px] font-semibold text-warn-fg whitespace-normal max-w-64" title="Weekly plan remark — the reason this date-less line is on the worklist">
                        📝 {r.remark}
                      </div>
                    )}
                  </td>
                  <td className="p-2 text-center font-bold">{r.item}</td>
                  <td className="p-2 text-center">
                    <Frac num={r.done} den={r.target} />
                  </td>
                  <td className="p-2 text-center font-extrabold tabnum" style={{ color: "var(--warn-fg)" }}>{r.available}</td>
                  <td className="p-2">
                    {!canEdit ? (
                      <span className="text-muted text-xs" title="View only — you don't have the Cut edit permission">—</span>
                    ) : (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min={1}
                        placeholder="qty"
                        value={qty[k] ?? ""}
                        onChange={(e) => setQty((s) => ({ ...s, [k]: e.target.value }))}
                        onKeyDown={(e) => e.key === "Enter" && save(r)}
                        className="w-16 border rounded-md px-1.5 py-1 text-center font-bold tabnum"
                        disabled={pending}
                      />
                      <button
                        type="button"
                        onClick={() => save(r)}
                        disabled={pending}
                        className={`rounded-md px-2.5 py-1 text-xs font-bold text-white transition-colors ${savedFlash[k] ? "bg-ok-fill" : "bg-brand-fill hover:bg-brand-dark"} disabled:opacity-50`}
                      >
                        {savedFlash[k] ? "✓ Saved" : "Save"}
                      </button>
                    </div>
                    )}
                    {msg[k] && <div className="text-[11px] text-bad-fg mt-0.5">{msg[k]}</div>}
                  </td>
                  {hasMachines && (
                    <td className="p-2 whitespace-nowrap">
                      <MachinePick dept={dept} bom={r.bom} mo={r.mo} item={r.item} machines={machines} current={assigned[k]} canEdit={canEdit} compact />
                    </td>
                  )}
                  <td className="p-2 text-center whitespace-nowrap">
                    <NotesButton lineNotes={lineNotes} onClick={() => setOpenNotes(openNotes === k ? null : k)} />
                  </td>
                </tr>
                {openNotes === k && (
                  <NotesPanelRow
                    bom={r.bom}
                    mo={r.mo}
                    item={r.item}
                    dept={dept}
                    lineNotes={lineNotes}
                    canEdit={canEdit}
                    onClose={() => setOpenNotes(null)}
                  />
                )}
              </Fragment>
    );
  }
}
