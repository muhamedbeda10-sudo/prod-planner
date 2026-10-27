"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { BellOff, BellRing, CheckCheck, ChevronDown, Inbox, Trash2 } from "lucide-react";
import { AiMarkdown } from "@/components/AiMarkdown";
import { AiPrintButton } from "@/components/AiPrint";
import { AiActionCard, ApproveAll } from "@/components/AiActionCard";
import { EmptyState } from "@/components/primitives";
import { INBOX_CHANGED } from "@/components/InboxBell";
import { INBOX_KIND_LOOK } from "@/components/inboxLook";
import { deleteInboxItems, markInboxRead } from "@/app/inbox/actions";
import { pushState, turnPushOff, turnPushOn, type PushState } from "@/lib/pushClient";
import { INBOX_KIND_LABEL, inboxPreview, type InboxKind } from "@/lib/domain/inbox";
import { formatDateTime } from "@/lib/domain/format";
import type { AiActionView } from "@/lib/domain/aiActions";
import type { InboxItemView } from "@/lib/server/ai/panel";

// The inbox: newest first, each item opened in place — its Markdown (charts
// included), and the changes it proposes as cards to approve. Opening an
// item marks it read. Above the list, a filter by what it is, this device's
// notifications switch, and Mark all read.

export type { InboxItemView };

/** What the inbox lists when it is not told: everything but a task's news,
 *  which is read on the task itself. */
const LISTED: readonly InboxKind[] = ["report", "message", "suggestion"];

const KIND_CHIP: Record<InboxKind, string> = { report: "Reports", message: "Messages", suggestion: "To approve", task: "Tasks" };

type Filter = "all" | "unread" | InboxKind;

const changed = () => window.dispatchEvent(new Event(INBOX_CHANGED));

/** This device's notifications: a switch — as a line of text and a button,
 *  or (compact) one icon button for a window's head. */
export function DevicePush({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<PushState | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    let live = true;
    pushState().then((s) => live && setState(s)).catch(() => live && setState("unsupported"));
    return () => {
      live = false;
    };
  }, []);
  const on = () =>
    start(async () => {
      setMsg(null);
      const err = await turnPushOn().catch(() => "Notifications could not be turned on — reload the page and try again.");
      setMsg(err);
      setState(await pushState());
    });
  const off = () =>
    start(async () => {
      setMsg(null);
      await turnPushOff().catch(() => setMsg("Notifications could not be turned off — reload the page and try again."));
      setState(await pushState());
    });
  if (state === null) return null;
  if (compact) {
    const label =
      state === "on" ? "Notifications are on for this device — turn them off"
      : state === "unsupported" ? "No notifications on this device — on an iPhone or iPad, add the app to the Home Screen and open it from there"
      : state === "denied" ? "Notifications are blocked by the browser — allow them in its settings"
      : "Turn on notifications for this device";
    const can = state !== "unsupported" && state !== "denied";
    return (
      <button
        type="button"
        className={`icon-btn icon-btn-md ${state === "on" ? "text-ok-fg" : ""}`}
        onClick={state === "on" ? off : on}
        disabled={pending || !can}
        title={msg ?? label}
        aria-label={label}
        aria-pressed={state === "on"}
      >
        {can ? <BellRing size={17} /> : <BellOff size={17} />}
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {state === "on" ? (
        <button type="button" className="btn btn-sm btn-ghost" disabled={pending} onClick={off} title="Notifications are on for this device — turn them off">
          <BellRing size={14} className="text-ok-fg" aria-hidden /> On this device
        </button>
      ) : state === "unsupported" ? (
        <span className="text-muted inline-flex items-center gap-1.5 px-1" title="On an iPhone or iPad, add the app to the Home Screen and open it from there.">
          <BellOff size={14} aria-hidden /> No notifications here
        </span>
      ) : state === "denied" ? (
        <span className="text-muted inline-flex items-center gap-1.5 px-1" title="Allow notifications for this site in the browser's settings.">
          <BellOff size={14} aria-hidden /> Blocked by the browser
        </span>
      ) : (
        <button type="button" className="btn btn-sm btn-secondary" disabled={pending} onClick={on}>
          <BellRing size={14} aria-hidden /> {pending ? "Turning on…" : "Notify this device"}
        </button>
      )}
      {msg && <span className="text-bad-fg font-semibold">{msg}</span>}
    </div>
  );
}

