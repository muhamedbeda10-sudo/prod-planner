"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { MessagesSquare, X, Maximize2, Reply, Volume2, VolumeX, Bell, BellOff, BellRing } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { pollChat, pollChatInbox } from "@/app/chat/actions";
import { tellInboxHead } from "@/components/InboxBell";
import { CornerCard } from "@/components/primitives";
import { FloatWindow } from "@/components/FloatDock";
import { announceOpen, floatStore, isPhone, parseStored, useCloseWhenOtherOpens, usePhone } from "@/components/floatWindow";
import { clampDockWidth } from "@/lib/domain/aiDock";
import type { ChatContact, ChatInboxItem, ThreadKind } from "@/lib/server/chat";
import { factoryClockHHMM } from "@/lib/domain/dates";
import { armChime, chimeOn, playChime, setChimeOn } from "@/lib/chime";
import { appInBackground, askNotify, notifyPerm, onNotifyClick, prepareNotify, systemNotify, type NotifyPerm } from "@/lib/sysNotify";
import { startPoll } from "@/lib/poll";

// 💬 Chat as a corner icon, not a tab.
//
// Messaging is not a place you go — it is something you glance at while doing
// the actual work, and a full-screen tab made every glance cost the page you
// were on. The icon lives in the nav's right cluster with its unread badge;
// clicking it docks the chat down the right of the screen, top to bottom,
// and the page moves left beside it (components/FloatDock, as the assistant
// and the inbox do — one of the three is open at a time); its left edge is
// dragged to make it wider, and from about 670px it shows the contacts and
// the conversation side by side. The full page is still there behind the ⤢
// for a long conversation.
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
//
// While the app is out of sight (minimised, another window or tab) a message
// also raises a system notification with the OS sound — that one needs no
// click on the page, only a one-time "Allow", which a small card offers once
// and the bell in the panel header offers any time.
//
// Every open page polls, and each poll is a server call and a database
// round trip for the whole plant's worth of tabs — so a page in front asks
// every half minute, and one out of sight only every two minutes, enough to
// raise the system notification (browsers slow a hidden tab's timers to about
// that anyway). Coming back to the front asks at once.

const PACE = { visibleMs: 30_000, hiddenMs: 120_000 };
const MAX_CARDS = 4;
const seenKey = (userId: number) => `chat.popup.seen.${userId}`;
const ASKED_KEY = "notify.asked";

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

// on the factory clock, as the chat itself writes it
const timeOf = (iso: string) => factoryClockHHMM(new Date(iso));

// the docked window's width, kept on this browser
const dockStore = floatStore("chat-panel:v1");

const ChatClient = dynamic(() => import("./ChatClient").then((m) => m.ChatClient), {
  ssr: false,
  loading: () => <div className="h-full grid place-items-center text-sm text-muted">Opening chat…</div>,
});

