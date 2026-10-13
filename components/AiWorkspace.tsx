"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  ArrowLeft, Bell, BookOpen, Bot, Clock, FileText, History, Lightbulb, Loader2, Maximize2, MessageSquare, Minimize2, Plus, Search, Settings, Trash2, X,
} from "lucide-react";
import { AiChat, GROUPS, groupOf, type ChatListApi } from "@/components/AiChat";
import { InboxView } from "@/components/InboxView";
import { AutomationsView } from "@/components/AutomationsView";
import { PlaybookView } from "@/components/PlaybookView";
import { EmptyState, Tabs } from "@/components/primitives";
import { INBOX_CHANGED, INBOX_UNREAD } from "@/components/InboxBell";
import { pollInbox } from "@/app/inbox/actions";
import { loadAiChat, loadAutomations, loadInbox, loadPlaybook } from "@/app/ai/panel/actions";
import { formatDateTime } from "@/lib/domain/format";
import type { AiChatTurn } from "@/lib/domain/ai";
import type { AiActionView } from "@/lib/domain/aiActions";
import type { InboxItemView } from "@/lib/server/ai/panel";

// The assistant's window: one head — who it is, what is open, and the
// buttons (new chat, chats, inbox, playbook, automations, settings, expand,
// close) — over the chat. In the large window a sidebar lists the chats and
// the inbox beside it; in the corner card and on a phone the chats and the
// inbox open in place of the chat, with Back. The chat stays mounted through
// every switch (an answer being written keeps coming, a typed question is
// kept); the inbox and the automations read again each time they are opened.

export type AiTab = "chat" | "inbox" | "automations" | "playbook";
/** What the body shows: a tab, or the list of chats (the corner card and the phone). */
export type AiView = AiTab | "history";
export type AiLayout = "compact" | "large" | "phone";

export const AI_TAB_META: Record<AiTab, { label: string; icon: typeof Bell }> = {
  chat: { label: "Chat", icon: MessageSquare },
  inbox: { label: "Inbox", icon: Bell },
  automations: { label: "Automations", icon: Clock },
  playbook: { label: "Playbook", icon: BookOpen },
};

type Loaded<T> = ({ ok: true } & T) | { ok: false; error: string };

/** A pane's data: loaded on its first showing, and again on each later
 *  showing when `fresh` — and whenever `reload` is called. `reload` is a new
 *  showing (the version moves on, so a view keyed on it starts over);
 *  `refresh` reads the same data again in place. A reply that a later read
 *  overtook is dropped. */
