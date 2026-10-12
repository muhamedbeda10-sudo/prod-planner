"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { BellOff, BellRing, CheckCheck, ChevronDown, FileText, Inbox, Lightbulb, MessageSquare, Trash2 } from "lucide-react";
import { AiMarkdown } from "@/components/AiMarkdown";
import { AiActionCard, ApproveAll } from "@/components/AiActionCard";
import { EmptyState } from "@/components/primitives";
import { INBOX_CHANGED } from "@/components/InboxBell";
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

const KIND: Record<InboxKind, { icon: typeof FileText; tone: string; tile: string }> = {
  report: { icon: FileText, tone: "pill-info", tile: "bg-info-bg text-info-fg" },
  message: { icon: MessageSquare, tone: "pill-warn", tile: "bg-warn-bg text-warn-fg" },
  suggestion: { icon: Lightbulb, tone: "pill-ok", tile: "bg-ok-bg text-ok-fg" },
};

type Filter = "all" | "unread" | InboxKind;

const changed = () => window.dispatchEvent(new Event(INBOX_CHANGED));

function DevicePush() {
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
  if (state === null) return null;
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
  const k = KIND[item.kind] ?? KIND.message;
  const unread = !item.readAt;
  return (
    <article id={`item-${item.id}`} className={`rounded-xl border bg-surface transition-shadow ${unread ? "border-[color-mix(in_srgb,var(--brand)_45%,var(--border))] shadow-[var(--shadow-sm)]" : ""}`}>
      <button type="button" onClick={onToggle} className="w-full text-start flex items-start gap-3 px-3 py-3 sm:px-4" aria-expanded={open}>
        <span className={`w-9 h-9 rounded-lg grid place-items-center shrink-0 ${k.tile}`} title={INBOX_KIND_LABEL[item.kind]}>
          <k.icon size={17} aria-hidden />
        </span>
        <span className="flex-1 min-w-0">
          {/* the title keeps the line; on a narrow screen the rest wraps under it */}
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`min-w-0 flex-[1_1_10rem] truncate text-sm ${unread ? "font-bold" : "font-semibold"}`} dir="auto">
              {item.title}
              {unread && <span className="inline-block w-2 h-2 ms-2 rounded-full bg-[var(--brand)] align-middle" aria-label="not read" />}
            </span>
            {proposed.length > 0 && <span className="pill pill-info shrink-0">{proposed.length} to approve</span>}
            <span className="ms-auto text-[11px] text-muted tabnum shrink-0 whitespace-nowrap">{formatDateTime(item.createdAt)}</span>
          </span>
          {!open && (
            <span className="block mt-0.5 text-[13px] text-muted truncate" dir="auto">
              {item.fromName && <span className="font-medium text-foreground/80">{item.fromName} · </span>}
              {inboxPreview(item.body, 160)}
            </span>
          )}
        </span>
        <ChevronDown size={15} className={`text-muted shrink-0 mt-2.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <div className="px-3 pb-3 sm:px-4 sm:pb-4 border-t pt-3">
          {item.fromName && <p className="text-xs text-muted mb-2" dir="auto">{item.fromName}</p>}
          <AiMarkdown text={item.body} className="!text-[14px]" />
          {proposed.length > 1 && <ApproveAll views={proposed} onChange={onAction} />}
          {actions.map((a) => <AiActionCard key={a.id} view={a} onChange={onAction} />)}
          <div className="flex justify-end mt-3">
            <button type="button" className="btn btn-sm btn-ghost text-bad-fg" onClick={onDelete}><Trash2 size={14} aria-hidden /> Remove</button>
          </div>
        </div>
      )}
    </article>
  );
}

export function InboxView({ items: initial, actions: initialActions, openId }: { items: InboxItemView[]; actions: AiActionView[]; openId: number | null }) {
  const [items, setItems] = useState(initial);
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

  const readNow = (ids: number[] | "all") => {
    const now = new Date().toISOString();
    setItems((xs) => xs.map((x) => (ids === "all" || ids.includes(x.id) ? { ...x, readAt: x.readAt ?? now } : x)));
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
    { id: "report", label: "Reports" },
    { id: "message", label: "Messages" },
    { id: "suggestion", label: "Suggestions" },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="no-scrollbar flex items-center gap-1.5 min-w-0">
          {chips.map((c) => {
            const n = counts[c.id] ?? 0;
            if (c.id !== "all" && n === 0) return null;
            return (
              <button key={c.id} type="button" onClick={() => setFilter(c.id)} className={`chip ${filter === c.id ? "chip-on" : ""}`} aria-pressed={filter === c.id}>
                {c.label}{c.id !== "all" && <span className="chip-count">{n}</span>}
              </button>
            );
          })}
        </div>
        <div className="ms-auto flex flex-wrap items-center gap-1.5">
          <DevicePush />
          {unread > 0 && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => readNow("all")}><CheckCheck size={14} aria-hidden /> Mark all read</button>
          )}
        </div>
      </div>
      {err && <p className="text-sm font-semibold text-bad-fg">{err}</p>}
      {shown.length === 0 ? (
        <div className="rounded-xl border border-dashed">
          <EmptyState
            icon={Inbox}
            title={items.length === 0 ? "Nothing here yet" : filter === "unread" ? "All read" : "Nothing of that kind"}
            hint={items.length === 0 ? "Reports, messages and suggestions from the assistant and the automations land here, and on this device when notifications are on." : undefined}
          />
        </div>
      ) : (
        <div className="space-y-2">
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
