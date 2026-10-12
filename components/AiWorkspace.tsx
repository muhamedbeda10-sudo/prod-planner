"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Bell, BookOpen, Clock, Loader2, MessageSquare, Settings } from "lucide-react";
import { AiChat } from "@/components/AiChat";
import { InboxView } from "@/components/InboxView";
import { AutomationsView } from "@/components/AutomationsView";
import { PlaybookView } from "@/components/PlaybookView";
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
    <div className="p-6 grid place-items-center text-muted">
      <Loader2 size={20} className="animate-spin" aria-label="Loading" />
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
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {d.paused ? (
          <span className="pill pill-warn">Paused by the owner</span>
        ) : (
          <span className={`pill ${d.inHours ? "pill-ok" : "pill-muted"}`}>{d.inHours ? "Running" : "Outside hours"}</span>
        )}
        <span className="text-muted">{d.hours}</span>
        {!d.paused && d.stale && <span className="pill pill-muted" title="No scheduler is set up: they run only while the app is open somewhere.">No scheduler</span>}
        {!d.allowed && <span className="pill pill-warn">Stopped — no permission</span>}
      </div>
      <AutomationsView automations={d.automations} canTime={d.allowed} onChanged={t.reload} />
    </div>
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
      <div className="flex items-center gap-1 border-b px-1.5 shrink-0 bg-surface">
        <div role="tablist" aria-label="AI assistant" className="flex items-center gap-0.5 min-w-0 overflow-x-auto">
          {tabs.map((t) => {
            const { label, icon: Icon } = AI_TAB_META[t];
            const on = t === tab;
            return (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => onTab(t)}
                title={label}
                className={`inline-flex items-center gap-1.5 ${compact && !on ? "px-2.5" : "px-3"} py-2.5 text-sm font-bold border-b-2 -mb-px whitespace-nowrap transition-colors ${
                  on ? "border-[var(--brand)] text-brand" : "border-transparent text-muted hover:text-foreground"
                }`}
              >
                <Icon size={15} aria-hidden />
                {/* the docked panel is narrow: only the open tab is named, the rest are icons with their name on hover */}
                <span className={compact && !on ? "sr-only" : ""}>{label}</span>
              </button>
            );
          })}
        </div>
        {toolbar && <div className="ms-auto flex items-center gap-0.5 shrink-0">{toolbar}</div>}
      </div>
      <div className="flex-1 min-h-0 relative">
        {tabs.map((t) => {
          if (!visited.has(t)) return null;
          const active = visible && t === tab;
          return (
            <div key={t} role="tabpanel" hidden={t !== tab} className={`absolute inset-0 ${t === "chat" ? "" : "overflow-y-auto p-3"}`}>
              {t === "chat" && <ChatTab active={active} compact={compact} initial={initialChat} syncUrl={syncUrl} />}
              {t === "inbox" && <InboxTab active={active} />}
              {t === "automations" && <AutomationsTab active={active} />}
              {t === "playbook" && <PlaybookTab active={active} />}
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
    <div className="h-[calc(100dvh-5.5rem)] md:h-[calc(100dvh-6.5rem)] min-h-[420px] bg-surface border rounded-xl overflow-hidden">
      <AiWorkspace
        tabs={tabs}
        tab={tab}
        onTab={setTab}
        compact={false}
        initialChat={initialChat}
        syncUrl
        toolbar={
          settings ? (
            <a href="/admin/ai" className="grid place-items-center w-8 h-8 rounded-md text-muted hover:text-foreground hover:bg-surface-2" title="AI settings" aria-label="AI settings">
              <Settings size={16} />
            </a>
          ) : undefined
        }
      />
    </div>
  );
}
