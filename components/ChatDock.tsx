"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { MessagesSquare, X, Maximize2 } from "lucide-react";
import Link from "next/link";
import { pollChat } from "@/app/chat/actions";
import type { ChatContact } from "@/lib/server/chat";

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

const ChatClient = dynamic(() => import("./ChatClient").then((m) => m.ChatClient), {
  ssr: false,
  loading: () => <div className="h-full grid place-items-center text-sm text-muted">Opening chat…</div>,
});

export function ChatDock({ me, unread }: { me: { id: number; name: string }; unread: number }) {
  const [open, setOpen] = useState(false);
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
        onClick={() => setOpen((v) => !v)}
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
            <Link
              href="/chat"
              onClick={() => setOpen(false)}
              className="ms-auto rounded-md p-1.5 hover:bg-surface transition-colors text-muted"
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
              <ChatClient me={me} initialContacts={contacts} fill />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
