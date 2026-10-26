"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Bot, CheckCircle2, CircleAlert, Info } from "lucide-react";
import { Modal } from "@/components/Modal";
import { useAiPanel } from "@/components/AiPanel";
import type { CockpitAction } from "@/lib/domain/kpis";

// What needs a decision today, worst first: one button in the cockpit's head
// — its icon the worst news, its badge how many — that opens the list in a
// popup, so the figures under it start at the top of the page. The printed
// cockpit carries the list itself (Cockpit.tsx).

const ACTION_ICON = { bad: CircleAlert, warn: AlertTriangle, info: Info } as const;
const ACTION_TONE = { bad: "text-bad-fg", warn: "text-warn-fg", info: "text-info-fg" } as const;

const NOTHING = "Nothing pressing — the plan, the centres and welding's parts are all on track.";

/** The list itself; `onOpen` runs when one of its links is followed. A
 *  decision acted on through the assistant (`ask`) opens the chat with its
 *  question ready — or, for someone without the assistant, has no link. */
export function DecisionList({ actions, onOpen, nothing = NOTHING }: { actions: readonly (CockpitAction & { line?: string })[]; onOpen?: () => void; nothing?: string }) {
  const panel = useAiPanel();
  const ai = panel?.tabs.includes("chat") ? panel : null;
  if (actions.length === 0) return <p className="text-sm text-ok-fg font-semibold">{nothing}</p>;
  return (
    <ul className="space-y-2">
      {actions.map((a, i) => {
        const Icon = ACTION_ICON[a.tone];
        return (
          <li key={i} className="flex items-start gap-2 text-sm">
            <Icon size={16} className={`mt-0.5 shrink-0 ${ACTION_TONE[a.tone]}`} aria-hidden />
            <span className="flex-1">{a.line && <span className="pill pill-muted me-1.5 align-middle">{a.line}</span>}{a.text}</span>
            {a.ask ? (
              ai && (
                <button type="button" onClick={() => { onOpen?.(); ai.ask(a.ask!); }} className="no-print shrink-0 text-brand-ink font-semibold inline-flex items-center gap-1 hover:underline" title="Open the assistant in a new chat with this question ready to send" aria-label={`Ask the assistant: ${a.text}`}>
                  <Bot size={13} aria-hidden /> Ask
                </button>
              )
            ) : (
              <Link href={a.href} onClick={onOpen} className="no-print shrink-0 text-brand-ink font-semibold inline-flex items-center gap-1 hover:underline">
                Open <ArrowRight size={13} aria-hidden />
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** What a list is: a decision (the Planning dashboard) or an intervention
 *  (the Production dashboard) — the button, the popup and the paper name it. */
export type DecisionKind = "decision" | "intervention";
const KIND = {
  decision: { noun: "a decision", title: "Needs a decision today", button: "Decisions", nothing: NOTHING },
  intervention: { noun: "an intervention", title: "Needs intervention in production", button: "Interventions", nothing: "Nothing pressing on the floor." },
} as const;

/** The list as the paper carries it — the popup's content, printed. */
export function PrintDecisions({ actions, kind = "decision", nothing, copy, notes = [] }: { actions: readonly (CockpitAction & { line?: string })[]; kind?: DecisionKind; nothing?: string; copy?: DecisionCopy; notes?: readonly string[] }) {
  const k = copy ?? KIND[kind];
  return (
    <section className="print-only" aria-label={k.title}>
      <h2>{k.title}</h2>
      <DecisionList actions={actions} nothing={nothing ?? k.nothing} />
      <Notes notes={notes} />
    </section>
  );
}

/** Lines under the list that need no one — not counted on the button. */
function Notes({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="mt-3 pt-3 border-t space-y-1 text-sm text-muted">
      {notes.map((n) => <li key={n} className="flex items-start gap-2"><Info size={14} className="mt-0.5 shrink-0" aria-hidden />{n}</li>)}
    </ul>
  );
}

/** A list's own wording, where neither preset fits (a dashboard's data checks). */
export interface DecisionCopy { noun: string; title: string; button: string; nothing: string; when?: string }

export function CockpitDecisions({ actions, kind = "decision", copy, notes = [] }: {
  actions: readonly (CockpitAction & { line?: string })[];
  kind?: DecisionKind;
  copy?: DecisionCopy;
  /** Lines under the list that need no one (not counted). */
  notes?: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const ai = useAiPanel();
  const k = copy ?? KIND[kind];
  const when = copy ? (copy.when ? ` ${copy.when}` : "") : " today";
  const worst = actions.some((a) => a.tone === "bad") ? "bad" : actions.some((a) => a.tone === "warn") ? "warn" : actions.length > 0 ? "info" : null;
  const Icon = worst ? ACTION_ICON[worst] : CheckCircle2;
  const label = actions.length === 0 ? `Nothing needs ${k.noun}${when}` : `${actions.length} ${actions.length === 1 ? "thing needs" : "things need"} ${k.noun}${when}`;

  return (
    <>
      <button type="button" className="no-print btn btn-secondary btn-sm" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={label} title={label}>
        <Icon size={14} className={worst ? ACTION_TONE[worst] : "text-ok-fg"} aria-hidden />
        {k.button}
        {actions.length > 0 && (
          <span className={`count-badge ${worst === "bad" ? "count-badge-alert" : "count-badge-warn"}`} aria-hidden>{actions.length > 99 ? "99+" : actions.length}</span>
        )}
      </button>
      {open && (
        <Modal title={k.title} sub="Worst first — open one to act on it, or ask the assistant." onClose={() => setOpen(false)} width="max-w-3xl" focusField={false}>
          <DecisionList actions={actions} onOpen={() => setOpen(false)} nothing={k.nothing} />
          <Notes notes={notes} />
          {ai && (
            <div className="flex justify-end mt-4 pt-3 border-t">
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setOpen(false); ai.open(); }} title="Ask the assistant about these figures — it reads the same cockpit">
                <Bot size={14} aria-hidden /> Ask the assistant
              </button>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
