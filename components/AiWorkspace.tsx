"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Bell, BookOpen, Clock, Loader2, MessageSquare, Settings } from "lucide-react";
import { AiChat } from "@/components/AiChat";
import { InboxView } from "@/components/InboxView";
import { AutomationsView } from "@/components/AutomationsView";
import { PlaybookView } from "@/components/PlaybookView";
import { Tabs } from "@/components/primitives";
import { loadAiChat, loadAutomations, loadInbox, loadPlaybook } from "@/app/ai/panel/actions";
import type { AiChatTurn } from "@/lib/domain/ai";
import type { AiActionView } from "@/lib/domain/aiActions";

// The assistant's tabs — the chat, the inbox, the automations and the
// playbook — as the side panel and the /ai page show them. A tab loads when
// it is first opened and stays mounted after (a chat being answered keeps
// streaming while another tab is open); the inbox and the automations read
// again each time they are opened.

export type AiTab = "chat" | "inbox" | "automations" | "playbook";

export const AI_TAB_META: Record<AiTab, { label: string; icon: typeof Bell }> = {
  chat: { label: "Chat", icon: MessageSquare },
  inbox: { label: "Inbox", icon: Bell },
  automations: { label: "Automations", icon: Clock },
  playbook: { label: "Playbook", icon: BookOpen },
};

type Loaded<T> = ({ ok: true } & T) | { ok: false; error: string };

/** A tab's data: loaded on its first showing, and again on each later
 *  showing when `fresh` — and whenever `reload` is called. */
function useTabData<T>(load: () => Promise<Loaded<T>>, active: boolean, fresh: boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const loadRef = useRef(load);
  const seen = useRef(false);

  const reload = useCallback(() => {
    loadRef.current()
      .then((r) => {
        if (r.ok) {
          setData(r);
          setError(null);
          setVersion((v) => v + 1);
        } else setError(r.error);
      })
      .catch(() => setError("Could not load — check the connection and try again."));
  }, []);

  useEffect(() => {
    if (!active) return;
    if (!seen.current || fresh) reload();
    seen.current = true;
  }, [active, fresh, reload]);

  return { data, error, version, reload };
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

function ChatTab({ active, compact, initial, syncUrl }: { active: boolean; compact: boolean; initial?: InitialChat; syncUrl: boolean }) {
  const t = useTabData(loadAiChat, active && !initial, false);
  const d = initial ?? (t.data ? { isOwner: t.data.isOwner, status: t.data.status, conversations: t.data.conversations, open: null } : null);
  if (!d) return <Loading error={t.error} onRetry={t.reload} />;
  return <AiChat isOwner={d.isOwner} status={d.status} conversations={d.conversations} initial={d.open} compact={compact} syncUrl={syncUrl} />;
}

function InboxTab({ active }: { active: boolean }) {
  const t = useTabData(loadInbox, active, true);
  if (!t.data) return <Loading error={t.error} onRetry={t.reload} />;
  return <InboxView key={t.version} items={t.data.items} actions={t.data.actions} openId={null} />;
}

function AutomationsTab({ active }: { active: boolean }) {
  const t = useTabData(loadAutomations, active, true);
  if (!t.data) return <Loading error={t.error} onRetry={t.reload} />;
  const d = t.data;
  return (
    <AutomationsView
      automations={d.automations}
      canTime={d.allowed}
      onChanged={t.reload}
      status={{ paused: d.paused, inHours: d.inHours, hours: d.hours, stale: d.stale, allowed: d.allowed }}
    />
  );
}

function PlaybookTab({ active }: { active: boolean }) {
  const t = useTabData(loadPlaybook, active, false);
  if (!t.data) return <Loading error={t.error} onRetry={t.reload} />;
  return <PlaybookView rules={t.data.rules} canEdit={t.data.canEdit} left={t.data.left} onChanged={t.reload} />;
}

export function AiWorkspace({
  tabs,
  tab,
  onTab,
  compact,
  visible = true,
  toolbar,
  initialChat,
  syncUrl = false,
}: {
  tabs: AiTab[];
  tab: AiTab;
  onTab: (t: AiTab) => void;
  /** Narrow — the docked side panel. */
  compact: boolean;
  /** The panel is open: a hidden panel loads nothing new. */
  visible?: boolean;
  /** Buttons at the end of the tab bar (expand, close, settings). */
  toolbar?: ReactNode;
  initialChat?: InitialChat;
  syncUrl?: boolean;
}) {
  // the tabs opened so far stay mounted; the rest are not made yet
  const [visited, setVisited] = useState<Set<AiTab>>(() => new Set([tab]));
  if (visible && !visited.has(tab)) setVisited(new Set(visited).add(tab));

  return (
    <div className="flex flex-col h-full min-h-0">
      <Tabs
        label="AI assistant"
        className="px-1.5 shrink-0 bg-surface"
        items={tabs.map((t) => ({ id: t, label: AI_TAB_META[t].label, icon: AI_TAB_META[t].icon }))}
        value={tab}
        onChange={(id) => onTab(id as AiTab)}
        iconsOnly={compact}
        end={toolbar}
      />
      <div className="flex-1 min-h-0 relative">
        {tabs.map((t) => {
          if (!visited.has(t)) return null;
          const active = visible && t === tab;
          const pane = t === "chat" ? "" : compact ? "overflow-y-auto p-3" : "overflow-y-auto px-4 py-5 md:px-8";
          return (
            <div key={t} role="tabpanel" hidden={t !== tab} className={`absolute inset-0 ${pane}`}>
              {/* a reading width for the lists; the chat keeps its own */}
              <div className={t === "chat" ? "h-full" : compact ? "" : "max-w-3xl mx-auto"}>
                {t === "chat" && <ChatTab active={active} compact={compact} initial={initialChat} syncUrl={syncUrl} />}
                {t === "inbox" && <InboxTab active={active} />}
                {t === "automations" && <AutomationsTab active={active} />}
                {t === "playbook" && <PlaybookTab active={active} />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The /ai page: the same tabs at full size, the chat in the address bar. */
export function AiWorkspacePage({ tabs, initialChat, settings }: { tabs: AiTab[]; initialChat: InitialChat; settings: boolean }) {
  const [tab, setTab] = useState<AiTab>("chat");
  return (
    <div className="h-[calc(100dvh-5.5rem)] md:h-[calc(100dvh-6.5rem)] min-h-[420px] bg-surface border rounded-xl overflow-hidden shadow-[var(--shadow-sm)]">
      <AiWorkspace
        tabs={tabs}
        tab={tab}
        onTab={setTab}
        compact={false}
        initialChat={initialChat}
        syncUrl
        toolbar={
          settings ? (
            <a href="/admin/ai" className="icon-btn icon-btn-md" title="AI settings" aria-label="AI settings">
              <Settings size={16} />
            </a>
          ) : undefined
        }
      />
    </div>
  );
}
