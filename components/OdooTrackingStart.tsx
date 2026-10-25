"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveOdooTrackingStart } from "@/app/admin/settings/actions";

/** One shared starting point for the plant, not a viewer's filter. */
export function OdooTrackingStart({ initialMonth }: { initialMonth: string | null }) {
  const [month, setMonth] = useState(initialMonth ?? "");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const router = useRouter();
  return <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
    e.preventDefault();
    const fd = new FormData(); fd.set("month", month);
    startTransition(async () => {
      const result = await saveOdooTrackingStart(fd);
      setMessage(result.ok ? "Tracking start saved for everyone." : result.error ?? "Could not save.");
      if (result.ok) router.refresh();
    });
  }}>
    <label className="flex flex-col gap-1 text-xs font-semibold">First Odoo plan month
      <input type="month" aria-label="First Odoo plan month" value={month} onChange={(e) => { setMonth(e.target.value); setMessage(""); }} disabled={pending} className="ctl" />
    </label>
    <button type="submit" disabled={pending} className="btn btn-sm btn-secondary">{pending ? "Saving…" : "Save tracking start"}</button>
    <p className="text-xs text-muted w-full">Automatic allocation starts with this plan month. Older orders stay untracked unless their own production record confirms an Odoo closing. Quantities are read automatically from Odoo.</p>
    {message && <p role="status" className="text-xs font-semibold w-full">{message}</p>}
  </form>;
}
