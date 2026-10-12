import Link from "next/link";
import { redirect } from "next/navigation";
import { Bell, BookOpen, Clock } from "lucide-react";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { aiStatusFor } from "@/lib/server/ai/access";
import { actionsOfConversation } from "@/lib/server/ai/changes";
import { READ_TOOL_TITLES } from "@/lib/server/ai/tools";
import { AI_DENY_TEXT, aiModel, displayTurns } from "@/lib/domain/ai";
import { PageHead } from "@/components/ui";
import { AiChat } from "@/components/AiChat";

export const metadata = { title: "AI assistant — ATC" };
export const dynamic = "force-dynamic";
// an approved change runs in this page's action — an import or a plan for
// every machine can take a while
export const maxDuration = 300;

// The AI assistant: ask about the plant in your own words and Claude answers
// from the app's data with tables, charts and suggestions — and prepares the
// changes it is asked for, each waiting on its card for the person's click.
// Who may use it, how much and for what is the owner's call (AI assistant
// settings, Users & Permissions).
export default async function AiPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const status = await aiStatusFor(user);
  if (!status.visible) redirect("/");

  const conversations = await prisma.aiConversation.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    take: 60,
    select: { id: true, title: true, updatedAt: true },
  });
  const wanted = Number((await searchParams).c);
  const open = Number.isInteger(wanted) && wanted > 0
    ? await prisma.aiConversation.findFirst({ where: { id: wanted, userId: user.id }, include: { messages: { orderBy: { id: "asc" } } } })
    : null;
  const actions = open ? await actionsOfConversation(open.id) : [];

  return (
    <>
      <PageHead
        title="AI assistant"
        sub={aiModel(status.model).label}
        actions={
          <span className="inline-flex gap-1.5">
            {hasPerm(user, "ai.automations") && (
              <Link href="/automations" className="btn btn-sm" title="What the assistant does by itself for you"><Clock size={14} aria-hidden /> Automations</Link>
            )}
            <Link href="/inbox" className="btn btn-sm" title="Reports, messages and suggestions"><Bell size={14} aria-hidden /> Inbox</Link>
            <Link href="/ai/playbook" className="btn btn-sm" title="How this plant works — what the assistant is told"><BookOpen size={14} aria-hidden /> Playbook</Link>
          </span>
        }
      />
      <AiChat
        isOwner={user.isOwner}
        status={{ ok: status.ok, reason: status.reason ? AI_DENY_TEXT[status.reason] : null, userSpent: status.userSpent, userCap: status.userCap, plantSpent: status.plantSpent, plantCap: status.plantCap }}
        conversations={conversations.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt.toISOString() }))}
        initial={open ? { id: open.id, turns: displayTurns(open.messages, READ_TOOL_TITLES), actions } : null}
      />
    </>
  );
}