function useTabData<T>(load: () => Promise<Loaded<T>>, active: boolean, fresh: boolean) {
  const [loaded, setLoaded] = useState<{ data: T; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const loadRef = useRef(load);
  const seen = useRef(false);
  const seq = useRef(0);

  const read = useCallback((bump: boolean) => {
    const n = ++seq.current;
    loadRef.current()
      .then((r) => {
        if (n !== seq.current) return;
        if (r.ok) {
          setLoaded({ data: r, at: Date.now() });
          setError(null);
          if (bump) setVersion((v) => v + 1);
        } else setError(r.error);
      })
      .catch(() => {
        if (n === seq.current) setError("Could not load — check the connection and try again.");
      });
  }, []);
  const reload = useCallback(() => read(true), [read]);
  const refresh = useCallback(() => read(false), [read]);

  useEffect(() => {
    if (!active) return;
    if (!seen.current || fresh) reload();
    seen.current = true;
  }, [active, fresh, reload]);

  return { data: loaded?.data ?? null, loadedAt: loaded?.at ?? 0, error, version, reload, refresh };
}

function Loading({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  if (error) {
    return (
      <div className="p-4 text-sm">
        <p className="font-semibold text-bad-fg">{error}</p>
        <button type="button" className="btn btn-sm mt-2" onClick={onRetry}>Try again</button>
      </div>
    );
  }
  return (
    <div className="p-10 flex items-center justify-center gap-2 text-sm text-muted">
      <Loader2 size={16} className="animate-spin" aria-hidden /> Loading…
    </div>
  );
}

export interface InitialChat {
  isOwner: boolean;
  status: Parameters<typeof AiChat>[0]["status"];
  conversations: Parameters<typeof AiChat>[0]["conversations"];
  open: { id: number; turns: AiChatTurn[]; actions: AiActionView[] } | null;
}

/** One button of the head: an icon, its name as the tooltip, lit when its view is open. */
function HeadBtn({ icon: Icon, label, on = false, badge = 0, onClick, disabled }: { icon: typeof Bell; label: string; on?: boolean; badge?: number; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`icon-btn icon-btn-md ai-head-btn ${on ? "icon-btn-on" : ""}`} title={label} aria-label={badge > 0 ? `${label} — ${badge} not read` : label} aria-pressed={on}>
      <Icon size={17} />
      {badge > 0 && <span className="count-badge count-badge-alert">{badge > 99 ? "99+" : badge}</span>}
    </button>
  );
}

/** A pane that is not the chat: Back to it, its name, then its content. */
function Pane({ title, onBack, children, padded = true }: { title: string; onBack: () => void; children: ReactNode; padded?: boolean }) {
  return (
    <div className="flex flex-col h-full">
      <div className="ai-pane-head">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
          <ArrowLeft size={15} aria-hidden /> Back
        </button>
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <div className={`flex-1 min-h-0 overflow-y-auto ${padded ? "p-3 md:p-4" : ""}`}>{children}</div>
    </div>
  );
}

/** The chats, grouped by day, the open one lit. */
function ChatList({ api, q, onPick }: { api: ChatListApi | null; q: string; onPick: (id: number) => void }) {
  if (!api) return <Loading error={null} onRetry={() => undefined} />;
  const needle = q.trim().toLowerCase();
  const convs = needle ? api.convs.filter((c) => c.title.toLowerCase().includes(needle)) : api.convs;
  if (convs.length === 0) return <EmptyState compact icon={Bot} title={needle ? "No chat matches" : "No chats yet"} hint={needle ? undefined : "Your questions will be kept here."} />;
  const now = new Date();
  const grouped = GROUPS.map((g) => ({ g, items: convs.filter((c) => groupOf(c.updatedAt, now) === g) })).filter((x) => x.items.length > 0);
  return (
    <nav className="px-1.5 pb-2">
      {grouped.map(({ g, items }) => (
        <div key={g}>
          <div className="conv-group">{g}</div>
          {items.map((c) => (
            <div key={c.id} className={`conv-item ${c.id === api.activeId ? "conv-item-active" : ""}`}>
              <button type="button" onClick={() => onPick(c.id)} className="flex-1 min-w-0 text-start px-2.5 py-1.5" disabled={api.busy}>
                <div className={`text-[13px] truncate ${c.id === api.activeId ? "font-semibold text-brand" : "font-medium"}`} dir="auto">{c.title}</div>
              </button>
              <button
                type="button"
                onClick={() => api.remove(c)}
                disabled={api.busy}
                className="conv-del icon-btn icon-btn-danger me-1"
                title="Delete this chat"
                aria-label={`Delete the chat ${c.title}`}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      ))}
    </nav>
  );
}

const KIND_ICON: Record<string, typeof FileText> = { report: FileText, message: MessageSquare, suggestion: Lightbulb };

/** The inbox as a list: what each is, its title, when — the one open lit. */
function InboxList({ items, q, openId, onPick }: { items: InboxItemView[] | null; q: string; openId: number | null; onPick: (id: number) => void }) {
  if (!items) return <Loading error={null} onRetry={() => undefined} />;
  const needle = q.trim().toLowerCase();
  const shown = needle ? items.filter((i) => i.title.toLowerCase().includes(needle) || (i.fromName ?? "").toLowerCase().includes(needle)) : items;
  if (shown.length === 0) return <EmptyState compact icon={Bell} title={needle ? "Nothing matches" : "Nothing here yet"} hint={needle ? undefined : "Reports, messages and suggestions land here."} />;
  return (
    <nav className="px-1.5 pb-2 space-y-0.5">
      {shown.map((it) => {
        const Icon = KIND_ICON[it.kind] ?? MessageSquare;
        const unread = !it.readAt;
        return (
          <button key={it.id} type="button" onClick={() => onPick(it.id)} className={`conv-item w-full text-start px-2.5 py-2 gap-2.5 ${it.id === openId ? "conv-item-active" : ""}`}>
            <Icon size={15} className="shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className={`block text-[13px] truncate ${unread ? "font-bold" : "font-medium"}`} dir="auto">{it.title}</span>
              <span className="block text-[11px] text-muted truncate tabnum">{it.fromName ? `${it.fromName} · ` : ""}{formatDateTime(it.createdAt)}</span>
            </span>
            {unread && <span className="w-2 h-2 rounded-full bg-[var(--brand)] shrink-0" aria-label="not read" />}
          </button>
        );
      })}
    </nav>
  );
}

export function AiWorkspace({
  tabs,
  view,
  onView,
  layout,
  visible = true,
  isOwner,
  inboxUnread = 0,
  onExpand,
  onClose,
  initialChat,
  syncUrl = false,
}: {
  tabs: AiTab[];
  view: AiView;
  onView: (v: AiView) => void;
  layout: AiLayout;
  /** The window is open: a hidden one loads nothing new. */
  visible?: boolean;
  isOwner: boolean;
  /** The inbox's unread count as the page knew it. */
  inboxUnread?: number;
  /** Expand to the large window or shrink to the corner — absent on the assistant's own page. */
  onExpand?: (large: boolean) => void;
  onClose?: () => void;
  initialChat?: InitialChat;
  syncUrl?: boolean;
}) {
  const hasChat = tabs.includes("chat");
  const large = layout === "large";
  const [chat, setChat] = useState<ChatListApi | null>(null);
  const [side, setSide] = useState<"chats" | "inbox">("chats");
  const [q, setQ] = useState("");
  const [inboxOpen, setInboxOpen] = useState<number | null>(null);
  // the unread count as last told: by the page, the chat's poll, or a read
  // after something changed — the inbox's own list wins when it is newer
  const [polled, setPolled] = useState(() => ({ n: inboxUnread, at: 0 }));

  // the chat's list of conversations, read fresh when it first shows
  const chatData = useTabData(loadAiChat, hasChat && visible && !initialChat, false);
  const chatInit = initialChat ?? (chatData.data ? { isOwner: chatData.data.isOwner, status: chatData.data.status, conversations: chatData.data.conversations, open: null } : null);

  // the inbox: for its pane, and for the sidebar's list
  const inboxActive = visible && (view === "inbox" || (large && side === "inbox"));
  const inbox = useTabData(loadInbox, tabs.includes("inbox") && inboxActive, true);
  const items = inbox.data?.items ?? null;
  const unread = items && inbox.loadedAt >= polled.at ? items.filter((i) => !i.readAt).length : polled.n;
  const inboxLoaded = items !== null;
  const refreshInbox = inbox.refresh;
  useEffect(() => {
    const fromChat = (e: Event) => setPolled({ n: (e as CustomEvent<number>).detail, at: Date.now() });
    // something was read or removed (here, or on the inbox page): the count
    // again, and the list in place — the open view keeps its place
    const onChanged = () => {
      pollInbox()
        .then((r) => setPolled({ n: r.unread, at: Date.now() }))
        .catch(() => undefined);
      if (inboxLoaded && visible) refreshInbox();
    };
    window.addEventListener(INBOX_UNREAD, fromChat);
    window.addEventListener(INBOX_CHANGED, onChanged);
    return () => {
      window.removeEventListener(INBOX_UNREAD, fromChat);
      window.removeEventListener(INBOX_CHANGED, onChanged);
    };
  }, [inboxLoaded, visible, refreshInbox]);

  const automations = useTabData(loadAutomations, tabs.includes("automations") && visible && view === "automations", true);
  const playbook = useTabData(loadPlaybook, tabs.includes("playbook") && visible && view === "playbook", false);

  // the panes opened so far stay mounted; the rest are not made yet
  const [visited, setVisited] = useState<Set<AiView>>(() => new Set([view]));
  if (visible && !visited.has(view)) setVisited(new Set(visited).add(view));

  const back = () => onView("chat");
  const pickChat = (id: number) => {
    chat?.open(id);
    onView("chat");
  };
  const pickInbox = (id: number) => {
    setInboxOpen(id);
    onView("inbox");
  };
  const newChat = () => {
    chat?.newChat();
    onView("chat");
  };
  const subtitle =
    view === "chat" ? chat?.activeTitle ?? "Ask about the plant" : view === "history" ? "Your chats" : view === "inbox" ? "Inbox" : view === "automations" ? "Automations" : "Playbook";

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface">
      <header className="ai-pop-head">
        <span className="ai-pop-logo"><Bot size={18} aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <div className="ai-pop-title">AI assistant</div>
          <div className="ai-pop-sub" dir="auto">{subtitle}</div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {hasChat && <HeadBtn icon={Plus} label="New chat" onClick={newChat} disabled={!!chat?.busy} />}
          {hasChat && !large && <HeadBtn icon={History} label="Chats" on={view === "history"} onClick={() => onView(view === "history" ? "chat" : "history")} />}
          {hasChat && large && <HeadBtn icon={History} label="Chats" on={view === "chat" && side === "chats"} onClick={() => { setSide("chats"); onView("chat"); }} />}
          {tabs.includes("inbox") && <HeadBtn icon={Bell} label="Inbox" badge={unread} on={view === "inbox"} onClick={() => { if (large) setSide("inbox"); onView("inbox"); }} />}
          {tabs.includes("playbook") && <HeadBtn icon={BookOpen} label="Playbook" on={view === "playbook"} onClick={() => onView("playbook")} />}
          {tabs.includes("automations") && <HeadBtn icon={Clock} label="Automations" on={view === "automations"} onClick={() => onView("automations")} />}
          {isOwner && (
            <Link href="/admin/ai" className="icon-btn icon-btn-md" title="AI settings" aria-label="AI settings">
              <Settings size={17} />
            </Link>
          )}
          {onExpand && layout !== "phone" && (
            <HeadBtn icon={large ? Minimize2 : Maximize2} label={large ? "Back to the corner" : "Expand"} onClick={() => onExpand(!large)} />
          )}
          {onClose && <HeadBtn icon={X} label="Close" onClick={onClose} />}
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {large && (
          <aside key="side" className="ai-side">
            <Tabs
              label="The sidebar"
              className="px-1 shrink-0"
              items={[
                ...(hasChat ? [{ id: "chats", label: "Chats", icon: History }] : []),
                ...(tabs.includes("inbox") ? [{ id: "inbox", label: "Inbox", icon: Bell, count: unread }] : []),
              ]}
              value={side}
              onChange={(id) => {
                setSide(id as "chats" | "inbox");
                setQ("");
              }}
            />
            <div className="relative p-2 shrink-0">
              <Search size={14} className="absolute start-4 top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={side === "chats" ? "Search chats…" : "Search the inbox…"}
                aria-label={side === "chats" ? "Search chats" : "Search the inbox"}
                className="w-full ps-8 pe-2 py-1.5 text-sm"
              />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {side === "chats" ? <ChatList api={chat} q={q} onPick={pickChat} /> : <InboxList items={items} q={q} openId={inboxOpen} onPick={pickInbox} />}
            </div>
          </aside>
        )}

        <div key="main" className="flex-1 min-w-0 relative">
          {hasChat && (
            <div role="tabpanel" hidden={view !== "chat"} className="absolute inset-0">
              {chatInit ? (
                <AiChat
                  isOwner={chatInit.isOwner}
                  status={chatInit.status}
                  conversations={chatInit.conversations}
                  initial={chatInit.open}
                  compact={!large}
                  syncUrl={syncUrl}
                  listInside={false}
                  onApi={setChat}
                />
              ) : (
                <Loading error={chatData.error} onRetry={chatData.reload} />
              )}
            </div>
          )}
          {hasChat && visited.has("history") && (
            <div role="tabpanel" hidden={view !== "history"} className="absolute inset-0">
              <Pane title="Chats" onBack={back} padded={false}>
                <div className="p-2 border-b flex gap-2">
                  <div className="relative flex-1">
                    <Search size={14} className="absolute start-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden />
                    <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats…" aria-label="Search chats" className="w-full ps-8 pe-2 py-1.5 text-sm" />
                  </div>
                  <button type="button" className="btn btn-primary btn-sm" onClick={newChat} disabled={!!chat?.busy}><Plus size={14} aria-hidden /> New chat</button>
                </div>
                <ChatList api={chat} q={q} onPick={pickChat} />
              </Pane>
            </div>
          )}
          {tabs.includes("inbox") && visited.has("inbox") && (
            <div role="tabpanel" hidden={view !== "inbox"} className="absolute inset-0">
              <Pane title="Inbox" onBack={back}>
                {inbox.data ? (
                  <div className={large ? "max-w-3xl mx-auto" : ""}>
                    <InboxView key={`${inbox.version}:${inboxOpen ?? 0}`} items={inbox.data.items} actions={inbox.data.actions} openId={inboxOpen} />
                  </div>
                ) : (
                  <Loading error={inbox.error} onRetry={inbox.reload} />
                )}
              </Pane>
            </div>
          )}
          {tabs.includes("automations") && visited.has("automations") && (
            <div role="tabpanel" hidden={view !== "automations"} className="absolute inset-0">
              <Pane title="Automations" onBack={back}>
                {automations.data ? (
                  <div className={large ? "max-w-3xl mx-auto" : ""}>
                    <AutomationsView
                      automations={automations.data.automations}
                      canTime={automations.data.allowed}
                      onChanged={automations.reload}
                      status={{ paused: automations.data.paused, inHours: automations.data.inHours, hours: automations.data.hours, stale: automations.data.stale, allowed: automations.data.allowed }}
                    />
                  </div>
                ) : (
                  <Loading error={automations.error} onRetry={automations.reload} />
                )}
              </Pane>
            </div>
          )}
          {tabs.includes("playbook") && visited.has("playbook") && (
            <div role="tabpanel" hidden={view !== "playbook"} className="absolute inset-0">
              <Pane title="Playbook" onBack={back}>
                {playbook.data ? (
                  <div className={large ? "max-w-3xl mx-auto" : ""}>
                    <PlaybookView rules={playbook.data.rules} canEdit={playbook.data.canEdit} left={playbook.data.left} onChanged={playbook.reload} />
                  </div>
                ) : (
                  <Loading error={playbook.error} onRetry={playbook.reload} />
                )}
              </Pane>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The /ai page: the large window laid into the page, the chat in the address bar. */
export function AiWorkspacePage({ tabs, initialChat, settings }: { tabs: AiTab[]; initialChat: InitialChat; settings: boolean }) {
  const [view, setView] = useState<AiView>("chat");
  return (
    <div className="h-[calc(100dvh-5.5rem)] md:h-[calc(100dvh-6.5rem)] min-h-[420px] bg-surface border rounded-xl overflow-hidden shadow-[var(--shadow-sm)]">
      <AiWorkspace tabs={tabs} view={view} onView={setView} layout="large" isOwner={settings} initialChat={initialChat} syncUrl />
    </div>
  );
}
