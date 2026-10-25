"use client";

import { EmptyState } from "@/components/primitives";

import { formatDate } from "@/lib/domain/format";
import { factoryClockHHMM, factoryDayISO } from "@/lib/domain/dates";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Send, ArrowLeft, MessagesSquare, Paperclip, Package, ChevronDown, X,
  FileText, FileSpreadsheet, File as FileGlyph, Trash2, Users, Plus,
  Pin, PinOff, LogOut, UserPlus, Reply, CheckCheck,
} from "lucide-react";
import {
  sendChatMessage, openChatThread, markChatThreadRead, pollChat,
  deleteChatMessageForMe, searchChatOrders, togglePinChatMessage,
  toggleChatReaction, createChatGroup, addChatGroupMembers, leaveChatGroup,
  getChatGroupMembers,
} from "@/app/chat/actions";
import {
  subscribeChat, chatRealtimeConfigured,
  type ChatBroadcastPayload,
} from "@/lib/chatRealtime";
import { compressImage } from "@/lib/imageCompress";
/** The quick-reaction row shown on a message's menu. */
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
import { traceHref } from "@/lib/domain/links";
import type { ChatAttachment, ChatContact, ChatMessageDTO, ThreadKind } from "@/lib/server/chat";

/* WhatsApp-familiar chat on the ATC palette: DMs and GROUPS in one list,
   pinned messages on a bar over the thread, emoji picker + reactions, order
   chips, image/document attachments (photos are compressed in the browser
   first). Delivery is DB-first: Realtime broadcast (when configured) makes
   events arrive live, and a poll covers everything else. */

type Thread = { kind: ThreadKind; id: number };
const sameThread = (a: Thread | null, b: Thread | null) => !!a && !!b && a.kind === b.kind && a.id === b.id;

// with realtime the poll is only a safety net; without it, it IS the transport
const POLL_MS = chatRealtimeConfigured ? 30000 : 5000;

// times and days on the factory clock, not the browser's: the server renders
// the thread first, and a browser in another zone would hydrate other text
const timeOf = (iso: string) => factoryClockHHMM(new Date(iso));
const dayOf = (iso: string) => factoryDayISO(new Date(iso));
const dayLabel = (iso: string) => formatDate(dayOf(iso));

const sizeLabel = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const isImage = (a: ChatAttachment) => a.type.startsWith("image/");

function docIcon(name: string) {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["xls", "xlsx", "csv"].includes(ext)) return <FileSpreadsheet size={18} className="shrink-0 text-brand-ink" />;
  if (["pdf", "doc", "docx"].includes(ext)) return <FileText size={18} className="shrink-0 text-brand-ink" />;
  return <FileGlyph size={18} className="shrink-0" />;
}

/** Contact-list preview when a message has no text. */
const previewLabel = (m: ChatMessageDTO) =>
  m.body ||
  (m.attachments.length > 0 ? (isImage(m.attachments[0]) ? "📷 Photo" : `📎 ${m.attachments[0].name}`) : m.mo ? `📦 ${m.mo}` : "");

const ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.bmp,.pdf,.xls,.xlsx,.csv,.doc,.docx";
const MAX_FILES = 6;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

// six hues cycled by account id — the theme's own (--avatar-1..6 in
// app/globals.css, lifted on the dark sheet so a sender's name stays
// readable): `.avatar-h1`…`.avatar-h6` set --avatar, which the disc, the
// sender's name and a quote's edge read
const avatarClass = (id: number) => `avatar-h${(id % 6) + 1}`;

