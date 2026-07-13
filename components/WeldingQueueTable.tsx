"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { WeldQueueRow } from "@/lib/domain/execution";
import type { QueueNoteDTO } from "@/lib/server/queueNotes";
import { recordOutput, addQueueNote, setQueueNoteStatus } from "@/app/worklist/actions";
import { Num } from "@/components/ui";
import { SearchBox, SelectFilter, FilterBar } from "@/components/FilterControls";
import { PrintButton } from "@/components/PrintButton";
import { ITEMS } from "@/lib/domain/constants";

function ddmm(iso: string) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

export function WeldingQueueTable({
  rows,
  day,
  dept = "Welding",
  upstream = "Cut",
  notes = {},
}: {
  rows: WeldQueueRow[];
  day: string;
  dept?: "Welding" | "Painting";
  upstream?: string;
  notes?: Record<string, QueueNoteDTO[]>; // keyed by bom|mo|item
}) {
  const verb = dept === "Welding" ? "weld" : "paint";
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [savedFlash, setSavedFlash] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");
  const [item, setItem] = useState("");
  const [openNotes, setOpenNotes] = useState<string | null>(null); // note panel per line (bom|mo|item)
  const [noteMsg, setNoteMsg] = useState("");

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
    startTransition(async () => {
      await setQueueNoteStatus(fd);
      router.refresh();
    });
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return rows.filter(
      (r) =>
        (!needle || `${r.bom} ${r.mo} ${r.description}`.toUpperCase().includes(needle)) &&
        (!item || r.item === item)
    );
  }, [rows, q, item]);

  const keyOf = (r: WeldQueueRow) => `${r.planNo}|${r.bom}|${r.mo}|${r.item}`;
  const totalAvailable = filtered.reduce((s, r) => s + r.available, 0);
  const plansShown = new Set(rows.map((r) => r.planNo));
  const cols = plansShown.size > 1 ? 14 : 13;

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
      setMsg((s) => ({ ...s, [k]: `Only ${r.available} available from ${upstream}` }));
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

  const renderRow = (r: WeldQueueRow, inGroup = false, lastInGroup = false) => {
    const k = keyOf(r);
    const cleared = r.available === 0;
    const overdue = !!r.dueISO && r.dueISO < day;
    const dueToday = r.dueISO === day;
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
          </td>
          <td className={`p-2 text-xs font-semibold whitespace-nowrap ${inGroup ? "pl-6" : ""}`}>
            {inGroup && <span className="text-muted mr-1">↳</span>}
            {r.mo || "—"}
          </td>
          <td className="p-2 font-bold whitespace-nowrap">{r.bom}</td>
          <td className="p-2 text-xs text-muted whitespace-nowrap">{r.description}</td>
          {plansShown.size > 1 && <td className="p-2 text-center text-xs tabnum">{r.planNo}</td>}
          <td className="p-2 text-center font-bold">{r.item}</td>
          <td className="p-2 text-center" style={{ background: "var(--cut-tint)" }}><Num v={r.cutToDate} /></td>
          <td className="p-2 text-center" style={{ background: "var(--weld-tint)" }}><Num v={r.weldedToDate} /></td>
          <td className="p-2 text-center"><Num v={r.weldedToday} /></td>
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
            ) : (
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={1}
                  max={r.available}
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
        {openNotes === noteKey && (
          <tr className={inGroup ? "border-x-2 border-brand" : ""}>
            <td colSpan={cols} className="p-3 bg-brand-light/30 border-y">
              <div className="max-w-3xl space-y-2">
                {lineNotes.length === 0 && (
                  <p className="text-xs text-muted">No notes yet on {r.mo || r.bom} {r.item} — write the first one below.</p>
                )}
                {lineNotes.map((n) => (
                  <div key={n.id} className={`bg-surface border rounded-lg p-2.5 ${n.status === "resolved" ? "opacity-60" : ""}`}>
                    <div className="flex items-center gap-2 text-xs mb-1">
                      <span className={`pill ${n.status === "open" ? "pill-warn" : "pill-ok"}`}>
                        {n.status === "open" ? "⚠ open" : "✓ resolved"}
                      </span>
                      <span className="font-semibold">{n.dept}</span>
                      <span className="text-muted tabnum">{n.createdISO}</span>
                      <button
                        type="button"
                        onClick={() => toggleNoteStatus(n.id, n.status === "open" ? "resolved" : "open")}
                        disabled={pending}
                        className="text-accent hover:underline ml-auto"
                      >
                        {n.status === "open" ? "Mark resolved" : "Reopen"}
                      </button>
                    </div>
                    <p className="text-sm whitespace-pre-wrap">{n.text}</p>
                    {n.photos.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-1.5">
                        {n.photos.map((p) => (
                          <a key={p} href={p} target="_blank" rel="noreferrer">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={p} alt="note photo" className="h-16 w-16 object-cover rounded-md border hover:opacity-80" />
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                <form onSubmit={submitNote} className="bg-surface border rounded-lg p-2.5 space-y-2">
                  <input type="hidden" name="bom" value={r.bom} />
                  <input type="hidden" name="mo" value={r.mo} />
                  <input type="hidden" name="item" value={r.item} />
                  <input type="hidden" name="dept" value={dept} />
                  <textarea
                    name="text"
                    required
                    rows={2}
                    placeholder={`What's really going on with ${r.mo || r.bom} ${r.item}? (missing parts, defects, disputed done claim…)`}
                    className="w-full border rounded-md px-2 py-1.5 text-sm bg-surface"
                    disabled={pending}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <input type="file" name="photos" accept="image/*" multiple className="text-xs" disabled={pending} />
                    <button
                      type="submit"
                      disabled={pending}
                      className="ml-auto rounded-md px-3 py-1.5 text-xs font-bold text-white bg-brand hover:bg-brand-dark disabled:opacity-50 transition-colors"
                    >
                      {pending ? "Saving…" : "Save note"}
                    </button>
                  </div>
                  {noteMsg && <div className="text-[11px] text-bad-fg">{noteMsg}</div>}
                </form>
              </div>
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  return (
    <>
      <FilterBar count={filtered.length} total={rows.length} onReset={() => { setQ(""); setItem(""); }} hasActive={!!q || !!item}>
        <SearchBox value={q} onChange={setQ} placeholder="Search MO / BOM…" />
        <SelectFilter
          label="Item"
          value={item}
          onChange={setItem}
          options={ITEMS.map((it) => ({ value: it, label: it }))}
        />
        <span className="text-xs text-muted">
          Available to {verb} (shown): <b className="text-foreground tabnum">{totalAvailable}</b> pcs
        </span>
        <PrintButton />
      </FilterBar>

      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand text-white text-left">
              <th className="p-2">Deliver on</th>
              <th className="p-2">MO</th>
              <th className="p-2">BOM</th>
              <th className="p-2">Description</th>
              {plansShown.size > 1 && <th className="p-2 text-center">Plan</th>}
              <th className="p-2 text-center">Item</th>
              <th className="p-2 text-center">{upstream} (total)</th>
              <th className="p-2 text-center">{dept === "Welding" ? "Welded" : "Painted"}</th>
              <th className="p-2 text-center">Today</th>
              <th className="p-2 text-center">Available</th>
              <th className="p-2 text-center">Waiting</th>
              <th className="p-2 text-center w-44">Record {dept === "Welding" ? "welded" : "painted"}</th>
              <th className="p-2 text-center">Notes</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={cols} className="p-4 text-center text-muted">
                {rows.length === 0 ? "Nothing cut is waiting for welding — the queue is clear." : "No lines match the search."}
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
                    <td className="p-2 text-center font-bold" style={{ background: "var(--cut-tint)" }}><Num v={sum((r) => r.cutToDate)} /></td>
                    <td className="p-2 text-center font-bold" style={{ background: "var(--weld-tint)" }}><Num v={sum((r) => r.weldedToDate)} /></td>
                    <td className="p-2 text-center font-bold"><Num v={sum((r) => r.weldedToday)} /></td>
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
                    <td className="p-2 text-center text-xs text-muted whitespace-nowrap">{open ? "▲ collapse" : "▼ open MOs"}</td>
                    <td className="p-2 text-center whitespace-nowrap">
                      {openNoteCount > 0 ? <span className="pill pill-bad">📝 {openNoteCount}</span> : <span className="text-muted text-xs">—</span>}
                    </td>
                  </tr>
                  {open && members.map((m, i) => renderRow(m, true, i === members.length - 1))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted mt-2">
        This queue is driven purely by {upstream} output — a piece finished upstream today is available immediately, and WIP from previous weeks stays until consumed. You cannot {verb} more than what {upstream} delivered. Shared BOMs show as one row — click it to open the MOs inside.
      </p>
    </>
  );
}
