"use server";

import { getCurrentUser } from "@/lib/server/auth";
import {
  automationsData, chatStatusFor, conversationsOf, inboxData, playbookData,
  type AiChatStatus, type AiConversationItem, type AutomationsData, type InboxItemView, type PlaybookRuleView,
} from "@/lib/server/ai/panel";
import { aiModel } from "@/lib/domain/ai";
import type { InboxTab } from "@/lib/domain/inbox";
import type { AiActionView } from "@/lib/domain/aiActions";

// What the AI and inbox windows load when a pane is opened — each the
// person's own, read as the pages read it (lib/server/ai/panel).

type Loaded<T> = ({ ok: true } & T) | { ok: false; error: string };

const NOT_LOGGED_IN = { ok: false as const, error: "You are not logged in — refresh the page." };
const CLOSED = { ok: false as const, error: "The assistant is not opened for your account." };

export async function loadAiChat(): Promise<Loaded<{ isOwner: boolean; model: string; status: AiChatStatus; conversations: AiConversationItem[] }>> {
  const me = await getCurrentUser();
  if (!me) return NOT_LOGGED_IN;
  const [chat, conversations] = await Promise.all([chatStatusFor(me), conversationsOf(me.id)]);
  if (!chat.visible) return CLOSED;
  return { ok: true, isOwner: me.isOwner, model: aiModel(chat.model).label, status: chat.status, conversations };
}

export async function loadInbox(): Promise<Loaded<{ items: InboxItemView[]; actions: AiActionView[]; unread: Record<InboxTab, number> }>> {
  const me = await getCurrentUser();
  if (!me) return NOT_LOGGED_IN;
  return { ok: true, ...(await inboxData(me.id)) };
}

export async function loadAutomations(): Promise<Loaded<AutomationsData>> {
  const me = await getCurrentUser();
  if (!me) return NOT_LOGGED_IN;
  return { ok: true, ...(await automationsData(me)) };
}

export async function loadPlaybook(): Promise<Loaded<{ rules: PlaybookRuleView[]; canEdit: boolean; left: number }>> {
  const me = await getCurrentUser();
  if (!me) return NOT_LOGGED_IN;
  const chat = await chatStatusFor(me);
  if (!chat.visible) return CLOSED;
  return { ok: true, ...(await playbookData(me)) };
}
