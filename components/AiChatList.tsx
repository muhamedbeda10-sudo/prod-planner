"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Bot, CheckSquare, History, MessageSquare, Pencil, Pin, PinOff, Plus, Search, Trash2, X } from "lucide-react";
import type { ChatListApi, Conv, ListResult } from "@/components/AiChat";
import { EmptyState } from "@/components/primitives";
import { Loading } from "@/components/useTabData";
import { factoryDaysBefore } from "@/lib/domain/dates";
import { formatWhenShort } from "@/lib/domain/format";

// The assistant's chats: a search, then the chats grouped by when they were
// last used (the pinned ones first), each with its time and — on hover, or
// always on a touch screen — rename, pin and delete. "Select" (or Ctrl/⌘ +
// click on a chat) ticks several at once — Shift + click ticks a run of them
// — to pin or delete them together; Esc leaves the selection. The same list
// sits beside the chat in the large window and in place of it on a phone.

/** Which group of the list a conversation sits in, by when it was last used —
 *  counted in factory days, so the server and a browser in any zone agree. */
function groupOf(iso: string, now: Date, pinned = false): string {
  if (pinned) return "Pinned";
  const ago = factoryDaysBefore(new Date(iso), now);
  if (ago <= 0) return "Today";
  if (ago === 1) return "Yesterday";
  if (ago <= 7) return "Previous 7 days";
  return "Earlier";
}
const GROUPS = ["Pinned", "Today", "Yesterday", "Previous 7 days", "Earlier"];

export function ChatList({ api, onPick, onNew, heading = true }: { api: ChatListApi | null; onPick: (id: number) => void; onNew: () => void; heading?: boolean }) {
  const [q, setQ] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  // the last chat ticked — Shift + click ticks the run from it
  const anchor = useRef<number | null>(null);
  const allBox = useRef<HTMLInputElement>(null);

  const convs = useMemo(() => api?.convs ?? [], [api?.convs]);
  // each chat's group and time, read once when the chats change — not on every keystroke or tick
  const placed = useMemo(() => {
    const now = new Date();
    return convs.map((c) => ({ c, group: groupOf(c.updatedAt, now, c.pinned), when: formatWhenShort(c.updatedAt, now) }));
  }, [convs]);
  const needle = q.trim().toLowerCase();
  const shownPlaced = useMemo(() => (needle ? placed.filter((x) => x.c.title.toLowerCase().includes(needle)) : placed), [placed, needle]);
  const shown = useMemo(() => shownPlaced.map((x) => x.c), [shownPlaced]);
  const grouped = useMemo(
    () => GROUPS.map((g) => ({ g, items: shownPlaced.filter((x) => x.group === g) })).filter((x) => x.items.length > 0),
    [shownPlaced],
  );
  // the order on screen, for Shift + click
  const order = useMemo(() => grouped.flatMap((x) => x.items.map((y) => y.c)), [grouped]);
  // a chat deleted since it was ticked is not counted
  const chosen = useMemo(() => convs.filter((c) => picked.has(c.id)), [convs, picked]);
  const shownChosen = shown.filter((c) => picked.has(c.id)).length;
  const allShown = shown.length > 0 && shownChosen === shown.length;
  const busy = !!api?.busy;

  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = shownChosen > 0 && !allShown;
  }, [shownChosen, allShown]);

  const leave = () => {
    setSelecting(false);
    setPicked(new Set());
    anchor.current = null;
  };

  const tick = (c: Conv, range: boolean) => {
    // read before the anchor moves: the update below runs later
    const from = range && anchor.current !== null ? order.findIndex((x) => x.id === anchor.current) : -1;
    const to = order.findIndex((x) => x.id === c.id);
    const run = from >= 0 && to >= 0 ? order.slice(Math.min(from, to), Math.max(from, to) + 1) : [c];
    const on = !picked.has(c.id);
    setPicked((now) => {
      const next = new Set(now);
      for (const x of run) {
        if (on) next.add(x.id);
        else next.delete(x.id);
      }
      return next;
    });
    anchor.current = c.id;
  };

  const tickAll = () =>
    setPicked((now) => {
      const next = new Set(now);
      for (const c of shown) {
        if (allShown) next.delete(c.id);
        else next.add(c.id);
      }
      return next;
    });

  const startWith = (c: Conv) => {
    setSelecting(true);
    setPicked(new Set([c.id]));
    anchor.current = c.id;
  };

  // a move that failed says so here — the chat, where its other errors show, may be hidden behind this list
  const [error, setError] = useState<string | null>(null);
  const done = (r: ListResult, after?: () => void) => {
    setError(r.error ?? null);
    if (r.ok) after?.();
  };
  const anyUnpinned = chosen.some((c) => !c.pinned);
  const pinChosen = async () => {
    if (!api || chosen.length === 0) return;
    done(await api.pinMany(chosen, anyUnpinned), leave);
  };
  const deleteChosen = async () => {
    if (!api || chosen.length === 0) return;
    done(await api.removeMany(chosen), leave);
  };

  if (!api) return <Loading error={null} onRetry={() => undefined} />;

  return (
    <div
      className="chat-list"
      onKeyDown={(e) => {
        if (e.key === "Escape" && selecting) {
          e.stopPropagation();
          leave();
        }
      }}
    >
      <div className={`chat-list-head ${selecting ? "chat-list-head-on" : ""}`}>
        {selecting ? (
          <>
            <label className="chat-list-all">
              <input ref={allBox} type="checkbox" checked={allShown} onChange={tickAll} disabled={shown.length === 0} aria-label={allShown ? "Untick every chat shown" : "Tick every chat shown"} />
              <span className="tabnum" aria-live="polite">{chosen.length} selected</span>
            </label>
            <button type="button" className="icon-btn" onClick={() => void pinChosen()} disabled={busy || chosen.length === 0} title={anyUnpinned ? "Pin the selected chats" : "Unpin the selected chats"} aria-label={anyUnpinned ? "Pin the selected chats" : "Unpin the selected chats"}>
              {anyUnpinned || chosen.length === 0 ? <Pin size={15} /> : <PinOff size={15} />}
            </button>
            <button type="button" className="icon-btn icon-btn-danger" onClick={() => void deleteChosen()} disabled={busy || chosen.length === 0} title="Delete the selected chats" aria-label="Delete the selected chats">
              <Trash2 size={15} />
            </button>
            <button type="button" className="icon-btn" onClick={leave} title="Done (Esc)" aria-label="Leave the selection">
              <X size={15} />
            </button>
          </>
        ) : (
          <>
            {heading && <History size={15} className="text-muted shrink-0" aria-hidden />}
            <span className="chat-list-title">
              {heading && "Chats"}
              {convs.length > 0 && <span className={heading ? "chat-list-count tabnum" : "text-muted tabnum font-medium"}>{heading ? convs.length : `${convs.length} chat${convs.length === 1 ? "" : "s"}`}</span>}
            </span>
            <button type="button" className="icon-btn" onClick={() => setSelecting(true)} disabled={convs.length === 0} title="Select chats — to pin or delete several at once" aria-label="Select chats">
              <CheckSquare size={15} />
            </button>
            <button type="button" className="btn btn-primary btn-sm chat-list-new" onClick={onNew} disabled={busy}>
              <Plus size={14} aria-hidden /> New
            </button>
          </>
        )}
      </div>
      <div className="chat-list-search">
        <Search size={14} className="chat-list-search-icon" aria-hidden />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats…" aria-label="Search chats" />
      </div>
      {error && <p className="alert alert-bad chat-list-error" role="alert" dir="auto">{error}</p>}
      <nav className="chat-list-body" aria-label="Chats">
        {shown.length === 0 ? (
          <EmptyState compact icon={Bot} title={needle ? "No chat matches" : "No chats yet"} hint={needle ? "Try another word from its name." : "Your questions will be kept here."} />
        ) : (
          grouped.map(({ g, items }) => (
            <div key={g} role="group" aria-label={g}>
              <div className="conv-group">
                <span>{g}</span>
                <span className="conv-group-n tabnum">{items.length}</span>
              </div>
              {items.map(({ c, when }) => (
                <ConvRow
                  key={c.id}
                  c={c}
                  when={when}
                  active={c.id === api.activeId}
                  busy={busy}
                  selecting={selecting}
                  checked={picked.has(c.id)}
                  onTick={(range) => tick(c, range)}
                  onOpen={(e) => {
                    if (e.ctrlKey || e.metaKey) startWith(c);
                    else onPick(c.id);
                  }}
                  onRemove={() => void api.removeMany([c]).then((r) => done(r))}
                  onRename={() => void api.rename(c).then((r) => done(r))}
                  onPin={() => void api.pinMany([c], !c.pinned).then((r) => done(r))}
                />
              ))}
            </div>
          ))
        )}
      </nav>
    </div>
  );
}

