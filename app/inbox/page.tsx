import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import { expireProposals, toView } from "@/lib/server/ai/changes";
import { PageHead } from "@/components/ui";
import { InboxView, type InboxItemView } from "@/components/InboxView";
import type { InboxKind } from "@/lib/domain/inbox";

export const metadata = { title: "Inbox — ATC" };
export const dynamic = "force-dynamic";

// What the assistant and the automations sent this person: reports, messages
// someone's automation sends them, suggestions with their changes ready to
// approve. Everyone has one — a person without the assistant still receives
// what other people's automations send them.

const SHOWN = 100;

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ item?: string }> }) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const sp = await searchParams;
  const open = Number(sp.item);
  const openId = Number.isInteger(open) && open > 0 ? open : null;

  // the item a notification opened is read by opening it
  if (openId) await prisma.aiInboxItem.updateMany({ where: { id: openId, userId: me.id, readAt: null }, data: { readAt: new Date() } });
  await expireProposals();
  const rows = await prisma.aiInboxItem.findMany({ where: { userId: me.id }, orderBy: { id: "desc" }, take: SHOWN });
  // the changes proposed with them — the person's own to decide
  const ids = [...new Set(rows.flatMap((r) => r.actionIds))];
  const actions = ids.length ? (await prisma.aiAction.findMany({ where: { id: { in: ids }, userId: me.id } })).map(toView) : [];
  const items: InboxItemView[] = rows.map((r) => ({
    id: r.id, kind: r.kind as InboxKind, title: r.title, body: r.body, fromName: r.fromName,
    createdAt: r.createdAt.toISOString(), readAt: r.readAt?.toISOString() ?? null, actionIds: r.actionIds,
  }));

  return (
    <div>
      <PageHead title="Inbox" sub="Reports, messages and suggestions from the assistant and the automations" />
      <InboxView items={items} actions={actions} openId={openId} />
    </div>
  );
}
