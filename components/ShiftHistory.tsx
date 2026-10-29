"use client";

import Link from "next/link";
import { CalendarDays, Moon, Pencil, Sun, Trash2, Wrench } from "lucide-react";
import { useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { TableEmpty, TableFrame, Th, useConfirm } from "@/components/DataTable";
import { formatDate } from "@/lib/domain/format";
import { rosterDepts, rosterFilterLabel, type RosterFilter } from "@/lib/domain/roster";
import { type RosterDept } from "@/lib/domain/shifts";
import { WORKER_DEPT_LABEL } from "@/lib/domain/tanks";
import { deleteRecordedShiftDay, deleteRecordedShiftDays } from "@/app/shifts/historyActions";
import type { ShiftHistoryDay } from "@/lib/server/shifts";

type EditView = "attendance" | "downtime";
export function ShiftHistory({ history, dayISO, filter, today, editableDepts, onOpenDay, onDeleted }: {
  history: readonly ShiftHistoryDay[];
  dayISO: string;
  filter: RosterFilter;
  today: string;
  editableDepts: readonly RosterDept[];
  onOpenDay: (view?: EditView) => void;
  onDeleted: (dateISO: string) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [confirm, dialog] = useConfirm();
  const [pending, start] = useTransition();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState("50");
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [deleted, setDeleted] = useState<{ source: typeof history; keys: Set<string> }>(() => ({ source: history, keys: new Set() }));
  const depts = rosterDepts(filter);
  // History totals cover whole departments, including when attendance was narrowed to a subsection.
  const scope = filter && !filter.startsWith("line:") ? `${WORKER_DEPT_LABEL[depts[0]]} (whole department)` : rosterFilterLabel(filter);
  const canDelete = depts.length > 0 && depts.every((d) => editableDepts.includes(d));
  const canEdit = depts.some((d) => editableDepts.includes(d));
  const available = history.filter((h) => deleted.source !== history || !deleted.keys.has(`${filter}|${h.dateISO}`));
  const rows = available.filter((h) => (!from || h.dateISO >= from) && (!to || h.dateISO <= to));
  const size = pageSize === "all" ? Math.max(1, rows.length) : Number(pageSize);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const currentPage = Math.min(page, pages - 1);
  const pageRows = rows.slice(currentPage * size, (currentPage + 1) * size);
  const selected = rows.filter((h) => selection.has(h.dateISO)).map((h) => h.dateISO);
  const selectedOnPage = pageRows.filter((h) => selection.has(h.dateISO)).length;
  const togglePage = () => setSelection((old) => {
    const next = new Set(old);
    for (const h of pageRows) { if (selectedOnPage === pageRows.length) next.delete(h.dateISO); else next.add(h.dateISO); }
    return next;
  });
  const href = (day: string, view: EditView | "history") => `/shifts?${new URLSearchParams({ day, view, ...(filter ? { sec: filter } : {}) })}`;
  const remove = async (dates: string[]) => {
    if (pending || !canDelete || !dates.length) return;
    const multiple = dates.length > 1;
    const sorted = [...dates].sort();
    if (!(await confirm({ title: multiple ? `Delete ${dates.length} recorded days?` : `Delete ${formatDate(dates[0])}?`, body: <><p>This permanently removes attendance, shift notes, machine stops and man-hour totals for {multiple ? "all selected days" : "this day"} in the departments below. Production output and worker profiles stay in place.</p><p className="mt-2 font-semibold">{depts.map((d) => WORKER_DEPT_LABEL[d]).join(" · ")}</p>{multiple && <details className="mt-3"><summary className="cursor-pointer font-semibold">Review {dates.length} dates: {formatDate(sorted[0])} – {formatDate(sorted[sorted.length - 1])}</summary><ul className="mt-2 grid grid-cols-2 gap-1 text-xs">{sorted.map((date) => <li key={date}>{formatDate(date)}</li>)}</ul></details>}</>, confirmLabel: multiple ? `Delete ${dates.length} days and shift data` : "Delete day and shift data", danger: true }))) return;
    setMsg(null);
    start(async () => {
      try {
        const fd = new FormData(); fd.set("depts", depts.join(","));
        if (multiple) fd.set("dates", JSON.stringify(dates)); else fd.set("date", dates[0]);
        const result = await (multiple ? deleteRecordedShiftDays(fd) : deleteRecordedShiftDay(fd));
        if (!result.ok) { setMsg({ ok: false, text: result.error ?? "Could not delete the selected days." }); return; }
        setDeleted((old) => ({ source: history, keys: new Set([...(old.source === history ? old.keys : []), ...dates.map((date) => `${filter}|${date}`)]) }));
        setSelection((old) => new Set([...old].filter((date) => !dates.includes(date))));
        setMsg({ ok: true, text: `Deleted ${multiple ? `${dates.length} days` : formatDate(dates[0])} — ${result.attendance ?? 0} attendance records, ${result.stops ?? 0} machine stops and ${result.totals ?? 0} daily totals.` });
        for (const date of dates) onDeleted(date);
        router.refresh();
      } catch { setMsg({ ok: false, text: "Could not confirm deletion. Refresh the page and check the selected days before trying again." }); }
    });
  };
  return (
    <section aria-label="Recorded shift days" className="space-y-3">
      {dialog}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="!mb-1">Recorded days <span className="text-muted font-normal">· {available.length.toLocaleString("en")}</span></h2><p className="text-xs text-muted">{scope} · all recorded dates · select days to delete together, or edit attendance and machine stops.</p></div>
        <div className="flex flex-wrap items-end gap-2 no-print">
          <label className="text-xs font-semibold text-muted">Scope<select aria-label="History scope" value={filter} disabled={pending} className="block mt-1 ctl" onChange={(e) => { const p = new URLSearchParams(params.toString()); if (e.target.value) p.set("sec", e.target.value); else p.delete("sec"); p.set("view", "history"); router.push(`${pathname}?${p}`); }}><option value="">Everyone</option><option value="line:TR">Transformers</option><option value="line:LV">LV panels</option>{filter && !filter.startsWith("line:") && <option value={filter}>{scope}</option>}</select></label>
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); const day = String(new FormData(e.currentTarget).get("historyDate")); setFrom(day); setTo(day); setPage(0); setSelection(new Set()); router.push(href(day, "history")); }}>
            <label className="text-xs font-semibold text-muted">Open another date<input key={dayISO} name="historyDate" aria-label="History date" className="block mt-1 ctl" type="date" required max={today} defaultValue={dayISO} disabled={pending} /></label>
            <button type="submit" className="btn btn-secondary btn-sm" disabled={pending}>Open date</button>
          </form>
        </div>
      </div>
      {msg && <p role="status" className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</p>}
      {!canDelete && <p className="text-xs text-muted">Deleting a full day needs recording permission for every department in this scope. Choose a line you manage to delete its records.</p>}
      <div className="flex flex-wrap items-end justify-between gap-3 no-print">
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs font-semibold text-muted">From<input aria-label="Recorded days from" type="date" max={to || today} value={from} disabled={pending} className="ctl block mt-1" onChange={(e) => { setFrom(e.target.value); setPage(0); setSelection(new Set()); }} /></label>
          <label className="text-xs font-semibold text-muted">To<input aria-label="Recorded days to" type="date" min={from || undefined} max={today} value={to} disabled={pending} className="ctl block mt-1" onChange={(e) => { setTo(e.target.value); setPage(0); setSelection(new Set()); }} /></label>
          {(from || to) && <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => { setFrom(""); setTo(""); setPage(0); setSelection(new Set()); }}>Clear dates</button>}
        </div>
        <label className="text-xs font-semibold text-muted">Rows per page<select aria-label="History rows per page" value={pageSize} disabled={pending} className="ctl ml-2" onChange={(e) => { setPageSize(e.target.value); setPage(0); }}><option value="25">25</option><option value="50">50</option><option value="100">100</option><option value="all">All days</option></select></label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-brand-light/30 p-2 no-print">
        <p className="text-xs text-muted" role="status">{selected.length ? `${selected.length} selected · ${rows.length} matching days` : `${rows.length} recorded days${from || to ? ` match the date filters · ${available.length} total` : " · all dates available"}`}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-ghost btn-sm" disabled={pending || !canDelete || !rows.length || selected.length === rows.length} onClick={() => setSelection(new Set(rows.map((h) => h.dateISO)))}>Select all {rows.length} matching days</button>
          {!!selected.length && <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => setSelection(new Set())}>Clear selection</button>}
          <button type="button" className="btn btn-danger btn-sm" disabled={pending || !canDelete || !selected.length} onClick={() => remove(selected)}><Trash2 size={14} aria-hidden />{pending ? "Deleting…" : `Delete selected (${selected.length})`}</button>
        </div>
      </div>
      <TableFrame className="rounded-xl border">
        <table className="table-cards w-full text-sm border-collapse" aria-label="Recorded shift days table">
          <thead><tr><th scope="col" className="px-3 w-10 no-print"><input type="checkbox" aria-label="Select all days on this page" checked={!!pageRows.length && selectedOnPage === pageRows.length} ref={(el) => { if (el) el.indeterminate = selectedOnPage > 0 && selectedOnPage < pageRows.length; }} disabled={pending || !canDelete || !pageRows.length} onChange={togglePage} /></th><Th label="Date" /><Th label="Day" num hint="Present on the day shift." /><Th label="Night" num hint="Present on the night shift." /><Th label="Absent" num /><Th label="Man-hours" num /><Th label="Stops" num hint="Machine stop records in this scope." /><Th label="Actions" className="no-print" /></tr></thead>
          <tbody>
            {!rows.length ? <tr><td colSpan={8}><TableEmpty title="No shift data for these dates" hint="Clear the date filters, choose another scope, or record attendance for a day." /></td></tr> : pageRows.map((h) => (
              <tr key={h.dateISO} className={selection.has(h.dateISO) ? "bg-brand-light/60" : h.dateISO === dayISO ? "bg-brand-light/40" : ""}>
                <td className="px-3 no-print"><input type="checkbox" aria-label={`Select shift day ${h.dateISO}`} checked={selection.has(h.dateISO)} disabled={pending || !canDelete} onChange={() => setSelection((old) => { const next = new Set(old); if (next.has(h.dateISO)) next.delete(h.dateISO); else next.add(h.dateISO); return next; })} /></td>
                <td className="px-3 py-3 whitespace-nowrap"><Link href={href(h.dateISO, "attendance")} onNavigate={(e) => { if (pending) e.preventDefault(); else onOpenDay("attendance"); }} className="inline-flex items-center gap-2 font-semibold text-brand-ink"><CalendarDays size={14} aria-hidden /><time dateTime={h.dateISO}>{formatDate(h.dateISO)}</time></Link>{h.entries === 0 && <span className="block text-[11px] text-muted">{h.people > 0 ? "Hours summary only" : "No attendance recorded"}</span>}</td>
                <td className="px-3 py-3 text-right tabnum"><span className="shift-tag shift-tag-day"><Sun size={12} aria-hidden />{h.entries === 0 ? "—" : h.day}</span></td>
                <td className="px-3 py-3 text-right tabnum"><span className="shift-tag shift-tag-night"><Moon size={12} aria-hidden />{h.entries === 0 ? "—" : h.night}</span></td>
                <td className="px-3 py-3 text-right tabnum text-muted">{h.entries ? Math.max(0, h.entries - h.day - h.night) : "—"}</td>
                <td className="px-3 py-3 text-right tabnum font-semibold">{h.hours.toLocaleString("en")}{!!h.legacyHours && <span className="block text-[11px] text-muted font-normal">incl. {h.legacyHours} legacy mh</span>}</td>
                <td className="px-3 py-3 text-right tabnum">{h.stops ?? 0}</td>
                <td className="px-3 py-3 no-print"><div className="flex items-center gap-1.5 whitespace-nowrap">
                  <Link href={href(h.dateISO, "attendance")} onNavigate={(e) => { if (pending) e.preventDefault(); else onOpenDay("attendance"); }} className="btn btn-ghost btn-sm" aria-label={`${canEdit ? "Edit" : "View"} attendance ${h.dateISO}`}><Pencil size={13} aria-hidden />{canEdit ? "Edit" : "View"}</Link>
                  <Link href={href(h.dateISO, "downtime")} onNavigate={(e) => { if (pending) e.preventDefault(); else onOpenDay("downtime"); }} className="btn btn-ghost btn-sm" aria-label={`Open machine stops ${h.dateISO}`}><Wrench size={13} aria-hidden />Stops</Link>
                  <button type="button" onClick={() => remove([h.dateISO])} disabled={pending || !canDelete} className="btn btn-ghost btn-sm text-bad-fg" aria-label={`Delete shift day ${h.dateISO}`} title={canDelete ? `Delete this day's shift data for ${scope}` : "You do not have recording permission for the whole scope"}><Trash2 size={13} aria-hidden />Delete</button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
      <nav aria-label="Recorded days pagination" className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted no-print">
        <p>{rows.length ? `${currentPage * size + 1}–${Math.min((currentPage + 1) * size, rows.length)} of ${rows.length} days` : "0 days"}{from || to ? ` · ${available.length} total recorded days` : ""}</p>
        <div className="flex items-center gap-2"><button type="button" className="btn btn-secondary btn-sm" aria-label="Previous history page" disabled={pending || !currentPage} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage + 1} of {pages}</span><button type="button" className="btn btn-secondary btn-sm" aria-label="Next history page" disabled={pending || currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}>Next</button></div>
      </nav>
    </section>
  );
}
