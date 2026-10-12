"use client";

import { useState, useTransition } from "react";
import { CalendarClock, ChevronDown, ChevronRight, FlaskConical, Pause, Play, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { deleteAutomation, restoreAutomation, runAutomationNow, setAutomationEnabled, setAutomationTiming } from "@/app/automations/actions";
import { CHECK_EVERY, WEEKDAY_NAMES, AUTOMATION_LIMITS } from "@/lib/domain/automations";
import { formatDateTime } from "@/lib/domain/format";
import type { AutomationView } from "@/lib/server/automations/views";

// The automations, each with what sets it off, what it does, when it runs
// next and how its last runs went — and Pause / Turn on, Timing, Test (to me),
// Delete. What one does is changed by asking the assistant; when it runs is
// changed here.

const STATUS_TONE: Record<string, string> = { ok: "pill-ok", failed: "pill-bad", skipped: "pill-warn", running: "pill-info" };
const KIND_LABEL: Record<string, string> = { notify: "Message", report: "Report", act: "Changes" };
const DAYS_LABEL: Record<string, string> = { working: "Working days", every: "Every day", weekdays: "Chosen days" };

type Result = { ok: boolean; error?: string };

const everyText = (min: number) => (min >= 60 ? `${min / 60} h` : `${min} min`);

/** When an automation runs — its times and days, or how often its condition
 *  is checked and in which hours. */
function TimingForm({ a, onDone, onCancel }: { a: AutomationView; onDone: () => void; onCancel: () => void }) {
  const t = a.timing;
  const [times, setTimes] = useState<string[]>(t.times);
  const [next, setNext] = useState("");
  const [days, setDays] = useState(t.days);
  const [weekdays, setWeekdays] = useState<number[]>(t.weekdays);
  const [every, setEvery] = useState(t.checkEveryMin);
  const [limited, setLimited] = useState(!!t.activeFrom);
  const [from, setFrom] = useState(t.activeFrom ?? "07:00");
  const [to, setTo] = useState(t.activeTo ?? "19:00");
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const addTime = () => {
    if (!/^\d{2}:\d{2}$/.test(next) || times.includes(next)) return;
    setTimes((xs) => [...xs, next].sort());
    setNext("");
  };
  const save = () => {
    setErr(null);
    const timing = t.trigger === "schedule"
      ? { times, days, weekdays: days === "weekdays" ? weekdays : [] }
      : { checkEveryMin: every, activeFrom: limited ? from : null, activeTo: limited ? to : null };
    const fd = new FormData();
    fd.set("id", String(a.id));
    fd.set("timing", JSON.stringify(timing));
    start(async () => {
      const r: Result = await setAutomationTiming(fd).catch(() => ({ ok: false, error: "The request failed — try again." }));
      if (r.ok) onDone();
      else setErr(r.error ?? "It was not saved.");
    });
  };

  return (
    <div className="mt-2 rounded-lg border bg-surface-2 p-3 space-y-3">
      {t.trigger === "schedule" ? (
        <>
          <div>
            <p className="text-xs font-bold text-muted mb-1.5">Times (Cairo)</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {times.map((x) => (
                <span key={x} className="pill pill-muted tabnum gap-1">
                  {x}
                  <button type="button" onClick={() => setTimes((xs) => xs.filter((y) => y !== x))} className="-me-1 p-0.5 rounded hover:bg-surface-3" aria-label={`Remove ${x}`}>
                    <X size={12} aria-hidden />
                  </button>
                </span>
              ))}
              {times.length < AUTOMATION_LIMITS.times && (
                <span className="inline-flex items-center gap-1">
                  <input type="time" value={next} onChange={(e) => setNext(e.target.value)} className="px-2 py-1 text-sm tabnum" aria-label="Add a time" />
                  <button type="button" className="btn btn-sm" onClick={addTime} disabled={!next} aria-label="Add the time"><Plus size={14} aria-hidden /></button>
                </span>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs font-bold text-muted mb-1.5">Days</p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(DAYS_LABEL).map(([k, label]) => (
                <button key={k} type="button" onClick={() => setDays(k)} className={`btn btn-sm ${days === k ? "btn-primary" : "btn-secondary"}`}>{label}</button>
              ))}
            </div>
            {days === "weekdays" && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {WEEKDAY_NAMES.map((n, d) => (
                  <label key={n} className={`pill cursor-pointer select-none ${weekdays.includes(d) ? "pill-ok" : "pill-muted"}`}>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={weekdays.includes(d)}
                      onChange={(e) => setWeekdays((ws) => (e.target.checked ? [...ws, d].sort() : ws.filter((x) => x !== d)))}
                    />
                    {n.slice(0, 3)}
                  </label>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <div>
            <p className="text-xs font-bold text-muted mb-1.5">Check every</p>
            <div className="flex flex-wrap gap-1.5">
              {CHECK_EVERY.map((m) => (
                <button key={m} type="button" onClick={() => setEvery(m)} className={`btn btn-sm tabnum ${every === m ? "btn-primary" : "btn-secondary"}`}>{everyText(m)}</button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="inline-flex items-center gap-1.5 font-semibold cursor-pointer">
              <input type="checkbox" checked={limited} onChange={(e) => setLimited(e.target.checked)} className="accent-[var(--brand)] w-4 h-4" />
              Only on working days between
            </label>
            <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} disabled={!limited} className="px-2 py-1 text-sm tabnum" aria-label="From" />
            <span>–</span>
            <input type="time" value={to} onChange={(e) => setTo(e.target.value)} disabled={!limited} className="px-2 py-1 text-sm tabnum" aria-label="To" />
          </div>
        </>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {err && <span className="text-sm font-semibold text-bad-fg me-auto">{err}</span>}
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel} disabled={pending}>Cancel</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save"}</button>
      </div>
    </div>
  );
}

function Row({ a, showOwner, canTime, onChanged }: { a: AutomationView; showOwner: boolean; canTime: boolean; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [timing, setTiming] = useState(false);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const act = (fn: (fd: FormData) => Promise<Result>, fields: Record<string, string>, okText: string, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    setMsg(null);
    const fd = new FormData();
    fd.set("id", String(a.id));
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    start(async () => {
      try {
        const r = await fn(fd);
        setMsg(r.ok ? { ok: true, text: okText } : { ok: false, text: r.error ?? "It did not go through." });
        if (r.ok) onChanged?.();
      } catch {
        setMsg({ ok: false, text: "The request failed — refresh the page and try again." });
      }
    });
  };
  return (
    <div className={`border rounded-xl bg-surface ${a.enabled ? "" : "opacity-75"}`}>
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full text-start flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2.5" aria-expanded={open}>
        {open ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
        <span className="font-extrabold min-w-0 truncate" dir="auto">{a.name}</span>
        <span className="pill pill-muted text-[11px]">{KIND_LABEL[a.kind] ?? a.kind}</span>
        {a.deleted ? <span className="pill pill-muted text-[11px]">Deleted</span> : !a.enabled && <span className="pill pill-warn text-[11px]">Paused</span>}
        {a.lastStatus && a.lastStatus !== "ok" && <span className={`pill ${STATUS_TONE[a.lastStatus] ?? "pill-muted"} text-[11px]`}>{a.lastStatus}</span>}
        {showOwner && <span className="text-xs text-muted">{a.owner}</span>}
        {a.nextRunAt && <span className="ms-auto text-xs text-muted tabnum">{formatDateTime(a.nextRunAt)}</span>}
        <span className="basis-full text-xs text-muted ps-6" dir="auto">{a.trigger}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 border-t space-y-2 text-sm">
          <p className="mt-2 text-xs text-muted" dir="auto">{a.action}</p>
          {a.lastNote && a.lastStatus !== "ok" && <p className="text-xs text-bad-fg" dir="auto">{a.lastNote}</p>}
          {a.text && <p className="whitespace-pre-wrap" dir="auto">{a.text}</p>}
          {a.conditionSql && <pre className="text-xs bg-surface-2 border rounded-lg p-2 overflow-x-auto ltr">{a.conditionSql}</pre>}
          {a.runs.length > 0 && (
            <ul className="space-y-1">
              {a.runs.map((r) => (
                <li key={r.id} className="flex flex-wrap gap-2 text-xs">
                  <span className="tabnum text-muted">{formatDateTime(r.startedAt)}</span>
                  <span className={`pill ${STATUS_TONE[r.status] ?? "pill-muted"} text-[10px]`}>{r.status}</span>
                  <span dir="auto" className="min-w-0">{r.error ?? r.summary ?? ""}</span>
                  {r.costUsd > 0 && <span className="text-muted tabnum">${r.costUsd.toFixed(3)}</span>}
                </li>
              ))}
            </ul>
          )}
          {timing && (
            <TimingForm
              a={a}
              onCancel={() => setTiming(false)}
              onDone={() => {
                setTiming(false);
                setMsg({ ok: true, text: "Timing saved." });
                onChanged?.();
              }}
            />
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {a.deleted ? (
              <button type="button" className="btn btn-sm" disabled={pending} onClick={() => act(restoreAutomation, { enabled: "false" }, "Restored, paused.")}><RotateCcw size={14} aria-hidden /> Restore</button>
            ) : (
              <>
                {a.enabled ? (
                  <button type="button" className="btn btn-sm" disabled={pending} onClick={() => act(setAutomationEnabled, { enabled: "false" }, "Paused.")}><Pause size={14} aria-hidden /> Pause</button>
                ) : (
                  <button type="button" className="btn btn-sm" disabled={pending} onClick={() => act(setAutomationEnabled, { enabled: "true" }, "On.")}><Play size={14} aria-hidden /> Turn on</button>
                )}
                {canTime && !timing && (
                  <button type="button" className="btn btn-sm" disabled={pending} onClick={() => setTiming(true)}><CalendarClock size={14} aria-hidden /> Timing</button>
                )}
                <button
                  type="button" className="btn btn-sm" disabled={pending}
                  onClick={() => act(runAutomationNow, {}, "Sent to your inbox as a test.", a.kind === "notify" ? undefined : "Run it now as a test? It costs like a question; the result comes to you alone.")}
                >
                  <FlaskConical size={14} aria-hidden /> {pending ? "Running…" : "Test"}
                </button>
                <button type="button" className="btn btn-sm btn-ghost text-bad-fg" disabled={pending} onClick={() => act(deleteAutomation, {}, "Deleted.", `Delete "${a.name}"?`)}><Trash2 size={14} aria-hidden /> Delete</button>
              </>
            )}
            {msg && <span className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export function AutomationsView({
  automations,
  showOwner = false,
  canTime = true,
  onChanged,
}: {
  automations: AutomationView[];
  showOwner?: boolean;
  /** May change when they run (their owner, or the app's owner). */
  canTime?: boolean;
  /** Something changed — for a list that is not refreshed by the page. */
  onChanged?: () => void;
}) {
  const [showDeleted, setShowDeleted] = useState(false);
  const live = automations.filter((a) => !a.deleted);
  const deleted = automations.filter((a) => a.deleted);
  return (
    <div className="space-y-2">
      {live.length === 0 && <p className="text-sm text-muted">No automations yet.</p>}
      {live.map((a) => <Row key={a.id} a={a} showOwner={showOwner} canTime={canTime} onChanged={onChanged} />)}
      {deleted.length > 0 && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowDeleted((v) => !v)}>
          {showDeleted ? "Hide" : "Show"} {deleted.length} deleted
        </button>
      )}
      {showDeleted && deleted.map((a) => <Row key={a.id} a={a} showOwner={showOwner} canTime={false} onChanged={onChanged} />)}
    </div>
  );
}
