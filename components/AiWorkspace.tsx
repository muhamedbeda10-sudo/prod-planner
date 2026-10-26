"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, BookOpen, Bot, Brain, Clock, History, Maximize2, MessageSquare, Minimize2, Plus, Search, Settings, X } from "lucide-react";
import { AiChat, ConvRow, GROUPS, groupOf, type ChatListApi } from "@/components/AiChat";
import { AutomationsView } from "@/components/AutomationsView";
import { PlaybookView } from "@/components/PlaybookView";
import { MemoryDialog } from "@/components/AiFeedback";
import type { AiFeedbackRating } from "@/lib/domain/aiLearn";
import { EmptyState } from "@/components/primitives";
import { loadAiChat, loadAutomations, loadPlaybook } from "@/app/ai/panel/actions";
import { Loading, useTabData } from "@/components/useTabData";
import type { AiChatTurn } from "@/lib/domain/ai";
import type { AiActionView } from "@/lib/domain/aiActions";

// The assistant's window: one head — who it is, what is open, and the
// buttons (new chat, chats, playbook, automations, settings, expand, close) —
// over the chat. In the large window a sidebar lists the chats beside it; in
// the corner card and on a phone the chats open in place of the chat, with
// Back. The chat stays mounted through every switch (an answer being written
// keeps coming, a typed question is kept); the automations read again each
// time they are opened. The inbox is a window of its own (InboxPanel).

export type AiTab = "chat" | "automations" | "playbook";
/** What the body shows: a tab, or the list of chats (the corner card and the phone). */
export type AiView = AiTab | "history";
export type AiLayout = "compact" | "large" | "phone";

export const AI_TAB_META: Record<AiTab, { label: string; icon: typeof Bot }> = {
  chat: { label: "Chat", icon: MessageSquare },
  automations: { label: "Automations", icon: Clock },
  playbook: { label: "Playbook", icon: BookOpen },
};

export interface InitialChat {
  isOwner: boolean;
  status: Parameters<typeof AiChat>[0]["status"];
  conversations: Parameters<typeof AiChat>[0]["conversations"];
  open: { id: number; turns: AiChatTurn[]; actions: AiActionView[]; ratings?: Record<number, AiFeedbackRating> } | null;
}

/** One button of the head: an icon, its name as the tooltip, lit when its view is open. */
export function HeadBtn({ icon: Icon, label, on = false, badge = 0, onClick, disabled }: { icon: typeof Bot; label: string; on?: boolean; badge?: number; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`icon-btn icon-btn-md ai-head-btn ${on ? "icon-btn-on" : ""}`} title={label} aria-label={badge > 0 ? `${label} — ${badge} not read` : label} aria-pressed={on}>
      <Icon size={17} />
      {badge > 0 && <span className="count-badge count-badge-alert">{badge > 99 ? "99+" : badge}</span>}
    </button>
  );
}

