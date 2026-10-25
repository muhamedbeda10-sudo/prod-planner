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
import { deleteRecordedShiftDay } from "@/app/shifts/historyActions";
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
  const [date, setDate] = useState(dayISO);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [deleted, setDeleted] = useState<{ source: typeof history; keys: Set<string> }>(() => ({ source: history, keys: new Set() }));
  const depts = rosterDepts(filter);
  // History totals cover whole departments, including when attendance was narrowed to a subsection.
  const scope = filter && !filter.startsWith("line:") ? `${WORKER_DEPT_LABEL[depts[0]]} (whole department)` : rosterFilterLabel(filter);
  const canDelete = depts.length > 0 && depts.every((d) => editableDepts.includes(d));
  const canEdit = depts.some((d) => editableDepts.includes(d));
  const rows = history.filter((h) => deleted.source !== history || !deleted.keys.has(`${filter}|${h.dateISO}`));
  const href = (day: string, view: EditView | "history") => `/shifts?${new URLSearchParams({ day, view, ...(filter ? { sec: filter } : {}) })}`;
  const remove = async (h: ShiftHistoryDay) => {
    if (pending || !canDelete) return;
    if (!(await confirm({ title: `Delete ${formatDate(h.dateISO)}?`, body: <><p>This permanently removes this day&apos;s attendance, shift notes, machine stops and man-hour totals for the departments below. Production output and worker profiles stay in place.</p><p className="mt-2 font-semibold">{depts.map((d) => WORKER_DEPT_LABEL[d]).join(" · ")}</p></>, confirmLabel: "Delete day and shift data", danger: true }))) return;
    setMsg(null);
    start(async () => {
      try {
        const fd = new FormData(); fd.set("date", h.dateISO); fd.set("depts", depts.join(","));
        const result = await deleteRecordedShiftDay(fd);
        if (!result.ok) { setMsg({ ok: false, text: result.error ?? "Could not delete this day." }); return; }
        setDeleted((old) => ({ source: history, keys: new Set(old.source === history ? old.keys : []).add(`${filter}|${h.dateISO}`) }));
        setMsg({ ok: true, text: `Deleted ${formatDate(h.dateISO)} — ${result.attendance ?? 0} attendance records, ${result.stops ?? 0} machine stops and ${result.totals ?? 0} daily totals.` });
        onDeleted(h.dateISO); router.refresh();
      } catch { setMsg({ ok: false, text: "Could not confirm deletion. Refresh the page and check the day's records before trying again." }); }
    });
  };
  return (
    <section aria-label="Recorded shift days" className="space-y-3">
      {dialog}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="!mb-1">Recorded days</h2><p className="text-xs text-muted">{scope} · recent days and the selected date · edit attendance or machine stops from the same row.</p></div>
        <div className="flex flex-wrap items-end gap-2 no-print">
          <label className="text-xs font-semibold text-muted">Scope<select aria-label="History scope" value={filter} disabled={pending} className="block mt-1 ctl" onChange={(e) => { const p = new URLSearchParams(params.toString()); if (e.target.value) p.set("sec", e.target.value); else p.delete("sec"); p.set("view", "history"); router.push(`${pathname}?${p}`); }}><option value="">Everyone</option><option value="line:TR">Transformers</option><option value="line:LV">LV panels</option>{filter && !filter.startsWith("line:") && <option value={filter}>{scope}</option>}</select></label>
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); router.push(href(date, "history")); }}>
            <label className="text-xs font-semibold text-muted">Open another date<input aria-label="History date" className="block mt-1 ctl" type="date" required max={today} value={date} onChange={(e) => setDate(e.target.value)} disabled={pending} /></label>
            <button type="submit" className="btn btn-secondary btn-sm" disabled={pending}>Open date</button>
          </form>
        </div>
      </div>
      {msg && <p role="status" className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</p>}
      {!canDelete && <p className="text-xs text-muted">Deleting a full day needs recording permission for every department in this scope. Choose a line you manage to delete its records.</p>}
      <TableFrame className="rounded-xl border">
        <table className="w-full text-sm border-collapse" aria-label="Recorded shift days table">
          <thead><tr><Th label="Date" /><Th label="Day" num hint="Present on the day shift." /><Th label="Night" num hint="Present on the night shift." /><Th label="Absent" num /><Th label="Man-hours" num /><Th label="Stops" num hint="Machine stop records in this scope." /><Th label="Actions" className="no-print" /></tr></thead>
          <tbody>
            {!rows.length ? <tr><td colSpan={7}><TableEmpty title="No shift data for these dates" hint="Choose an earlier date, another scope, or record attendance for a day." /></td></tr> : rows.map((h) => (
              <tr key={h.dateISO} className={h.dateISO === dayISO ? "bg-brand-light/40" : ""}>
                <td className="px-3 py-3 whitespace-nowrap"><Link href={href(h.dateISO, "attendance")} onNavigate={(e) => { if (pending) e.preventDefault(); else onOpenDay("attendance"); }} className="inline-flex items-center gap-2 font-semibold text-brand-ink"><CalendarDays size={14} aria-hidden /><time dateTime={h.dateISO}>{formatDate(h.dateISO)}</time></Link>{h.entries === 0 && <span className="block text-[11px] text-muted">{h.people > 0 ? "Hours summary only" : "No attendance recorded"}</span>}</td>
                <td className="px-3 py-3 text-right tabnum"><span className="shift-tag shift-tag-day"><Sun size={12} aria-hidden />{h.entries === 0 ? "—" : h.day}</span></td>
                <td className="px-3 py-3 text-right tabnum"><span className="shift-tag shift-tag-night"><Moon size={12} aria-hidden />{h.entries === 0 ? "—" : h.night}</span></td>
                <td className="px-3 py-3 text-right tabnum text-muted">{h.entries ? Math.max(0, h.entries - h.day - h.night) : "—"}</td>
                <td className="px-3 py-3 text-right tabnum font-semibold">{h.hours.toLocaleString("en")}{!!h.legacyHours && <span className="block text-[11px] text-muted font-normal">incl. {h.legacyHours} legacy mh</span>}</td>
                <td className="px-3 py-3 text-right tabnum">{h.stops ?? 0}</td>
                <td className="px-3 py-3 no-print"><div className="flex items-center gap-1.5 whitespace-nowrap">
                  <Link href={href(h.dateISO, "attendance")} onNavigate={(e) => { if (pending) e.preventDefault(); else onOpenDay("attendance"); }} className="btn btn-ghost btn-sm" aria-label={`${canEdit ? "Edit" : "View"} attendance ${h.dateISO}`}><Pencil size={13} aria-hidden />{canEdit ? "Edit" : "View"}</Link>
                  <Link href={href(h.dateISO, "downtime")} onNavigate={(e) => { if (pending) e.preventDefault(); else onOpenDay("downtime"); }} className="btn btn-ghost btn-sm" aria-label={`Open machine stops ${h.dateISO}`}><Wrench size={13} aria-hidden />Stops</Link>
                  <button type="button" onClick={() => remove(h)} disabled={pending || !canDelete} className="btn btn-ghost btn-sm text-bad-fg" aria-label={`Delete shift day ${h.dateISO}`} title={canDelete ? `Delete this day's shift data for ${scope}` : "You do not have recording permission for the whole scope"}><Trash2 size={13} aria-hidden />Delete</button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
    </section>
  );
}
