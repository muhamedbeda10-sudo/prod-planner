"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveShiftHours } from "@/app/admin/settings/actions";

// The hours the plant's shifts are worth. Every man-hour the app counts is
// measured with these — the shift log's day, a machine's crew, the day the
// calibration compares against — so they live here rather than in the code.
// The CODE a day was recorded under never changes; only what it is worth
// does, and it applies from now on wherever hours are read.

export function ShiftHoursForm({ short, long, overtime, nightOvertime = 3, compact = false }: {
  short: number; long: number; overtime: number; nightOvertime?: number;
  /** Embed the fields where a caller supplies its own heading and explanation. */
  compact?: boolean;
}) {
  const router = useRouter();
  const [v, setV] = useState({ shiftShortH: String(short), shiftLongH: String(long), overtimeH: String(overtime), nightOvertimeH: String(nightOvertime) });
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = v.shiftShortH !== String(short) || v.shiftLongH !== String(long) || v.overtimeH !== String(overtime) || v.nightOvertimeH !== String(nightOvertime);

  const field = (k: keyof typeof v, label: string, hint: string) => (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-bold">{label}</span>
      <span className="inline-flex items-center gap-1">
        <input
          type="number" min={0} max={24} step={0.25} inputMode="decimal"
          value={v[k]}
          disabled={pending}
          onChange={(e) => setV((x) => ({ ...x, [k]: e.target.value }))}
          className="ctl font-bold tabnum w-24 ltr"
        />
        <span className="text-xs text-muted">hours</span>
      </span>
      <span className="text-[11px] text-muted">{hint}</span>
    </label>
  );

  const body = (
    <>
      <div className="flex flex-wrap gap-4">
        {field("shiftShortH", "Day working hours", "07:00–16:00 less the 1 h break")}
        {field("shiftLongH", "Night working hours", "19:00–04:00 less the 1 h break")}
        {field("overtimeH", "Day overtime", "16:00–19:00")}
        {field("nightOvertimeH", "Night overtime", "04:00–07:00 next day; booked to the shift start date")}
      </div>
      <div className="flex items-center gap-2 mt-3">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={pending || !dirty}
          onClick={() => {
            const fd = new FormData();
            for (const [k, val] of Object.entries(v)) fd.set(k, val);
            setMsg(null);
            start(async () => {
              const res = await saveShiftHours(fd);
              setMsg(res.ok ? { ok: true, text: "Saved — the hours apply everywhere from now on." } : { ok: false, text: res.error ?? "Failed to save." });
              if (res.ok) router.refresh();
            });
          }}
        >
          {pending ? "Saving…" : "Save hours"}
        </button>
        {msg && <span className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</span>}
      </div>
    </>
  );

  if (compact) return body;

  return (
    <section className="bg-surface border rounded-xl p-4">
      <h2 className="text-base font-bold">🕘 Shift hours</h2>
      <p className="explain text-xs text-muted mt-0.5 mb-3">
        Net working hours after the one-hour break, plus optional overtime: day 16:00–19:00, night 04:00–07:00. Every man-hour the app counts uses
        these: the day’s total per department, the crew on a machine, and what the standard times are calibrated against.
        Days already recorded keep the shift they were recorded under and are re-counted with the new hours.
      </p>
      {body}
    </section>
  );
}
