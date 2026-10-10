"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Check, Copy, Loader2, MessageSquare, PanelLeft, Plus, Search, Send, Trash2 } from "lucide-react";
import { AiMarkdown } from "@/components/AiMarkdown";
import { deleteAiConversation, loadAiConversation } from "@/app/ai/actions";
import { AI_MAX_QUESTION, usdText, type AiChatTurn } from "@/lib/domain/ai";

// The AI assistant's chat: the person's conversations on the side, the open
// one in the middle, the answer streaming in as it is written — what it is
// looking up shown while it looks — and the month's spend under the box.

interface Turn extends AiChatTurn {
  error?: string;
}

interface Conv {
  id: number;
  title: string;
  updatedAt: string;
}

export interface AiChatStatus {
  ok: boolean;
  reason: string | null;
  userSpent: number;
  userCap: number;
  plantSpent: number;
  plantCap: number;
}

const SUGGESTIONS = [
  "إيه الأوردرات المتأخرة دلوقتي، وواقفة في أنهي قسم؟",
  "اعملي رسم بياني لإنتاج كل قسم في آخر 7 أيام",
  "أنهي ماكينة عليها أكبر حمل شغل دلوقتي؟",
  "إيه الـ MOs اللي مستنية تتقفل في الأودو؟",
  "لخصلي إنتاج امبارح واقترح أولويات النهارده",
  "Which open orders still have no nesting on the Material tab?",
];

