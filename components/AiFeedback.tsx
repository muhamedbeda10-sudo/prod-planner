"use client";

import { useEffect, useState, useTransition } from "react";
import { Brain, Check, Pencil, Plus, ThumbsDown, ThumbsUp, Trash2, X } from "lucide-react";
import { forgetAiMemory, loadAiMemories, rateAiAnswer, saveAiMemory } from "@/app/ai/actions";
import { Modal } from "@/components/Modal";
import { EmptyState } from "@/components/primitives";
import { AI_FEEDBACK_LIMITS, AI_MEMORY_LIMITS, type AiFeedbackRating } from "@/lib/domain/aiLearn";
import type { AiMemoryView } from "@/lib/server/ai/memory";

// How a person teaches the assistant: a thumbs up or down under an answer —
// a down asks what was wrong, which the owner reads on AI settings → Quality
// — and the list of what it remembers about them, theirs to correct.

/** 👍 / 👎 under one answer of a saved chat. */
export function AnswerRating({ conversationId, answer, text, rating, onRated }: {
  conversationId: number;
  /** The answer's place among the chat's answers, as the screen counts them. */
  answer: number;
  /** Its words — what finds it when the screen's count is off. */
  text: string;
  rating: AiFeedbackRating | null;
  onRated: (r: AiFeedbackRating) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, start] = useTransition();

  const send = (r: AiFeedbackRating, note = "") =>
    start(async () => {
      setError(null);
      const res = await rateAiAnswer(conversationId, answer, r, note, text.slice(0, 200));
      if (!res.ok) {
        setError(res.error ?? "Could not send it.");
        return;
      }
      onRated(r);
      setAsking(false);
      setSent(true);
    });

  return (
    <>
      <button type="button" className={`btn btn-ghost btn-sm text-xs ${rating === "up" ? "text-ok-fg" : ""}`} disabled={pending} aria-pressed={rating === "up"}
        onClick={() => send("up")} title="A good answer" aria-label="A good answer">
        <ThumbsUp size={13} />
      </button>
      <button type="button" className={`btn btn-ghost btn-sm text-xs ${rating === "down" ? "text-bad-fg" : ""}`} disabled={pending} aria-pressed={rating === "down"} aria-expanded={asking}
        onClick={() => setAsking((v) => !v)} title="Something is wrong" aria-label="Something is wrong">
        <ThumbsDown size={13} />
      </button>
      {sent && !asking && <span className="text-xs text-muted" role="status">{rating === "down" ? "Thanks — the owner will read it." : "Thanks."}</span>}
      {asking && (
        <form className="mt-2 w-full flex flex-col gap-1.5" onSubmit={(e) => { e.preventDefault(); send("down", draft); }}>
          <label className="text-xs font-semibold" htmlFor={`fb-${conversationId}-${answer}`}>What was wrong, or what is the right answer?</label>
          <textarea id={`fb-${conversationId}-${answer}`} dir="auto" rows={2} maxLength={AI_FEEDBACK_LIMITS.note} value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. The plan's target counts the cable boxes too — it is 685, not 505" className="w-full text-sm" />
          <div className="flex items-center gap-2">
            <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>Send</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAsking(false)}>Cancel</button>
            {error && <span className="text-xs text-bad-fg">{error}</span>}
          </div>
        </form>
      )}
      {error && !asking && <span className="text-xs text-bad-fg">{error}</span>}
    </>
  );
}

/** What the assistant remembers about the person: read, corrected, deleted
 *  and added to here; it writes them itself when told something lasting. */
export function MemoryDialog({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<AiMemoryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [pending, start] = useTransition();

  const reload = async () => {
    const r = await loadAiMemories();
    if (r.ok) setItems(r.memories ?? []);
    else setError(r.error ?? "Could not read them.");
  };
  useEffect(() => {
    let live = true;
    loadAiMemories().then((r) => {
      if (!live) return;
      if (r.ok) setItems(r.memories ?? []);
      else setError(r.error ?? "Could not read them.");
    });
    return () => {
      live = false;
    };
  }, []);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) {
        setError(r.error ?? "That did not work.");
        return;
      }
      after?.();
      await reload();
    });

  return (
    <Modal title={<span className="inline-flex items-center gap-2"><Brain size={18} aria-hidden /> What the assistant remembers about you</span>}
      sub="It uses these in every chat with you. Tell it in a chat (“I work in Welding”, “answer in Arabic”) or add one here." onClose={onClose} busy={pending} focusField={false}>
      {items === null ? (
        <p className="text-sm text-muted">Reading…</p>
      ) : items.length === 0 ? (
        <EmptyState compact icon={Brain} title="Nothing yet" hint="Tell it about your work and how you like your answers — it will remember." />
      ) : (
        <ul className="divide-y border rounded-lg">
          {items.map((m) => (
            <li key={m.id} className="flex items-start gap-2 px-3 py-2">
              {editing?.id === m.id ? (
                <form className="flex-1 flex gap-2" onSubmit={(e) => { e.preventDefault(); run(() => saveAiMemory(editing.text, m.id), () => setEditing(null)); }}>
                  <input dir="auto" className="flex-1 text-sm" maxLength={AI_MEMORY_LIMITS.text} value={editing.text} onChange={(e) => setEditing({ id: m.id, text: e.target.value })} aria-label="The memory" autoFocus />
                  <button type="submit" className="icon-btn" disabled={pending} title="Save" aria-label="Save"><Check size={15} /></button>
                  <button type="button" className="icon-btn" onClick={() => setEditing(null)} title="Cancel" aria-label="Cancel"><X size={15} /></button>
                </form>
              ) : (
                <>
                  <span className="flex-1 text-sm" dir="auto">{m.text}</span>
                  <button type="button" className="icon-btn" onClick={() => setEditing({ id: m.id, text: m.text })} title="Correct it" aria-label="Correct it"><Pencil size={14} /></button>
                  <button type="button" className="icon-btn" disabled={pending} onClick={() => run(() => forgetAiMemory(m.id))} title="Forget it" aria-label="Forget it"><Trash2 size={14} /></button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); run(() => saveAiMemory(draft), () => setDraft("")); }}>
        <input dir="auto" className="flex-1 text-sm" maxLength={AI_MEMORY_LIMITS.text} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. I follow the Welding plan — start with it" aria-label="Something to remember" />
        <button type="submit" className="btn btn-secondary btn-sm" disabled={pending || !draft.trim()}><Plus size={14} /> Add</button>
      </form>
      {error && <p className="text-sm text-bad-fg mt-2" role="alert">{error}</p>}
    </Modal>
  );
}
