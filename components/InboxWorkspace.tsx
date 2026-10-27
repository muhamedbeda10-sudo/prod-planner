"use client";

import { useEffect, useState } from "react";
import { Bell, FileText, Inbox, ListChecks, Maximize2, Minimize2, X } from "lucide-react";
import { Tabs } from "@/components/primitives";
import { DevicePush, InboxView } from "@/components/InboxView";
import { TasksView } from "@/components/TasksView";
import { FloatHead, HeadBtn } from "@/components/FloatDock";
import { INBOX_CHANGED, onInboxHead } from "@/components/InboxBell";
import { Loading, useTabData } from "@/components/useTabData";
import { loadInbox } from "@/app/ai/panel/actions";
import { loadTasks } from "@/app/tasks/actions";
import { INBOX_TAB_LABEL, TAB_KINDS, type InboxTab } from "@/lib/domain/inbox";

// The inbox's window: its head — what it is, how much is not read, this
// device's notifications, expand, close — over three tabs: Alerts (messages
// from people and automations, changes waiting for an approval), Reports
// (what the assistant and the automations wrote for the person) and Tasks
// (given to them, and given by them). The lists read again each time the
// window opens, and the counts whenever something is read anywhere.

export type InboxLayout = "compact" | "large" | "phone" | "page";

const TAB_ICON: Record<InboxTab, typeof Bell> = { alerts: Bell, reports: FileText, tasks: ListChecks };

const EMPTY_HINT: Record<Exclude<InboxTab, "tasks">, string> = {
  alerts: "Messages from colleagues and the automations, and changes waiting for your approval, land here — and on this device when notifications are on.",
  reports: "Reports the assistant and your automations write for you land here — and on this device when notifications are on.",
};

export function InboxWorkspace({
  layout,
  tab,
  onTab,
  taskId,
  onTask,
  visible = true,
  openItem = null,
  onExpand,
  onClose,
}: {
  layout: InboxLayout;
  tab: InboxTab;
  onTab: (t: InboxTab) => void;
  /** The task open on the Tasks tab. */
  taskId: number | null;
  onTask: (id: number | null) => void;
  /** The window is open: a hidden one loads nothing new. */
  visible?: boolean;
  /** An item a notification opened (the page). */
  openItem?: number | null;
  onExpand?: (large: boolean) => void;
  onClose?: () => void;
}) {
  const large = layout === "large";
  const wide = layout === "large" || layout === "page";
  const inbox = useTabData(loadInbox, visible && tab !== "tasks", true);
  const tasks = useTabData(loadTasks, visible && tab === "tasks", true);
  // the counts: the inbox's own when it is newer, else the bell's last word
  const [told, setTold] = useState<{ n: number; at: number } | null>(null);

  // something read or changed anywhere (here, the bell's poll, another tab):
  // the counts and the lists again, in place
  const refreshInbox = inbox.refresh;
  const refreshTasks = tasks.refresh;
  useEffect(() => {
    if (!visible) return;
    const again = () => {
      refreshInbox();
      if (tab === "tasks") refreshTasks();
    };
    window.addEventListener(INBOX_CHANGED, again);
    const stopHead = onInboxHead((h) => setTold({ n: h.unread, at: Date.now() }));
    return () => {
      window.removeEventListener(INBOX_CHANGED, again);
      stopHead();
    };
  }, [visible, tab, refreshInbox, refreshTasks]);

  const unread = inbox.data?.unread ?? null;
  const total = unread ? unread.alerts + unread.reports + unread.tasks : 0;
  const count = told && told.at > inbox.loadedAt ? told.n : total;
  const subtitle = count > 0 ? `${count} not read` : "All read";

  const body = (t: Exclude<InboxTab, "tasks">) =>
    inbox.data ? (
      <div className={`p-2.5 md:p-3 ${wide ? "max-w-[1600px] mx-auto md:px-5" : ""}`}>
        <InboxView key={`${inbox.version}:${openItem ?? 0}`} items={inbox.data.items} actions={inbox.data.actions} openId={openItem} kinds={TAB_KINDS[t]} device={false} emptyHint={EMPTY_HINT[t]} />
      </div>
    ) : (
      <Loading error={inbox.error} onRetry={inbox.reload} />
    );

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface">
      <FloatHead icon={Inbox} title="Inbox" sub={subtitle}>
          <DevicePush compact />
          {onExpand && layout !== "phone" && layout !== "page" && (
            <HeadBtn icon={large ? Minimize2 : Maximize2} label={large ? "Back to the side" : "Expand"} onClick={() => onExpand(!large)} />
          )}
          {onClose && <HeadBtn icon={X} label="Close" onClick={onClose} />}
      </FloatHead>
      <Tabs
        label="The inbox"
        className={`shrink-0 ${wide ? "px-2" : ""}`}
        fill={!wide}
        items={(["alerts", "reports", "tasks"] as const).map((t) => ({ id: t, label: INBOX_TAB_LABEL[t], icon: TAB_ICON[t], count: unread?.[t] ?? 0 }))}
        value={tab}
        onChange={(id) => onTab(id as InboxTab)}
      />
      <div className="flex-1 min-h-0 relative">
        {tab === "tasks" ? (
          tasks.data ? (
            <TasksView key={tasks.version} data={tasks.data} onChanged={refreshTasks} split={wide} openId={taskId} onOpen={onTask} />
          ) : (
            <Loading error={tasks.error} onRetry={tasks.reload} />
          )
        ) : (
          <div className="absolute inset-0 overflow-y-auto">{body(tab)}</div>
        )}
      </div>
    </div>
  );
}