/** A pane that is not the chat: Back to it, its name, then its content. */
export function Pane({ title, onBack, children, padded = true }: { title: string; onBack: () => void; children: ReactNode; padded?: boolean }) {
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
  const grouped = GROUPS.map((g) => ({ g, items: convs.filter((c) => groupOf(c.updatedAt, now, c.pinned) === g) })).filter((x) => x.items.length > 0);
  return (
    <nav className="px-1.5 pb-2">
      {grouped.map(({ g, items }) => (
        <div key={g}>
          <div className="conv-group">{g}</div>
          {items.map((c) => <ConvRow key={c.id} c={c} active={c.id === api.activeId} busy={api.busy} onOpen={() => onPick(c.id)} onRemove={() => api.remove(c)} onRename={() => api.rename(c)} onPin={() => api.pin(c)} />)}
        </div>
      ))}
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
  /** Expand to the large window or shrink to the corner — absent on the assistant's own page. */
  onExpand?: (large: boolean) => void;
  onClose?: () => void;
  initialChat?: InitialChat;
  syncUrl?: boolean;
}) {
  const hasChat = tabs.includes("chat");
  const large = layout === "large";
  const [chat, setChat] = useState<ChatListApi | null>(null);
  const [q, setQ] = useState("");

  // the chat's list of conversations, read fresh when it first shows
  const chatData = useTabData(loadAiChat, hasChat && visible && !initialChat, false);
  const chatInit = initialChat ?? (chatData.data ? { isOwner: chatData.data.isOwner, status: chatData.data.status, conversations: chatData.data.conversations, open: null } : null);

  const automations = useTabData(loadAutomations, tabs.includes("automations") && visible && view === "automations", true);
  const playbook = useTabData(loadPlaybook, tabs.includes("playbook") && visible && view === "playbook", false);

  // the panes opened so far stay mounted; the rest are not made yet
  const [visited, setVisited] = useState<Set<AiView>>(() => new Set([view]));
  if (visible && !visited.has(view)) setVisited(new Set(visited).add(view));

  const [memoryOpen, setMemoryOpen] = useState(false);
  const back = () => onView("chat");
  const pickChat = (id: number) => {
    chat?.open(id);
    onView("chat");
  };
  const newChat = () => {
    chat?.newChat();
    onView("chat");
  };
  const subtitle =
    view === "chat" ? chat?.activeTitle ?? "Ask about the plant" : view === "history" ? "Your chats" : view === "automations" ? "Automations" : "Playbook";

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface">
      {memoryOpen && <MemoryDialog onClose={() => setMemoryOpen(false)} />}
      <header className="ai-pop-head">
        <span className="ai-pop-logo"><Bot size={18} aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <div className="ai-pop-title">AI assistant</div>
          <div className="ai-pop-sub" dir="auto">{subtitle}</div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {hasChat && <HeadBtn icon={Plus} label="New chat" onClick={newChat} disabled={!!chat?.busy} />}
          {hasChat && !large && <HeadBtn icon={History} label="Chats" on={view === "history"} onClick={() => onView(view === "history" ? "chat" : "history")} />}
          {hasChat && large && <HeadBtn icon={History} label="Chats" on={view === "chat"} onClick={() => onView("chat")} />}
          {hasChat && <HeadBtn icon={Brain} label="What it remembers about you" on={memoryOpen} onClick={() => setMemoryOpen(true)} />}
          {tabs.includes("playbook") && <HeadBtn icon={BookOpen} label="Playbook" on={view === "playbook"} onClick={() => onView("playbook")} />}
          {tabs.includes("automations") && <HeadBtn icon={Clock} label="Automations" on={view === "automations"} onClick={() => onView("automations")} />}
          {isOwner && (
            <Link href="/admin/ai" className="icon-btn icon-btn-md" title="AI settings" aria-label="AI settings">
              <Settings size={17} />
            </Link>
          )}
          {onExpand && layout !== "phone" && (
            <HeadBtn icon={large ? Minimize2 : Maximize2} label={large ? "Back to the corner" : "Fill screen"} onClick={() => onExpand(!large)} />
          )}
          {onClose && <HeadBtn icon={X} label="Close" onClick={onClose} />}
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {large && (
          <aside key="side" className="ai-side">
            <div className="flex items-center gap-2 px-3 pt-3 pb-1 shrink-0">
              <History size={15} className="text-muted" aria-hidden />
              <span className="text-sm font-semibold flex-1">Chats</span>
              <button type="button" className="icon-btn" onClick={newChat} disabled={!!chat?.busy} title="New chat" aria-label="New chat"><Plus size={15} /></button>
            </div>
            <div className="relative p-2 shrink-0">
              <Search size={14} className="absolute start-4 top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats…" aria-label="Search chats" className="w-full ps-8 pe-2 py-1.5 text-sm" />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              <ChatList api={chat} q={q} onPick={pickChat} />
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
                      builder={{ meId: automations.data.meId, people: automations.data.people }}
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
