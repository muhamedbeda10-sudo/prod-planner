"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle, BarChart3, Bot, Boxes, Check, ChevronDown, Clock, Copy, Factory, FileSpreadsheet, FileText, Image as ImageIcon, Layers, ListChecks, Loader2, MonitorPlay, PanelLeft, Paperclip, Plus, Search, Send, Trash2, X,
} from "lucide-react";
import { AiMarkdown } from "@/components/AiMarkdown";
import { AiActionCard, ApproveAll } from "@/components/AiActionCard";
import { AiPrintButton } from "@/components/AiPrint";
import { EmptyState } from "@/components/primitives";
import { deleteAiConversation, discardAiFile, loadAiConversation, uploadAiFile } from "@/app/ai/actions";
import { AI_MAX_QUESTION, usdText, type AiChatTurn } from "@/lib/domain/ai";
import { AI_FILE_ACCEPT, AI_FILE_LIMITS, AI_IMAGE_MAX_SIDE, AI_IMAGE_QUALITY, fileSizeText } from "@/lib/domain/aiFiles";
import { isSimulatorShow, SIMULATOR_HREF, type SimulatorShow } from "@/lib/domain/simulatorScreen";
import { compressImage } from "@/lib/imageCompress";
import { openSimulator, stageOnSimulator } from "@/lib/simulatorBridge";
import type { AiActionView } from "@/lib/domain/aiActions";
import type { AiChatStatus } from "@/lib/server/ai/panel";

// The AI assistant's chat: the person's conversations on the side (a drawer
// below a laptop's width, and always in the narrow side panel), the open one
// in the middle, the answer streaming in as it is written — what it looked up
// in one quiet line, the changes it prepares as cards to approve — and the
// allowance under the box. A photo, a PDF or a sheet can go with a question:
// the paperclip sends it to the app first (a photo shrunk to what reads
// well), and the question carries its number; the photo shows on the
// question after. With the What-if Simulator open on the page, a question
// carries the scenario on it, and a scenario the assistant shows goes
// straight onto it — or, with it closed, comes as a button that opens it
// with that scenario.

interface Turn extends AiChatTurn {
  error?: string;
  /** Scenarios the assistant showed on the Simulator during this answer —
   *  kept for this page's life only. */
  simulator?: SimulatorNote[];
}

