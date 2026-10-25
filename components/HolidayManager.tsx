"use client";

import { formatDate } from "@/lib/domain/format";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, Plus, Trash2 } from "lucide-react";
import { addHoliday, deleteHoliday } from "@/app/calendar/actions";
import { Modal } from "@/components/Modal";
import { PageHead } from "@/components/ui";
import { EmptyState, SectionCard } from "@/components/primitives";

// The factory's days off besides Fridays: holidays and shutdowns, each a
// date and a name. The plan's working days and every "lands in" figure skip
// them.

export interface HolidayRow {
  id: number;
  date: string; // ISO
  name: string;
}

export function HolidayManager({ rows }: { rows: HolidayRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState("");
  const [adding, setAdding] = useState(false);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setMsg("");
    startTransition(async () => {
      const r = await addHoliday(fd);
      if (r.ok) {
        form.reset();
        setAdding(false);
        router.refresh();
      } else {
        setMsg(r.error ?? "Failed");
      }
    });
  }

  function remove(id: number, name: string) {
    if (!confirm(`Remove "${name}"? The day becomes a normal working day again.`)) return;
    const fd = new FormData();
    fd.set("id", String(id));
    setMsg("");
    startTransition(async () => {
      const r = await deleteHoliday(fd);
      if (r.ok) router.refresh();
      else setMsg(r.error ?? "Failed");
    });
  }

  // Opening or closing the Add form drops any pending message so an error
  // raised inside the form never lingers under the page header once it closes.
  function openAdd() {
    setMsg("");
    setAdding(true);
  }

  function closeAdd() {
    setMsg("");
    setAdding(false);
  }

  const addButton = (
    <button type="button" className="btn btn-primary btn-sm" onClick={openAdd}>
      <Plus size={14} aria-hidden /> Add a day off
    </button>
  );

  return (
    <div className="space-y-4">
      <PageHead title="Factory Calendar" sub="Holidays and shutdowns besides Fridays" actions={addButton} />
      {msg && !adding && <p className="alert alert-bad">{msg}</p>}
      {adding && (
        <Modal title="Add a day off" sub="Fridays are always off — add holidays and shutdowns." onClose={closeAdd} busy={pending} width="max-w-lg">
          <form onSubmit={submit} className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="field-label">Date</span>
                <input name="date" type="date" required className="px-2 py-1.5 text-sm tabnum" />
              </label>
              <label className="block flex-1 min-w-40">
                <span className="field-label">Name</span>
                <input name="name" type="text" required placeholder="Eid al-Fitr, maintenance shutdown…" className="w-full px-2 py-1.5 text-sm" />
              </label>
            </div>
            {msg && <p className="alert alert-bad">{msg}</p>}
            <div className="flex justify-end gap-2 pt-3 border-t">
              <button type="button" className="btn btn-sm btn-ghost" onClick={closeAdd} disabled={pending}>Cancel</button>
              <button type="submit" disabled={pending} className="btn btn-primary btn-sm">{pending ? "Saving…" : "Add"}</button>
            </div>
          </form>
        </Modal>
      )}

      <SectionCard icon={CalendarDays} title="Days off" description="Each one is skipped by the plan's working days and every “lands in” figure." padded={false} className="max-w-2xl">
        {rows.length === 0 ? (
          <EmptyState compact icon={CalendarDays} title="No holidays yet" hint="Fridays are always off." action={addButton} />
        ) : (
          <div className="overflow-x-auto border-t">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="text-start ps-4 md:ps-5">Date</th>
                  <th className="text-start">Name</th>
                  <th className="text-end pe-4 md:pe-5 w-16"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((h) => (
                  <tr key={h.id}>
                    <td className="ps-4 md:ps-5 whitespace-nowrap font-bold tabnum" title={h.date}>{formatDate(h.date)}</td>
                    <td>{h.name}</td>
                    <td className="text-end pe-4 md:pe-5">
                      <button type="button" onClick={() => remove(h.id, h.name)} disabled={pending} className="icon-btn icon-btn-danger" title="Remove" aria-label={`Remove ${h.name}`}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
