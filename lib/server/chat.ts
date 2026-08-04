import "server-only";
import { prisma } from "@/lib/db";

// In-app direct messages. Reads are always scoped to the CALLING user — a
// thread can only be fetched by one of its two ends, and unread counts only
// count messages addressed to the caller.

export interface ChatMessageDTO {
  id: number;
  fromId: number;
  toId: number;
  body: string;
  createdAt: string; // ISO — serializable across the server/client boundary
}

export interface ChatContact {
  id: number;
  name: string;
  isAdmin: boolean;
  unread: number; // messages from this user the caller hasn't read
  lastBody: string | null; // latest message either way — the list preview
  lastAt: string | null;
  lastFromMe: boolean;
}

const toDTO = (m: { id: number; fromId: number; toId: number; body: string; createdAt: Date }): ChatMessageDTO => ({
  id: m.id,
  fromId: m.fromId,
  toId: m.toId,
  body: m.body,
  createdAt: m.createdAt.toISOString(),
});

/** Everyone the caller can message (active users), each carrying the unread
 *  count and the latest exchanged message as a preview. Unread first, then
 *  most recent conversation, then by name. */
export async function getChatContacts(meId: number): Promise<ChatContact[]> {
  const [users, unread, latest] = await Promise.all([
    prisma.user.findMany({
      where: { active: true, id: { not: meId } },
      select: { id: true, name: true, isAdmin: true },
      orderBy: { name: "asc" },
    }),
    prisma.chatMessage.groupBy({
      by: ["fromId"],
      where: { toId: meId, readAt: null },
      _count: { _all: true },
    }),
    // newest slice of the caller's history — enough to preview every active
    // conversation without a per-contact query
    prisma.chatMessage.findMany({
      where: { OR: [{ fromId: meId }, { toId: meId }] },
      orderBy: { id: "desc" },
      take: 1000,
      select: { id: true, fromId: true, toId: true, body: true, createdAt: true },
    }),
  ]);

  const unreadOf = new Map(unread.map((u) => [u.fromId, u._count._all]));
  const lastOf = new Map<number, (typeof latest)[number]>(); // partner id → newest message
  for (const m of latest) {
    const partner = m.fromId === meId ? m.toId : m.fromId;
    if (!lastOf.has(partner)) lastOf.set(partner, m); // list is newest-first
  }

  return users
    .map((u) => {
      const last = lastOf.get(u.id);
      return {
        id: u.id,
        name: u.name,
        isAdmin: u.isAdmin,
        unread: unreadOf.get(u.id) ?? 0,
        lastBody: last?.body ?? null,
        lastAt: last?.createdAt.toISOString() ?? null,
        lastFromMe: last ? last.fromId === meId : false,
      };
    })
    .sort(
      (a, b) =>
        Number(!!b.unread) - Number(!!a.unread) ||
        (b.lastAt ?? "").localeCompare(a.lastAt ?? "") ||
        a.name.localeCompare(b.name),
    );
}

/** The conversation between the caller and one other user, oldest first.
 *  `afterId` fetches only what's new — the polling fallback's increment. */
export async function getChatThread(meId: number, otherId: number, afterId?: number): Promise<ChatMessageDTO[]> {
  const messages = await prisma.chatMessage.findMany({
    where: {
      OR: [
        { fromId: meId, toId: otherId },
        { fromId: otherId, toId: meId },
      ],
      ...(afterId ? { id: { gt: afterId } } : {}),
    },
    orderBy: { id: afterId ? "asc" : "desc" },
    take: afterId ? undefined : 200, // a fresh open shows the latest 200
    select: { id: true, fromId: true, toId: true, body: true, createdAt: true },
  });
  if (!afterId) messages.reverse(); // fetched newest-first to cap, shown oldest-first
  return messages.map(toDTO);
}

/** Total unread messages for the caller — the nav badge. */
export async function getChatUnreadCount(meId: number): Promise<number> {
  return prisma.chatMessage.count({ where: { toId: meId, readAt: null } });
}
