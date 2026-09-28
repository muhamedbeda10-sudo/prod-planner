"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessagesSquare, X, Maximize2, Reply, Volume2, VolumeX } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { pollChat, pollChatInbox } from "@/app/chat/actions";
import type { ChatContact, ChatInboxItem, ThreadKind } from "@/lib/server/chat";
import { armChime, chimeOn, playChime, setChimeOn } from "@/lib/chime";

// 💬 Chat as a corner icon, not a tab.
//
// Messaging is not a place you go — it is something you glance at while doing
// the actual work, and a full-screen tab made every glance cost the page you
// were on. The icon lives in the nav's right cluster with its unread badge;
// clicking it drops a panel over the corner, and the page underneath is
// untouched. The full page is still there behind the ⤢ for a long conversation.
//
// The chat bundle is the heaviest client module in the app, so it is only
// fetched when the panel is first opened — a planner who never chats never
// downloads it.
//
// A message that arrives while the panel is closed pops up as a card in the
// bottom corner of whatever page is open — who sent it, the group, a preview —
// with Reply (opens the panel on that conversation) and ✕. A light poll finds
// them; the newest id already popped is kept per user in the browser, so a
// reload or a new page never pops the same message twice. Every new card
// plays a short chime; the speaker in the panel header mutes it.

const POLL_MS = 15000;
const MAX_CARDS = 4;
const seenKey = (userId: number) => `chat.popup.seen.${userId}`;

