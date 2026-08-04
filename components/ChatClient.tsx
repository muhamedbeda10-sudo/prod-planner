"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Send, ArrowLeft, MessagesSquare, Paperclip, Package, ChevronDown, X,
  FileText, FileSpreadsheet, File as FileIcon, Trash2,
} from "lucide-react";
import {
  sendChatMessage, openChatThread, markChatThreadRead, pollChat,
  deleteChatMessageForMe, searchChatOrders,
} from "@/app/chat/actions";
import { subscribeChat, chatRealtimeConfigured, type ChatBroadcastPayload } from "@/lib/chatRealtime";
import { traceHref } from "@/lib/domain/links";
import type { ChatAttachment, ChatContact, ChatMessageDTO } from "@/lib/server/chat";

/* WhatsApp-familiar two-pane chat on the ATC palette: contacts left, thread
   right over a textured backdrop, my bubbles green-tinted. On mobile the panes
   take turns. Delivery is DB-first: Realtime broadcast (when configured) makes
   messages arrive live, and a poll covers everything else. A message can carry
   an ORDER CHIP (opens the MO's trace) and image / PDF / Office attachments;
   "delete" only hides a message from the deleting side. */

// with realtime the poll is only a safety net; without it, it IS the transport
const POLL_MS = chatRealtimeConfigured ? 30000 : 5000;

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayOf = (iso: string) => iso.slice(0, 10);
const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "2-digit" });

const sizeLabel = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const isImage = (a: ChatAttachment) => a.type.startsWith("image/");

function docIcon(name: string) {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["xls", "xlsx", "csv"].includes(ext)) return <FileSpreadsheetIcon />;
  if (["pdf", "doc", "docx"].includes(ext)) return <FileTextIcon />;
  return <FileIcon size={18} className="shrink-0" />;
}
const FileSpreadsheetIcon = () => <FileSpreadsheet size={18} className="shrink-0 text-brand" />;
const FileTextIcon = () => <FileText size={18} className="shrink-0 text-brand" />;

/** Contact-list preview when a message has no text. */
const previewLabel = (m: ChatMessageDTO) =>
  m.body ||
  (m.attachments.length > 0 ? (isImage(m.attachments[0]) ? "📷 Photo" : `📎 ${m.attachments[0].name}`) : m.mo ? `📦 ${m.mo}` : "");

const ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.bmp,.pdf,.xls,.xlsx,.csv,.doc,.docx";
const MAX_FILES = 6;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const AVATAR_COLORS = ["#1a8150", "#2b6cb0", "#d97706", "#7c3aed", "#c2410c", "#0e7490"];
const avatarColor = (id: number) => AVATAR_COLORS[id % AVATAR_COLORS.length];

