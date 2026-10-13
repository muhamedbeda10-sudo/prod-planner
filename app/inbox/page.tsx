import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import { InboxPage } from "@/components/InboxPage";
import { isInboxTab, tabOfKind, type InboxKind, type InboxTab } from "@/lib/domain/inbox";

export const metadata = { title: "Inbox — ATC" };
export const dynamic = "force-dynamic";

// The inbox at full size — the window the bell opens, laid into the page:
// Alerts, Reports and Tasks. A notification opens it here, on what it is
// about: an item (read by opening it) on its tab, or a task on the Tasks tab.

export default async function Inbox({ searchParams }: { searchParams: Promise<{ item?: string; task?: string; tab?: string }> }) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const sp = await searchParams;
  const idOf = (v: string | undefined) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const itemId = idOf(sp.item);
  const taskId = idOf(sp.task);

  let tab: InboxTab = sp.tab && isInboxTab(sp.tab) ? sp.tab : taskId ? "tasks" : "alerts";
  if (itemId) {
    const item = await prisma.aiInboxItem.findFirst({ where: { id: itemId, userId: me.id }, select: { kind: true, taskId: true } });
    if (item) {
      // the item a notification opened is read by opening it
      await prisma.aiInboxItem.updateMany({ where: { id: itemId, userId: me.id, readAt: null }, data: { readAt: new Date() } });
      tab = tabOfKind(item.kind as InboxKind);
      if (item.taskId) return <InboxPage tab="tasks" taskId={item.taskId} openItem={null} />;
    }
  }
  return <InboxPage tab={tab} taskId={taskId} openItem={itemId} />;
}
