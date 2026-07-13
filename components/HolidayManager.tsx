"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addHoliday, deleteHoliday } from "@/app/calendar/actions";

export interface HolidayRow {
  id: number;
  date: string; // ISO
  name: string;
}

export function HolidayManager({ rows }: { rows: HolidayRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState("");

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setMsg("");
    startTransition(async () => {
      const r = await addHoliday(fd);
      if (r.ok) {
        form.reset();
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
    startTransition(async () => {
      await deleteHoliday(fd);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4 max-w-xl">
      <form onSubmit={submit} className="bg-surface border rounded-xl p-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-xs text-muted font-semibold mb-1">Date</span>
          <input name="date" type="date" required className="border rounded-md px-2 py-1.5 bg-surface text-sm" />
        </label>
        <label className="text-sm flex-1 min-w-40">
          <span className="block text-xs text-muted font-semibold mb-1">Name</span>
          <input name="name" type="text" required placeholder="Eid al-Fitr, maintenance shutdown…" className="w-full border rounded-md px-2 py-1.5 bg-surface text-sm" />
        </label>
        <button type="submit" disabled={pending} className="bg-brand hover:bg-brand-dark text-white font-bold rounded-md px-4 py-2 text-sm disabled:opacity-50 transition-colors">
          + Add day off
        </button>
        {msg && <span className="text-xs text-bad-fg font-semibold w-full">{msg}</span>}
      </form>

      <div className="bg-surface border rounded-xl overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-brand text-white text-left">
              <th className="p-2">Date</th>
              <th className="p-2">Name</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={3} className="p-4 text-center text-muted">No holidays yet — Fridays are always off.</td></tr>
            )}
            {rows.map((h, i) => (
              <tr key={h.id} className={i % 2 ? "bg-zebra" : ""}>
                <td className="p-2 whitespace-nowrap font-bold tabnum">{h.date}</td>
                <td className="p-2">{h.name}</td>
                <td className="p-2 text-right">
                  <button onClick={() => remove(h.id, h.name)} disabled={pending} className="text-bad-fg text-xs px-2 hover:underline">Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
