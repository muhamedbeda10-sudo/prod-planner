"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BellRing, Check, CheckCheck, ExternalLink } from "lucide-react";
import { INBOX_CHANGED, INBOX_UNREAD } from "@/components/InboxBell";
import { useInboxPanel } from "@/components/InboxPanel";
import { usePhone } from "@/components/floatWindow";
import { INBOX_KIND_LOOK } from "@/components/inboxLook";
import { loadInboxPopups, markInboxRead } from "@/app/inbox/actions";
import { armChime, playChime } from "@/lib/chime";
import { INBOX_KIND_LABEL, arrivedSince, headChanged, tabOfKind, type InboxHead, type InboxPopupItem } from "@/lib/domain/inbox";
import { formatDateTime } from "@/lib/domain/format";

// What reaches a person — an alert, a task or its news, a report or a message
// from an automation — pops up under the bell on whatever page is open, and
// stays there until they mark it read (there is no ✕): Open shows it in the
// inbox's window, Mark read clears the card. Either way it stays under the
// bell to come back to. What is unread lives on the server, so a reload or
// another device shows the same cards until they are read.
//
// It asks nothing on its own: the bar's poll (the chat's, or the bell's —
// which also asks at once when something is read anywhere) tells it the
// unread count and the newest unread item, and it fetches the cards only when
// that changes. A card newer than the page chimes, unless the sound is muted
// in the chat. The cards step aside while the inbox's window or page is open:
// the person is reading it there. A phone shows the newest card alone, the
// rest counted under it, so the page stays in sight.

const changed = () => window.dispatchEvent(new Event(INBOX_CHANGED));

export function InboxAlerts({ initial }: { initial: InboxHead }) {
  const [items, setItems] = useState<InboxPopupItem[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inbox = useInboxPanel();
  const phone = usePhone();
  const router = useRouter();
  const pathname = usePathname();
  // the head the page was served with, read once
  const served = useRef(initial);
  // the head the cards on screen were fetched for (null: ask on the next
  // word), and the newest item seen — what was waiting at page load does not chime
  const fetchedFor = useRef<InboxHead | null>(null);
  const seenMax = useRef(initial.latestId);
  const seq = useRef(0);

  const fetchCards = useCallback(async (head: InboxHead) => {
    const n = ++seq.current;
    const r = await loadInboxPopups().catch(() => null);
    if (n !== seq.current) return;
    if (!r?.ok) {
      // offline for a moment — the next word from the poll asks again
      fetchedFor.current = null;
      return;
    }
    fetchedFor.current = head;
    setItems(r.items);
    setTotal(r.total);
    const ids = r.items.map((i) => i.id);
    if (arrivedSince(ids, seenMax.current).length > 0) playChime();
    seenMax.current = Math.max(seenMax.current, ...ids);
  }, []);

  useEffect(() => {
    armChime();
    const first = served.current;
    if (first.unread > 0) void fetchCards(first);
    else fetchedFor.current = first;
    const onHead = (e: Event) => {
      const head = (e as CustomEvent<InboxHead>).detail;
      if (!fetchedFor.current || headChanged(fetchedFor.current, head)) void fetchCards(head);
    };
    window.addEventListener(INBOX_UNREAD, onHead);
    return () => window.removeEventListener(INBOX_UNREAD, onHead);
  }, [fetchCards]);

  const read = async (ids: number[] | "popups"): Promise<boolean> => {
    setErr(null);
    setBusy(true);
    const r = await markInboxRead(ids).catch(() => ({ ok: false, error: "Not marked read — check the connection and try again." }));
    setBusy(false);
    if (!r.ok) {
      setErr(r.error ?? "Not marked read.");
      return false;
    }
    if (ids === "popups") {
      setItems([]);
      setTotal(0);
    } else {
      setItems((xs) => xs.filter((x) => !ids.includes(x.id)));
      setTotal((t) => Math.max(0, t - ids.length));
    }
    // the bell asks again, and its answer brings the next cards and the
    // inbox's counts
    changed();
    return true;
  };

  const open = async (it: InboxPopupItem) => {
    if (!(await read([it.id]))) return;
    const tab = tabOfKind(it.kind);
    if (inbox) inbox.open({ tab, taskId: it.taskId ?? undefined, itemId: it.taskId ? null : it.id });
    else router.push(it.taskId ? `/inbox?task=${it.taskId}` : `/inbox?item=${it.id}`);
  };

  const onInboxPage = pathname === "/inbox" || pathname.startsWith("/inbox/");
  if (items.length === 0 || onInboxPage || inbox?.shown) return null;
  const cards = phone ? items.slice(0, 1) : items;
  const more = total - cards.length;

  return (
    <section className="inbox-alerts no-print" aria-label="New in your inbox">
      <p className="sr-only" role="status">{total === 1 ? "1 new item in your inbox" : `${total} new items in your inbox`}</p>
      {cards.map((it) => {
        const k = INBOX_KIND_LOOK[it.kind] ?? INBOX_KIND_LOOK.message;
        return (
          <article key={it.id} className="inbox-alert" aria-label={it.title}>
            <span className={`inbox-alert-tile ${k.tile}`} title={INBOX_KIND_LABEL[it.kind]}>
              <k.icon size={16} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <b className="inbox-alert-title" dir="auto">{it.title}</b>
                <span className="ms-auto shrink-0 text-xs text-muted tabnum whitespace-nowrap">{formatDateTime(it.createdAt)}</span>
              </div>
              {it.fromName && <div className="text-xs text-muted truncate" dir="auto">{it.fromName}</div>}
              {it.preview && <p className="inbox-alert-body" dir="auto">{it.preview}</p>}
              <div className="inbox-alert-actions">
                <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void open(it)}>
                  <ExternalLink size={14} aria-hidden /> Open
                </button>
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void read([it.id])}>
                  <Check size={14} aria-hidden /> Mark read
                </button>
              </div>
            </div>
          </article>
        );
      })}
      {(more > 0 || total > 1 || err) && (
        <div className="inbox-alerts-foot">
          {err ? (
            <span className="text-xs font-semibold text-bad-fg me-auto">{err}</span>
          ) : more > 0 ? (
            <button type="button" className="btn btn-sm btn-ghost me-auto" onClick={() => (inbox ? inbox.open({}) : router.push("/inbox"))}>
              <BellRing size={14} aria-hidden /> {more} more in the inbox
            </button>
          ) : (
            <span className="me-auto" />
          )}
          {total > 1 && (
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void read("popups")}>
              <CheckCheck size={14} aria-hidden /> Mark all read
            </button>
          )}
        </div>
      )}
    </section>
  );
}