/** A scenario the assistant showed, and whether it is on the Simulator yet. */
interface SimulatorNote extends SimulatorShow {
  shown: boolean;
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

const SUGGESTIONS: { q: string; icon: typeof Clock }[] = [
  { q: "إيه الأوردرات المتأخرة دلوقتي، وواقفة في أنهي قسم؟", icon: Clock },
  { q: "اعملي رسم بياني لإنتاج كل قسم في آخر 7 أيام", icon: BarChart3 },
  { q: "أنهي ماكينة عليها أكبر حمل شغل دلوقتي؟", icon: Factory },
  { q: "إيه الـ MOs اللي مستنية تتقفل في الأودو؟", icon: Boxes },
  { q: "لخصلي إنتاج امبارح واقترح أولويات النهارده", icon: ListChecks },
  { q: "Which open orders still have no nesting on the Material tab?", icon: Layers },
];

const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Which group of the list a conversation sits in, by when it was last used. */
function groupOf(iso: string, now: Date): string {
  const t = new Date(iso).getTime();
  const today = startOfDay(now);
  if (t >= today) return "Today";
  if (t >= today - DAY) return "Yesterday";
  if (t >= today - 7 * DAY) return "Previous 7 days";
  return "Earlier";
}
const GROUPS = ["Today", "Yesterday", "Previous 7 days", "Earlier"];

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
  const router = useRouter();
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
    } else if (ev.type === "simulator") {
      if (!isSimulatorShow(ev.show)) return;
      const show = ev.show;
      // on the Simulator at once when it is open on the page; a button otherwise
      const sim = openSimulator();
      if (sim) sim.show(show.scenario, show.label);
      patchLast((t) => ({ ...t, simulator: [...(t.simulator ?? []), { ...show, shown: sim !== null }] }));
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
    for (const raw of picked.slice(0, Math.max(0, room))) {
      // a phone photo is several MB: shrunk to what still reads well
      const f = await compressImage(raw, { maxDimension: AI_IMAGE_MAX_SIDE, quality: AI_IMAGE_QUALITY });
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

  /** A scenario the assistant showed, put on the Simulator: on it at once
   *  when it is open on the page, else left for it as it opens. */
  function showOnSimulator(s: SimulatorNote) {
    const sim = openSimulator();
    if (sim) sim.show(s.scenario, s.label);
    else {
      stageOnSimulator(s.scenario, s.label);
      router.push(SIMULATOR_HREF);
    }
    setTurns((all) =>
      all.map((t) => (t.simulator?.some((x) => x.toolUseId === s.toolUseId) ? { ...t, simulator: t.simulator.map((x) => (x.toolUseId === s.toolUseId ? { ...x, shown: true } : x)) } : t)),
    );
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
    // the Simulator open on the page: the assistant starts from what it shows
    const sim = openSimulator();
    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: activeId, question, fileIds: sent.map((f) => f.id), ...(sim ? { screen: { simulator: sim.scenario() } } : {}) }),
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
    status.userDayCap > 0 && `today ${of(spent.userToday, status.userDayCap)}`,
    `month ${of(spent.user, status.userCap)}`,
    isOwner && (status.plantCap > 0 || status.plantDayCap > 0) && `plant ${status.plantDayCap > 0 ? `today ${of(spent.plantToday, status.plantDayCap)}` : of(spent.plant, status.plantCap)}`,
  ].filter(Boolean).join(" · ");
  const activeTitle = convs.find((c) => c.id === activeId)?.title ?? null;

  // the conversations: beside the chat on a wide screen, a drawer over it in
  // the side panel and below a laptop's width
  const drawerCls = compact
    ? `${sideOpen ? "flex absolute z-20 inset-y-0 start-0 w-[min(18rem,85%)] shadow-2xl border-e" : "hidden"}`
    : `${sideOpen ? "flex fixed z-50 inset-y-0 start-0 w-[min(20rem,85vw)] shadow-2xl" : "hidden"} lg:static lg:z-auto lg:flex lg:w-64 lg:shadow-none lg:border-e`;
  const narrowOnly = compact ? "" : "lg:hidden";
  const now = new Date();
  const grouped = GROUPS.map((g) => ({ g, items: convs.filter((c) => groupOf(c.updatedAt, now) === g) })).filter((x) => x.items.length > 0);

  return (
    <div className="ai-chat relative flex h-full min-h-[380px]">
      {sideOpen && (
        <button
          type="button"
          aria-label="Close the chats"
          className={compact ? "absolute inset-0 z-10 bg-black/45" : "lg:hidden fixed inset-0 z-40 bg-black/45"}
          onClick={() => setSideOpen(false)}
        />
      )}
      <aside className={`${drawerCls} shrink-0 flex-col bg-surface overflow-hidden`}>
        <div className="p-2 flex gap-1.5">
          <button type="button" className="btn btn-primary btn-sm flex-1" onClick={newChat} disabled={busy}>
            <Plus size={15} /> New chat
          </button>
          {/* .btn sets its own display, so the hiding goes on a wrapper */}
          <span className={narrowOnly}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSideOpen(false)} aria-label="Close the chats"><X size={16} /></button>
          </span>
        </div>
        <nav className="flex-1 overflow-y-auto px-1.5 pb-2">
          {convs.length === 0 && <EmptyState icon={Bot} title="No chats yet" hint="Your questions will be kept here." compact />}
          {grouped.map(({ g, items }) => (
            <div key={g}>
              <div className="conv-group">{g}</div>
              {items.map((c) => (
                <div key={c.id} className={`conv-item ${c.id === activeId ? "conv-item-active" : ""}`}>
                  <button type="button" onClick={() => open(c.id)} className="flex-1 min-w-0 text-start px-2.5 py-1.5" disabled={busy}>
                    <div className={`text-[13px] truncate ${c.id === activeId ? "font-semibold text-brand" : "font-medium"}`} dir="auto">{c.title}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(c)}
                    disabled={busy}
                    className="conv-del icon-btn icon-btn-danger me-1"
                    title="Delete this chat"
                    aria-label={`Delete the chat ${c.title}`}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      {/* the open conversation */}
      <section className="flex-1 min-w-0 flex flex-col bg-surface overflow-hidden">
        <div className={`${narrowOnly} flex items-center gap-1 px-1.5 py-1 border-b`}>
          <button type="button" className="icon-btn" onClick={() => setSideOpen(true)} aria-label="Chats" title="Chats">
            <PanelLeft size={16} />
          </button>
          <div className="flex-1 min-w-0 text-[13px] font-semibold truncate px-1" dir="auto">{activeTitle ?? "New chat"}</div>
          <button type="button" className="icon-btn" onClick={newChat} disabled={busy} aria-label="New chat" title="New chat">
            <Plus size={16} />
          </button>
        </div>

        <div ref={scroller} className="flex-1 overflow-y-auto px-3 py-4 sm:px-5 md:px-8 md:py-6">
          {loadErr && <p className="text-sm font-semibold text-bad-fg mb-3">{loadErr}</p>}
          {turns.length === 0 ? (
            <Welcome onPick={(q) => (canAsk ? ask(q) : setInput(q))} disabled={!canAsk || busy} compact={compact} />
          ) : (
            <div className="max-w-3xl mx-auto space-y-6">
              {turns.map((t, i) =>
                t.role === "user" ? (
                  <div key={i} className="flex flex-col items-end gap-1.5">
                    {t.files && t.files.length > 0 && (
                      <div className="flex flex-wrap justify-end gap-1.5 max-w-[88%] sm:max-w-[78%]">
                        {t.files.map((f) => <SentFile key={f.id} file={f} />)}
                      </div>
                    )}
                    <div dir="auto" className="ai-bubble">{t.text}</div>
                  </div>
                ) : (
                  <Answer
                    key={i}
                    turn={t}
                    question={turns[i - 1]?.role === "user" ? turns[i - 1].text : ""}
                    live={busy && i === turns.length - 1 ? live : null}
                    streaming={busy && i === turns.length - 1}
                    actions={(t.actionIds ?? []).flatMap((id) => (actions[id] ? [actions[id]] : []))}
                    onAction={putAction}
                    onSimulator={showOnSimulator}
                  />
                ),
              )}
            </div>
          )}
        </div>

        <form
          className="px-3 pb-3 pt-1 sm:px-5 md:px-8"
          onSubmit={(e) => {
            e.preventDefault();
            ask(input);
          }}
        >
          <div className="max-w-3xl mx-auto">
            {!canAsk && (
              <div className="mb-2 flex items-start gap-2 rounded-lg border bg-surface-2 px-3 py-2 text-xs">
                <AlertCircle size={14} className="text-warn-fg mt-0.5 shrink-0" aria-hidden />
                <span className="min-w-0">
                  {status.reason ?? "The AI allowance is used up."}
                  {isOwner && <> <a href="/admin/ai" className="font-semibold text-brand underline underline-offset-2">Settings</a></>}
                </span>
              </div>
            )}
            <div className={`composer ${!canAsk ? "opacity-60" : ""}`}>
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
                enterKeyHint="send"
                disabled={!canAsk}
                placeholder={canAsk ? "Ask about the plant…" : ""}
                // 16px: a phone zooms the page into a smaller box
                className="w-full min-w-0 resize-none text-base leading-relaxed"
              />
              <div className="flex items-center gap-1.5 px-2 pb-2">
                <input ref={picker} type="file" accept={AI_FILE_ACCEPT} multiple hidden onChange={(e) => attach(e.target.files)} />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => picker.current?.click()}
                  disabled={!canAsk || busy || pending.length >= AI_FILE_LIMITS.perQuestion}
                  aria-label="Attach a photo, a PDF or a sheet"
                  title="Attach a photo, a PDF or a sheet (Excel, CSV) — to read it, take figures off it, or import it"
                >
                  <Paperclip size={16} />
                </button>
                <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5">
                  {pending.map((f) => (
                    <span key={f.id} className="pill pill-muted gap-1 max-w-full" dir="auto">
                      <FileKindIcon kind={f.kind} size={12} /> <span className="truncate">{f.name}</span> <span className="text-muted">{fileSizeText(f.size)}</span>
                      <button type="button" onClick={() => unattach(f.id)} disabled={busy} className="-me-1 p-0.5 rounded hover:bg-surface-3" aria-label={`Remove ${f.name}`} title="Remove">
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                  {uploading > 0 && (
                    <span className="text-xs text-muted inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> Sending…</span>
                  )}
                  {fileErr && <span className="text-xs font-semibold text-bad-fg" dir="auto">{fileErr}</span>}
                  {!fileErr && uploading === 0 && pending.length === 0 && (
                    <span className="hidden sm:inline text-[11px] text-muted tabnum ms-auto" title="What the assistant cost you">{meter}</span>
                  )}
                </div>
                <button type="submit" className="composer-send shrink-0" disabled={!canAsk || busy || uploading > 0 || !input.trim()} aria-label="Send" title="Send (Enter)">
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                </button>
              </div>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}

function Welcome({ onPick, disabled, compact }: { onPick: (q: string) => void; disabled: boolean; compact: boolean }) {
  return (
    <div className={`max-w-2xl mx-auto ${compact ? "pt-6" : "pt-4 sm:pt-10 md:pt-16"}`}>
      <div className="flex flex-col items-center text-center gap-2">
        <span className="w-12 h-12 rounded-2xl bg-brand-light text-brand grid place-items-center shrink-0">
          <Bot size={24} />
        </span>
        <h2 className="!text-xl !font-bold !normal-case !tracking-normal !text-foreground !mb-0">Ask about the plant</h2>
        <p className="text-sm text-muted max-w-md">Orders, output, machines, material, Odoo, shifts — answered from the live data. Changes it prepares wait for your approval.</p>
      </div>
      <div className={`grid grid-cols-1 ${compact ? "" : "sm:grid-cols-2"} gap-2 mt-6`}>
        {SUGGESTIONS.map(({ q, icon: Icon }, i) => (
          <button
            key={q}
            type="button"
            disabled={disabled}
            onClick={() => onPick(q)}
            dir="auto"
            // a phone and the side panel show the first four
            className={`${i >= 4 ? (compact ? "hidden" : "hidden sm:flex") : "flex"} text-start border rounded-xl px-3 py-2.5 text-sm bg-surface hover:bg-surface-2 hover:border-[var(--border-strong)] transition-colors disabled:opacity-60 items-start gap-2.5`}
          >
            <span className="w-7 h-7 rounded-lg bg-surface-2 text-muted grid place-items-center shrink-0"><Icon size={14} /></span>
            <span className="leading-snug pt-1">{q}</span>
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

/** What the assistant looked up on the way — one quiet line, the long
 *  ones folded. */
function Lookups({ items }: { items: string[] }) {
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, 3);
  return (
    <div className="ai-lookups mb-2">
      <Search size={12} className="shrink-0 opacity-70" aria-hidden />
      {shown.map((l, i) => <span key={i} dir="auto">{l}</span>)}
      {items.length > 3 && !all && (
        <button type="button" className="inline-flex items-center gap-0.5 font-semibold hover:text-foreground" onClick={() => setAll(true)}>
          +{items.length - 3} more <ChevronDown size={12} />
        </button>
      )}
    </div>
  );
}

function Answer({
  turn,
  question,
  live,
  streaming,
  actions,
  onAction,
  onSimulator,
}: {
  turn: Turn;
  /** The question it answers — the printout's title. */
  question: string;
  live: string | null;
  streaming: boolean;
  actions: AiActionView[];
  onAction: (v: AiActionView) => void;
  onSimulator: (s: SimulatorNote) => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-3">
      <div className="hidden sm:grid w-7 h-7 rounded-lg bg-brand-light text-brand place-items-center shrink-0 mt-0.5">
        <Bot size={15} />
      </div>
      <div className="flex-1 min-w-0">
        <Lookups items={turn.lookups} />
        {turn.text && <AiMarkdown text={turn.text} streaming={streaming} />}
        {live && (
          <div className="flex items-center gap-2 text-sm text-muted mt-1" dir="auto">
            <Loader2 size={14} className="animate-spin shrink-0" />
            {live}
          </div>
        )}
        {turn.simulator?.map((s) => <SimulatorLine key={s.toolUseId} note={s} onShow={() => onSimulator(s)} />)}
        {actions.map((v) => <AiActionCard key={v.id} view={v} onChange={onAction} />)}
        {!streaming && <ApproveAll views={actions} onChange={onAction} />}
        {turn.error && (
          <p className="text-sm font-semibold text-bad-fg mt-2 flex items-start gap-1.5"><AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden /> {turn.error}</p>
        )}
        {!streaming && turn.text && (
          <div className="mt-1.5 -ms-1">
            <button
              type="button"
              className="btn btn-ghost btn-sm text-xs"
              onClick={() => {
                navigator.clipboard?.writeText(turn.text).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
            </button>
            <AiPrintButton title={question.length > 90 ? `${question.slice(0, 89)}…` : question || "AI assistant"} subtitle="AI assistant" text={turn.text} className="text-xs" />
          </div>
        )}
      </div>
    </div>
  );
}

/** A scenario the assistant showed: on the Simulator already, or a button
 *  that opens the Simulator with it — and puts it back on after a change. */
function SimulatorLine({ note, onShow }: { note: SimulatorNote; onShow: () => void }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border px-3 py-2 text-sm">
      <MonitorPlay size={15} className="text-brand shrink-0" aria-hidden />
      <span className="flex-1 min-w-0">
        <span className="font-semibold">{note.shown ? "On your Simulator" : "For your Simulator"}</span>
        <span className="text-muted"> · {note.label}</span>
      </span>
      <button
        type="button"
        className={`btn btn-sm ${note.shown ? "btn-ghost" : "btn-primary"}`}
        onClick={onShow}
        title={note.shown ? "Put this scenario on the Simulator again" : "Open the What-if Simulator with this scenario"}
      >
        {note.shown ? "Show it again" : "Open on the Simulator"}
      </button>
    </div>
  );
}

function FileKindIcon({ kind, size }: { kind: string; size: number }) {
  if (kind === "image") return <ImageIcon size={size} />;
  if (kind === "pdf") return <FileText size={size} />;
  return <FileSpreadsheet size={size} />;
}

/** A file sent with a question: a photo as itself (opening full size), any
 *  other file as its name to download — or a note once it is no longer kept. */
function SentFile({ file }: { file: { id: number; name: string; kind: string } }) {
  const [gone, setGone] = useState(false);
  const href = `/api/ai/files/${file.id}`;
  if (file.kind === "image" && !gone) {
    return (
      <a href={href} target="_blank" rel="noopener" title={file.name} className="block">
        {/* eslint-disable-next-line @next/next/no-img-element -- a private file behind the session, not a static asset */}
        <img src={href} alt={file.name} loading="lazy" onError={() => setGone(true)} className="h-28 max-w-[14rem] rounded-xl border object-cover bg-surface-2" />
      </a>
    );
  }
  return (
    // a tab of its own: a file cleared since must not take the chat's place
    <a href={gone ? undefined : href} target="_blank" rel="noopener" className="pill pill-muted" dir="auto" title={gone ? "No longer kept" : `File #${file.id}`}>
      <FileKindIcon kind={file.kind} size={12} /> {file.name}{gone ? " — no longer kept" : ""}
    </a>
  );
}