function Avatar({ id, name, size = 9 }: { id: number; name: string; size?: 8 | 9 | 10 }) {
  const px = { 8: "w-8 h-8 text-xs", 9: "w-9 h-9 text-sm", 10: "w-10 h-10 text-sm" }[size];
  return (
    <span
      className={`${px} shrink-0 rounded-full text-white font-extrabold grid place-items-center shadow-sm`}
      style={{ background: avatarColor(id) }}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/** The order chip inside a bubble — opens the MO's full trace. */
function MoChip({ mo, mine }: { mo: string; mine: boolean }) {
  return (
    <Link
      href={traceHref({ mo })}
      className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 mb-1 text-xs font-bold border transition-colors ${
        mine ? "bg-white/40 border-black/10 hover:bg-white/60 dark:bg-black/20 dark:border-white/10 dark:hover:bg-black/30"
             : "bg-brand-light text-brand border-transparent hover:opacity-80"
      }`}
      title={`Open the trace for ${mo}`}
    >
      <Package size={13} className="shrink-0" />
      <span className="truncate max-w-[180px]">{mo}</span>
    </Link>
  );
}

function AttachmentView({ a }: { a: ChatAttachment }) {
  if (isImage(a)) {
    return (
      <a href={a.url} target="_blank" rel="noreferrer" className="block" title={`${a.name} — open full size`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- runtime uploads, size unknown at build */}
        <img src={a.url} alt={a.name} className="rounded-lg max-h-56 max-w-full object-cover shadow-sm" loading="lazy" />
      </a>
    );
  }
  return (
    <a
      href={a.url}
      target="_blank"
      rel="noreferrer"
      download={a.name}
      className="flex items-center gap-2.5 rounded-lg border border-black/10 dark:border-white/10 bg-white/50 dark:bg-black/20 px-2.5 py-2 hover:bg-white/80 dark:hover:bg-black/30 transition-colors"
      title={`Download ${a.name}`}
    >
      {docIcon(a.name)}
      <span className="min-w-0">
        <span className="block truncate text-xs font-bold max-w-[200px]">{a.name}</span>
        <span className="block text-[10px] opacity-60">{sizeLabel(a.size)}</span>
      </span>
    </a>
  );
}

export function ChatClient({ me, initialContacts }: { me: { id: number; name: string }; initialContacts: ChatContact[] }) {
  const [contacts, setContacts] = useState(initialContacts);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessageDTO[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // composer extras
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [pendingMo, setPendingMo] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // MO picker popover
  const [moOpen, setMoOpen] = useState(false);
  const [moQuery, setMoQuery] = useState("");
  const [moResults, setMoResults] = useState<{ mo: string; bom: string; status: string }[]>([]);

  // per-message menu: which message, and whether delete is armed
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [armedDelete, setArmedDelete] = useState<number | null>(null);

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

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, activeId]);

  // debounce the MO picker search
  useEffect(() => {
    if (!moOpen) return;
    const t = setTimeout(() => {
      void searchChatOrders(moQuery).then((r) => setMoResults(r.orders));
    }, 250);
    return () => clearTimeout(t);
  }, [moQuery, moOpen]);

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
                  lastBody: previewLabel(m),
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
    setMenuFor(null);
    setArmedDelete(null);
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

  const addFiles = useCallback((incoming: FileList | null) => {
    if (!incoming) return;
    setError(null);
    setPendingFiles((cur) => {
      const next = [...cur];
      for (const f of Array.from(incoming)) {
        if (next.length >= MAX_FILES) {
          setError(`Max ${MAX_FILES} files per message.`);
          break;
        }
        if (f.size > MAX_FILE_BYTES) {
          setError(`"${f.name}" is larger than 10 MB.`);
          continue;
        }
        next.push(f);
      }
      return next;
    });
  }, []);

  const send = useCallback(async () => {
    const text = draft.trim();
    const to = activeRef.current;
    if ((!text && pendingFiles.length === 0 && !pendingMo) || !to || sending) return;
    setSending(true);
    setError(null);

    const fd = new FormData();
    fd.set("to", String(to));
    fd.set("body", text);
    if (pendingMo) fd.set("mo", pendingMo);
    for (const f of pendingFiles) fd.append("files", f);

    const res = await sendChatMessage(fd);
    setSending(false);
    if (!res.ok || !res.message) {
      setError(res.error ?? "Could not send the message.");
      return;
    }
    setDraft("");
    setPendingFiles([]);
    setPendingMo(null);
    appendUnique([res.message]);
    touchContact(res.message, { countUnread: false });
  }, [draft, pendingFiles, pendingMo, sending, appendUnique, touchContact]);

  const deleteForMe = useCallback(async (id: number) => {
    setMenuFor(null);
    setArmedDelete(null);
    const res = await deleteChatMessageForMe(id);
    if (res.ok) setMessages((cur) => cur.filter((m) => m.id !== id));
  }, []);

  const active = useMemo(() => contacts.find((c) => c.id === activeId) ?? null, [contacts, activeId]);
  const totalUnread = contacts.reduce((s, c) => s + c.unread, 0);

  return (
    <div className="flex h-[calc(100vh-7rem)] overflow-hidden rounded-xl border bg-surface shadow-md">
      {/* ===== contacts ===== */}
      <aside className={`${activeId !== null ? "hidden md:flex" : "flex"} w-full md:w-72 lg:w-80 shrink-0 flex-col border-r`}>
        <div className="px-4 py-3 border-b flex items-center gap-2 bg-surface-2">
          <MessagesSquare size={17} className="text-brand shrink-0" />
          <span className="font-bold text-sm">Chat</span>
          {totalUnread > 0 && (
            <span className="ml-auto grid place-items-center min-w-[20px] h-5 rounded-full bg-brand text-white text-[11px] font-extrabold px-1.5">
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
              className={`w-full text-left px-3.5 py-3 border-b flex items-center gap-3 transition-colors ${
                c.id === activeId ? "bg-brand-light/60" : "hover:bg-surface-2"
              }`}
            >
              <Avatar id={c.id} name={c.name} size={10} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className={`truncate text-sm ${c.unread > 0 ? "font-extrabold" : "font-semibold"}`}>{c.name}</span>
                  {c.isAdmin && <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-brand bg-brand-light rounded px-1 py-0.5">Admin</span>}
                  {c.lastAt && <span className="ml-auto shrink-0 text-[10px] text-muted tabnum">{timeOf(c.lastAt)}</span>}
                </span>
                <span className={`block truncate text-xs mt-0.5 ${c.unread > 0 ? "text-foreground font-semibold" : "text-muted"}`} dir="auto">
                  {c.lastBody ? `${c.lastFromMe ? "You: " : ""}${c.lastBody}` : "No messages yet"}
                </span>
              </span>
              {c.unread > 0 && (
                <span className="shrink-0 grid place-items-center min-w-[20px] h-5 rounded-full bg-brand text-white text-[11px] font-extrabold px-1.5">
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
          <div className="flex-1 grid place-items-center text-center p-8" style={{ background: "var(--chat-bg)" }}>
            <div className="text-muted">
              <MessagesSquare size={40} className="mx-auto mb-3 opacity-40" />
              <p className="font-semibold">Pick a person to start chatting</p>
              <p className="text-xs mt-1">Messages are private between you and the person you send them to.</p>
            </div>
          </div>
        ) : (
          <>
            <div className="px-4 py-2.5 border-b flex items-center gap-3 bg-surface-2">
              <button
                type="button"
                onClick={() => setActiveId(null)}
                className="md:hidden -ml-1 rounded-lg p-1.5 hover:bg-surface transition-colors"
                aria-label="Back to contacts"
              >
                <ArrowLeft size={18} />
              </button>
              <Avatar id={active.id} name={active.name} size={9} />
              <span className="min-w-0">
                <span className="block font-bold text-sm truncate">{active.name}</span>
                <span className="block text-[10px] text-muted">
                  {chatRealtimeConfigured ? "live" : "updates every few seconds"}
                </span>
              </span>
            </div>

            {/* messages over the textured backdrop */}
            <div
              className="flex-1 overflow-y-auto px-3 md:px-6 py-3"
              style={{
                background: "var(--chat-bg)",
                backgroundImage: "radial-gradient(var(--chat-dots) 1px, transparent 1.2px)",
                backgroundSize: "18px 18px",
              }}
              onClick={() => {
                setMenuFor(null);
                setArmedDelete(null);
              }}
            >
              {messages.map((m, i) => {
                const mine = m.fromId === me.id;
                const newDay = i === 0 || dayOf(m.createdAt) !== dayOf(messages[i - 1].createdAt);
                return (
                  <div key={m.id}>
                    {newDay && (
                      <div className="text-center my-3">
                        <span className="text-[10px] font-bold uppercase tracking-wide rounded-lg px-2.5 py-1 bg-surface text-muted shadow-sm">
                          {dayLabel(m.createdAt)}
                        </span>
                      </div>
                    )}
                    <div className={`group flex ${mine ? "justify-end" : "justify-start"} mb-1`}>
                      <div
                        className="relative max-w-[80%] md:max-w-[65%] rounded-xl px-2.5 pt-1.5 pb-1 text-sm shadow-sm"
                        style={{
                          background: mine ? "var(--chat-mine)" : "var(--chat-theirs)",
                          color: mine ? "var(--chat-mine-fg)" : "var(--chat-theirs-fg)",
                          borderTopRightRadius: mine ? 4 : undefined,
                          borderTopLeftRadius: mine ? undefined : 4,
                        }}
                      >
                        {/* message menu (delete for me) — appears on hover / tap */}
                        <button
                          type="button"
                          aria-label="Message options"
                          onClick={(e) => {
                            e.stopPropagation();
                            setArmedDelete(null);
                            setMenuFor(menuFor === m.id ? null : m.id);
                          }}
                          className={`absolute top-0.5 ${mine ? "left-0.5" : "right-0.5"} rounded p-0.5 opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity`}
                        >
                          <ChevronDown size={14} />
                        </button>
                        {menuFor === m.id && (
                          <div
                            className={`absolute z-10 top-6 ${mine ? "left-1" : "right-1"} bg-surface text-foreground border rounded-lg shadow-lg overflow-hidden`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              onClick={() => (armedDelete === m.id ? void deleteForMe(m.id) : setArmedDelete(m.id))}
                              className="flex items-center gap-2 px-3 py-2 text-xs font-bold whitespace-nowrap hover:bg-surface-2 transition-colors text-danger"
                            >
                              <Trash2 size={13} className="shrink-0" />
                              {armedDelete === m.id ? "Tap again to confirm" : "Delete for me"}
                            </button>
                            <p className="px-3 pb-2 text-[10px] text-muted max-w-[180px]">
                              Removed from YOUR view only — {mine ? "the recipient" : "the sender"} keeps it.
                            </p>
                          </div>
                        )}

                        {m.mo && <MoChip mo={m.mo} mine={mine} />}
                        {m.attachments.length > 0 && (
                          <span className="flex flex-col gap-1.5 mb-1">
                            {m.attachments.map((a, j) => (
                              <AttachmentView key={j} a={a} />
                            ))}
                          </span>
                        )}
                        {m.body && (
                          <span className="whitespace-pre-wrap break-words" dir="auto">
                            {m.body}
                          </span>
                        )}
                        <span className="float-right ml-2 mt-1.5 text-[10px] tabnum" style={{ color: "var(--chat-time)" }}>
                          {timeOf(m.createdAt)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            {error && <p className="px-4 py-2 text-xs font-semibold text-danger border-t bg-surface">{error}</p>}

            {/* pending attachments / order chip — visible before sending */}
            {(pendingFiles.length > 0 || pendingMo) && (
              <div className="border-t bg-surface-2 px-3 py-2 flex flex-wrap items-center gap-1.5">
                {pendingMo && (
                  <span className="inline-flex items-center gap-1.5 rounded-lg bg-brand-light text-brand border border-brand/20 px-2 py-1 text-xs font-bold">
                    <Package size={13} />
                    {pendingMo}
                    <button type="button" onClick={() => setPendingMo(null)} aria-label="Remove order" className="hover:opacity-70">
                      <X size={13} />
                    </button>
                  </span>
                )}
                {pendingFiles.map((f, i) => (
                  <span key={i} className="inline-flex items-center gap-1.5 rounded-lg bg-surface border px-2 py-1 text-xs font-semibold max-w-[220px]">
                    {docIcon(f.name)}
                    <span className="truncate">{f.name}</span>
                    <span className="text-muted text-[10px] shrink-0">{sizeLabel(f.size)}</span>
                    <button
                      type="button"
                      onClick={() => setPendingFiles((cur) => cur.filter((_, j) => j !== i))}
                      aria-label={`Remove ${f.name}`}
                      className="hover:opacity-70 shrink-0"
                    >
                      <X size={13} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* MO picker popover */}
            {moOpen && (
              <div className="border-t bg-surface px-3 py-2.5">
                <div className="flex items-center gap-2 mb-1.5">
                  <Package size={14} className="text-brand shrink-0" />
                  <input
                    autoFocus
                    value={moQuery}
                    onChange={(e) => setMoQuery(e.target.value)}
                    placeholder="Search MO or BOM…"
                    className="flex-1 rounded-lg border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand"
                  />
                  <button type="button" onClick={() => setMoOpen(false)} aria-label="Close" className="text-muted hover:text-foreground">
                    <X size={16} />
                  </button>
                </div>
                {moQuery.trim().length >= 2 && (
                  <div className="max-h-40 overflow-y-auto rounded-lg border divide-y">
                    {moResults.length === 0 && <p className="px-3 py-2 text-xs text-muted">No matching orders.</p>}
                    {moResults.map((o) => (
                      <button
                        key={o.mo}
                        type="button"
                        onClick={() => {
                          setPendingMo(o.mo);
                          setMoOpen(false);
                          setMoQuery("");
                        }}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-surface-2 transition-colors flex items-center gap-2"
                      >
                        <span className="font-bold">{o.mo}</span>
                        <span className="text-muted truncate">{o.bom}</span>
                        {o.status === "closed" && (
                          <span className="ml-auto shrink-0 text-[9px] font-bold uppercase text-muted border rounded px-1">closed</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* composer */}
            <form
              className="border-t bg-surface-2 p-2.5 flex items-end gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPT}
                multiple
                hidden
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = ""; // same file can be re-picked
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Attach images, PDF, Excel or Word (max 10 MB each)"
                aria-label="Attach files"
                className="shrink-0 grid place-items-center w-10 h-10 rounded-full text-muted hover:text-brand hover:bg-surface transition-colors"
              >
                <Paperclip size={19} />
              </button>
              <button
                type="button"
                onClick={() => setMoOpen((v) => !v)}
                title="Attach an order (MO) — the recipient can open its trace"
                aria-label="Attach an order"
                className={`shrink-0 grid place-items-center w-10 h-10 rounded-full transition-colors ${
                  moOpen || pendingMo ? "text-brand bg-brand-light" : "text-muted hover:text-brand hover:bg-surface"
                }`}
              >
                <Package size={19} />
              </button>
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
                dir="auto"
                placeholder={`Message ${active.name}…`}
                className="flex-1 resize-none rounded-2xl border bg-surface px-3.5 py-2.5 text-sm outline-none focus:border-brand max-h-32"
              />
              <button
                type="submit"
                disabled={sending || (!draft.trim() && pendingFiles.length === 0 && !pendingMo)}
                className="shrink-0 grid place-items-center w-10 h-10 rounded-full bg-brand text-white shadow-sm transition-opacity disabled:opacity-40"
                aria-label="Send"
              >
                <Send size={17} className={sending ? "animate-pulse" : ""} />
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