const ago = (iso: string) => {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

export function AiChat({
  meName,
  isOwner,
  status,
  conversations,
  initial,
}: {
  meName: string;
  isOwner: boolean;
  status: AiChatStatus;
  conversations: Conv[];
  initial: { id: number; turns: AiChatTurn[] } | null;
}) {
  const [convs, setConvs] = useState<Conv[]>(conversations);
  const [activeId, setActiveId] = useState<number | null>(initial?.id ?? null);
  const [turns, setTurns] = useState<Turn[]>(initial?.turns ?? []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<string | null>(null);
  const [spent, setSpent] = useState({ user: status.userSpent, plant: status.plantSpent });
  const [sideOpen, setSideOpen] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // deltas arrive token by token — gathered and drawn a few times a second
  const pending = useRef("");
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const capReached = (status.userCap > 0 && spent.user >= status.userCap) || (status.plantCap > 0 && spent.plant >= status.plantCap);
  const canAsk = status.ok && !capReached;

  // keep the newest of the answer in view while it is written
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, live]);

  const patchLast = (f: (t: Turn) => Turn) =>
    setTurns((all) => {
      if (all.length === 0) return all;
      const copy = all.slice();
      copy[copy.length - 1] = f(copy[copy.length - 1]);
      return copy;
    });

  const flush = () => {
    flushTimer.current = null;
    const d = pending.current;
    pending.current = "";
    if (d) patchLast((t) => ({ ...t, text: t.text + d }));
  };

  function setUrl(id: number | null) {
    window.history.replaceState(null, "", id ? `/ai?c=${id}` : "/ai");
  }

  async function open(id: number) {
    if (busy) return;
    setLoadErr(null);
    setSideOpen(false);
    const r = await loadAiConversation(id);
    if (!r.ok) {
      setLoadErr(r.error ?? "Could not open it.");
      return;
    }
    setActiveId(id);
    setTurns(r.turns ?? []);
    setUrl(id);
  }

  function newChat() {
    if (busy) return;
    setActiveId(null);
    setTurns([]);
    setLoadErr(null);
    setSideOpen(false);
    setUrl(null);
    box.current?.focus();
  }

  async function remove(c: Conv) {
    if (busy || !confirm(`Delete the chat "${c.title}"? What it cost stays in the usage log.`)) return;
    const r = await deleteAiConversation(c.id);
    if (!r.ok) return setLoadErr(r.error ?? "Could not delete it.");
    setConvs((all) => all.filter((x) => x.id !== c.id));
    if (activeId === c.id) newChat();
  }

  function handle(ev: { type: string; [k: string]: unknown }, question: string) {
    if (ev.type === "start") {
      const id = Number(ev.conversationId);
      setActiveId(id);
      setUrl(id);
      setConvs((all) => [{ id, title: String(ev.title ?? question), updatedAt: new Date().toISOString() }, ...all.filter((c) => c.id !== id)]);
    } else if (ev.type === "status") {
      flush();
      const text = String(ev.text ?? "");
      setLive(text);
      patchLast((t) => ({ ...t, lookups: [...t.lookups, text] }));
    } else if (ev.type === "text") {
      setLive(null);
      pending.current += String(ev.delta ?? "");
      if (!flushTimer.current) flushTimer.current = setTimeout(flush, 60);
    } else if (ev.type === "done") {
      flush();
      const cost = Number(ev.costUsd ?? 0);
      setSpent((s) => ({ user: s.user + cost, plant: s.plant + cost }));
      if (ev.error) patchLast((t) => ({ ...t, error: String(ev.error) }));
    }
  }

  async function ask(text: string) {
    const question = text.trim();
    if (!question || busy || !canAsk) return;
    setInput("");
    setBusy(true);
    setLive("Reading the question…");
    setTurns((all) => [...all, { role: "user", text: question, lookups: [] }, { role: "assistant", text: "", lookups: [] }]);
    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: activeId, question }),
      });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `The request failed (${res.status}).`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) handle(JSON.parse(line), question);
        }
      }
    } catch (e) {
      flush();
      patchLast((t) => ({ ...t, error: e instanceof Error ? e.message : "The request failed." }));
    } finally {
      flush();
      setBusy(false);
      setLive(null);
    }
  }

  const meter = status.userCap > 0
    ? `${usdText(spent.user)} of your ${usdText(status.userCap)} this month`
    : `${usdText(spent.user)} used this month${isOwner && status.plantCap > 0 ? ` · plant ${usdText(spent.plant)} of ${usdText(status.plantCap)}` : ""}`;

  return (
    <div className="ai-chat flex gap-3 h-[calc(100dvh-8.5rem)] min-h-[420px]">
      {/* the conversations */}
      <aside className={`${sideOpen ? "fixed inset-x-3 top-16 bottom-3 z-40 shadow-2xl" : "hidden"} md:static md:flex md:shadow-none w-auto md:w-60 shrink-0 flex-col bg-surface border rounded-xl overflow-hidden`}>
        <div className="p-2 border-b flex gap-2">
          <button type="button" className="btn btn-primary btn-sm flex-1" onClick={newChat} disabled={busy}>
            <Plus size={15} /> New chat
          </button>
          {/* .btn sets its own display, so the hiding goes on a wrapper */}
          <span className="md:hidden"><button type="button" className="btn btn-ghost btn-sm" onClick={() => setSideOpen(false)}>Close</button></span>
        </div>
        <nav className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          {convs.length === 0 && <p className="text-xs text-muted p-2">Your chats will be listed here.</p>}
          {convs.map((c) => (
            <div key={c.id} className={`group flex items-center gap-1 rounded-lg ${c.id === activeId ? "bg-brand-light" : "hover:bg-surface-2"}`}>
              <button type="button" onClick={() => open(c.id)} className="flex-1 min-w-0 text-start px-2.5 py-2" disabled={busy}>
                <div className={`text-sm font-semibold truncate ${c.id === activeId ? "text-brand" : ""}`} dir="auto">{c.title}</div>
                <div className="text-[11px] text-muted">{ago(c.updatedAt)}</div>
              </button>
              <button
                type="button"
                onClick={() => remove(c)}
                disabled={busy}
                className="p-1.5 me-1 rounded-md text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-bad-fg hover:bg-bad-bg"
                title="Delete this chat"
                aria-label={`Delete the chat ${c.title}`}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </nav>
      </aside>

      {/* the open conversation */}
      <section className="flex-1 min-w-0 flex flex-col bg-surface border rounded-xl overflow-hidden">
        <div className="md:hidden flex items-center gap-2 p-2 border-b">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSideOpen(true)}>
            <PanelLeft size={15} /> Chats
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={newChat} disabled={busy}>
            <Plus size={15} /> New
          </button>
        </div>

        <div ref={scroller} className="flex-1 overflow-y-auto px-3 py-4 md:px-6">
          {loadErr && <p className="text-sm font-semibold text-bad-fg mb-3">{loadErr}</p>}
          {turns.length === 0 ? (
            <Welcome name={meName} onPick={(q) => (canAsk ? ask(q) : setInput(q))} disabled={!canAsk || busy} />
          ) : (
            <div className="max-w-4xl mx-auto space-y-5">
              {turns.map((t, i) =>
                t.role === "user" ? (
                  <div key={i} className="flex justify-end">
                    <div dir="auto" className="max-w-[85%] rounded-2xl rounded-ee-md bg-brand-light px-3.5 py-2 text-[15px] whitespace-pre-wrap">{t.text}</div>
                  </div>
                ) : (
                  <Answer key={i} turn={t} live={busy && i === turns.length - 1 ? live : null} streaming={busy && i === turns.length - 1} />
                ),
              )}
            </div>
          )}
        </div>

        <form
          className="border-t p-2.5 md:p-3"
          onSubmit={(e) => {
            e.preventDefault();
            ask(input);
          }}
        >
          {!canAsk && (
            <p className="text-sm font-semibold text-warn-fg mb-2">
              {status.reason ?? "You have used this month's AI allowance — ask the owner to raise it."}
              {isOwner && <> <a href="/admin/ai" className="underline text-brand">Open AI assistant settings</a></>}
            </p>
          )}
          <div className="max-w-4xl mx-auto flex items-end gap-2">
            <textarea
              ref={box}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  ask(input);
                }
              }}
              rows={Math.min(6, Math.max(1, input.split("\n").length))}
              maxLength={AI_MAX_QUESTION}
              dir="auto"
              disabled={!canAsk}
              placeholder={canAsk ? "Ask about orders, output, machines, material… (Enter to send, Shift+Enter for a new line)" : ""}
              className="flex-1 resize-none px-3 py-2 text-[15px] rounded-xl"
            />
            <button type="submit" className="btn btn-primary h-10 w-10 !p-0 shrink-0" disabled={!canAsk || busy || !input.trim()} aria-label="Send" title="Send">
              {busy ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
            </button>
          </div>
          <div className="max-w-4xl mx-auto flex flex-wrap justify-between gap-x-3 gap-y-0.5 mt-1.5 text-[11px] text-muted">
            <span>Read-only answers from the app&apos;s data — check the figures that matter.</span>
            <span className="tabnum">{meter}</span>
          </div>
        </form>
      </section>
    </div>
  );
}

