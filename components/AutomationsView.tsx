"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, FlaskConical, Pause, Play, RotateCcw, Trash2 } from "lucide-react";
import { deleteAutomation, restoreAutomation, runAutomationNow, setAutomationEnabled } from "@/app/automations/actions";
import { formatDateTime } from "@/lib/domain/format";
import type { AutomationView } from "@/lib/server/automations/views";

// The automations, each with what sets it off, what it does, when it runs
// next and how its last runs went — and Pause / Turn on, Test (to me), Delete.
// They are made and changed by asking the assistant.

const STATUS_TONE: Record<string, string> = { ok: "pill-ok", failed: "pill-bad", skipped: "pill-warn", running: "pill-info" };
const KIND_LABEL: Record<string, string> = { notify: "Message", report: "Report", act: "Prepares changes" };

function Row({ a, showOwner }: { a: AutomationView; showOwner: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const act = (fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fields: Record<string, string>, okText: string, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    setMsg(null);
    const fd = new FormData();
    fd.set("id", String(a.id));
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    start(async () => {
      try {
        const r = await fn(fd);
        setMsg(r.ok ? { ok: true, text: okText } : { ok: false, text: r.error ?? "It did not go through." });
      } catch {
        setMsg({ ok: false, text: "The request failed — refresh the page and try again." });
      }
    });
  };
  return (
    <div className={`border rounded-xl ${a.enabled ? "" : "opacity-75"}`}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 font-extrabold text-start" aria-expanded={open}>
          {open ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
          <span dir="auto">{a.name}</span>
        </button>
        <span className="pill pill-muted text-[11px]">{KIND_LABEL[a.kind] ?? a.kind}</span>
        {a.deleted ? <span className="pill pill-muted text-[11px]">Deleted</span> : !a.enabled && <span className="pill pill-warn text-[11px]">Paused</span>}
        {a.lastStatus && <span className={`pill ${STATUS_TONE[a.lastStatus] ?? "pill-muted"} text-[11px]`}>Last: {a.lastStatus}</span>}
        {showOwner && <span className="text-xs text-muted">· {a.owner}</span>}
        <span className="ms-auto text-xs text-muted tabnum">{a.nextRunAt ? `next ${formatDateTime(a.nextRunAt)}` : ""}</span>
        <span className="basis-full text-sm text-muted" dir="auto">{a.trigger} — {a.action}.</span>
        {a.lastNote && a.lastStatus !== "ok" && <span className="basis-full text-xs text-bad-fg" dir="auto">{a.lastNote}</span>}
      </div>
      {open && (
        <div className="px-3 pb-3 border-t space-y-2 text-sm">
          {a.text && (
            <div className="mt-2">
              <p className="text-xs font-semibold text-muted">{a.kind === "notify" ? "The message" : "The assistant's instruction"}</p>
              <p className="whitespace-pre-wrap" dir="auto">{a.text}</p>
            </div>
          )}
          {a.conditionSql && (
            <div>
              <p className="text-xs font-semibold text-muted">What it watches (a read-only query)</p>
              <pre className="text-xs bg-surface-2 border rounded-lg p-2 overflow-x-auto ltr">{a.conditionSql}</pre>
            </div>
          )}
          {a.runs.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted">Last runs</p>
              <ul className="space-y-1">
                {a.runs.map((r) => (
                  <li key={r.id} className="flex flex-wrap gap-2 text-xs">
                    <span className="tabnum text-muted">{formatDateTime(r.startedAt)}</span>
                    <span className={`pill ${STATUS_TONE[r.status] ?? "pill-muted"} text-[10px]`}>{r.status}</span>
                    <span className="text-muted">{r.cause}</span>
                    <span dir="auto">{r.error ?? r.summary ?? ""}</span>
                    {r.costUsd > 0 && <span className="text-muted tabnum">${r.costUsd.toFixed(3)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-muted">{a.createdBy ? `Made by ${a.createdBy}. ` : ""}To change it, ask the assistant.</p>
          <div className="flex flex-wrap gap-2">
            {a.deleted ? (
              <button type="button" className="btn btn-sm" disabled={pending} onClick={() => act(restoreAutomation, { enabled: "false" }, "Back on the list, paused.")}><RotateCcw size={14} aria-hidden /> Bring back</button>
            ) : (
              <>
                {a.enabled ? (
                  <button type="button" className="btn btn-sm" disabled={pending} onClick={() => act(setAutomationEnabled, { enabled: "false" }, "Paused.")}><Pause size={14} aria-hidden /> Pause</button>
                ) : (
                  <button type="button" className="btn btn-sm" disabled={pending} onClick={() => act(setAutomationEnabled, { enabled: "true" }, "On again.")}><Play size={14} aria-hidden /> Turn on</button>
                )}
                <button
                  type="button" className="btn btn-sm" disabled={pending}
                  onClick={() => act(runAutomationNow, {}, "Done — whatever it sent is in your inbox, marked as a test.", a.kind === "notify" ? undefined : "Run it now as a test? The assistant's work costs as a question does; the result comes to you alone.")}
                >
                  <FlaskConical size={14} aria-hidden /> {pending ? "Running…" : "Test now (to me)"}
                </button>
                <button type="button" className="btn btn-sm btn-ghost text-bad-fg" disabled={pending} onClick={() => act(deleteAutomation, {}, "Deleted.", `Delete "${a.name}"? It stops; its record stays.`)}><Trash2 size={14} aria-hidden /> Delete</button>
              </>
            )}
            {msg && <span className={`text-sm font-semibold ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>{msg.text}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export function AutomationsView({ automations, showOwner = false, ai }: { automations: AutomationView[]; showOwner?: boolean; ai: boolean }) {
  const [showDeleted, setShowDeleted] = useState(false);
  const live = automations.filter((a) => !a.deleted);
  const deleted = automations.filter((a) => a.deleted);
  return (
    <div className="space-y-3 max-w-4xl">
      {live.length === 0 && (
        <p className="text-sm text-muted">
          None yet.{" "}
          {ai ? (
            <>Ask the <Link href="/ai" className="underline">assistant</Link> — e.g. “every working day at 7:30 send me the orders late at welding”, or “when an order is put on hold, tell Ahmed”.</>
          ) : (
            "The assistant makes them for the people the owner opened automations to."
          )}
        </p>
      )}
      {live.map((a) => <Row key={a.id} a={a} showOwner={showOwner} />)}
      {deleted.length > 0 && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowDeleted((v) => !v)}>
          {showDeleted ? "Hide" : "Show"} {deleted.length} deleted
        </button>
      )}
      {showDeleted && deleted.map((a) => <Row key={a.id} a={a} showOwner={showOwner} />)}
    </div>
  );
}
