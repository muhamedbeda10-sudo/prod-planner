"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Check, Copy, FileSpreadsheet, Loader2, MessageSquare, PanelLeft, Paperclip, Plus, Search, Send, Trash2, X } from "lucide-react";
import { AiMarkdown } from "@/components/AiMarkdown";
import { AiActionCard, ApproveAll } from "@/components/AiActionCard";
import { deleteAiConversation, discardAiFile, loadAiConversation, uploadAiFile } from "@/app/ai/actions";
import { AI_MAX_QUESTION, usdText, type AiChatTurn } from "@/lib/domain/ai";
import { AI_FILE_ACCEPT, AI_FILE_LIMITS, fileSizeText } from "@/lib/domain/aiFiles";
import type { AiActionView } from "@/lib/domain/aiActions";
import type { AiChatStatus } from "@/lib/server/ai/panel";

// The AI assistant's chat: the person's conversations on the side (a drawer
// below a laptop's width, and always in the narrow side panel), the open one in the middle, the answer streaming
// in as it is written — what it is looking up shown while it looks, the
// changes it prepares as cards to approve — and the month's spend under the
// box. A sheet can go with a question: the paperclip sends it to the app
// first, and the question carries its number.

interface Turn extends AiChatTurn {
  error?: string;
}

interface Conv {
  id: number;
  title: string;
  updatedAt: string;
}

/** A file attached and kept, waiting for the question it goes with. */
interface Pending {
  id: number;
  name: string;
  kind: string;
  size: number;
}

