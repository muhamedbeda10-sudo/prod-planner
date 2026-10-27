import type { AiFeedbackRating } from "@/lib/domain/aiLearn";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasPerm } from "@/lib/server/auth";
import { actionsOfConversation } from "@/lib/server/ai/changes";
import { chatStatusFor, conversationsOf } from "@/lib/server/ai/panel";
import { chatTurnsOf } from "@/lib/server/ai/chatTurns";
import { AiWorkspacePage, type AiTab } from "@/components/AiWorkspace";

export const metadata = { title: "AI assistant — ATC" };
export const dynamic = "force-dynamic";
// an approved change runs in this page's action — an import or a plan for
// every machine can take a while
export const maxDuration = 300;

// The AI assistant at full size — the same tabs as the side panel (the chat,
// the inbox, the automations, the playbook); a chat opened here keeps its
// address (?c=). Who may use it, how much and for what is the owner's call
// (AI assistant settings, Users & Permissions).
export default async function AiPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const chat = await chatStatusFor(user);
  if (!chat.visible) redirect("/");

  const wanted = Number((await searchParams).c);
  const [conversations, open] = await Promise.all([
    conversationsOf(user.id),
    Number.isInteger(wanted) && wanted > 0
      ? prisma.aiConversation.findFirst({ where: { id: wanted, userId: user.id }, include: { messages: { orderBy: { id: "asc" } } } })
      : null,
  ]);
  const [actions, feedback, turns] = open
    ? await Promise.all([actionsOfConversation(open.id), prisma.aiFeedback.findMany({ where: { conversationId: open.id }, select: { turn: true, rating: true } }), chatTurnsOf(open)])
    : [[], [], []];
  const tabs: AiTab[] = ["chat", ...(hasPerm(user, "ai.automations") ? (["automations"] as const) : []), "playbook"];

  return (
    <AiWorkspacePage
      tabs={tabs}
      settings={user.isOwner}
      initialChat={{
        isOwner: user.isOwner,
        status: chat.status,
        conversations,
        open: open ? { id: open.id, turns, actions, ratings: Object.fromEntries(feedback.map((f) => [f.turn, f.rating as AiFeedbackRating])) } : null,
      }}
    />
  );
}
