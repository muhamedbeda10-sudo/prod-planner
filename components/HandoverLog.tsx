"use client";

import { Pencil, Trash2 } from "lucide-react";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateHandover, deleteHandover, bulkDeleteHandover, bulkSetHandoverDate } from "@/app/handover/actions";
import { toISODate } from "@/lib/domain/dates";
import type { SoiLookup } from "@/lib/server/soi";
import { ExportButton } from "@/components/ExportButton";
import { Soi, soiOf } from "@/components/ui";
import { SearchBox, SelectFilter, FilterBar, useSavedFilter } from "@/components/FilterControls";
import { DateSlicer } from "@/components/DateSlicer";
import { addDaysISO, slicerPresets } from "@/lib/domain/dateSlicer";
import { ITEMS, DEPTS, SHOTBLAST_STAGE, DELIVERED_STAGE, deptLabel } from "@/lib/domain/constants";
import { LV_CHAIN, LV_ITEM } from "@/lib/domain/lv";
import type { ProductLine } from "@/lib/domain/lines";

// every ledger stage the log can carry — production depts + tracker-only stages
const LOG_DEPTS = [...DEPTS, SHOTBLAST_STAGE, DELIVERED_STAGE];

// A calendar day (UTC) offset from today — the log's exact-day presets.
// 0 = today (what has been recorded so far), -1 = yesterday (the day the Daily
// Report opens on by default, so both screens agree).
function dayISO(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

export interface LogRow {
  id: number;
  date: string; // ISO
  dept: string;
  bom: string;
  bomRaw: string | null;
  mo: string | null;
  item: string;
  qty: number;
  source: string;
  createdBy: string | null; // who recorded the change (worklist / tracker / manual)
  flags?: string[] | null; // data-guard warnings — the row LOOKS wrong, check it
}

export function HandoverLog({ rows, editableDepts = [], soi, viewTabs, line = "TR" }: {
  rows: LogRow[];
  editableDepts?: string[];
  /** Whose log this is — the transformers' departments and components, or the panels' stages. */
  line?: ProductLine;
  soi?: SoiLookup;
  /** The tab's view switcher (Tracker / Daily log) — it rides in the filter
   *  bar, since the log is sized to fill the screen. */
  viewTabs?: React.ReactNode;
}) {
  const canEditRow = (r: LogRow) => editableDepts.includes(r.dept);
  const router = useRouter();
  const [editing, setEditing] = useState<number | null>(null);
  const [qty, setQty] = useState("");
  const [date, setDate] = useState("");
  const [rowErr, setRowErr] = useState<Record<number, string>>({});
  const [pending, startTransition] = useTransition();

  // bulk actions: tick rows, then re-date them all or delete them all
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkDate, setBulkDate] = useState("");
  const [bulkMsg, setBulkMsg] = useState("");

  // filters — survive navigating away and back (sessionStorage per tab)
  const [q, setQ] = useSavedFilter("log.q");
  const [dept, setDept] = useSavedFilter("log.dept");
  const [item, setItem] = useSavedFilter("log.item");
  const [from, setFrom] = useSavedFilter("log.from");
  const [to, setTo] = useSavedFilter("log.to");
  // default window: the log opens on the LAST 3 recorded days, not everything —
  // presets and the custom range below widen it
  const [period, setPeriod] = useSavedFilter("log.period", "3");
  const [flaggedOnly, setFlaggedOnly] = useSavedFilter("log.flagged");
  // today, computed once (impure Date only in the lazy initializer)
  const [tISO] = useState(() => dayISO(0));
  // the days on screen: a range picked on the slicer, else the saved quick
  // window ("t" today, "y" yesterday, or the last N days — 3 by default)
  const range = useMemo(() => {
    if (from || to) return { from: from || to, to: to || from };
    if (period === "t") return { from: tISO, to: tISO };
    if (period === "y") { const y = addDaysISO(tISO, -1); return { from: y, to: y }; }
    return { from: addDaysISO(tISO, -((Number(period) || 3) - 1)), to: tISO };
  }, [from, to, period, tISO]);
  const pickRange = (f: string | null, t: string | null) => { setFrom(f ?? ""); setTo(t ?? ""); setPeriod(""); };
  const loggedDays = useMemo(() => [...new Set(rows.map((r) => r.date))].sort(), [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return rows.filter((r) => {
      if (flaggedOnly && !r.flags?.length) return false;
      if (needle && !r.bom.toUpperCase().includes(needle)) return false;
      if (dept && r.dept !== dept) return false;
      if (item && r.item !== item) return false;
      if (r.date < range.from || r.date > range.to) return false;
      return true;
    });
  }, [rows, q, dept, item, range, flaggedOnly]);

  // the flag count ignores the flagged-only toggle itself (else clicking it
  // could change its own label) but respects every other filter
  const flaggedCount = useMemo(
    () => rows.filter((r) => r.flags?.length && (!dept || r.dept === dept) && (!item || r.item === item)).length,
    [rows, dept, item]
  );

  const hasActive = !!(q || dept || item || from || to || period !== "3" || flaggedOnly);
  const reset = () => { setQ(""); setDept(""); setItem(""); setFrom(""); setTo(""); setPeriod("3"); setFlaggedOnly(""); };

  // only VISIBLE selected rows count (hiding a row by filtering un-selects it
  // effectively — nothing off-screen ever gets re-dated by surprise)
  const editableVisible = useMemo(() => filtered.filter((r) => canEditRow(r)), [filtered, editableDepts]); // eslint-disable-line react-hooks/exhaustive-deps
  const selectedVisible = useMemo(() => editableVisible.filter((r) => selected.has(r.id)).map((r) => r.id), [editableVisible, selected]);
  const allVisibleSelected = editableVisible.length > 0 && selectedVisible.length === editableVisible.length;

  // shift-click ticks everything between the last tick and this one — thirty
  // rows of one wrong import are a range, not thirty clicks
  const lastTicked = useRef<number | null>(null);
  const toggleRow = (id: number, shift = false) => {
    const anchor = lastTicked.current;
    lastTicked.current = id;
    setSelected((s) => {
      const n = new Set(s);
      if (shift && anchor !== null && anchor !== id) {
        const order = editableVisible.map((r) => r.id);
        const a = order.indexOf(anchor);
        const b = order.indexOf(id);
        if (a >= 0 && b >= 0) {
          const on = !n.has(id); // the clicked row decides: tick the range, or clear it
          for (const rid of order.slice(Math.min(a, b), Math.max(a, b) + 1)) {
            if (on) n.add(rid);
            else n.delete(rid);
          }
          return n;
        }
      }
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  const toggleAll = () =>
    setSelected(allVisibleSelected ? new Set() : new Set(editableVisible.map((r) => r.id)));

  /** Delete every ticked row in one go. The server judges the batch as a
   *  batch, so rows that only break the chain individually (a cut row and the
   *  weld row it fed) go together; anything it refuses leaves all of them. */
  function deleteSelected() {
    const n = selectedVisible.length;
    if (n === 0) return;
    if (!confirm(`Delete ${n} record${n === 1 ? "" : "s"} permanently?\n\nTheir quantities return to the pending balance on every screen. This cannot be undone.`)) return;
    const fd = new FormData();
    fd.set("ids", selectedVisible.join(","));
    setBulkMsg("");
    startTransition(async () => {
      const r = await bulkDeleteHandover(fd);
      if (r.ok) {
        setSelected(new Set());
        router.refresh();
      } else {
        setBulkMsg(r.error ?? "Failed");
      }
    });
  }

  function applyBulkDate() {
    if (!bulkDate || selectedVisible.length === 0) return;
    if (!confirm(`Change the date of ${selectedVisible.length} record(s) to ${bulkDate}?`)) return;
    const fd = new FormData();
    fd.set("ids", selectedVisible.join(","));
    fd.set("date", bulkDate);
    setBulkMsg("");
    startTransition(async () => {
      const r = await bulkSetHandoverDate(fd);
      if (r.ok) {
        setSelected(new Set());
        setBulkDate("");
        router.refresh();
      } else {
        setBulkMsg(r.error ?? "Failed");
      }
    });
  }

  const exportRows = filtered.map((r) => ({
    Date: r.date,
    DEPT: deptLabel(r.dept),
    BOM: r.bom,
    MO: r.mo ?? "",
    SOI: soiOf(soi, r.mo, r.bom) ?? "",
    Item: r.item,
    QTY: r.qty,
    Source: r.source,
    By: r.createdBy ?? "",
    "Corrected From": r.bomRaw && r.bomRaw !== r.bom ? r.bomRaw : "",
    "Check ⚠": r.flags?.join(" | ") ?? "",
  }));

  function save(id: number) {
    const fd = new FormData();
    fd.set("id", String(id));
    fd.set("qty", qty);
    fd.set("date", date);
    startTransition(async () => {
      const r = await updateHandover(fd);
      if (r.ok) {
        setEditing(null);
        setRowErr((s) => ({ ...s, [id]: "" }));
        router.refresh();
      } else {
        setRowErr((s) => ({ ...s, [id]: r.error ?? "Failed" }));
      }
    });
  }
  function remove(id: number) {
    if (!confirm("Delete this record permanently? Its quantity will return to the pending balance on every screen.")) return;
    const fd = new FormData();
    fd.set("id", String(id));
    startTransition(async () => {
      const r = await deleteHandover(fd);
      if (r.ok) {
        setRowErr((s) => ({ ...s, [id]: "" }));
        router.refresh();
      } else {
        setRowErr((s) => ({ ...s, [id]: r.error ?? "Failed" }));
      }
    });
  }

  return (
    <>
      <FilterBar count={filtered.length} total={rows.length} onReset={reset} hasActive={hasActive}>
        {viewTabs}
        <SearchBox value={q} onChange={setQ} placeholder="Search BOM…" />
        <SelectFilter label={line === "LV" ? "Stage" : "Dept"} value={dept} onChange={setDept} options={(line === "LV" ? [...LV_CHAIN] : LOG_DEPTS).map((d) => ({ value: d, label: deptLabel(d) }))} />
        {line !== "LV" && <SelectFilter label="Item" value={item} onChange={setItem} options={ITEMS.map((i) => ({ value: i, label: i }))} />}
        {flaggedCount > 0 && (
          <button
            type="button"
            onClick={() => setFlaggedOnly(flaggedOnly ? "" : "1")}
            title="Rows the data guard wants a human to check — unusual quantity, exact duplicate, or recorded far from the work date"
            className={`btn btn-sm justify-self-start ${flaggedOnly ? "btn-primary" : "btn-secondary"}`}
          >
            ⚠ <span className="tabnum">{flaggedCount}</span> to check
          </button>
        )}
        <ExportButton rows={exportRows} filename={`daily-handover.xlsx`} sheetName="Daily HandOver" />
      </FilterBar>
      <div className="mb-3">
        <DateSlicer
          mode="range" from={range.from} to={range.to} min={[loggedDays[0] ?? tISO, addDaysISO(tISO, -60)].sort()[0]} max={tISO}
          presets={slicerPresets(["today", "yesterday", "last3", "last7", "thisMonth", "lastMonth", "last30"], tISO)}
          marks={loggedDays} onChange={pickRange}
        />
      </div>

      {/* bulk re-date bar — appears once rows are ticked */}
      {selectedVisible.length > 0 && (
        <div className="no-print flex flex-wrap items-center gap-2.5 bg-brand-light/70 border rounded-xl px-3.5 py-2.5 mb-3 text-sm" style={{ borderColor: "color-mix(in srgb, var(--brand) 40%, transparent)" }}>
          <b className="tabnum">{selectedVisible.length}</b> record{selectedVisible.length === 1 ? "" : "s"} selected
          <label className="inline-flex items-center gap-1.5">
            <span className="text-muted text-[11px] font-bold uppercase tracking-wide">New date</span>
            <input type="date" value={bulkDate} onChange={(e) => setBulkDate(e.target.value)} className="border rounded-md px-2 py-1.5 text-sm bg-surface" disabled={pending} />
          </label>
          <button type="button" onClick={applyBulkDate} disabled={pending || !bulkDate} className="btn btn-primary btn-sm">
            {pending ? "Applying…" : "Apply to all"}
          </button>
          <button type="button" onClick={() => { setSelected(new Set()); setBulkMsg(""); }} className="btn btn-ghost btn-sm">
            Clear selection
          </button>
          {/* the one destructive button on the bar sits apart from the date
              controls, so a stray click lands on nothing */}
          <button
            type="button"
            onClick={deleteSelected}
            disabled={pending}
            className="btn btn-sm btn-danger ms-auto"
            title="Delete the ticked records permanently — their quantities return to the pending balance everywhere"
          >
            🗑 Delete {selectedVisible.length} selected
          </button>
          {bulkMsg && <span className="order-last w-full text-xs font-semibold text-bad-fg">{bulkMsg}</span>}
        </div>
      )}

      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand-fill text-white text-left">
              <th className="p-2 no-print w-8 text-center">
                {editableVisible.length > 0 && (
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                    title="Select all visible rows you can edit"
                    className="cursor-pointer"
                  />
                )}
              </th>
              <th className="p-2">Date</th>
              <th className="p-2">Dept</th>
              <th className="p-2">BOM</th>
              <th className="p-2">MO</th>
              <th className="p-2" title="Sales order item">SOI</th>
              <th className="p-2 text-center">Item</th>
              <th className="p-2 text-center">Qty</th>
              <th className="p-2">Source</th>
              <th className="p-2">By</th>
              <th className="p-2 no-print"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={11} className="p-4 text-center text-muted">
                {rows.length === 0 ? "No records." : "No rows match the filters."}
              </td></tr>
            )}
            {filtered.map((r, i) => (
              <tr key={r.id} className={`${i % 2 ? "bg-zebra" : ""} ${selected.has(r.id) ? "!bg-brand-light/50" : ""}`}>
                <td className="p-2 no-print text-center">
                  {canEditRow(r) && (
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      // the shift key rides on the click behind the change —
                      // preventing the click instead would leave React's
                      // controlled box out of step with the range
                      onChange={(e) => toggleRow(r.id, (e.nativeEvent as MouseEvent).shiftKey)}
                      title="Tick to select · Shift-click to select a range"
                      className="cursor-pointer"
                    />
                  )}
                </td>
                <td className="p-2 whitespace-nowrap">
                  {editing === r.id ? (
                    <input type="date" defaultValue={r.date} onChange={(e) => setDate(e.target.value)} className="border rounded px-1 py-0.5 text-xs" />
                  ) : (
                    r.date
                  )}
                </td>
                <td className="p-2">{deptLabel(r.dept)}</td>
                <td className="p-2 font-bold whitespace-nowrap">
                  {r.bom}
                  {r.bomRaw && r.bomRaw !== r.bom && (
                    <span className="pill pill-ok ml-1" title={`corrected from ${r.bomRaw}`}>fixed</span>
                  )}
                  {!!r.flags?.length && (
                    <span className="pill pill-warn ml-1 cursor-help" title={r.flags.join("\n")}>
                      ⚠ check
                    </span>
                  )}
                </td>
                <td className="p-2 text-xs whitespace-nowrap text-muted">{r.mo ?? "—"}</td>
                <td className="p-2 whitespace-nowrap"><Soi soi={soiOf(soi, r.mo, r.bom)} /></td>
                <td className="p-2 text-center font-bold">{r.item === LV_ITEM ? <span title="An LV panel — one item through its stages">Panel</span> : r.item}</td>
                <td className="p-2 text-center font-bold tabnum">
                  {editing === r.id ? (
                    <input type="number" min={0} defaultValue={r.qty} onChange={(e) => setQty(e.target.value)} className="w-16 border rounded px-1 py-0.5" autoFocus />
                  ) : (
                    r.qty
                  )}
                </td>
                <td className="p-2 text-xs text-muted">{r.source}</td>
                <td className="p-2 text-xs whitespace-nowrap">{r.createdBy ?? <span className="text-muted">—</span>}</td>
                <td className="p-2 no-print text-right">
                  <span className="whitespace-nowrap">
                    {editing === r.id ? (
                      <span className="inline-flex items-center gap-1">
                        <button type="button" onClick={() => save(r.id)} disabled={pending} className="btn btn-primary btn-sm">Save</button>
                        <button type="button" onClick={() => { setEditing(null); setRowErr((s) => ({ ...s, [r.id]: "" })); }} className="btn btn-ghost btn-sm">Cancel</button>
                      </span>
                    ) : canEditRow(r) ? (
                      <span className="inline-flex items-center gap-0.5">
                        <button type="button" onClick={() => { setEditing(r.id); setQty(String(r.qty)); setDate(r.date); }} className="icon-btn" title="Edit" aria-label="Edit this entry"><Pencil size={14} /></button>
                        <button type="button" onClick={() => remove(r.id)} disabled={pending} className="icon-btn icon-btn-danger" title="Delete" aria-label="Delete this entry"><Trash2 size={14} /></button>
                      </span>
                    ) : null}
                  </span>
                  {rowErr[r.id] && <div className="text-[11px] text-bad-fg mt-0.5 max-w-72 whitespace-normal text-left">{rowErr[r.id]}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export { toISODate };
