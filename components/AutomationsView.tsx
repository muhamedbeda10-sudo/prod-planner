"use client";

import { useState, useTransition } from "react";
import { Bell, CalendarClock, ChevronDown, Clock, FileText, FlaskConical, Pause, Play, Plus, RotateCcw, Trash2, Wand2, X, Zap } from "lucide-react";
import { deleteAutomation, restoreAutomation, runAutomationNow, setAutomationEnabled, setAutomationTiming } from "@/app/automations/actions";
import { EmptyState } from "@/components/primitives";
import { CHECK_EVERY, WEEKDAY_NAMES, AUTOMATION_LIMITS } from "@/lib/domain/automations";
import { formatDateTime } from "@/lib/domain/format";
import type { AutomationView } from "@/lib/server/automations/views";

// The automations, each a card: what sets it off, what it does, when it
// runs next and how its last runs went — and Pause / Turn on, Timing, Test
// (to me), Delete. What one does is changed by asking the assistant; when it
// runs is changed here. Above them, whether automations run at all right now.

const STATUS_TONE: Record<string, string> = { ok: "pill-ok", failed: "pill-bad", skipped: "pill-warn", running: "pill-info" };
const KIND: Record<string, { label: string; icon: typeof Bell; tile: string }> = {
  notify: { label: "Message", icon: Bell, tile: "bg-warn-bg text-warn-fg" },
  report: { label: "Report", icon: FileText, tile: "bg-info-bg text-info-fg" },
  act: { label: "Changes", icon: Wand2, tile: "bg-ok-bg text-ok-fg" },
};
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
    <div className="mt-3 rounded-lg border bg-surface-2 p-3 space-y-3">
      {t.trigger === "schedule" ? (
        <>
          <div>
            <p className="filter-label mb-1.5">Times (Cairo)</p>
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
            <p className="filter-label mb-1.5">Days</p>
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
            <p className="filter-label mb-1.5">Check every</p>
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
  const k = KIND[a.kind] ?? KIND.notify;
  const off = a.deleted || !a.enabled;
  return (
    <article className={`rounded-xl border bg-surface ${off ? "opacity-70" : ""}`}>
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full text-start flex items-start gap-3 px-3 py-3 sm:px-4" aria-expanded={open}>
        <span className={`w-9 h-9 rounded-lg grid place-items-center shrink-0 ${k.tile}`} title={k.label}>
          <k.icon size={17} aria-hidden />
        </span>
        <span className="flex-1 min-w-0">
          {/* the name keeps the line; on a narrow screen the pills wrap under it */}
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 flex-[1_1_10rem] truncate text-sm font-bold" dir="auto">{a.name}</span>
            {a.deleted ? <span className="pill pill-muted">Deleted</span> : !a.enabled ? <span className="pill pill-warn">Paused</span> : null}
            {a.lastStatus && a.lastStatus !== "ok" && <span className={`pill ${STATUS_TONE[a.lastStatus] ?? "pill-muted"}`}>Last: {a.lastStatus}</span>}
            {showOwner && <span className="text-xs text-muted truncate">{a.owner}</span>}
            {a.nextRunAt && <span className="ms-auto text-[11px] text-muted tabnum whitespace-nowrap shrink-0" title="Next run">{formatDateTime(a.nextRunAt)}</span>}
          </span>
          <span className="block mt-0.5 text-[13px] text-muted truncate" dir="auto">
            {a.timing.trigger === "schedule" ? <Clock size={12} className="inline -mt-0.5 me-1" aria-hidden /> : <Zap size={12} className="inline -mt-0.5 me-1" aria-hidden />}
            {a.trigger} — {a.action}
          </span>
        </span>
        <ChevronDown size={15} className={`text-muted shrink-0 mt-2.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <div className="px-3 pb-3 sm:px-4 sm:pb-4 border-t pt-3 space-y-3 text-sm">
          {a.lastNote && a.lastStatus !== "ok" && <p className="text-xs text-bad-fg" dir="auto">{a.lastNote}</p>}
          {a.text && (
            <div>
              <p className="filter-label mb-1">{a.kind === "notify" ? "The message" : "The assistant's instruction"}</p>
              <p className="whitespace-pre-wrap" dir="auto">{a.text}</p>
            </div>
          )}
          {a.conditionSql && (
            <div>
              <p className="filter-label mb-1">What it watches</p>
              <pre className="text-xs bg-surface-2 border rounded-lg p-2.5 overflow-x-auto ltr">{a.conditionSql}</pre>
            </div>
          )}
          {a.runs.length > 0 && (
            <div>
              <p className="filter-label mb-1">Last runs</p>
              <ul className="space-y-1">
                {a.runs.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="tabnum text-muted w-28 shrink-0">{formatDateTime(r.startedAt)}</span>
                    <span className={`pill ${STATUS_TONE[r.status] ?? "pill-muted"}`}>{r.status}</span>
                    <span dir="auto" className="min-w-0">{r.error ?? r.summary ?? ""}</span>
                    {r.costUsd > 0 && <span className="text-muted tabnum ms-auto">${r.costUsd.toFixed(3)}</span>}
                  </li>
                ))}
              </ul>
            </div>
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
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            {a.deleted ? (
              <button type="button" className="btn btn-sm btn-secondary" disabled={pending} onClick={() => act(restoreAutomation, { enabled: "false" }, "Restored, paused.")}><RotateCcw size={14} aria-hidden /> Restore</button>
            ) : (
              <>
                {a.enabled ? (
                  <button type="button" className="btn btn-sm btn-secondary" disabled={pending} onClick={() => act(setAutomationEnabled, { enabled: "false" }, "Paused.")}><Pause size={14} aria-hidden /> Pause</button>
                ) : (
                  <button type="button" className="btn btn-sm btn-primary" disabled={pending} onClick={() => act(setAutomationEnabled, { enabled: "true" }, "On.")}><Play size={14} aria-hidden /> Turn on</button>
                )}
                {canTime && !timing && (
                  <button type="button" className="btn btn-sm btn-secondary" disabled={pending} onClick={() => setTiming(true)}><CalendarClock size={14} aria-hidden /> Timing</button>
                )}
                <button
                  type="button" className="btn btn-sm btn-secondary" disabled={pending}
                  onClick={() => act(runAutomationNow, {}, "Sent to your inbox as a test.", a.kind === "notify" ? undefined : "Run it now as a test? It costs like a question; the result comes to you alone.")}
                >
                  <FlaskConical size={14} aria-hidden /> {pending ? "Running…" : "Test"}
                </button>
                <button type="button" className="btn btn-sm btn-ghost text-bad-fg ms-auto" disabled={pending} onClick={() => act(deleteAutomation, {}, "Deleted.", `Delete "${a.name}"?`)}><Trash2 size={14} aria-hidden /> Delete</button>
              </>
            )}
            {msg && <span className={`basis-full text-xs font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</span>}
          </div>
          <p className="text-[11px] text-muted">{a.createdBy ? `Made by ${a.createdBy}. ` : ""}To change what it does, ask the assistant.</p>
        </div>
      )}
    </article>
  );
}

