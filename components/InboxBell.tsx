"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { pollInbox } from "@/app/inbox/actions";

// The bell in the bar: what the assistant and the automations sent this
// person, with the number not read yet. The number rides on the chat's own
// poll (every open page makes it anyway — one request, not two); the bell
// asks by itself only now and then as a fallback, when the page comes back
// to the front, and at once when the inbox page says it changed something.

/** The inbox page changed something — ask again now. */
export const INBOX_CHANGED = "inbox-changed";
/** A fresh count from the chat's poll (CustomEvent<number>). */
export const INBOX_UNREAD = "inbox-unread";
const FALLBACK_MS = 5 * 60_000;

export function InboxBell({ initial, active }: { initial: number; active: boolean }) {
  const [unread, setUnread] = useState(initial);

  useEffect(() => {
    let stop = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await pollInbox();
        if (!stop) setUnread(r.unread);
      } catch {
        /* offline for a moment — the next tick tries again */
      }
    };
    const fromChat = (e: Event) => setUnread((e as CustomEvent<number>).detail);
    const t = window.setInterval(refresh, FALLBACK_MS);
    const onShow = () => void refresh();
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener(INBOX_CHANGED, onShow);
    window.addEventListener(INBOX_UNREAD, fromChat);
    return () => {
      stop = true;
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener(INBOX_CHANGED, onShow);
      window.removeEventListener(INBOX_UNREAD, fromChat);
    };
  }, []);

  const label = unread > 0 ? `Inbox — ${unread} not read` : "Inbox";
  return (
    <Link href="/inbox" className={`nav-tab nav-tab-icon flex items-center gap-1 ${active ? "nav-tab-active" : ""}`} aria-label={label} title={label}>
      <Bell size={18} />
      {unread > 0 && <span className="count-badge count-badge-alert">{unread > 99 ? "99+" : unread}</span>}
    </Link>
  );
}
