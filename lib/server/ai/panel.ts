import "server-only";
import type { User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { aiStatusFor, getAiSettings, type AiStatus } from "./access";
import { expireProposals, toView } from "./changes";
import { AUTOMATIONS_KEY, automationWindowOf } from "@/lib/server/automations/store";
import { automationsClock } from "@/lib/server/automations/scheduler";
import { automationViews, type AutomationView } from "@/lib/server/automations/views";
import { AI_DENY_TEXT } from "@/lib/domain/ai";
import { playbookText } from "@/lib/domain/aiPlaybook";
import { describeWindow, inAutomationWindow } from "@/lib/domain/automations";
import { INBOX_TABS, tabOfKind, type InboxKind, type InboxTab } from "@/lib/domain/inbox";
import type { AiActionView } from "@/lib/domain/aiActions";

// What the assistant's tabs show — the chat, the inbox, the automations and
// the playbook — read the same way for their pages and for the side panel,
// which loads each tab when it is opened.

/** The chat's allowance as its box shows it. */
export interface AiChatStatus {
  ok: boolean;
  reason: string | null;
  userSpent: number;
  userCap: number;
  userSpentToday: number;
  userDayCap: number;
  plantSpent: number;
  plantCap: number;
  plantSpentToday: number;
  plantDayCap: number;
}

export function chatStatusOf(s: AiStatus): AiChatStatus {
  return {
    ok: s.ok,
    reason: s.reason ? AI_DENY_TEXT[s.reason] : null,
    userSpent: s.userSpent,
    userCap: s.userCap,
    userSpentToday: s.userSpentToday,
    userDayCap: s.userDayCap,
    plantSpent: s.plantSpent,
    plantCap: s.plantCap,
    plantSpentToday: s.plantSpentToday,
    plantDayCap: s.plantDayCap,
  };
}

export interface AiConversationItem {
  id: number;
  title: string;
  updatedAt: string;
}

/** A person's latest conversations, newest first. */
export async function conversationsOf(userId: number): Promise<AiConversationItem[]> {
  const rows = await prisma.aiConversation.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: 60,
    select: { id: true, title: true, updatedAt: true },
  });
  return rows.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt.toISOString() }));
}

export interface InboxItemView {
  id: number;
  kind: InboxKind;
  title: string;
  body: string;
  fromName: string | null;
  createdAt: string;
  readAt: string | null;
  actionIds: number[];
}

const INBOX_SHOWN = 100;

/** What is not read yet, by the inbox's tabs. */
export async function inboxCounts(userId: number): Promise<Record<InboxTab, number>> {
  const rows = await prisma.aiInboxItem.groupBy({ by: ["kind"], where: { userId, readAt: null }, _count: { _all: true } });
  const out = Object.fromEntries(INBOX_TABS.map((t) => [t, 0])) as Record<InboxTab, number>;
  for (const r of rows) out[tabOfKind(r.kind as InboxKind)] += r._count._all;
  return out;
}

/** A person's inbox, newest first, with the changes proposed in it — theirs
 *  to decide. A task's news is not listed: it is read on the task. */
export async function inboxData(userId: number): Promise<{ items: InboxItemView[]; actions: AiActionView[]; unread: Record<InboxTab, number> }> {
  await expireProposals();
  const [rows, unread] = await Promise.all([
    prisma.aiInboxItem.findMany({ where: { userId, kind: { not: "task" } }, orderBy: { id: "desc" }, take: INBOX_SHOWN }),
    inboxCounts(userId),
  ]);
  const ids = [...new Set(rows.flatMap((r) => r.actionIds))];
  const actions = ids.length ? (await prisma.aiAction.findMany({ where: { id: { in: ids }, userId } })).map(toView) : [];
  const items: InboxItemView[] = rows.map((r) => ({
    id: r.id, kind: r.kind as InboxKind, title: r.title, body: r.body, fromName: r.fromName,
    createdAt: r.createdAt.toISOString(), readAt: r.readAt?.toISOString() ?? null, actionIds: r.actionIds,
  }));
  return { items, actions, unread };
}

export interface AutomationsData {
  automations: AutomationView[];
  /** May keep automations now (a person who lost it still sees theirs, stopped). */
  allowed: boolean;
  /** The owner's switch, and whether automations may run at this moment. */
  paused: boolean;
  inHours: boolean;
  /** When they may run: "Sun, Mon … · 07:00–19:00". */
  hours: string;
  /** No scheduler, and no tick for a while: they run only while the app is open. */
  stale: boolean;
}

export async function automationsData(me: User): Promise<AutomationsData> {
  const now = new Date();
  const [automations, clock, s] = await Promise.all([automationViews({ ownerId: me.id }), automationsClock(now), getAiSettings()]);
  const window = automationWindowOf(s);
  return {
    automations,
    allowed: hasPerm(me, AUTOMATIONS_KEY),
    paused: clock.paused,
    inHours: inAutomationWindow(now, window),
    hours: describeWindow(window),
    stale: clock.stale,
  };
}

export interface PlaybookRuleView {
  id: number;
  topic: string;
  title: string;
  body: string;
  active: boolean;
  updatedBy: string | null;
  updatedAt: string;
  revisions: { id: number; action: string; by: string; at: string }[];
}

/** The plant's playbook, its rules by topic with their latest revisions. */
export async function playbookData(me: User): Promise<{ rules: PlaybookRuleView[]; canEdit: boolean; left: number }> {
  const rows = await prisma.aiPlaybookEntry.findMany({
    orderBy: [{ active: "desc" }, { topic: "asc" }, { id: "asc" }],
    include: { revisions: { orderBy: { id: "desc" }, take: 5 } },
  });
  const { left } = playbookText(rows.filter((r) => r.active));
  const rules = rows.map((r) => ({
    id: r.id, topic: r.topic, title: r.title, body: r.body, active: r.active,
    updatedBy: r.updatedBy, updatedAt: r.updatedAt.toISOString(),
    revisions: r.revisions.map((v) => ({ id: v.id, action: v.action, by: v.by, at: v.at.toISOString() })),
  }));
  return { rules, canEdit: me.isAdmin, left };
}

/** Whether this person may open the assistant's own tabs (the chat, the playbook). */
export async function chatStatusFor(me: User): Promise<{ visible: boolean; status: AiChatStatus; model: string }> {
  const s = await aiStatusFor(me);
  return { visible: s.visible, status: chatStatusOf(s), model: s.model };
}