export interface AutomationsStatus {
  paused: boolean;
  inHours: boolean;
  hours: string;
  stale: boolean;
  allowed: boolean;
}

export function AutomationsView({
  automations,
  showOwner = false,
  canTime = true,
  onChanged,
  status,
}: {
  automations: AutomationView[];
  showOwner?: boolean;
  /** May change when they run (their owner, or the app's owner). */
  canTime?: boolean;
  /** Something changed — for a list that is not refreshed by the page. */
  onChanged?: () => void;
  /** Whether automations run at all right now — shown above the list. */
  status?: AutomationsStatus;
}) {
  const [showDeleted, setShowDeleted] = useState(false);
  const live = automations.filter((a) => !a.deleted);
  const deleted = automations.filter((a) => a.deleted);
  return (
    <div className="space-y-3">
      {status && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`inline-flex items-center gap-1.5 font-semibold ${status.paused ? "text-warn-fg" : status.inHours ? "text-ok-fg" : "text-muted"}`}>
            <span className={`w-2 h-2 rounded-full ${status.paused ? "bg-[var(--warn-fg)]" : status.inHours ? "bg-[var(--ok-fg)]" : "bg-[var(--muted)]"}`} aria-hidden />
            {status.paused ? "Paused by the owner" : status.inHours ? "Running" : "Outside the hours"}
          </span>
          <span className="text-muted">{status.hours}</span>
          {!status.paused && status.stale && <span className="pill pill-muted" title="No scheduler is set up: they run only while the app is open somewhere.">No scheduler</span>}
          {!status.allowed && <span className="pill pill-warn">Stopped — no permission</span>}
        </div>
      )}
      {live.length === 0 ? (
        <div className="rounded-xl border border-dashed">
          <EmptyState
            icon={Clock}
            title="No automations yet"
            hint={<>Ask the assistant for one — “every working day at 7:30 send me the orders late at welding”, or “when an order is put on hold, tell Ahmed”.</>}
          />
        </div>
      ) : (
        <div className="space-y-2">
          {live.map((a) => <Row key={a.id} a={a} showOwner={showOwner} canTime={canTime} onChanged={onChanged} />)}
        </div>
      )}
      {deleted.length > 0 && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowDeleted((v) => !v)}>
          {showDeleted ? "Hide" : "Show"} {deleted.length} deleted
        </button>
      )}
      {showDeleted && <div className="space-y-2">{deleted.map((a) => <Row key={a.id} a={a} showOwner={showOwner} canTime={false} onChanged={onChanged} />)}</div>}
    </div>
  );
}
