"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, Check, CheckCheck, Clock, Loader2, RotateCcw, Undo2, X } from "lucide-react";
import { approveAiAction, rejectAiAction, undoAiAction } from "@/app/ai/actions";
import { RISK_TEXT, type AiActionStatus, type AiActionView } from "@/lib/domain/aiActions";

// A change the assistant prepared, as the person answers it: what it does,
// row by row (before → after), and Approve / Reject — then what happened,
// with Undo while nothing was changed after it.

const STATUS: Record<AiActionStatus, { label: string; tone: string }> = {
  proposed: { label: "Waiting for your approval", tone: "pill-info" },
  executing: { label: "Running…", tone: "pill-muted" },
  executed: { label: "Done", tone: "pill-ok" },
  failed: { label: "Refused by the app", tone: "pill-bad" },
  rejected: { label: "Rejected", tone: "pill-muted" },
  stale: { label: "Out of date — not done", tone: "pill-warn" },
  expired: { label: "Expired — not done", tone: "pill-muted" },
  undone: { label: "Undone", tone: "pill-muted" },
};

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "");

/** What the server answered, as the card shows it. */
type Decide = (id: number) => Promise<{ ok: boolean; error?: string; view?: AiActionView }>;

export function AiActionCard({ view, onChange }: { view: AiActionView; onChange: (v: AiActionView) => void }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const run = (fn: Decide, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    setErr(null);
    start(async () => {
      try {
        const r = await fn(view.id);
        if (r.view) onChange(r.view);
        if (!r.ok) setErr(r.error ?? "It did not go through.");
      } catch {
        setErr("The request failed — refresh the page and try again.");
      }
    });
  };

  const st = STATUS[view.status];
  const rows = showAll ? view.changes : view.changes.slice(0, 8);
  const danger = view.risk === "destructive";

  return (
    <div className={`mt-2 border rounded-xl overflow-hidden ${view.status === "proposed" ? (danger ? "border-[var(--bad-fg)]" : "border-[var(--brand)]") : ""}`}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-surface-2 border-b">
        <span className="text-sm font-extrabold" dir="auto">{view.title}</span>
        <span className={`pill ${st.tone} text-[11px]`}>{st.label}</span>
        {view.risk !== "low" && (
          <span className={`pill ${danger ? "pill-bad" : "pill-warn"} text-[11px]`}>
            <AlertTriangle size={11} /> {RISK_TEXT[view.risk]}
          </span>
        )}
        {view.auto && <span className="pill pill-muted text-[11px]" title="A small change you allowed the assistant to make without asking">made without asking</span>}
        <span className="ms-auto text-[11px] text-muted tabnum">#{view.id}</span>
      </div>
      <div className="px-3 py-2 space-y-2">
        <p className="text-sm" dir="auto">{view.summary}</p>
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted text-start">
                  <th className="text-start font-semibold py-1 pe-3">What</th>
                  <th className="text-start font-semibold py-1 pe-3">Now</th>
                  <th className="text-start font-semibold py-1">After</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c, i) => (
                  <tr key={i} className="border-t">
                    <td className="py-1 pe-3 font-semibold" dir="auto">{c.label}</td>
                    <td className="py-1 pe-3 text-muted tabnum" dir="auto">{c.before}</td>
                    <td className="py-1 font-bold tabnum" dir="auto">{c.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {view.changes.length > rows.length && (
              <button type="button" className="btn btn-ghost btn-sm mt-1 text-xs" onClick={() => setShowAll(true)}>Show all {view.changes.length} rows</button>
            )}
          </div>
        )}
        {view.result && view.status === "executed" && <p className="text-xs text-ok-fg font-semibold" dir="auto">{view.result}</p>}
        {view.error && view.status !== "proposed" && <p className="text-xs text-bad-fg font-semibold" dir="auto">{view.error}</p>}
        {err && <p className="text-xs text-bad-fg font-semibold" dir="auto">{err}</p>}

        <div className="flex flex-wrap items-center gap-2">
          {view.status === "proposed" && (
            <>
              <button
                type="button"
                className={`btn btn-sm ${danger ? "btn-secondary text-bad-fg" : "btn-primary"}`}
                disabled={pending}
                onClick={() => run(approveAiAction, danger ? `Approve this deletion?\n\n${view.summary}` : undefined)}
              >
                {pending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Approve
              </button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={pending} onClick={() => run(rejectAiAction)}>
                <X size={14} /> Reject
              </button>
              {view.expiresAt && (
                <span className="text-[11px] text-muted inline-flex items-center gap-1">
                  <Clock size={11} /> until {new Date(view.expiresAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </>
          )}
          {view.status === "executing" && (
            <span className="text-xs text-muted inline-flex items-center gap-1">
              <Loader2 size={13} className="animate-spin" /> Running…
            </span>
          )}
          {view.status === "executed" && (
            <>
              <span className="text-[11px] text-muted inline-flex items-center gap-1">
                <CheckCheck size={12} /> {time(view.executedAt)}
              </span>
              {view.canUndo && (
                <button type="button" className="btn btn-sm btn-ghost" disabled={pending} onClick={() => run(undoAiAction, "Put this change back the way it was?")}>
                  {pending ? <Loader2 size={14} className="animate-spin" /> : <Undo2 size={14} />} Undo
                </button>
              )}
            </>
          )}
          {view.status === "undone" && view.undoneAt && (
            <span className="text-[11px] text-muted inline-flex items-center gap-1">
              <RotateCcw size={12} /> put back at {time(view.undoneAt)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Approve every waiting change of one answer, in order, stopping at the
 *  first that does not go through. */
export function ApproveAll({ views, onChange }: { views: AiActionView[]; onChange: (v: AiActionView) => void }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const waiting = views.filter((v) => v.status === "proposed" && v.risk !== "destructive");
  if (waiting.length < 2) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn btn-sm btn-secondary"
        disabled={pending}
        onClick={() => {
          setErr(null);
          start(async () => {
            for (const v of waiting) {
              const r = await approveAiAction(v.id);
              if (r.view) onChange(r.view);
              if (!r.ok) {
                setErr(`#${v.id}: ${r.error ?? "it did not go through"} — the rest were left waiting.`);
                return;
              }
            }
          });
        }}
      >
        {pending ? <Loader2 size={14} className="animate-spin" /> : <CheckCheck size={14} />} Approve all {waiting.length}
      </button>
      {err && <span className="text-xs text-bad-fg font-semibold" dir="auto">{err}</span>}
    </div>
  );
}