function readSeen(userId: number): number | null {
  try {
    const v = Number(localStorage.getItem(seenKey(userId)));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function writeSeen(userId: number, id: number) {
  try {
    localStorage.setItem(seenKey(userId), String(id));
  } catch {
    /* private window — the popups just start fresh next time */
  }
}

const timeOf = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const ChatClient = dynamic(() => import("./ChatClient").then((m) => m.ChatClient), {
  ssr: false,
  loading: () => <div className="h-full grid place-items-center text-sm text-muted">Opening chat…</div>,
});

export function ChatDock({ me, unread: initialUnread }: { me: { id: number; name: string }; unread: number }) {
  const [open, setOpen] = useState(false);
  const [liveUnread, setLiveUnread] = useState<number | null>(null);
  const unread = liveUnread ?? initialUnread;
  const [cards, setCards] = useState<ChatInboxItem[]>([]);
  const [openOn, setOpenOn] = useState<{ kind: ThreadKind; id: number } | null>(null);
  const pathname = usePathname();
  const router = useRouter();
  const quietRef = useRef(false); // panel open or on /chat — the chat itself shows them
  useEffect(() => {
    quietRef.current = open || pathname === "/chat";
  }, [open, pathname]);
  const cursorRef = useRef<number | null>(null);
  const [sound, setSound] = useState(true);
  useEffect(() => {
    armChime();
    const t = setTimeout(() => setSound(chimeOn()), 0); // localStorage only exists in the browser
    return () => clearTimeout(t);
  }, []);
  const [contacts, setContacts] = useState<ChatContact[] | null>(null);
  const [err, setErr] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // the contact list is fetched once, the first time the panel opens; the
  // chat's own polling keeps it current from there
  const load = useCallback(() => {
    if (contacts !== null) return;
    pollChat(null, 0, 0)
      .then((r) => (r.ok && r.contacts ? setContacts(r.contacts) : setErr(r.error ?? "Could not open chat.")))
      .catch(() => setErr("Could not open chat."));
  }, [contacts]);

  const poll = useCallback(async () => {
    if (cursorRef.current === null) cursorRef.current = readSeen(me.id);
    const first = cursorRef.current === null; // first ever — only set the cursor
    const res = await pollChatInbox(cursorRef.current ?? 0).catch(() => null);
    if (!res?.ok) return;
    setLiveUnread(res.unread ?? 0);
    const fresh = first ? [] : (res.items ?? []);
    if (fresh.length > 0 && !quietRef.current) {
      playChime();
      setCards((cur) => {
        const have = new Set(cur.map((c) => c.id));
        return [...fresh.filter((m) => !have.has(m.id)), ...cur].slice(0, 10);
      });
    }
    const next = Math.max(cursorRef.current ?? 0, res.latestId ?? 0);
    if (next !== cursorRef.current) {
      cursorRef.current = next;
      writeSeen(me.id, next);
    }
  }, [me.id]);

  useEffect(() => {
    const first = setTimeout(() => void poll(), 1200);
    const t = setInterval(() => void poll(), POLL_MS);
    const onVis = () => document.visibilityState === "visible" && void poll();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearTimeout(first);
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [poll]);

  // closing the panel refreshes the badge — reading there changed it
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) void poll();
    wasOpen.current = open;
  }, [open, poll]);

  const reply = (c: ChatInboxItem) => {
    setCards([]);
    // the corner panel is desktop-only; a phone gets the full chat page
    if (!window.matchMedia("(min-width: 768px)").matches) {
      router.push(`/chat?open=${c.kind}-${c.threadId}`);
      return;
    }
    setOpenOn({ kind: c.kind, id: c.threadId });
    setOpen(true);
  };
  const dismiss = (id: number) => setCards((cur) => cur.filter((c) => c.id !== id));

  useEffect(() => {
    if (!open) return;
    load();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    // pointerdown, not click: a click that starts inside the panel and ends
    // outside it (selecting a message) must not close the thing
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open, load]);

  return (
    <div className="relative shrink-0">
      <button
        ref={btnRef}
        type="button"
        onClick={() => {
          setOpenOn(null);
          setCards([]);
          setOpen((v) => !v);
        }}
        onMouseEnter={load}
        className={`nav-tab nav-tab-icon flex items-center relative ${open ? "nav-tab-active" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread > 0 ? `Chat — ${unread} unread` : "Chat"}
        title={unread > 0 ? `Chat — ${unread} unread` : "Chat"}
      >
        <MessagesSquare size={18} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-bad-fg text-white text-[10px] font-extrabold grid place-items-center tabnum">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Chat"
          // Anchored to the icon on desktop; on a phone it takes the screen,
          // where a corner panel would be unusable.
          className="fixed inset-x-2 bottom-2 top-16 z-50 flex flex-col rounded-xl border bg-surface text-foreground shadow-xl overflow-hidden md:absolute md:inset-auto md:right-0 md:top-[calc(100%+10px)] md:w-[860px] md:max-w-[92vw] md:h-[min(640px,calc(100vh-7rem))]"
        >
          <div className="flex items-center gap-2 px-3 py-2 border-b bg-surface-2 shrink-0">
            <MessagesSquare size={15} className="text-brand" />
            <b className="text-sm">Chat</b>
            <button
              type="button"
              onClick={() => {
                const on = !sound;
                setSound(on);
                setChimeOn(on);
                if (on) playChime();
              }}
              className="ms-auto rounded-md p-1.5 hover:bg-surface transition-colors text-muted"
              title={sound ? "Message sound on — click to mute" : "Message sound off — click to turn on"}
              aria-label={sound ? "Mute message sound" : "Turn message sound on"}
              aria-pressed={sound}
            >
              {sound ? <Volume2 size={15} /> : <VolumeX size={15} />}
            </button>
            <Link
              href="/chat"
              onClick={() => setOpen(false)}
              className="rounded-md p-1.5 hover:bg-surface transition-colors text-muted"
              title="Open chat full screen"
              aria-label="Open chat full screen"
            >
              <Maximize2 size={15} />
            </Link>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md p-1.5 hover:bg-surface transition-colors text-muted"
              aria-label="Close chat"
              title="Close"
            >
              <X size={16} />
            </button>
          </div>
          <div className="flex-1 min-h-0">
            {err ? (
              <p className="p-4 text-sm text-bad-fg">{err}</p>
            ) : contacts === null ? (
              <div className="h-full grid place-items-center text-sm text-muted">Opening chat…</div>
            ) : (
              <ChatClient me={me} initialContacts={contacts} fill openOn={openOn} />
            )}
          </div>
        </div>
      )}

      {/* portalled: inside the sticky header (its own z-30 layer) the cards
          could never sit above a page's own overlays */}
      {cards.length > 0 && !open && createPortal(
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 right-4 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2 text-foreground"
        >
          {cards.slice(0, MAX_CARDS).map((c) => (
            <div
              key={c.id}
              className="flex gap-3 rounded-xl border border-l-4 border-l-brand bg-surface p-3 shadow-xl animate-[navdrop_0.2s_ease-out]"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand text-sm font-extrabold text-white">
                {c.fromName.trim().charAt(0).toUpperCase() || "?"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <b className="truncate text-sm">{c.fromName}</b>
                  {c.groupName && <span className="truncate text-xs text-muted">in {c.groupName}</span>}
                  <span className="ms-auto shrink-0 text-[11px] text-muted tabnum">{timeOf(c.createdAt)}</span>
                </div>
                <p className="mt-0.5 line-clamp-2 break-words text-sm" dir="auto">{c.snippet || "New message"}</p>
                <div className="mt-2 flex items-center gap-2">
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => reply(c)}>
                    <Reply size={14} /> Reply
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => dismiss(c.id)}>Dismiss</button>
                </div>
              </div>
              <button
                type="button"
                onClick={() => dismiss(c.id)}
                className="self-start rounded-md p-1 text-muted hover:bg-surface-2"
                aria-label="Dismiss"
              >
                <X size={14} />
              </button>
            </div>
          ))}
          {cards.length > MAX_CARDS && (
            <button
              type="button"
              className="self-end rounded-full border bg-surface px-3 py-1 text-xs font-bold shadow"
              onClick={() => {
                setCards([]);
                if (window.matchMedia("(min-width: 768px)").matches) setOpen(true);
                else router.push("/chat");
              }}
            >
              +{cards.length - MAX_CARDS} more — open chat
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
