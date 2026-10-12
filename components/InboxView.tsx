"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { BellOff, BellRing, CheckCheck, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { AiMarkdown } from "@/components/AiMarkdown";
import { AiActionCard, ApproveAll } from "@/components/AiActionCard";
import { INBOX_CHANGED } from "@/components/InboxBell";
import { deleteInboxItems, markInboxRead } from "@/app/inbox/actions";
import { pushState, turnPushOff, turnPushOn, type PushState } from "@/lib/pushClient";
import { INBOX_KIND_LABEL, inboxPreview, type InboxKind } from "@/lib/domain/inbox";
import { formatDateTime } from "@/lib/domain/format";
import type { AiActionView } from "@/lib/domain/aiActions";

// The inbox: newest first, each item opened in place — its Markdown (charts
// included), and the changes it proposes as cards to approve. Opening an
// item marks it read. At the top, this device's notifications: on, off, or
// why they cannot be.

export interface InboxItemView {
  id: number;
  kind: InboxKind;
  title: string;
  body: string;
  fromName: string | null;
  createdAt: string;
  readAt: string | null;
  actionIds: number[];
}

const KIND_TONE: Record<InboxKind, string> = { report: "pill-info", message: "pill-warn", suggestion: "pill-ok" };

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
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {state === "on" ? (
        <>
          <BellRing size={16} className="text-ok-fg" aria-hidden />
          <span className="font-semibold">Notifications are on for this device.</span>
          <button type="button" className="btn btn-sm" disabled={pending} onClick={off}>Turn off</button>
        </>
      ) : state === "unsupported" ? (
        <span className="text-muted">This browser cannot receive notifications. On an iPhone or iPad, add the app to the Home Screen (Share → Add to Home Screen) and open it from there.</span>
      ) : state === "denied" ? (
        <>
          <BellOff size={16} className="text-muted" aria-hidden />
          <span className="text-muted">Notifications are blocked for this site — allow them in the browser&apos;s site settings to get these on this device.</span>
        </>
      ) : (
        <>
          <BellOff size={16} className="text-muted" aria-hidden />
          <span className="text-muted">Get these on this device even with the app closed.</span>
          <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={on}>{pending ? "Turning on…" : "Turn on notifications"}</button>
        </>
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
  const ref = useRef<HTMLDivElement>(null);
  const proposed = actions.filter((a) => a.status === "proposed");
  return (
    <div ref={ref} id={`item-${item.id}`} className={`border rounded-xl ${item.readAt ? "" : "border-[var(--brand)]"}`}>
      <button type="button" onClick={onToggle} className="w-full text-start flex flex-wrap items-center gap-2 px-3 py-2.5" aria-expanded={open}>
        {open ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
        {!item.readAt && <span className="w-2 h-2 rounded-full bg-[var(--brand)]" aria-label="not read" />}
        <span className={`pill ${KIND_TONE[item.kind] ?? "pill-muted"} text-[11px]`}>{INBOX_KIND_LABEL[item.kind] ?? item.kind}</span>
        <span className="font-extrabold" dir="auto">{item.title}</span>
        {proposed.length > 0 && <span className="pill pill-info text-[11px]">{proposed.length} to approve</span>}
        <span className="ms-auto text-xs text-muted tabnum">{formatDateTime(item.createdAt)}</span>
        {!open && <span className="basis-full text-sm text-muted truncate" dir="auto">{inboxPreview(item.body, 160)}</span>}
      </button>
      {open && (
        <div className="px-3 pb-3 border-t">
          {item.fromName && <p className="text-xs text-muted mt-2" dir="auto">From {item.fromName}</p>}
          <div className="text-sm"><AiMarkdown text={item.body} /></div>
          {proposed.length > 1 && <ApproveAll views={proposed} onChange={onAction} />}
          {actions.map((a) => <AiActionCard key={a.id} view={a} onChange={onAction} />)}
          <div className="flex justify-end mt-2">
            <button type="button" className="btn btn-sm btn-ghost text-bad-fg" onClick={onDelete}><Trash2 size={14} aria-hidden /> Remove</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function InboxView({ items: initial, actions: initialActions, openId }: { items: InboxItemView[]; actions: AiActionView[]; openId: number | null }) {
  const [items, setItems] = useState(initial);
  const [actions, setActions] = useState(() => new Map(initialActions.map((a) => [a.id, a])));
  const [openIds, setOpenIds] = useState<Set<number>>(() => new Set(openId ? [openId] : []));
  const [err, setErr] = useState<string | null>(null);
  const unread = useMemo(() => items.filter((i) => !i.readAt).length, [items]);

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

  return (
    <div className="space-y-3 max-w-4xl">
      <div className="card p-3 flex flex-wrap items-center gap-3">
        <DevicePush />
        {unread > 0 && (
          <button type="button" className="btn btn-sm ms-auto" onClick={() => readNow("all")}><CheckCheck size={14} aria-hidden /> Mark all read ({unread})</button>
        )}
      </div>
      {err && <p className="text-sm font-semibold text-bad-fg">{err}</p>}
      {items.length === 0 ? (
        <p className="text-muted text-sm">Nothing yet. Reports, messages and suggestions from the assistant and the automations arrive here.</p>
      ) : (
        items.map((it) => (
          <Item
            key={it.id}
            item={it}
            actions={it.actionIds.map((id) => actions.get(id)).filter((a): a is AiActionView => !!a)}
            open={openIds.has(it.id)}
            onToggle={() => toggle(it)}
            onDelete={() => remove(it)}
            onAction={onAction}
          />
        ))
      )}
    </div>
  );
}