export function ChatDock({ me, unread: initialUnread }: { me: { id: number; name: string }; unread: number }) {
  const [open, setOpen] = useState(false);
  const [contacts, setContacts] = useState<ChatContact[] | null>(null);
  const [err, setErr] = useState("");
  // closed, the chat is put away whole (its own polling stops) and its
  // contacts are read again the next time it opens
  const close = useCallback(() => {
    setOpen(false);
    setContacts(null);
    setErr("");
  }, []);
  // opening it closes the assistant's or the inbox's window, and theirs closes it
  const show = useCallback(
    (on: boolean) => {
      if (!on) return close();
      announceOpen("chat");
      setOpen(true);
    },
    [close],
  );
  useCloseWhenOtherOpens("chat", open, close);
  const dockRaw = useSyncExternalStore(dockStore.subscribe, dockStore.read, () => "");
  const dockWidth = useMemo(() => clampDockWidth(parseStored<{ width: number }>(dockRaw).width), [dockRaw]);
  const [liveUnread, setLiveUnread] = useState<number | null>(null);
  const unread = liveUnread ?? initialUnread;
  const [cards, setCards] = useState<ChatInboxItem[]>([]);
  const [openOn, setOpenOn] = useState<{ kind: ThreadKind; id: number } | null>(null);
  const pathname = usePathname();
  const router = useRouter();
  // the full chat page shows a message itself; the docked chat chimes for
  // one (it may be on another conversation) but pops no card over it
  const onChatPage = pathname === "/chat" || pathname.startsWith("/chat/");
  const phone = usePhone();
  // docked beside a page only — not over the chat page itself, nor a phone's
  const docked = open && !onChatPage && !phone;
  // going to the chat page puts the docked one away
  if (open && onChatPage) close();
  const quietRef = useRef({ page: false, docked: false });
  useEffect(() => {
    quietRef.current = { page: onChatPage, docked };
  }, [onChatPage, docked]);
  const cursorRef = useRef<number | null>(null);
  const [sound, setSound] = useState(true);
  useEffect(() => {
    armChime();
    const t = setTimeout(() => setSound(chimeOn()), 0); // localStorage only exists in the browser
    return () => clearTimeout(t);
  }, []);
  const [perm, setPerm] = useState<NotifyPerm>("unsupported");
  const [offer, setOffer] = useState(false); // the one-time "turn on desktop alerts" card
  useEffect(() => {
    prepareNotify();
    const t = setTimeout(() => {
      const p = notifyPerm();
      setPerm(p);
      let asked = false;
      try { asked = localStorage.getItem(ASKED_KEY) === "1"; } catch {}
      setOffer(p === "default" && !asked);
    }, 3000);
    return () => clearTimeout(t);
  }, []);
  const turnOnAlerts = async () => {
    const p = await askNotify();
    setPerm(p);
    setOffer(false);
    try { localStorage.setItem(ASKED_KEY, "1"); } catch {}
  };
  const notNow = () => {
    setOffer(false);
    try { localStorage.setItem(ASKED_KEY, "1"); } catch {}
  };

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
    // the bell's number comes with the same answer
    if (res.inbox) tellInboxHead(res.inbox);
    const fresh = first ? [] : (res.items ?? []);
    // out of sight: the OS notification carries it (even with the panel open)
    if (fresh.length > 0 && appInBackground()) {
      const m = fresh[0];
      void systemNotify({
        title: fresh.length > 1 ? `${fresh.length} new messages` : m.groupName ? `${m.fromName} in ${m.groupName}` : m.fromName,
        body: fresh.length > 1 ? fresh.slice(0, 3).map((x) => `${x.fromName}: ${x.snippet}`).join("\n") : m.snippet || "New message",
        tag: `chat-${m.id}`,
        url: `/chat?open=${m.kind}-${m.threadId}`,
        action: { kind: "chat", thread: { kind: m.kind, id: m.threadId } },
      });
    }
    if (fresh.length > 0 && !quietRef.current.page) playChime();
    if (fresh.length > 0 && !quietRef.current.page && !quietRef.current.docked) {
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

  useEffect(() => startPoll(poll, PACE, 1200), [poll]);

  // closing the panel refreshes the badge — reading there changed it
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) void poll();
    wasOpen.current = open;
  }, [open, poll]);

  const openThread = useCallback(
    (kind: ThreadKind, id: number) => {
      setCards([]);
      // the docked chat is for a wider screen; a phone gets the full chat page
      if (isPhone()) {
        router.push(`/chat?open=${kind}-${id}`);
        return;
      }
      setOpenOn({ kind, id });
      show(true);
    },
    [router, show],
  );
  const reply = (c: ChatInboxItem) => openThread(c.kind, c.threadId);

  // a click on a system notification lands here
  useEffect(() => onNotifyClick((a) => a.kind === "chat" && openThread(a.thread.kind, a.thread.id)), [openThread]);
  const dismiss = (id: number) => setCards((cur) => cur.filter((c) => c.id !== id));

  // docked beside the page, it stays open while the page is worked in —
  // the icon, its ✕ or Escape from inside it close it
  useEffect(() => {
    if (docked) load();
  }, [docked, load]);

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          setOpenOn(null);
          setCards([]);
          show(!docked);
        }}
        onMouseEnter={load}
        className={`nav-tab nav-tab-icon flex items-center relative ${docked ? "nav-tab-active" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={docked}
        aria-label={unread > 0 ? `Chat — ${unread} unread` : "Chat"}
        title={unread > 0 ? `Chat — ${unread} unread` : "Chat"}
      >
        <MessagesSquare size={18} />
        {unread > 0 && (
          <span className="count-badge count-badge-alert absolute -top-1 -right-1">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {/* portalled out of the sticky header (its own z-30 layer), beside the
          assistant's and the inbox's windows */}
      {docked && createPortal(
        <FloatWindow name="chat" label="Chat" edgeLabel="Resize the chat" layout="compact" shown width={dockWidth} onWidth={(width) => dockStore.write({ width })} onClose={close}>
          <div className="flex flex-col h-full min-h-0 bg-surface">
            <header className="ai-pop-head">
              <span className="ai-pop-logo"><MessagesSquare size={18} aria-hidden /></span>
              <div className="min-w-0 flex-1">
                <div className="ai-pop-title">Chat</div>
                <div className="ai-pop-sub">Messages with your colleagues</div>
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                {perm !== "unsupported" && (
                  <button
                    type="button"
                    onClick={() => perm === "default" && void turnOnAlerts()}
                    className={`icon-btn icon-btn-md ${perm === "granted" ? "text-brand-ink" : ""}`}
                    title={
                      perm === "granted" ? "Desktop alerts are on — they show when the app is minimised or on another tab"
                      : perm === "denied" ? "Desktop alerts are blocked — allow notifications from the lock icon in the address bar"
                      : "Turn on desktop alerts"
                    }
                    aria-label="Desktop alerts"
                  >
                    {perm === "granted" ? <BellRing size={17} /> : perm === "denied" ? <BellOff size={17} /> : <Bell size={17} />}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const on = !sound;
                    setSound(on);
                    setChimeOn(on);
                    if (on) playChime();
                  }}
                  className="icon-btn icon-btn-md"
                  title={sound ? "Sound on for messages and Odoo alerts — click to mute" : "Sound off — click to turn on"}
                  aria-label={sound ? "Mute message sound" : "Turn message sound on"}
                  aria-pressed={sound}
                >
                  {sound ? <Volume2 size={17} /> : <VolumeX size={17} />}
                </button>
                <Link href="/chat" onClick={close} className="icon-btn icon-btn-md" title="Open chat full screen" aria-label="Open chat full screen">
                  <Maximize2 size={17} />
                </Link>
                <button type="button" onClick={close} className="icon-btn icon-btn-md" aria-label="Close chat" title="Close">
                  <X size={17} />
                </button>
              </div>
            </header>
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
        </FloatWindow>,
        document.body,
      )}

      {offer && !docked && createPortal(
        <CornerCard
          role="dialog"
          label="Desktop alerts"
          icon={BellRing}
          title="Turn on desktop alerts?"
          className="z-50"
          actions={
            <>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => void turnOnAlerts()}>Turn on</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={notNow}>Not now</button>
            </>
          }
        >
          Messages and alerts reach you with a sound even when the app is minimised or on another tab.
        </CornerCard>,
        document.body,
      )}

      {/* portalled: inside the sticky header (its own z-30 layer) the cards
          could never sit above a page's own overlays */}
      {cards.length > 0 && !docked && createPortal(
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 right-[calc(1rem_+_var(--ai-dock-push,0px))] z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2 text-foreground"
        >
          {cards.slice(0, MAX_CARDS).map((c) => (
            <div
              key={c.id}
              className="flex gap-3 rounded-xl border border-l-4 border-l-brand bg-surface p-3 shadow-xl animate-[navdrop_0.2s_ease-out]"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-fill text-sm font-extrabold text-white">
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
                if (!isPhone()) show(true);
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
