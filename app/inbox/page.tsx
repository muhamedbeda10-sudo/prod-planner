import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import { inboxData } from "@/lib/server/ai/panel";
import { PageHead, ReadingColumn } from "@/components/ui";
import { InboxView } from "@/components/InboxView";

export const metadata = { title: "Inbox — ATC" };
export const dynamic = "force-dynamic";

// What the assistant and the automations sent this person: reports, messages
// someone's automation sends them, suggestions with their changes ready to
// approve. Everyone has one — a person without the assistant still receives
// what other people's automations send them. A notification opens it here,
// on the item it is about.

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ item?: string }> }) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const sp = await searchParams;
  const open = Number(sp.item);
  const openId = Number.isInteger(open) && open > 0 ? open : null;

  // the item a notification opened is read by opening it
  if (openId) await prisma.aiInboxItem.updateMany({ where: { id: openId, userId: me.id, readAt: null }, data: { readAt: new Date() } });
  const { items, actions } = await inboxData(me.id);

  return (
    <ReadingColumn>
      <PageHead title="Inbox" />
      <InboxView items={items} actions={actions} openId={openId} />
    </ReadingColumn>
  );
}