/** One chat in the list: open it — or, while selecting, tick it. */
function ConvRow({
  c, when, active, busy, selecting, checked, onTick, onOpen, onRemove, onRename, onPin,
}: {
  c: Conv; when: string; active: boolean; busy: boolean; selecting: boolean; checked: boolean;
  onTick: (range: boolean) => void; onOpen: (e: MouseEvent) => void; onRemove: () => void; onRename: () => void; onPin: () => void;
}) {
  // a click's Shift, read as it starts — the change that follows (on the box
  // or through its label) does not carry it
  const shift = useRef(false);
  const icon = <span className="conv-icon" aria-hidden>{c.pinned ? <Pin size={12} /> : <MessageSquare size={12} />}</span>;
  const title = <span className="conv-title" dir="auto">{c.title}</span>;
  const time = <span className="conv-time tabnum">{when}</span>;
  if (selecting) {
    return (
      <label className={`conv-item conv-item-select ${checked ? "conv-item-checked" : ""}`} onClickCapture={(e) => { shift.current = e.shiftKey; }}>
        <input
          type="checkbox"
          className="conv-check"
          checked={checked}
          onChange={() => {
            onTick(shift.current);
            shift.current = false;
          }}
          aria-label={`Select the chat ${c.title}`}
        />
        {icon}
        {title}
        {time}
      </label>
    );
  }
  return (
    <div className={`conv-item ${active ? "conv-item-active" : ""}`}>
      <button type="button" onClick={onOpen} className="conv-main" disabled={busy} aria-current={active ? "true" : undefined} title={c.title}>
        {icon}
        {title}
        {time}
      </button>
      <div className="conv-acts">
        <button type="button" onClick={onRename} disabled={busy} className="icon-btn" title="Rename this chat" aria-label={`Rename the chat ${c.title}`}>
          <Pencil size={13} />
        </button>
        <button type="button" onClick={onPin} disabled={busy} className="icon-btn" title={c.pinned ? "Unpin" : "Pin to the top"} aria-label={`${c.pinned ? "Unpin" : "Pin"} the chat ${c.title}`} aria-pressed={!!c.pinned}>
          {c.pinned ? <PinOff size={13} /> : <Pin size={13} />}
        </button>
        <button type="button" onClick={onRemove} disabled={busy} className="icon-btn icon-btn-danger" title="Delete this chat" aria-label={`Delete the chat ${c.title}`}>
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}