function Welcome({ name, onPick, disabled }: { name: string; onPick: (q: string) => void; disabled: boolean }) {
  return (
    <div className="max-w-2xl mx-auto text-center pt-6 md:pt-14">
      <div className="mx-auto w-12 h-12 rounded-2xl bg-brand-light text-brand grid place-items-center">
        <Bot size={26} />
      </div>
      <p className="mt-3 text-lg font-extrabold">Hi {name.split(" ")[0]} — ask me about the plant</p>
      <p className="text-sm text-muted mt-1">
        I read the app&apos;s live data — orders, plans, the daily log, machines, material, Odoo, shifts, consumables — and answer with
        tables, charts and suggestions. Arabic or English.
      </p>
      <div className="grid sm:grid-cols-2 gap-2 mt-5 text-start">
        {SUGGESTIONS.map((q) => (
          <button key={q} type="button" disabled={disabled} onClick={() => onPick(q)} dir="auto"
            className="border rounded-xl px-3 py-2.5 text-sm hover:bg-surface-2 hover:border-[var(--border-strong)] transition-colors disabled:opacity-60 flex items-start gap-2">
            <MessageSquare size={15} className="text-muted mt-0.5 shrink-0" />
            <span>{q}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Answer({ turn, live, streaming }: { turn: Turn; live: string | null; streaming: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2.5">
      <div className="w-8 h-8 rounded-full bg-brand-light text-brand grid place-items-center shrink-0 mt-0.5">
        <Bot size={17} />
      </div>
      <div className="flex-1 min-w-0">
        {turn.lookups.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {turn.lookups.map((l, i) => (
              <span key={i} className="pill pill-muted text-[11px]" dir="auto" title="Looked up in the database">
                <Search size={11} /> {l}
              </span>
            ))}
          </div>
        )}
        {turn.text && <AiMarkdown text={turn.text} streaming={streaming} />}
        {live && (
          <div className="flex items-center gap-2 text-sm text-muted mt-1" dir="auto">
            <Loader2 size={15} className="animate-spin shrink-0" />
            {live}
          </div>
        )}
        {turn.error && <p className="text-sm font-semibold text-bad-fg mt-1">{turn.error}</p>}
        {!streaming && turn.text && (
          <button
            type="button"
            className="btn btn-ghost btn-sm mt-1 -ms-2 text-xs"
            onClick={() => {
              navigator.clipboard?.writeText(turn.text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
    </div>
  );
}
