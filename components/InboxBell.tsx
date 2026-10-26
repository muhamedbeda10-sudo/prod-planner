"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { pollInbox } from "@/app/inbox/actions";
import { startPoll } from "@/lib/poll";

// The bell in the bar: what the assistant and the automations sent this
// person, with the number not read yet. The number rides on the chat's own
// poll (every open page makes it anyway — one request, not two); the bell
// asks by itself only now and then as a fallback, when the page comes back
// to the front, and at once when the inbox page says it changed something.

/** The inbox page changed something — ask again now. */
export const INBOX_CHANGED = "inbox-changed";
/** A fresh count from the chat's poll (CustomEvent<number>). */
export const INBOX_UNREAD = "inbox-unread";
const PACE = { visibleMs: 5 * 60_000, hiddenMs: null };

export function InboxBell({ initial, active, onOpen }: { initial: number; active: boolean; /** Open the inbox in the AI panel instead of its page. */ onOpen?: () => void }) {
  const [unread, setUnread] = useState(initial);

  useEffect(() => {
    const refresh = async () => {
      try {
        setUnread((await pollInbox()).unread);
      } catch {
        /* offline for a moment — the next tick tries again */
      }
    };
    const fromChat = (e: Event) => setUnread((e as CustomEvent<number>).detail);
    // the fallback asks only in front (out of sight nothing shows the number), the first one after the chat's own
    const stopPoll = startPoll(refresh, PACE, PACE.visibleMs);
    const onChanged = () => void refresh();
    window.addEventListener(INBOX_CHANGED, onChanged);
    window.addEventListener(INBOX_UNREAD, fromChat);
    return () => {
      stopPoll();
      window.removeEventListener(INBOX_CHANGED, onChanged);
      window.removeEventListener(INBOX_UNREAD, fromChat);
    };
  }, []);

  const label = unread > 0 ? `Inbox — ${unread} not read` : "Inbox";
  const inner = (
    <>
      <Bell size={18} />
      {unread > 0 && <span className="count-badge count-badge-alert">{unread > 99 ? "99+" : unread}</span>}
    </>
  );
  const cls = `nav-tab nav-tab-icon flex items-center gap-1 ${active ? "nav-tab-active" : ""}`;
  if (onOpen) {
    return <button type="button" onClick={onOpen} className={cls} aria-label={label} title={label}>{inner}</button>;
  }
  return <Link href="/inbox" className={cls} aria-label={label} title={label}>{inner}</Link>;
}
