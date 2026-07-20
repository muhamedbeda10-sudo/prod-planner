"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CutTranche } from "@/lib/domain/execution";
import type { QueueNoteDTO } from "@/lib/server/queueNotes";
import { recordOutput, setWorklistDate, clearWorklistDate } from "@/app/worklist/actions";
import { SearchBox, FilterBar } from "@/components/FilterControls";
import { NotesButton, NotesPanelRow } from "@/components/QueueNotes";
import { Frac } from "@/components/Frac";
import { DEFAULTS } from "@/lib/domain/constants";
import { assessDeliveryRisk } from "@/lib/domain/insights";

function ddmm(iso: string) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

export function CutTrancheTable({
  rows,
  day,
  planNo,
  variant, // "due" = due today · "overdue" = missed dates (red date badge)
  hideFilter = false, // the cut page has ONE shared filter above all tables
  notes = {},
  capacity = DEFAULTS.capacityPerItem,
  canEdit = false,
  isAdmin = false,
}: {
  rows: CutTranche[];
  day: string;
  planNo: number;
  variant: "due" | "overdue";
  hideFilter?: boolean;
  notes?: Record<string, QueueNoteDTO[]>; // keyed by bom|mo|item
  capacity?: number; // pcs/item/working day — feeds the at-risk early warning
  canEdit?: boolean; // user holds cut.edit — otherwise view-only
  isAdmin?: boolean; // admins may re-date a line / revert their override
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [savedFlash, setSavedFlash] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");
  const [openNotes, setOpenNotes] = useState<string | null>(null); // per tranche row key
  const [dateEdit, setDateEdit] = useState<string | null>(null); // row key being re-dated (admin)
  const [dateVal, setDateVal] = useState("");

  // admin: move this row's promise to a new delivery date (override on top of
  // the plan — the plan itself is untouched, so revert always works)
  function saveDate(r: CutTranche) {
    const fd = new FormData();
    fd.set("bom", r.bom);
    fd.set("mo", r.mo);
    fd.set("item", r.item);
    fd.set("origISO", r.overrideOrigISO ?? r.deliveryISO); // keep the TRUE original as the key
    fd.set("date", dateVal);
    startTransition(async () => {
      const res = await setWorklistDate(fd);
      if (res.ok) {
        setDateEdit(null);
        router.refresh();
      } else {
        setMsg((s) => ({ ...s, [keyOf(r)]: res.error ?? "Failed" }));
      }
    });
  }

  // admin: back to the original plan date — or back to date-less ("" origin)
  function revertDate(r: CutTranche) {
    if (r.overrideOrigISO === undefined) return;
    const fd = new FormData();
    fd.set("bom", r.bom);
    fd.set("mo", r.mo);
    fd.set("item", r.item);
    fd.set("origISO", r.overrideOrigISO);
    startTransition(async () => {
      const res = await clearWorklistDate(fd);
      if (res.ok) router.refresh();
      else setMsg((s) => ({ ...s, [keyOf(r)]: res.error ?? "Failed" }));
    });
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    if (!needle) return rows;
    return rows.filter((r) => `${r.bom} ${r.mo} ${r.description}`.toUpperCase().includes(needle));
  }, [rows, q]);

  const keyOf = (r: CutTranche) => `${r.bom}|${r.mo}|${r.item}|${r.deliveryISO}`;
  const totalRemaining = filtered.reduce((s, r) => s + r.remaining, 0);

  // shared BOMs: one summary row per BOM × item, expandable to its MO tranches
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (gk: string) =>
    setOpenGroups((s) => {
      const n = new Set(s);
      if (n.has(gk)) n.delete(gk);
      else n.add(gk);
      return n;
    });
  const groups = useMemo(() => {
    const map = new Map<string, CutTranche[]>();
    for (const r of filtered) {
      const gk = `${r.bom}|${r.item}`;
      if (!map.has(gk)) map.set(gk, []);
      map.get(gk)!.push(r);
    }
    return [...map.entries()];
  }, [filtered]);

  function save(r: CutTranche) {
    const k = keyOf(r);
    const n = Number(qty[k]);
    if (!qty[k] || !Number.isFinite(n) || n <= 0) {
      setMsg((s) => ({ ...s, [k]: "Enter a quantity > 0" }));
      return;
    }
    const fd = new FormData();
    fd.set("date", day);
    fd.set("dept", "Cut");
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

  // showOrder: inside a group the same MO may have several tranche rows — its
  // whole-order fraction is printed once (first row) so the group header's
  // per-MO total visibly matches the sum of the rows.
  const renderRow = (r: CutTranche, inGroup = false, lastInGroup = false, showOrder = true) => {
    const k = keyOf(r);
    const noteKey = `${r.bom}|${r.mo}|${r.item}`;
    const lineNotes = notes[noteKey] ?? [];
    // early warning (due lines only): more pieces remain than one day of
    // capacity can cut — this line will join the overdue list unless split
    const atRisk =
      variant === "due" &&
      assessDeliveryRisk({ dueISO: r.cutDueISO, dueQty: r.remaining }, day, capacity) === "at-risk";
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
              <button type="button" onClick={() => saveDate(r)} disabled={pending} className="text-ok-fg font-extrabold px-0.5" title="Save the new delivery date">✓</button>
              <button type="button" onClick={() => setDateEdit(null)} disabled={pending} className="text-muted px-0.5" title="Cancel">✕</button>
            </span>
          ) : (
            <>
              <span className={`pill ${variant === "overdue" ? "pill-bad" : "pill-ok"}`}>
                📅 {ddmm(r.deliveryISO)}
              </span>
              {r.overrideOrigISO !== undefined && (
                <span
                  className="pill pill-warn ml-1"
                  title={r.overrideOrigISO ? `Re-dated by admin — original date ${ddmm(r.overrideOrigISO)}` : "Dated by admin — this line had no date"}
                >
                  ✎
                </span>
              )}
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => { setDateEdit(k); setDateVal(r.deliveryISO); }}
                  disabled={pending}
                  className="text-muted text-xs px-1 hover:text-accent align-middle"
                  title="Change this line's delivery date (admin)"
                >
                  📅✎
                </button>
              )}
              {isAdmin && r.overrideOrigISO !== undefined && (
                <button
                  type="button"
                  onClick={() => revertDate(r)}
                  disabled={pending}
                  className="text-muted text-xs px-1 hover:text-accent align-middle"
                  title={r.overrideOrigISO ? `Back to the original date (${ddmm(r.overrideOrigISO)})` : "Back to date-less (this line had no date)"}
                >
                  ↩
                </button>
              )}
            </>
          )}
          {atRisk && (
            <span
              className="pill pill-bad ml-1"
              title={`Likely to slip: ${r.remaining} pcs remaining exceeds one day of capacity (${capacity}/item)`}
            >
              ⚠ at risk
            </span>
          )}
        </td>
        <td className={`p-2 text-xs font-semibold whitespace-nowrap ${inGroup ? "pl-6" : ""}`}>
          {inGroup && <span className="text-muted mr-1">↳</span>}
          {r.mo}
        </td>
        <td className="p-2 font-bold whitespace-nowrap">{r.bom}</td>
        <td className="p-2 text-xs text-muted whitespace-nowrap">{r.description}</td>
        <td className="p-2 text-center font-bold">{r.item}</td>
        <td className="p-2 text-center">
          {showOrder ? (
            <Frac num={r.deptDone ?? 0} den={r.orderQty ?? null} />
          ) : (
            <span className="text-muted text-xs" title="Same MO as the row above — its order total is counted once">〃</span>
          )}
        </td>
        <td className="p-2 text-center">
          <Frac num={r.remaining} den={r.qty} color={r.remaining <= 0 ? "var(--ok-fg)" : variant === "overdue" ? "var(--bad-fg)" : "var(--warn-fg)"} />
        </td>
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
              className={`rounded-md px-2.5 py-1 text-xs font-bold text-white transition-colors ${savedFlash[k] ? "bg-ok-fg" : "bg-brand hover:bg-brand-dark"} disabled:opacity-50`}
            >
              {savedFlash[k] ? "✓ Saved" : "Save"}
            </button>
          </div>
          )}
          {msg[k] && <div className="text-[11px] text-bad-fg mt-0.5">{msg[k]}</div>}
        </td>
        <td className="p-2 text-center whitespace-nowrap">
          <NotesButton lineNotes={lineNotes} onClick={() => setOpenNotes(openNotes === k ? null : k)} />
        </td>
      </tr>
      {openNotes === k && (
        <NotesPanelRow
          bom={r.bom}
          mo={r.mo}
          item={r.item}
          dept="Cut"
          lineNotes={lineNotes}
          colSpan={9}
          className={inGroup ? "border-x-2 border-brand" : ""}
          canEdit={canEdit}
        />
      )}
      </Fragment>
    );
  };

  return (
    <>
      {!hideFilter && (
        <FilterBar count={filtered.length} total={rows.length} onReset={() => setQ("")} hasActive={!!q}>
          <SearchBox value={q} onChange={setQ} placeholder="Search MO / BOM…" />
          <span className="text-xs text-muted">
            Remaining (shown): <b className="text-foreground tabnum">{totalRemaining}</b> pcs
          </span>
        </FilterBar>
      )}

      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className={`${variant === "overdue" ? "bg-bad-fg" : "bg-brand"} text-white text-left`}>
              <th className="p-2">{variant === "overdue" ? "Was due" : "Deliver on"}</th>
              <th className="p-2">MO</th>
              <th className="p-2">BOM</th>
              <th className="p-2">Description</th>
              <th className="p-2 text-center">Item</th>
              <th className="p-2 text-center" title="Whole order: cut so far / order qty">Done / Order</th>
              <th className="p-2 text-center" title="This date: still to cut / planned for the day">Left / Day plan</th>
              <th className="p-2 text-center w-44">Record cut</th>
              <th className="p-2 text-center">Notes</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={9} className="p-4 text-center text-muted">
                {rows.length === 0
                  ? variant === "overdue"
                    ? "No overdue backlog — nothing slipped 🎉"
                    : "Nothing scheduled for today."
                  : "No lines match the search."}
              </td></tr>
            )}
            {groups.map(([gk, members]) => {
              if (members.length === 1) return renderRow(members[0]);
              const open = openGroups.has(gk);
              const [gBom, gItem] = gk.split("|");
              const moCount = new Set(members.map((m) => m.mo)).size;
              const minDel = members.map((m) => m.deliveryISO).sort()[0];
              const gDesc = members.find((m) => m.description)?.description ?? "";
              const sumQty = members.reduce((s, r) => s + r.qty, 0);
              const sumRem = members.reduce((s, r) => s + r.remaining, 0);
              // whole-order fraction: count each MO once (an MO may have several tranches here)
              const perMo = new Map(members.map((m) => [m.mo, m]));
              const gDone = [...perMo.values()].reduce((s, m) => s + (m.deptDone ?? 0), 0);
              const gOrder = [...perMo.values()].reduce((s, m) => s + (m.orderQty ?? 0), 0);
              return (
                <Fragment key={`g|${gk}`}>
                  <tr
                    className={`cursor-pointer bg-brand-light/30 hover:bg-brand-light/60 transition-colors font-semibold ${open ? "border-x-2 border-t-2 border-brand" : ""}`}
                    onClick={() => toggleGroup(gk)}
                    title={open ? "Collapse MOs" : "Show the MOs inside this BOM"}
                  >
                    <td className="p-2 whitespace-nowrap">
                      <span className={`pill ${variant === "overdue" ? "pill-bad" : "pill-ok"}`}>📅 {ddmm(minDel)}</span>
                    </td>
                    <td className="p-2 text-xs font-bold whitespace-nowrap">
                      <span className={`inline-block mr-1 transition-transform duration-150 ${open ? "rotate-90" : ""}`}>▶</span>
                      {moCount} MO{moCount > 1 ? "s" : ""} · {members.length} lines
                    </td>
                    <td className="p-2 font-bold whitespace-nowrap">{gBom}</td>
                    <td className="p-2 text-xs text-muted whitespace-nowrap">{gDesc}</td>
                    <td className="p-2 text-center font-bold">{gItem}</td>
                    <td className="p-2 text-center">
                      <Frac num={gDone} den={gOrder > 0 ? gOrder : null} />
                    </td>
                    <td className="p-2 text-center">
                      <Frac num={sumRem} den={sumQty} color={sumRem <= 0 ? "var(--ok-fg)" : variant === "overdue" ? "var(--bad-fg)" : "var(--warn-fg)"} />
                    </td>
                    <td className="p-2 text-center text-xs text-muted whitespace-nowrap">{open ? "▲ collapse" : "▼ open MOs"}</td>
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
                  {open && members.map((m, i) => renderRow(m, true, i === members.length - 1, members.findIndex((x) => x.mo === m.mo) === i))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
