"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { pollInbox } from "@/app/inbox/actions";
import { startPoll } from "@/lib/poll";
import type { InboxHead } from "@/lib/domain/inbox";

// The bell in the bar: what the assistant and the automations sent this
// person, with the number not read yet. The number rides on the chat's own
// poll (every open page makes it anyway — one request, not two); the bell
// asks by itself only now and then as a fallback, when the page comes back
// to the front, and at once when the inbox page says it changed something.
// Either answer goes out as INBOX_UNREAD, which the popups
// (components/InboxAlerts) and the inbox's window listen to as well.

/** The inbox page changed something — ask again now. */
export const INBOX_CHANGED = "inbox-changed";
/** A fresh count and newest unread item (CustomEvent<InboxHead>). */
export const INBOX_UNREAD = "inbox-unread";
const PACE = { visibleMs: 5 * 60_000, hiddenMs: null };

/** Tell the bell, the popups and the inbox's window what the server said. */
export const tellInboxHead = (head: InboxHead) => window.dispatchEvent(new CustomEvent<InboxHead>(INBOX_UNREAD, { detail: head }));

export function InboxBell({ initial, active, onOpen }: { initial: number; active: boolean; /** Open the inbox in the AI panel instead of its page. */ onOpen?: () => void }) {
  const [unread, setUnread] = useState(initial);

  useEffect(() => {
    const refresh = async () => {
      try {
        tellInboxHead(await pollInbox());
      } catch {
        /* offline for a moment — the next tick tries again */
      }
    };
    const fromChat = (e: Event) => setUnread((e as CustomEvent<InboxHead>).detail.unread);
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