function Item({ item, actions, open, onToggle, onDelete, onAction }: {
  item: InboxItemView;
  actions: AiActionView[];
  open: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onAction: (v: AiActionView) => void;
}) {
  const proposed = actions.filter((a) => a.status === "proposed");
  const k = INBOX_KIND_LOOK[item.kind] ?? INBOX_KIND_LOOK.message;
  const unread = !item.readAt;
  return (
    <article id={`item-${item.id}`} className={`inbox-item ${unread ? "inbox-item-unread" : ""}`}>
      <button type="button" onClick={onToggle} className="w-full text-start flex items-start gap-2.5 px-3 py-2.5" aria-expanded={open}>
        <span className={`w-8 h-8 rounded-lg grid place-items-center shrink-0 ${k.tile}`} title={INBOX_KIND_LABEL[item.kind]}>
          <k.icon size={16} aria-hidden />
        </span>
        <span className="flex-1 min-w-0">
          {/* the title keeps the line; on a narrow screen the rest wraps under it */}
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className={`min-w-0 flex-[1_1_10rem] truncate text-sm ${unread ? "font-bold" : "font-semibold"}`} dir="auto">
              {item.title}
              {unread && <span className="sr-only"> (not read)</span>}
            </span>
            {proposed.length > 0 && <span className="pill pill-info shrink-0">{proposed.length} to approve</span>}
            <span className="ms-auto text-xs text-muted tabnum shrink-0 whitespace-nowrap">{formatDateTime(item.createdAt)}</span>
          </span>
          {!open && (
            <span className="block text-[13px] text-muted truncate" dir="auto">
              {item.fromName && <span className="font-medium text-foreground/80">{item.fromName} · </span>}
              {inboxPreview(item.body, 160)}
            </span>
          )}
        </span>
        <ChevronDown size={15} className={`text-muted shrink-0 mt-2 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <div className="px-3 pb-3 border-t pt-2.5">
          {item.fromName && <p className="text-xs text-muted mb-2" dir="auto">{item.fromName}</p>}
          <AiMarkdown text={item.body} shared className="!text-[14px]" />
          {proposed.length > 1 && <ApproveAll views={proposed} onChange={onAction} />}
          {actions.map((a) => <AiActionCard key={a.id} view={a} onChange={onAction} />)}
          <div className="flex justify-end gap-1 mt-3">
            <AiPrintButton title={item.title} subtitle={item.fromName ?? INBOX_KIND_LABEL[item.kind]} date={formatDateTime(item.createdAt)} text={item.body} />
            <button type="button" className="btn btn-sm btn-ghost text-bad-fg" onClick={onDelete}><Trash2 size={14} aria-hidden /> Remove</button>
          </div>
        </div>
      )}
    </article>
  );
}

export function InboxView({
  items: initial,
  actions: initialActions,
  openId,
  kinds = LISTED,
  device = true,
  emptyHint = "Reports, messages and suggestions from the assistant and the automations land here, and on this device when notifications are on.",
}: {
  items: InboxItemView[];
  actions: AiActionView[];
  openId: number | null;
  /** The kinds this list shows — an inbox tab's. */
  kinds?: readonly InboxKind[];
  /** This device's notifications switch above the list (the window keeps it in its head). */
  device?: boolean;
  emptyHint?: string;
}) {
  const [all, setItems] = useState(initial);
  const items = useMemo(() => all.filter((i) => kinds.includes(i.kind)), [all, kinds]);
  const [actions, setActions] = useState(() => new Map(initialActions.map((a) => [a.id, a])));
  const [openIds, setOpenIds] = useState<Set<number>>(() => new Set(openId ? [openId] : []));
  const [filter, setFilter] = useState<Filter>("all");
  const [err, setErr] = useState<string | null>(null);
  const unread = useMemo(() => items.filter((i) => !i.readAt).length, [items]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length, unread };
    for (const it of items) c[it.kind] = (c[it.kind] ?? 0) + 1;
    return c;
  }, [items, unread]);
  const shown = items.filter((it) => filter === "all" || (filter === "unread" ? !it.readAt : it.kind === filter));

  const readNow = (ids: number[]) => {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    setItems((xs) => xs.map((x) => (ids.includes(x.id) ? { ...x, readAt: x.readAt ?? now } : x)));
    markInboxRead(ids).then((r) => (r.ok ? changed() : setErr(r.error ?? "Could not mark it read."))).catch(() => setErr("Could not mark it read."));
  };

  // the item a notification opened (the page marked it read): in view, and
  // the bell told
  useEffect(() => {
    if (!openId) return;
    document.getElementById(`item-${openId}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    changed();
  }, [openId]);

  const toggle = (it: InboxItemView) => {
    setOpenIds((s) => {
      const n = new Set(s);
      if (n.has(it.id)) n.delete(it.id);
      else n.add(it.id);
      return n;
    });
    if (!it.readAt) readNow([it.id]);
  };

  const remove = (it: InboxItemView) => {
    if (!confirm(`Remove "${it.title}" from your inbox?`)) return;
    setItems((xs) => xs.filter((x) => x.id !== it.id));
    deleteInboxItems([it.id]).then((r) => (r.ok ? changed() : setErr(r.error ?? "Could not remove it."))).catch(() => setErr("Could not remove it."));
  };

  const onAction = (v: AiActionView) => setActions((m) => new Map(m).set(v.id, v));

  const chips: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "unread", label: "Unread" },
    // a tab of one kind needs no chip for it
    ...(kinds.length > 1 ? kinds.map((k) => ({ id: k, label: KIND_CHIP[k] })) : []),
  ];

  return (
    <div className="space-y-2.5">
      {/* one row: the filters scroll sideways on a narrow window, the buttons keep their place */}
      <div className="flex items-center gap-2">
        <div className="no-scrollbar flex flex-1 items-center gap-1.5 min-w-0">
          {items.length > 0 && chips.map((c) => {
            const n = counts[c.id] ?? 0;
            if (c.id !== "all" && n === 0) return null;
            return (
              <button key={c.id} type="button" onClick={() => setFilter(c.id)} className={`chip ${filter === c.id ? "chip-on" : ""}`} aria-pressed={filter === c.id}>
                {c.label}{c.id !== "all" && <span className="chip-count">{n}</span>}
              </button>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {device && <DevicePush />}
          {unread > 0 && (
            <button type="button" className="btn btn-sm btn-ghost whitespace-nowrap" onClick={() => readNow(items.filter((i) => !i.readAt).map((i) => i.id))}><CheckCheck size={14} aria-hidden /> Mark all read</button>
          )}
        </div>
      </div>
      {err && <p className="text-sm font-semibold text-bad-fg">{err}</p>}
      {shown.length === 0 ? (
        <div className="rounded-xl border border-dashed">
          <EmptyState
            icon={Inbox}
            title={items.length === 0 ? "Nothing here yet" : filter === "unread" ? "All read" : "Nothing of that kind"}
            hint={items.length === 0 ? emptyHint : undefined}
          />
        </div>
      ) : (
        <div className="space-y-1.5">
          {shown.map((it) => (
            <Item
              key={it.id}
              item={it}
              actions={it.actionIds.map((id) => actions.get(id)).filter((a): a is AiActionView => !!a)}
              open={openIds.has(it.id)}
              onToggle={() => toggle(it)}
              onDelete={() => remove(it)}
              onAction={onAction}
            />
          ))}
        </div>
      )}
    </div>
  );
}