function Avatar({ contact, size = 9 }: { contact: { kind: ThreadKind; id: number; name: string }; size?: 8 | 9 | 10 }) {
  const px = { 8: "w-8 h-8 text-xs", 9: "w-9 h-9 text-sm", 10: "w-10 h-10 text-sm" }[size];
  return (
    <span
      className={`${px} ${avatarClass(contact.id + (contact.kind === "group" ? 3 : 0))} avatar-disc shrink-0 rounded-full font-extrabold grid place-items-center shadow-sm`}
    >
      {contact.kind === "group" ? <Users size={size * 2 - 2} /> : contact.name.trim().charAt(0).toUpperCase()}
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
             : "bg-brand-light text-brand-ink border-transparent hover:opacity-80"
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

export function ChatClient({ me, initialContacts, fill = false, openOn = null }: {
  me: { id: number; name: string };
  initialContacts: ChatContact[];
  /** Inside the nav's chat popup, the panel already supplies the frame and the
   *  height — fill it instead of sizing against the viewport. */
  fill?: boolean;
  /** A conversation to open straight away (Reply on a message popup). A new
   *  object opens it again, so the same thread can be asked for twice. */
  openOn?: Thread | null;
}) {
  const [contacts, setContacts] = useState(initialContacts);
  const [active, setActive] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<ChatMessageDTO[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // composer extras
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [pendingMo, setPendingMo] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<ChatMessageDTO | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);

  // MO picker popover
  const [moOpen, setMoOpen] = useState(false);
  const [moQuery, setMoQuery] = useState("");
  const [moResults, setMoResults] = useState<{ mo: string; bom: string; status: string }[]>([]);

  // per-message menu: which message + a FIXED on-screen position. Rendered as
  // a floating layer (not inside the bubble) so the scroll container can never
  // clip it; coordinates are clamped to the viewport and flip upward when the
  // bubble sits near the bottom.
  const [menuFor, setMenuFor] = useState<{ id: number; x: number; y: number } | null>(null);
  const [armedDelete, setArmedDelete] = useState<number | null>(null);

  const MENU_W = 232;
  const MENU_H = 226;
  const openMenu = useCallback((e: React.MouseEvent, m: ChatMessageDTO, mine: boolean) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.min(Math.max(8, mine ? r.right - MENU_W : r.left), window.innerWidth - MENU_W - 8);
    let y = r.bottom + 6;
    if (y + MENU_H > window.innerHeight - 8) y = Math.max(8, r.top - MENU_H - 6);
    setArmedDelete(null);
    setMenuFor((cur) => (cur?.id === m.id ? null : { id: m.id, x, y }));
  }, []);

  // pinned bar + jump highlight
  const [pinsOpen, setPinsOpen] = useState(false);
  const [highlightId, setHighlightId] = useState<number | null>(null);

  // groups
  const [groupModal, setGroupModal] = useState<"create" | "add" | null>(null);
  const [groupName, setGroupName] = useState("");
  const [groupPicks, setGroupPicks] = useState<Set<number>>(new Set());
  const [groupMembers, setGroupMembers] = useState<{ id: number; name: string; lastReadId: number }[]>([]);
  const [groupCreatedBy, setGroupCreatedBy] = useState<number | null>(null);
  const [leaveArmed, setLeaveArmed] = useState(false);

  // the handlers below live in effects/subscriptions — refs keep them reading
  // the CURRENT thread without resubscribing on every click
  const activeRef = useRef(active);
  const messagesRef = useRef(messages);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, active]);

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

  /** The thread a message belongs to, from MY point of view. */
  const threadOf = useCallback(
    (m: ChatMessageDTO): Thread =>
      m.groupId ? { kind: "group", id: m.groupId } : { kind: "user", id: m.fromId === me.id ? (m.toId ?? 0) : m.fromId },
    [me.id],
  );

  /** Reflect one message onto the contact list (preview + unread). */
  const touchContact = useCallback(
    (m: ChatMessageDTO, opts: { countUnread: boolean }) => {
      const t = threadOf(m);
      setContacts((cur) =>
        cur
          .map((c) =>
            c.kind === t.kind && c.id === t.id
              ? {
                  ...c,
                  lastBody: previewLabel(m),
                  lastAt: m.createdAt,
                  lastFromMe: m.fromId === me.id,
                  lastFromName: m.fromId === me.id ? null : m.fromName,
                  unread: c.unread + (opts.countUnread && m.fromId !== me.id ? 1 : 0),
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
    [me.id, threadOf],
  );

  const openThread = useCallback(async (t: Thread) => {
    activeRef.current = t; // sync now — the stale-reply check below can't wait for the effect
    setActive(t);
    setMessages([]);
    setError(null);
    setMenuFor(null);
    setArmedDelete(null);
    setPinsOpen(false);
    setLeaveArmed(false);
    setReplyTarget(null);
    setGroupMembers([]);
    setGroupCreatedBy(null);
    setContacts((cur) => cur.map((c) => (c.kind === t.kind && c.id === t.id ? { ...c, unread: 0 } : c)));
    const [res, members] = await Promise.all([
      openChatThread(t.kind, t.id),
      t.kind === "group" ? getChatGroupMembers(t.id) : Promise.resolve(null),
    ]);
    // ignore a reply that lands after the user already switched threads
    if (!sameThread(activeRef.current, t)) return;
    if (!res.ok) setError(res.error ?? "Could not load the conversation.");
    else setMessages(res.messages ?? []);
    if (members?.ok) {
      setGroupMembers(members.members);
      setGroupCreatedBy(members.createdBy);
    }
  }, []);

  useEffect(() => {
    if (!openOn) return;
    const t = setTimeout(() => void openThread(openOn), 0);
    return () => clearTimeout(t);
  }, [openOn, openThread]);

  // one catch-up poll: new thread messages, a LIGHT state merge for what's
  // already on screen (pins / reads / reactions travel without bodies or
  // images), group read cursors, and fresh unread counts. This single call is
  // the whole transport when Realtime isn't configured.
  const catchUp = useCallback(async () => {
    const open = activeRef.current;
    const lastId = messagesRef.current.at(-1)?.id ?? 0;
    const res = await pollChat(open?.kind ?? null, open?.id ?? 0, lastId);
    if (!res.ok) return;
    if (res.contacts) {
      // the open thread's unread stays 0 — reading it is this screen's job
      setContacts(res.contacts.map((c) => (sameThread(activeRef.current, { kind: c.kind, id: c.id }) ? { ...c, unread: 0 } : c)));
    }
    if (!sameThread(activeRef.current, open)) return;
    if (res.messages && res.messages.length > 0) {
      appendUnique(res.messages);
      if (open && res.messages.some((m) => m.fromId !== me.id)) void markChatThreadRead(open.kind, open.id);
    }
    if (res.state && res.state.length > 0) {
      const stateOf = new Map(res.state.map((s) => [s.id, s]));
      setMessages((cur) =>
        cur.map((m) => {
          const s = stateOf.get(m.id);
          return s ? { ...m, pinnedAt: s.pinnedAt, readAt: s.readAt, reactions: s.reactions } : m;
        }),
      );
    }
    if (open?.kind === "group" && res.members && res.members.length > 0) setGroupMembers(res.members);
  }, [appendUnique, me.id]);

  // live delivery — my own topic carries every thread I'm part of
  useEffect(() => {
    const unsubscribe = subscribeChat(me.id, {
      onMessage: (p: ChatBroadcastPayload) => {
        const m = p.message;
        const t = threadOf(m);
        if (sameThread(t, activeRef.current)) {
          appendUnique([m]);
          touchContact(m, { countUnread: false });
          if (m.fromId !== me.id) void markChatThreadRead(t.kind, t.id); // read as it arrives — the thread is on screen
        } else {
          touchContact(m, { countUnread: true });
        }
      },
      // pins / reads / reactions / membership changed — one light catch-up
      // covers it all: state merge for the open thread + fresh contact list
      onSync: () => void catchUp(),
      onDrop: () => void catchUp(), // socket dropped — anything broadcast meanwhile is only in the DB
    });
    return unsubscribe;
  }, [me.id, appendUnique, touchContact, catchUp, threadOf]);

  // the poll: transport without realtime, safety net with it
  useEffect(() => {
    const t = setInterval(() => void catchUp(), POLL_MS);
    return () => clearInterval(t);
  }, [catchUp]);

  const addFiles = useCallback(async (incoming: FileList | null) => {
    if (!incoming) return;
    setError(null);
    // photos shrink in the browser BEFORE they queue — a 10 MB phone shot
    // becomes a light JPEG, which also keeps the no-Blob fallback possible
    const prepared = await Promise.all(Array.from(incoming).map((f) => compressImage(f)));
    setPendingFiles((cur) => {
      const next = [...cur];
      for (const f of prepared) {
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
    const t = activeRef.current;
    if ((!text && pendingFiles.length === 0 && !pendingMo) || !t || sending) return;
    setSending(true);
    setError(null);

    const fd = new FormData();
    fd.set("kind", t.kind);
    fd.set("to", String(t.id));
    fd.set("body", text);
    if (pendingMo) fd.set("mo", pendingMo);
    if (replyTarget) fd.set("replyTo", String(replyTarget.id));
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
    setReplyTarget(null);
    appendUnique([res.message]);
    touchContact(res.message, { countUnread: false });
  }, [draft, pendingFiles, pendingMo, replyTarget, sending, appendUnique, touchContact]);

  const deleteForMe = useCallback(async (id: number) => {
    setMenuFor(null);
    setArmedDelete(null);
    const res = await deleteChatMessageForMe(id);
    if (res.ok) setMessages((cur) => cur.filter((m) => m.id !== id));
  }, []);

  const togglePin = useCallback(async (m: ChatMessageDTO) => {
    setMenuFor(null);
    // optimistic — the sync broadcast will confirm for everyone else
    setMessages((cur) =>
      cur.map((x) => (x.id === m.id ? { ...x, pinnedAt: x.pinnedAt ? null : new Date().toISOString() } : x)),
    );
    await togglePinChatMessage(m.id);
  }, []);

  const react = useCallback(
    async (m: ChatMessageDTO, emoji: string) => {
      setMenuFor(null);
      // optimistic toggle of MY reaction — one per user, same emoji removes
      setMessages((cur) =>
        cur.map((x) => {
          if (x.id !== m.id) return x;
          const mine = x.reactions.find((r) => r.mine);
          let reactions = x.reactions
            .map((r) => (r.mine ? { ...r, count: r.count - 1, mine: false } : r))
            .filter((r) => r.count > 0);
          if (mine?.emoji !== emoji) {
            const hit = reactions.find((r) => r.emoji === emoji);
            reactions = hit
              ? reactions.map((r) => (r.emoji === emoji ? { ...r, count: r.count + 1, mine: true } : r))
              : [...reactions, { emoji, count: 1, mine: true }];
          }
          return { ...x, reactions };
        }),
      );
      await toggleChatReaction(m.id, emoji);
    },
    [],
  );

  const jumpToMessage = useCallback((id: number) => {
    document.getElementById(`chat-msg-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlightId(id);
    setTimeout(() => setHighlightId(null), 1600);
    setPinsOpen(false);
  }, []);

  const submitGroup = useCallback(async () => {
    if (groupModal === "create") {
      const res = await createChatGroup(groupName, [...groupPicks]);
      if (!res.ok || !res.groupId) {
        setError(res.error ?? "Could not create the group.");
        return;
      }
      setGroupModal(null);
      setGroupName("");
      setGroupPicks(new Set());
      await catchUp();
      void openThread({ kind: "group", id: res.groupId });
    } else if (groupModal === "add" && activeRef.current?.kind === "group") {
      const res = await addChatGroupMembers(activeRef.current.id, [...groupPicks]);
      if (!res.ok) setError(res.error ?? "Could not add members.");
      setGroupModal(null);
      setGroupPicks(new Set());
      const info = await getChatGroupMembers(activeRef.current.id);
      if (info.ok) setGroupMembers(info.members);
    }
  }, [groupModal, groupName, groupPicks, catchUp, openThread]);

  const leaveGroup = useCallback(async () => {
    const t = activeRef.current;
    if (!t || t.kind !== "group") return;
    await leaveChatGroup(t.id);
    setActive(null);
    activeRef.current = null;
    setLeaveArmed(false);
    void catchUp();
  }, [catchUp]);

  /** The ✓ / ✓✓ on MY messages: DM reads m.readAt; groups read every other
   *  member's cursor — all caught up turns the ticks "seen". */
  const ticksFor = useCallback(
    (m: ChatMessageDTO): { seen: boolean; title: string } | null => {
      if (m.fromId !== me.id) return null;
      if (m.groupId) {
        const others = groupMembers.filter((u) => u.id !== me.id);
        if (others.length === 0) return null;
        const seen = others.filter((u) => u.lastReadId >= m.id).length;
        return { seen: seen === others.length, title: `Seen by ${seen} of ${others.length}` };
      }
      return m.readAt
        ? { seen: true, title: `Seen at ${timeOf(m.readAt)}` }
        : { seen: false, title: "Delivered — not seen yet" };
    },
    [me.id, groupMembers],
  );

  const activeContact = useMemo(
    () => (active ? (contacts.find((c) => c.kind === active.kind && c.id === active.id) ?? null) : null),
    [contacts, active],
  );
  const totalUnread = contacts.reduce((s, c) => s + c.unread, 0);
  const pinned = useMemo(() => messages.filter((m) => m.pinnedAt), [messages]);
  const users = useMemo(() => contacts.filter((c) => c.kind === "user"), [contacts]);
  const pickableUsers = useMemo(
    () => (groupModal === "add" ? users.filter((u) => !groupMembers.some((m) => m.id === u.id)) : users),
    [groupModal, users, groupMembers],
  );

  return (
    <div className={`flex overflow-hidden bg-surface ${fill ? "h-full" : "h-[calc(100vh-7.75rem)] rounded-xl border shadow-md"}`}>
      {/* ===== contacts ===== */}
      <aside className={`${active !== null ? "hidden md:flex" : "flex"} w-full md:w-72 lg:w-80 shrink-0 flex-col border-r`}>
        <div className="px-4 py-3 border-b flex items-center gap-2 bg-surface-2">
          <MessagesSquare size={17} className="text-brand-ink shrink-0" />
          <span className="font-bold text-sm">Chat</span>
          {totalUnread > 0 && (
            <span className="grid place-items-center min-w-[20px] h-5 rounded-full bg-brand-fill text-white text-[11px] font-extrabold px-1.5">
              {totalUnread > 99 ? "99+" : totalUnread}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              setGroupModal("create");
              setGroupPicks(new Set());
              setGroupName("");
            }}
            title="New group"
            className="ml-auto inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-bold text-brand-ink hover:bg-brand-light transition-colors"
          >
            <Plus size={13} />
            Group
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {contacts.length === 0 && (
            <p className="p-4 text-sm text-muted">No other users yet — the admin can add accounts from Users &amp; Permissions.</p>
          )}
          {contacts.map((c) => (
            <button
              key={`${c.kind}:${c.id}`}
              type="button"
              onClick={() => void openThread({ kind: c.kind, id: c.id })}
              className={`w-full text-left px-3.5 py-3 border-b flex items-center gap-3 transition-colors ${
                sameThread(active, { kind: c.kind, id: c.id }) ? "bg-brand-light/60" : "hover:bg-surface-2"
              }`}
            >
              <Avatar contact={c} size={10} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className={`truncate text-sm ${c.unread > 0 ? "font-extrabold" : "font-semibold"}`}>{c.name}</span>
                  {c.kind === "group" && (
                    <span className="shrink-0 text-[9px] font-bold text-muted">{c.memberCount} 👥</span>
                  )}
                  {c.kind === "user" && c.isAdmin && (
                    <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-brand-ink bg-brand-light rounded px-1 py-0.5">Admin</span>
                  )}
                  {c.lastAt && <span className="ml-auto shrink-0 text-[10px] text-muted tabnum">{timeOf(c.lastAt)}</span>}
                </span>
                <span className={`block truncate text-xs mt-0.5 ${c.unread > 0 ? "text-foreground font-semibold" : "text-muted"}`} dir="auto">
                  {c.lastBody
                    ? `${c.lastFromMe ? "You: " : c.kind === "group" && c.lastFromName ? `${c.lastFromName}: ` : ""}${c.lastBody}`
                    : c.kind === "group" ? "Say hello 👋" : "No messages yet"}
                </span>
              </span>
              {c.unread > 0 && (
                <span className="shrink-0 grid place-items-center min-w-[20px] h-5 rounded-full bg-brand-fill text-white text-[11px] font-extrabold px-1.5">
                  {c.unread > 99 ? "99+" : c.unread}
                </span>
              )}
            </button>
          ))}
        </div>
      </aside>

      {/* ===== thread ===== */}
      <section className={`${active === null ? "hidden md:flex" : "flex"} flex-1 min-w-0 flex-col`}>
        {activeContact === null ? (
          <div className="flex-1 grid place-items-center p-8" style={{ background: "var(--chat-bg)" }}>
            <EmptyState icon={MessagesSquare} title="Pick a person or a group to start chatting" hint="Direct messages stay between the two of you; groups reach every member." />
          </div>
        ) : (
          <>
            <div className="px-4 py-2.5 border-b flex items-center gap-3 bg-surface-2">
              <button
                type="button"
                onClick={() => setActive(null)}
                className="md:hidden -ml-1 rounded-lg p-1.5 hover:bg-surface transition-colors"
                aria-label="Back to contacts"
              >
                <ArrowLeft size={18} />
              </button>
              <Avatar contact={activeContact} size={9} />
              <span className="min-w-0 flex-1">
                <span className="block font-bold text-sm truncate">{activeContact.name}</span>
                <span className="block text-[10px] text-muted truncate">
                  {activeContact.kind === "group"
                    ? groupMembers.map((m) => (m.id === me.id ? "You" : m.name)).join(", ") || `${activeContact.memberCount} members`
                    : chatRealtimeConfigured ? "live" : "updates every few seconds"}
                </span>
              </span>
              {activeContact.kind === "group" && (
                <span className="flex items-center gap-1">
                  {groupCreatedBy === me.id && (
                    <button
                      type="button"
                      onClick={() => {
                        setGroupModal("add");
                        setGroupPicks(new Set());
                      }}
                      title="Add members"
                      className="rounded-lg p-2 text-muted hover:text-brand-ink hover:bg-surface transition-colors"
                    >
                      <UserPlus size={16} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => (leaveArmed ? void leaveGroup() : setLeaveArmed(true))}
                    title={leaveArmed ? "Tap again to confirm leaving" : "Leave group"}
                    className={`rounded-lg p-2 transition-colors ${leaveArmed ? "text-bad-fg bg-bad-bg" : "text-muted hover:text-bad-fg hover:bg-surface"}`}
                  >
                    <LogOut size={16} />
                  </button>
                </span>
              )}
            </div>

            {/* pinned bar */}
            {pinned.length > 0 && (
              <div className="border-b bg-surface">
                <button
                  type="button"
                  onClick={() => setPinsOpen((v) => !v)}
                  className="w-full px-4 py-2 flex items-center gap-2 text-xs font-bold text-brand-ink hover:bg-surface-2 transition-colors"
                >
                  <Pin size={13} className="shrink-0" />
                  {pinned.length === 1 ? "1 pinned message" : `${pinned.length} pinned messages`}
                  <ChevronDown size={13} className={`transition-transform ${pinsOpen ? "rotate-180" : ""}`} />
                  {!pinsOpen && (
                    <span className="ml-1 min-w-0 truncate font-normal text-muted" dir="auto">
                      {previewLabel(pinned[pinned.length - 1])}
                    </span>
                  )}
                </button>
                {pinsOpen && (
                  <div className="max-h-36 overflow-y-auto border-t divide-y">
                    {pinned.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => jumpToMessage(p.id)}
                        className="w-full text-left px-4 py-2 text-xs hover:bg-surface-2 transition-colors flex items-center gap-2"
                      >
                        <span className="font-bold shrink-0">{p.fromId === me.id ? "You" : p.fromName}:</span>
                        <span className="truncate text-muted" dir="auto">{previewLabel(p)}</span>
                        <span className="ml-auto shrink-0 text-[10px] text-muted tabnum">{timeOf(p.createdAt)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

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
              onScroll={() => setMenuFor(null)}
            >
              {messages.map((m, i) => {
                const mine = m.fromId === me.id;
                const newDay = i === 0 || dayOf(m.createdAt) !== dayOf(messages[i - 1].createdAt);
                const showSender = activeContact.kind === "group" && !mine && (i === 0 || messages[i - 1].fromId !== m.fromId || newDay);
                return (
                  <div key={m.id} id={`chat-msg-${m.id}`}>
                    {newDay && (
                      <div className="text-center my-3">
                        <span className="text-[10px] font-bold uppercase tracking-wide rounded-lg px-2.5 py-1 bg-surface text-muted shadow-sm">
                          {dayLabel(m.createdAt)}
                        </span>
                      </div>
                    )}
                    <div className={`group flex ${mine ? "justify-end" : "justify-start"} mb-1`}>
                      <div
                        className={`relative max-w-[80%] md:max-w-[65%] rounded-xl px-2.5 pt-1.5 pb-1 text-sm shadow-sm transition-shadow ${
                          highlightId === m.id ? "ring-2 ring-brand" : ""
                        }`}
                        style={{
                          background: mine ? "var(--chat-mine)" : "var(--chat-theirs)",
                          color: mine ? "var(--chat-mine-fg)" : "var(--chat-theirs-fg)",
                          borderTopRightRadius: mine ? 4 : undefined,
                          borderTopLeftRadius: mine ? undefined : 4,
                        }}
                      >
                        {/* message menu trigger — the menu itself floats above
                            the page so the scroller can never clip it */}
                        <button
                          type="button"
                          aria-label="Message options"
                          onClick={(e) => openMenu(e, m, mine)}
                          className={`absolute top-0.5 ${mine ? "left-0.5" : "right-0.5"} rounded p-0.5 opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity`}
                        >
                          <ChevronDown size={14} />
                        </button>

                        {showSender && (
                          <span className={`block text-[11px] font-extrabold mb-0.5 ${avatarClass(m.fromId)} avatar-name`}>
                            {m.fromName}
                          </span>
                        )}
                        {m.pinnedAt && <Pin size={11} className={`absolute -top-1.5 ${mine ? "right-2" : "left-2"} text-brand-ink rotate-45`} />}
                        {m.replyTo && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              jumpToMessage(m.replyTo!.id);
                            }}
                            className={`block w-full text-left mb-1 rounded-lg px-2 py-1.5 bg-black/5 dark:bg-white/5 border-l-[3px] hover:bg-black/10 dark:hover:bg-white/10 transition-colors ${avatarClass(m.replyTo.fromId)} avatar-quote`}
                            title="Go to the quoted message"
                          >
                            <span className={`block text-[10px] font-extrabold ${avatarClass(m.replyTo.fromId)} avatar-name`}>
                              {m.replyTo.fromId === me.id ? "You" : m.replyTo.fromName}
                            </span>
                            <span className="block truncate text-[11px] opacity-70" dir="auto">
                              {m.replyTo.snippet}
                            </span>
                          </button>
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
                        <span className="float-right ml-2 mt-1.5 inline-flex items-center gap-0.5 text-[10px] tabnum" style={{ color: "var(--chat-time)" }}>
                          {timeOf(m.createdAt)}
                          {(() => {
                            const t = ticksFor(m);
                            if (!t) return null;
                            return (
                              <span title={t.title} aria-label={t.title} className="inline-flex">
                                <CheckCheck size={14} className={`shrink-0 ${t.seen ? "text-info-fg" : "opacity-50"}`} />
                              </span>
                            );
                          })()}
                        </span>
                        {/* reactions */}
                        {m.reactions.length > 0 && (
                          <span className={`absolute -bottom-3 ${mine ? "right-1" : "left-1"} flex gap-0.5`}>
                            {m.reactions.map((r) => (
                              <button
                                key={r.emoji}
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void react(m, r.emoji);
                                }}
                                className={`inline-flex items-center gap-0.5 rounded-full border bg-surface px-1.5 py-0.5 text-[11px] shadow-sm transition-transform hover:scale-110 ${
                                  r.mine ? "border-brand" : ""
                                }`}
                                title={r.mine ? "Tap to remove your reaction" : "React the same"}
                              >
                                {r.emoji}
                                {r.count > 1 && <span className="tabnum font-bold text-[10px]">{r.count}</span>}
                              </button>
                            ))}
                          </span>
                        )}
                      </div>
                    </div>
                    {m.reactions.length > 0 && <div className="h-3" />}
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            {error && <p className="px-4 py-2 text-xs font-semibold text-bad-fg border-t bg-surface">{error}</p>}

            {/* replying-to bar — what the next send will quote */}
            {replyTarget && (
              <div className="border-t bg-surface px-3 py-2 flex items-center gap-2.5">
                <Reply size={15} className="shrink-0 text-brand-ink" />
                <button
                  type="button"
                  onClick={() => jumpToMessage(replyTarget.id)}
                  className={`min-w-0 flex-1 text-left rounded-lg px-2 py-1 bg-surface-2 border-l-[3px] hover:opacity-80 transition-opacity ${avatarClass(replyTarget.fromId)} avatar-quote`}
                >
                  <span className={`block text-[10px] font-extrabold ${avatarClass(replyTarget.fromId)} avatar-name`}>
                    {replyTarget.fromId === me.id ? "You" : replyTarget.fromName}
                  </span>
                  <span className="block truncate text-[11px] text-muted" dir="auto">
                    {previewLabel(replyTarget)}
                  </span>
                </button>
                <button type="button" onClick={() => setReplyTarget(null)} aria-label="Cancel reply" className="shrink-0 text-muted hover:text-foreground">
                  <X size={15} />
                </button>
              </div>
            )}

            {/* pending attachments / order chip — visible before sending */}
            {(pendingFiles.length > 0 || pendingMo) && (
              <div className="border-t bg-surface-2 px-3 py-2 flex flex-wrap items-center gap-1.5">
                {pendingMo && (
                  <span className="inline-flex items-center gap-1.5 rounded-lg bg-brand-light text-brand-ink border border-brand/20 px-2 py-1 text-xs font-bold">
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
                  <Package size={14} className="text-brand-ink shrink-0" />
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
                  void addFiles(e.target.files);
                  e.target.value = ""; // same file can be re-picked
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Attach images, PDF, Excel or Word (max 10 MB each)"
                aria-label="Attach files"
                className="shrink-0 grid place-items-center w-10 h-10 rounded-full text-muted hover:text-brand-ink hover:bg-surface transition-colors"
              >
                <Paperclip size={19} />
              </button>
              <button
                type="button"
                onClick={() => setMoOpen((v) => !v)}
                title="Attach an order (MO) — the recipient can open its trace"
                aria-label="Attach an order"
                className={`shrink-0 grid place-items-center w-10 h-10 rounded-full transition-colors ${
                  moOpen || pendingMo ? "text-brand-ink bg-brand-light" : "text-muted hover:text-brand-ink hover:bg-surface"
                }`}
              >
                <Package size={19} />
              </button>
              <textarea
                ref={draftRef}
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
                placeholder={`Message ${activeContact.name}…`}
                className="flex-1 resize-none rounded-2xl border bg-surface px-3.5 py-2.5 text-sm outline-none focus:border-brand max-h-32"
              />
              <button
                type="submit"
                disabled={sending || (!draft.trim() && pendingFiles.length === 0 && !pendingMo)}
                className="shrink-0 grid place-items-center w-10 h-10 rounded-full bg-brand-fill text-white shadow-sm transition-opacity disabled:opacity-40"
                aria-label="Send"
              >
                <Send size={17} className={sending ? "animate-pulse" : ""} />
              </button>
            </form>
          </>
        )}
      </section>

      {/* ===== floating message menu — fixed layer, clipped by nothing ===== */}
      {menuFor &&
        (() => {
          const m = messages.find((x) => x.id === menuFor.id);
          if (!m) return null;
          return (
            <>
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => {
                  setMenuFor(null);
                  setArmedDelete(null);
                }}
                className="fixed inset-0 z-40 cursor-default"
              />
              <div
                className="fixed z-50 bg-surface text-foreground border rounded-xl shadow-lg overflow-hidden"
                style={{ left: menuFor.x, top: menuFor.y, width: MENU_W }}
              >
                {/* quick reactions */}
                <div className="flex items-center gap-0.5 px-2 pt-2 pb-1">
                  {QUICK_REACTIONS.map((e) => (
                    <button
                      key={e}
                      type="button"
                      onClick={() => void react(m, e)}
                      className={`grid place-items-center w-8 h-8 rounded-full text-base transition-transform hover:scale-125 ${
                        m.reactions.some((r) => r.mine && r.emoji === e) ? "bg-brand-light" : ""
                      }`}
                    >
                      {e}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setReplyTarget(m);
                    setMenuFor(null);
                    draftRef.current?.focus();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-bold whitespace-nowrap hover:bg-surface-2 transition-colors"
                >
                  <Reply size={13} className="shrink-0" />
                  Reply
                </button>
                <button
                  type="button"
                  onClick={() => void togglePin(m)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-bold whitespace-nowrap hover:bg-surface-2 transition-colors"
                >
                  {m.pinnedAt ? <PinOff size={13} className="shrink-0" /> : <Pin size={13} className="shrink-0" />}
                  {m.pinnedAt ? "Unpin" : "Pin"}
                </button>
                <button
                  type="button"
                  onClick={() => (armedDelete === m.id ? void deleteForMe(m.id) : setArmedDelete(m.id))}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-bold whitespace-nowrap hover:bg-surface-2 transition-colors text-bad-fg"
                >
                  <Trash2 size={13} className="shrink-0" />
                  {armedDelete === m.id ? "Tap again to confirm" : "Delete for me"}
                </button>
                <p className="px-3 pb-2 text-[10px] text-muted">
                  Delete removes it from YOUR view only — everyone else keeps it.
                </p>
              </div>
            </>
          );
        })()}

      {/* ===== group create / add-members modal ===== */}
      {groupModal && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setGroupModal(null)}
            className="absolute inset-0 bg-black/45 backdrop-blur-[2px]"
          />
          <div className="relative w-full max-w-sm bg-surface border rounded-xl shadow-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <Users size={17} className="text-brand-ink" />
              <span className="font-bold text-sm">{groupModal === "create" ? "New group" : "Add members"}</span>
              <button type="button" onClick={() => setGroupModal(null)} aria-label="Close" className="ml-auto text-muted hover:text-foreground">
                <X size={17} />
              </button>
            </div>
            {groupModal === "create" && (
              <input
                autoFocus
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                maxLength={60}
                placeholder="Group name — e.g. Welding team 🔧"
                className="w-full rounded-lg border bg-surface px-3 py-2 text-sm outline-none focus:border-brand mb-3"
              />
            )}
            <p className="text-[11px] font-bold uppercase tracking-wide text-muted mb-1.5">Members</p>
            <div className="max-h-52 overflow-y-auto rounded-lg border divide-y mb-3">
              {pickableUsers.length === 0 && <p className="px-3 py-2 text-xs text-muted">Everyone is already in.</p>}
              {pickableUsers.map((u) => (
                <label key={u.id} className="flex items-center gap-2.5 px-3 py-2 text-sm cursor-pointer hover:bg-surface-2 transition-colors">
                  <input
                    type="checkbox"
                    checked={groupPicks.has(u.id)}
                    onChange={(e) =>
                      setGroupPicks((cur) => {
                        const next = new Set(cur);
                        if (e.target.checked) next.add(u.id);
                        else next.delete(u.id);
                        return next;
                      })
                    }
                  />
                  <Avatar contact={u} size={8} />
                  <span className="font-semibold truncate">{u.name}</span>
                </label>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void submitGroup()}
              disabled={groupPicks.size === 0 || (groupModal === "create" && !groupName.trim())}
              className="w-full rounded-lg bg-brand-fill text-white font-bold text-sm py-2.5 transition-opacity disabled:opacity-40"
            >
              {groupModal === "create" ? `Create group (${groupPicks.size + 1} members)` : `Add ${groupPicks.size} member${groupPicks.size === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