export type { AiChatStatus };

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
  isOwner,
  status,
  conversations,
  initial,
  compact = false,
  syncUrl = true,
}: {
  isOwner: boolean;
  status: AiChatStatus;
  conversations: Conv[];
  initial: { id: number; turns: AiChatTurn[]; actions: AiActionView[] } | null;
  /** Narrow (the side panel): the chats are always a drawer. */
  compact?: boolean;
  /** Keep the open chat in the address bar (the /ai page). */
  syncUrl?: boolean;
}) {
  const [convs, setConvs] = useState<Conv[]>(conversations);
  const [activeId, setActiveId] = useState<number | null>(initial?.id ?? null);
  const [turns, setTurns] = useState<Turn[]>(initial?.turns ?? []);
  // the cards, by the tool call that prepared them
  const [actions, setActions] = useState<Record<string, AiActionView>>(() => byCall(initial?.actions ?? []));
  const putAction = (v: AiActionView) => setActions((m) => (v.toolUseId ? { ...m, [v.toolUseId]: v } : m));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<string | null>(null);
  const [spent, setSpent] = useState({ user: status.userSpent, plant: status.plantSpent, userToday: status.userSpentToday, plantToday: status.plantSpentToday });
  const [sideOpen, setSideOpen] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [uploading, setUploading] = useState(0);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  // deltas arrive token by token — gathered and drawn a few times a second
  const delta = useRef("");
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const capReached =
    (status.userCap > 0 && spent.user >= status.userCap) ||
    (status.plantCap > 0 && spent.plant >= status.plantCap) ||
    (status.userDayCap > 0 && spent.userToday >= status.userDayCap) ||
    (status.plantDayCap > 0 && spent.plantToday >= status.plantDayCap);
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
    const d = delta.current;
    delta.current = "";
    if (d) patchLast((t) => ({ ...t, text: t.text + d }));
  };

  function setUrl(id: number | null) {
    if (syncUrl) window.history.replaceState(null, "", id ? `/ai?c=${id}` : "/ai");
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
    setActions(byCall(r.actions ?? []));
    setUrl(id);
  }

  function newChat() {
    if (busy) return;
    setActiveId(null);
    setTurns([]);
    setActions({});
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
      delta.current += String(ev.delta ?? "");
      if (!flushTimer.current) flushTimer.current = setTimeout(flush, 60);
    } else if (ev.type === "action") {
      const v = ev.action as AiActionView;
      putAction(v);
      if (v.toolUseId) {
        const id = v.toolUseId;
        patchLast((t) => ({ ...t, actionIds: [...(t.actionIds ?? []).filter((x) => x !== id), id] }));
      }
    } else if (ev.type === "done") {
      flush();
      const cost = Number(ev.costUsd ?? 0);
      setSpent((s) => ({ user: s.user + cost, plant: s.plant + cost, userToday: s.userToday + cost, plantToday: s.plantToday + cost }));
      if (ev.error) patchLast((t) => ({ ...t, error: String(ev.error) }));
    }
  }

  /** Send picked files to the app, one by one — each kept as it arrives. */
  async function attach(list: FileList | null) {
    const picked = [...(list ?? [])];
    if (picker.current) picker.current.value = "";
    if (picked.length === 0) return;
    setFileErr(null);
    const room = AI_FILE_LIMITS.perQuestion - pending.length;
    if (picked.length > room) setFileErr(`At most ${AI_FILE_LIMITS.perQuestion} files with one question.`);
    for (const f of picked.slice(0, Math.max(0, room))) {
      if (f.size > AI_FILE_LIMITS.maxBytes) {
        setFileErr(`"${f.name}" is ${fileSizeText(f.size)} — at most ${fileSizeText(AI_FILE_LIMITS.maxBytes)} a file.`);
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const fd = new FormData();
        fd.set("file", f);
        const r = await uploadAiFile(fd);
        if (r.ok) setPending((all) => [...all, r.file]);
        else setFileErr(r.error);
      } catch {
        setFileErr(`"${f.name}" could not be sent — try again.`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  function unattach(id: number) {
    setPending((all) => all.filter((f) => f.id !== id));
    void discardAiFile(id);
  }

  async function ask(text: string) {
    const question = text.trim();
    if (!question || busy || !canAsk || uploading > 0) return;
    const sent = pending;
    setInput("");
    setPending([]);
    setFileErr(null);
    setBusy(true);
    setLive("Reading the question…");
    setTurns((all) => [
      ...all,
      { role: "user", text: question, lookups: [], ...(sent.length ? { files: sent.map(({ id, name, kind }) => ({ id, name, kind })) } : {}) },
      { role: "assistant", text: "", lookups: [] },
    ]);
    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: activeId, question, fileIds: sent.map((f) => f.id) }),
      });
      if (!res.ok || !res.body) {
        // refused before it began: the files wait for the next try
        setPending(sent);
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

  const of = (v: number, cap: number) => (cap > 0 ? `${usdText(v)} / ${usdText(cap)}` : usdText(v));
  const meter = [
    status.userDayCap > 0 && `Today ${of(spent.userToday, status.userDayCap)}`,
    `Month ${of(spent.user, status.userCap)}`,
    isOwner && (status.plantCap > 0 || status.plantDayCap > 0) && `Plant ${status.plantDayCap > 0 ? `today ${of(spent.plantToday, status.plantDayCap)}` : of(spent.plant, status.plantCap)}`,
  ].filter(Boolean).join(" · ");
  const activeTitle = convs.find((c) => c.id === activeId)?.title ?? null;

  // the conversations: beside the chat on a wide screen, a drawer over it in
  // the side panel and below a laptop's width
  const drawerCls = compact
    ? `${sideOpen ? "flex absolute z-20 inset-y-0 start-0 w-[min(18rem,85%)] shadow-2xl border-e" : "hidden"}`
    : `${sideOpen ? "flex fixed z-50 inset-y-0 start-0 w-[min(20rem,85vw)] shadow-2xl" : "hidden"} lg:static lg:z-auto lg:flex lg:w-64 lg:shadow-none lg:border lg:rounded-xl`;
  const narrowOnly = compact ? "" : "lg:hidden";

  return (
    <div className={`ai-chat relative flex h-full min-h-[380px] ${compact ? "" : "gap-3"}`}>
      {sideOpen && (
        <button
          type="button"
          aria-label="Close the chats"
          className={compact ? "absolute inset-0 z-10 bg-black/45" : "lg:hidden fixed inset-0 z-40 bg-black/45"}
          onClick={() => setSideOpen(false)}
        />
      )}
      <aside className={`${drawerCls} shrink-0 flex-col bg-surface overflow-hidden`}>
        <div className="p-2 border-b flex gap-2">
          <button type="button" className="btn btn-primary btn-sm flex-1" onClick={newChat} disabled={busy}>
            <Plus size={15} /> New chat
          </button>
          {/* .btn sets its own display, so the hiding goes on a wrapper */}
          <span className={narrowOnly}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSideOpen(false)} aria-label="Close the chats"><X size={16} /></button>
          </span>
        </div>
        <nav className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          {convs.length === 0 && <p className="text-xs text-muted p-2">No chats yet.</p>}
          {convs.map((c) => (
            <div key={c.id} className={`flex items-center gap-1 rounded-lg ${c.id === activeId ? "bg-brand-light" : "hover:bg-surface-2"}`}>
              <button type="button" onClick={() => open(c.id)} className="flex-1 min-w-0 text-start px-2.5 py-2" disabled={busy}>
                <div className={`text-sm font-semibold truncate ${c.id === activeId ? "text-brand" : ""}`} dir="auto">{c.title}</div>
                <div className="text-[11px] text-muted">{ago(c.updatedAt)}</div>
              </button>
              <button
                type="button"
                onClick={() => remove(c)}
                disabled={busy}
                className="p-2 me-0.5 rounded-md text-muted opacity-60 hover:opacity-100 hover:text-bad-fg hover:bg-bad-bg"
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
      <section className={`flex-1 min-w-0 flex flex-col bg-surface overflow-hidden ${compact ? "" : "border rounded-xl"}`}>
        <div className={`${narrowOnly} flex items-center gap-1 px-1.5 py-1 border-b`}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSideOpen(true)} aria-label="Chats" title="Chats">
            <PanelLeft size={17} />
          </button>
          <div className="flex-1 min-w-0 text-sm font-bold truncate" dir="auto">{activeTitle ?? "New chat"}</div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={newChat} disabled={busy} aria-label="New chat" title="New chat">
            <Plus size={17} />
          </button>
        </div>

        <div ref={scroller} className="flex-1 overflow-y-auto px-3 py-3 sm:px-4 md:px-6 md:py-4">
          {loadErr && <p className="text-sm font-semibold text-bad-fg mb-3">{loadErr}</p>}
          {turns.length === 0 ? (
            <Welcome onPick={(q) => (canAsk ? ask(q) : setInput(q))} disabled={!canAsk || busy} compact={compact} />
          ) : (
            <div className="max-w-4xl mx-auto space-y-4 md:space-y-5">
              {turns.map((t, i) =>
                t.role === "user" ? (
                  <div key={i} className="flex flex-col items-end gap-1">
                    {t.files && t.files.length > 0 && (
                      <div className="flex flex-wrap justify-end gap-1.5 max-w-[88%] sm:max-w-[80%]">
                        {t.files.map((f) => (
                          <span key={f.id} className="pill pill-muted text-[11px]" dir="auto" title={`File #${f.id}`}>
                            <FileSpreadsheet size={12} /> {f.name}
                          </span>
                        ))}
                      </div>
                    )}
                    <div dir="auto" className="max-w-[88%] sm:max-w-[80%] rounded-2xl rounded-ee-md bg-brand-light px-3.5 py-2 text-[15px] whitespace-pre-wrap break-words">{t.text}</div>
                  </div>
                ) : (
                  <Answer
                    key={i}
                    turn={t}
                    live={busy && i === turns.length - 1 ? live : null}
                    streaming={busy && i === turns.length - 1}
                    actions={(t.actionIds ?? []).flatMap((id) => (actions[id] ? [actions[id]] : []))}
                    onAction={putAction}
                  />
                ),
              )}
            </div>
          )}
        </div>

        <form
          className="border-t px-2.5 pt-2.5 pb-2 md:px-3 md:pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            ask(input);
          }}
        >
          {!canAsk && (
            <p className="max-w-4xl mx-auto text-sm font-semibold text-warn-fg mb-2">
              {status.reason ?? "The AI allowance is used up."}
              {isOwner && <> <a href="/admin/ai" className="underline text-brand">Settings</a></>}
            </p>
          )}
          {(pending.length > 0 || uploading > 0 || fileErr) && (
            <div className="max-w-4xl mx-auto flex flex-wrap items-center gap-1.5 mb-2">
              {pending.map((f) => (
                <span key={f.id} className="pill pill-muted text-xs gap-1" dir="auto">
                  <FileSpreadsheet size={13} /> {f.name} <span className="text-muted">{fileSizeText(f.size)}</span>
                  <button type="button" onClick={() => unattach(f.id)} disabled={busy} className="-me-1 p-0.5 rounded hover:bg-surface-2" aria-label={`Remove ${f.name}`} title="Remove">
                    <X size={12} />
                  </button>
                </span>
              ))}
              {uploading > 0 && (
                <span className="text-xs text-muted inline-flex items-center gap-1"><Loader2 size={13} className="animate-spin" /> Sending the file…</span>
              )}
              {fileErr && <span className="text-xs font-semibold text-bad-fg" dir="auto">{fileErr}</span>}
            </div>
          )}
          <div className="max-w-4xl mx-auto flex items-end gap-2">
            <input ref={picker} type="file" accept={AI_FILE_ACCEPT} multiple hidden onChange={(e) => attach(e.target.files)} />
            <button
              type="button"
              className="btn btn-ghost h-10 w-10 !p-0 shrink-0"
              onClick={() => picker.current?.click()}
              disabled={!canAsk || busy || pending.length >= AI_FILE_LIMITS.perQuestion}
              aria-label="Attach a sheet"
              title="Attach a sheet (Excel or CSV) — to read it or import it"
            >
              <Paperclip size={18} />
            </button>
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
              rows={Math.min(5, Math.max(1, input.split("\n").length))}
              maxLength={AI_MAX_QUESTION}
              dir="auto"
              enterKeyHint="send"
              disabled={!canAsk}
              placeholder={canAsk ? "Ask about the plant…" : ""}
              // 16px: a phone zooms the page into a smaller box
              className="flex-1 min-w-0 resize-none px-3 py-2 text-base rounded-xl"
            />
            <button type="submit" className="btn btn-primary h-10 w-10 !p-0 shrink-0" disabled={!canAsk || busy || uploading > 0 || !input.trim()} aria-label="Send" title="Send">
              {busy ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
            </button>
          </div>
          <div className="max-w-4xl mx-auto text-end mt-1 text-[11px] text-muted tabnum">{meter}</div>
        </form>
      </section>
    </div>
  );
}

function Welcome({ onPick, disabled, compact }: { onPick: (q: string) => void; disabled: boolean; compact: boolean }) {
  return (
    <div className={`max-w-2xl mx-auto ${compact ? "pt-4" : "pt-2 sm:pt-8 md:pt-14"}`}>
      <div className="flex items-center justify-center gap-2.5">
        <span className="w-9 h-9 rounded-xl bg-brand-light text-brand grid place-items-center shrink-0">
          <Bot size={20} />
        </span>
        <p className="text-lg font-extrabold">Ask about the plant</p>
      </div>
      <div className={`grid grid-cols-1 ${compact ? "" : "sm:grid-cols-2"} gap-2 mt-4 sm:mt-6`}>
        {SUGGESTIONS.map((q, i) => (
          <button
            key={q}
            type="button"
            disabled={disabled}
            onClick={() => onPick(q)}
            dir="auto"
            // a phone and the side panel show the first four
            className={`${i >= 4 ? (compact ? "hidden" : "hidden sm:flex") : "flex"} text-start border rounded-xl px-3 py-2.5 text-sm hover:bg-surface-2 hover:border-[var(--border-strong)] transition-colors disabled:opacity-60 items-start gap-2`}
          >
            <MessageSquare size={15} className="text-muted mt-0.5 shrink-0" />
            <span>{q}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The cards keyed by the tool call that prepared them. */
function byCall(list: readonly AiActionView[]): Record<string, AiActionView> {
  const out: Record<string, AiActionView> = {};
  for (const v of list) if (v.toolUseId) out[v.toolUseId] = v;
  return out;
}

function Answer({ turn, live, streaming, actions, onAction }: { turn: Turn; live: string | null; streaming: boolean; actions: AiActionView[]; onAction: (v: AiActionView) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2.5">
      <div className="hidden sm:grid w-8 h-8 rounded-full bg-brand-light text-brand place-items-center shrink-0 mt-0.5">
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
        {actions.map((v) => <AiActionCard key={v.id} view={v} onChange={onAction} />)}
        {!streaming && <ApproveAll views={actions} onChange={onAction} />}
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
