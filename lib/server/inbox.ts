import "server-only";
import { prisma } from "@/lib/db";
import { pushTo } from "@/lib/server/push";
import {
  INBOX_BODY_MAX, INBOX_POPUP_PREVIEW, INBOX_POPUP_SHOWN, INBOX_TITLE_MAX, inboxPreview, type InboxHead, type InboxKind, type InboxPopupItem,
} from "@/lib/domain/inbox";

// Putting something in a person's inbox — a report, a message, a suggestion,
// a task's news — and pushing it to their devices. The inbox row is the delivery; the push is
// a courtesy on top of it (a person with no device turned on, or a device
// that is off, still finds it under the bell).

export interface InboxDelivery {
  userId: number;
  kind: InboxKind;
  title: string;
  body: string;
  fromName?: string | null;
  /** Who sent it by hand through the assistant — the one who may take it back. */
  fromUserId?: number | null;
  automationId?: number | null;
  runId?: number | null;
  actionIds?: number[];
  /** A task's news: the task it is about — its notification opens the task. */
  taskId?: number | null;
}


/** People pushed to at once — a slow push service holds up only its own. */
const PUSH_AT_ONCE = 5;

/** Deliver each item, then push them; the ids of the rows made. Only active
 *  accounts receive anything. Every row is in before the first push goes. */
export async function deliverToInbox(items: readonly InboxDelivery[]): Promise<number[]> {
  if (items.length === 0) return [];
  const active = new Set((await prisma.user.findMany({ where: { id: { in: [...new Set(items.map((i) => i.userId))] }, active: true }, select: { id: true } })).map((u) => u.id));
  const made: { id: number; item: InboxDelivery }[] = [];
  for (const i of items) {
    if (!active.has(i.userId)) continue;
    const row = await prisma.aiInboxItem.create({
      data: {
        userId: i.userId, kind: i.kind, title: i.title.slice(0, INBOX_TITLE_MAX), body: i.body.slice(0, INBOX_BODY_MAX), fromName: i.fromName ?? null, fromUserId: i.fromUserId ?? null,
        automationId: i.automationId ?? null, runId: i.runId ?? null, actionIds: i.actionIds ?? [], taskId: i.taskId ?? null,
      },
      select: { id: true },
    });
    made.push({ id: row.id, item: i });
  }
  for (let k = 0; k < made.length; k += PUSH_AT_ONCE) {
    await Promise.all(
      made.slice(k, k + PUSH_AT_ONCE).map(async ({ id, item }) => {
        const url = item.taskId ? `/inbox?task=${item.taskId}` : `/inbox?item=${id}`;
        // a task's news replaces its earlier notification on the device
        const tag = item.taskId ? `task-${item.taskId}` : `inbox-${id}`;
        const pushed = await pushTo(item.userId, { title: item.title, body: inboxPreview(item.body), url, tag });
        if (pushed.sent > 0) await prisma.aiInboxItem.update({ where: { id }, data: { pushedAt: new Date() } });
      }),
    );
  }
  return made.map((m) => m.id);
}

/** The bar's poll: the unread count and the newest unread item, in one query. */
export async function inboxHead(userId: number): Promise<InboxHead> {
  const r = await prisma.aiInboxItem.aggregate({ where: { userId, readAt: null }, _count: { _all: true }, _max: { id: true } });
  return { unread: r._count._all, latestId: r._max.id ?? 0 };
}

/** What pops up on the screen until it is marked read: every unread item
 *  but what the person sent themselves (a reply kept from their own chat). */
const popupWhere = (userId: number) => ({ userId, readAt: null, OR: [{ fromUserId: null }, { fromUserId: { not: userId } }] });

/** The popups: the newest few, and how many in all. */
export async function inboxPopups(userId: number): Promise<{ items: InboxPopupItem[]; total: number }> {
  const where = popupWhere(userId);
  const [rows, total] = await Promise.all([
    prisma.aiInboxItem.findMany({
      where, orderBy: { id: "desc" }, take: INBOX_POPUP_SHOWN,
      select: { id: true, kind: true, title: true, body: true, fromName: true, createdAt: true, taskId: true },
    }),
    prisma.aiInboxItem.count({ where }),
  ]);
  const items = rows.map((r) => ({
    id: r.id, kind: r.kind as InboxKind, title: r.title, preview: inboxPreview(r.body, INBOX_POPUP_PREVIEW), fromName: r.fromName,
    createdAt: r.createdAt.toISOString(), taskId: r.taskId,
  }));
  return { items, total };
}

/** Mark read every item that pops up — and only those. */
export async function markInboxPopupsRead(userId: number): Promise<void> {
  await prisma.aiInboxItem.updateMany({ where: popupWhere(userId), data: { readAt: new Date() } });
}

/** What the bell shows: the unread count, the newest unread item, and
 *  whether there is anything at all (a person nothing was ever sent to has no
 *  bell). Never throws — the bar on every page reads it. */
export async function inboxState(userId: number): Promise<InboxHead & { any: boolean }> {
  try {
    const [head, first] = await Promise.all([inboxHead(userId), prisma.aiInboxItem.findFirst({ where: { userId }, select: { id: true } })]);
    return { ...head, any: !!first };
  } catch (e) {
    console.error("inbox: could not read the bell's count", e);
    return { unread: 0, latestId: 0, any: false };
  }
}
