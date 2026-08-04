"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Send, ArrowLeft, MessagesSquare } from "lucide-react";
import { sendChatMessage, openChatThread, markChatThreadRead, pollChat } from "@/app/chat/actions";
import { subscribeChat, chatRealtimeConfigured, type ChatBroadcastPayload } from "@/lib/chatRealtime";
import type { ChatContact, ChatMessageDTO } from "@/lib/server/chat";

/* Two panes: contacts on the left, the open thread on the right. On mobile the
   panes take turns — the thread slides in over the list with a back arrow.
   Delivery is DB-first: Realtime broadcast (when configured) makes messages
   arrive live, and a poll covers everything else — no realtime env, a dropped
   socket, or another device reading the thread. */

// with realtime the poll is only a safety net; without it, it IS the transport
const POLL_MS = chatRealtimeConfigured ? 30000 : 5000;

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayOf = (iso: string) => iso.slice(0, 10);
const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "2-digit" });

export function ChatClient({ me, initialContacts }: { me: { id: number; name: string }; initialContacts: ChatContact[] }) {
  const [contacts, setContacts] = useState(initialContacts);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessageDTO[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // the handlers below live in effects/subscriptions — refs keep them reading
  // the CURRENT thread without resubscribing on every click
  const activeRef = useRef(activeId);
  const messagesRef = useRef(messages);
  useEffect(() => {
    activeRef.current = activeId;
  }, [activeId]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, activeId]);

  const appendUnique = useCallback((incoming: ChatMessageDTO[]) => {
    if (incoming.length === 0) return;
    setMessages((cur) => {
      const seen = new Set(cur.map((m) => m.id));
      const fresh = incoming.filter((m) => !seen.has(m.id));
      return fresh.length > 0 ? [...cur, ...fresh] : cur;
    });
  }, []);

  /** Reflect one message onto the contact list (preview + unread). */
  const touchContact = useCallback(
    (m: ChatMessageDTO, opts: { countUnread: boolean }) => {
      const partner = m.fromId === me.id ? m.toId : m.fromId;
      setContacts((cur) =>
        cur
          .map((c) =>
            c.id === partner
              ? {
                  ...c,
                  lastBody: m.body,
                  lastAt: m.createdAt,
                  lastFromMe: m.fromId === me.id,
                  unread: c.unread + (opts.countUnread && m.fromId === partner ? 1 : 0),
                }
              : c,
          )
          .sort(
            (a, b) =>
              Number(!!b.unread) - Number(!!a.unread) ||
              (b.lastAt ?? "").localeCompare(a.lastAt ?? "") ||
              a.name.localeCompare(b.name),
          ),
      );
    },
    [me.id],
  );

  const openThread = useCallback(async (otherId: number) => {
    activeRef.current = otherId; // sync now — the stale-reply check below can't wait for the effect
    setActiveId(otherId);
    setMessages([]);
    setError(null);
    setContacts((cur) => cur.map((c) => (c.id === otherId ? { ...c, unread: 0 } : c)));
    const res = await openChatThread(otherId);
    // ignore a reply that lands after the user already switched threads
    if (activeRef.current !== otherId) return;
    if (!res.ok) setError(res.error ?? "Could not load the conversation.");
    else setMessages(res.messages ?? []);
  }, []);

  // one catch-up poll: new thread messages + fresh unread counts
  const catchUp = useCallback(async () => {
    const open = activeRef.current;
    const lastId = messagesRef.current.at(-1)?.id ?? 0;
    const res = await pollChat(open, lastId);
    if (!res.ok) return;
    if (res.contacts) {
      // the open thread's unread stays 0 — reading it is this screen's job
      setContacts(res.contacts.map((c) => (c.id === activeRef.current ? { ...c, unread: 0 } : c)));
    }
    if (res.messages && res.messages.length > 0 && activeRef.current === open) {
      appendUnique(res.messages);
      if (open && res.messages.some((m) => m.fromId === open)) void markChatThreadRead(open);
    }
  }, [appendUnique]);

  // live delivery — my own topic carries everything addressed to OR sent by me
  useEffect(() => {
    const unsubscribe = subscribeChat(
      me.id,
      (p: ChatBroadcastPayload) => {
        const m = p.message;
        const partner = m.fromId === me.id ? m.toId : m.fromId;
        if (partner === activeRef.current) {
          appendUnique([m]);
          touchContact(m, { countUnread: false });
          if (m.toId === me.id) void markChatThreadRead(partner); // read as it arrives — the thread is on screen
        } else {
          touchContact(m, { countUnread: true });
        }
      },
      () => void catchUp(), // socket dropped — anything broadcast meanwhile is only in the DB
    );
    return unsubscribe;
  }, [me.id, appendUnique, touchContact, catchUp]);

  // the poll: transport without realtime, safety net with it
  useEffect(() => {
    const t = setInterval(() => void catchUp(), POLL_MS);
    return () => clearInterval(t);
  }, [catchUp]);

  const send = useCallback(async () => {
    const text = draft.trim();
    const to = activeRef.current;
    if (!text || !to || sending) return;
    setSending(true);
    setError(null);
    const res = await sendChatMessage(to, text);
    setSending(false);
    if (!res.ok || !res.message) {
      setError(res.error ?? "Could not send the message.");
      return;
    }
    setDraft("");
    appendUnique([res.message]);
    touchContact(res.message, { countUnread: false });
  }, [draft, sending, appendUnique, touchContact]);

  const active = useMemo(() => contacts.find((c) => c.id === activeId) ?? null, [contacts, activeId]);
  const totalUnread = contacts.reduce((s, c) => s + c.unread, 0);

  return (
    <div className="flex h-[calc(100vh-7rem)] overflow-hidden rounded-xl border bg-surface">
      {/* ===== contacts ===== */}
      <aside className={`${activeId !== null ? "hidden md:flex" : "flex"} w-full md:w-72 lg:w-80 shrink-0 flex-col border-r`}>
        <div className="px-4 py-3 border-b flex items-center gap-2">
          <MessagesSquare size={17} className="text-brand shrink-0" />
          <span className="font-bold text-sm">Chat</span>
          {totalUnread > 0 && (
            <span className="ml-auto grid place-items-center min-w-[20px] h-5 rounded-full bg-red-600 text-white text-[11px] font-extrabold px-1.5">
              {totalUnread > 99 ? "99+" : totalUnread}
            </span>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {contacts.length === 0 && (
            <p className="p-4 text-sm text-muted">No other users yet — the admin can add accounts from Users &amp; Permissions.</p>
          )}
          {contacts.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => void openThread(c.id)}
              className={`w-full text-left px-4 py-3 border-b flex items-center gap-3 transition-colors ${
                c.id === activeId ? "bg-brand-light/60" : "hover:bg-surface-2"
              }`}
            >
              <span className="w-9 h-9 shrink-0 rounded-full bg-brand-light text-brand font-extrabold grid place-items-center text-sm">
                {c.name.trim().charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className={`truncate text-sm ${c.unread > 0 ? "font-extrabold" : "font-semibold"}`}>{c.name}</span>
                  {c.isAdmin && <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-brand bg-brand-light rounded px-1 py-0.5">Admin</span>}
                  {c.lastAt && <span className="ml-auto shrink-0 text-[10px] text-muted tabnum">{timeOf(c.lastAt)}</span>}
                </span>
                <span className={`block truncate text-xs mt-0.5 ${c.unread > 0 ? "text-foreground font-semibold" : "text-muted"}`}>
                  {c.lastBody ? `${c.lastFromMe ? "You: " : ""}${c.lastBody}` : "No messages yet"}
                </span>
              </span>
              {c.unread > 0 && (
                <span className="shrink-0 grid place-items-center min-w-[20px] h-5 rounded-full bg-red-600 text-white text-[11px] font-extrabold px-1.5">
                  {c.unread > 99 ? "99+" : c.unread}
                </span>
              )}
            </button>
          ))}
        </div>
      </aside>

      {/* ===== thread ===== */}
      <section className={`${activeId === null ? "hidden md:flex" : "flex"} flex-1 min-w-0 flex-col`}>
        {active === null ? (
          <div className="flex-1 grid place-items-center text-center p-8">
            <div className="text-muted">
              <MessagesSquare size={40} className="mx-auto mb-3 opacity-40" />
              <p className="font-semibold">Pick a person to start chatting</p>
              <p className="text-xs mt-1">Messages are private between you and the person you send them to.</p>
            </div>
          </div>
        ) : (
          <>
            <div className="px-4 py-3 border-b flex items-center gap-3">
              <button
                type="button"
                onClick={() => setActiveId(null)}
                className="md:hidden -ml-1 rounded-lg p-1.5 hover:bg-surface-2 transition-colors"
                aria-label="Back to contacts"
              >
                <ArrowLeft size={18} />
              </button>
              <span className="w-8 h-8 shrink-0 rounded-full bg-brand-light text-brand font-extrabold grid place-items-center text-sm">
                {active.name.trim().charAt(0).toUpperCase()}
              </span>
              <span className="font-bold text-sm truncate">{active.name}</span>
            </div>

            <div ref={scrollerRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-1.5">
              {messages.map((m, i) => {
                const mine = m.fromId === me.id;
                const newDay = i === 0 || dayOf(m.createdAt) !== dayOf(messages[i - 1].createdAt);
                return (
                  <div key={m.id}>
                    {newDay && (
                      <div className="text-center my-3">
                        <span className="text-[10px] font-bold uppercase tracking-wide text-muted bg-surface-2 rounded-full px-2.5 py-1">
                          {dayLabel(m.createdAt)}
                        </span>
                      </div>
                    )}
                    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                      <div
                        className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                          mine ? "bg-brand text-white rounded-br-md" : "bg-surface-2 rounded-bl-md"
                        }`}
                      >
                        {m.body}
                        <span className={`block text-right text-[10px] mt-0.5 tabnum ${mine ? "text-white/70" : "text-muted"}`}>
                          {timeOf(m.createdAt)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            {error && <p className="px-4 py-2 text-xs font-semibold text-danger border-t">{error}</p>}

            <form
              className="border-t p-3 flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends, Shift+Enter makes a new line
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                maxLength={2000}
                placeholder={`Message ${active.name}…`}
                className="flex-1 resize-none rounded-xl border bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand max-h-32"
              />
              <button
                type="submit"
                disabled={sending || !draft.trim()}
                className="shrink-0 grid place-items-center w-10 h-10 rounded-xl bg-brand text-white transition-opacity disabled:opacity-40"
                aria-label="Send"
              >
                <Send size={17} />
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
