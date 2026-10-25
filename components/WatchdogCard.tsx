"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Play, Radar, Save } from "lucide-react";
import { runWatchNow, saveWatchSettings, type AiActionResult } from "@/app/admin/ai/actions";
import { Note, SectionCard, SettingRow, Switch } from "@/components/primitives";
import { WATCH_RANGES } from "@/lib/domain/watchdog";
import { formatDateTime } from "@/lib/domain/format";

// AI settings → Automations → the plant's watchdog: on or off, its time, how
// far a figure must stray before it says so, who gets its report, whether
// the assistant adds its few lines — and a run now.

export interface WatchdogData {
  enabled: boolean;
  at: string;
  dropPct: number;
  absencePct: number;
  chronicDays: number;
  chronicOf: number;
  lateMinDays: number;
  recipientIds: number[];
  aiSummary: boolean;
  lastRunAt: string | null;
  lastFindings: number;
  /** People who may receive it. */
  people: { id: number; name: string; isOwner: boolean }[];
}

type Msg = { ok: boolean; text: string } | null;

export function WatchdogCard({ data }: { data: WatchdogData }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  const [v, setV] = useState({ ...data });
  const run = (fn: () => Promise<AiActionResult>) =>
    start(async () => {
      setMsg(null);
      const r = await fn();
      setMsg(r.ok ? (r.message ? { ok: true, text: r.message } : null) : { ok: false, text: r.error ?? "Failed." });
      if (r.ok) router.refresh();
    });
  const num = (k: keyof typeof WATCH_RANGES, label: string, hint: string, suffix = "") => (
    <SettingRow title={label} hint={hint}>
      <span className="inline-flex items-center gap-1">
        <input type="number" className="w-20 text-end tabnum" min={WATCH_RANGES[k].min} max={WATCH_RANGES[k].max} value={v[k]}
          onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} aria-label={label} />
        {suffix && <span className="text-sm text-muted">{suffix}</span>}
      </span>
    </SettingRow>
  );
  const save = () => {
    const f = new FormData();
    f.set("enabled", v.enabled ? "1" : "0");
    f.set("at", v.at);
    for (const k of Object.keys(WATCH_RANGES) as (keyof typeof WATCH_RANGES)[]) f.set(k, String(v[k]));
    f.set("recipients", v.recipientIds.join(","));
    f.set("aiSummary", v.aiSummary ? "1" : "0");
    run(() => saveWatchSettings(f));
  };
  const toggle = (id: number) => setV({ ...v, recipientIds: v.recipientIds.includes(id) ? v.recipientIds.filter((x) => x !== id) : [...v.recipientIds, id] });

  return (
    <SectionCard icon={Radar} title="The plant's watchdog"
      description="Each working morning it looks for orders heading late, a stage's output well under its usual and high absence — plain arithmetic, no cost — and sends one report with a task ready for each finding."
      end={data.lastRunAt ? <span className="text-xs text-muted">Last run {formatDateTime(data.lastRunAt)} · {data.lastFindings} new</span> : <span className="text-xs text-muted">Not run yet</span>}>
      <form onSubmit={(e) => { e.preventDefault(); save(); }}>
        <SettingRow title="On" hint="Off: it does not run.">
          <Switch on={v.enabled} onChange={(x) => setV({ ...v, enabled: x })} label="Watchdog on" />
        </SettingRow>
        <SettingRow title="At" hint="Cairo time, working days.">
          <input type="time" value={v.at} onChange={(e) => setV({ ...v, at: e.target.value })} aria-label="Watchdog time" />
        </SettingRow>
        {num("lateMinDays", "Late by at least", "An order forecast to finish this many days after its delivery day.", "days")}
        {num("dropPct", "Output drop", "A stage's earned hours this far under the median of its last 10 working days.", "%")}
        {num("absencePct", "Absence", "A department's day with this share absent — and above its own usual.", "%")}
        <SettingRow title="A worker absent" hint="Absent this many of their last recorded days.">
          <span className="inline-flex items-center gap-1 text-sm">
            <input type="number" className="w-16 text-end tabnum" min={WATCH_RANGES.chronicDays.min} max={WATCH_RANGES.chronicDays.max} value={v.chronicDays}
              onChange={(e) => setV({ ...v, chronicDays: Number(e.target.value) })} aria-label="Absent days" />
            of
            <input type="number" className="w-16 text-end tabnum" min={WATCH_RANGES.chronicOf.min} max={WATCH_RANGES.chronicOf.max} value={v.chronicOf}
              onChange={(e) => setV({ ...v, chronicOf: Number(e.target.value) })} aria-label="Days looked at" />
          </span>
        </SettingRow>
        <SettingRow title="The assistant's lines" hint="A few lines over the findings — what matters most and what to do first. Haiku; a cent or so a day.">
          <Switch on={v.aiSummary} onChange={(x) => setV({ ...v, aiSummary: x })} label="The assistant's lines" />
        </SettingRow>
        <SettingRow title="Report to" hint="None ticked: the owner." stack>
          <div className="flex flex-wrap gap-1.5">
            {data.people.map((p) => (
              <button key={p.id} type="button" className="chip-toggle" aria-pressed={v.recipientIds.includes(p.id)} onClick={() => toggle(p.id)}>
                {p.name}
              </button>
            ))}
          </div>
        </SettingRow>
        <div className="flex flex-wrap items-center gap-2 pt-4 mt-3 border-t">
          <Note msg={msg} />
          <button type="button" className="btn btn-secondary btn-sm ms-auto" disabled={pending} onClick={() => run(() => runWatchNow())}>
            <Play size={14} aria-hidden /> Run now
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
            <Save size={14} aria-hidden /> {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </SectionCard>
  );
}
