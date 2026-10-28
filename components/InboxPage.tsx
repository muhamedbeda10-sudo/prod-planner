"use client";

import { useState } from "react";
import { InboxWorkspace } from "@/components/InboxWorkspace";
import type { InboxTab } from "@/lib/domain/inbox";

/** The /inbox page: the inbox window laid into the page, at full size. */
export function InboxPage({ tab: firstTab, taskId: firstTask, openItem }: { tab: InboxTab; taskId: number | null; openItem: number | null }) {
  const [tab, setTab] = useState<InboxTab>(firstTab);
  const [taskId, setTaskId] = useState<number | null>(firstTask);
  return (
    <div className="h-[var(--page-fill)] min-h-[420px] bg-surface border rounded-xl overflow-hidden shadow-[var(--shadow-sm)]">
      <InboxWorkspace layout="page" tab={tab} onTab={setTab} taskId={taskId} onTask={setTaskId} openItem={openItem} />
    </div>
  );
}
