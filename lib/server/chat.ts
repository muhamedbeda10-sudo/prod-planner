import "server-only";
import { prisma } from "@/lib/db";

// In-app direct messages. Reads are always scoped to the CALLING user — a
// thread can only be fetched by one of its two ends, unread counts only count
// messages addressed to the caller, and a message the caller "deleted for me"
// (hiddenForFrom/hiddenForTo) never comes back to them while the other end
// keeps seeing it.

export interface ChatAttachment {
  url: string;
  name: string;
  size: number; // bytes
  type: string; // MIME as uploaded
}

export interface ChatMessageDTO {
  id: number;
  fromId: number;
  toId: number;
  body: string;
  mo: string | null; // attached order — the client renders a chip to /trace
  attachments: ChatAttachment[];
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

type Row = {
  id: number;
  fromId: number;
  toId: number;
  body: string;
  mo: string | null;
  attachments: string | null;
  createdAt: Date;
};

const ROW_SELECT = {
  id: true, fromId: true, toId: true, body: true, mo: true, attachments: true, createdAt: true,
} as const;

function parseAttachments(json: string | null): ChatAttachment[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return []; // a corrupt blob loses its previews, never the whole thread
  }
}

const toDTO = (m: Row): ChatMessageDTO => ({
  id: m.id,
  fromId: m.fromId,
  toId: m.toId,
  body: m.body,
  mo: m.mo,
  attachments: parseAttachments(m.attachments),
  createdAt: m.createdAt.toISOString(),
});

/** What the contact list shows for a message with no text. */
function previewOf(m: Row): string {
  if (m.body) return m.body;
  const att = parseAttachments(m.attachments);
  if (att.length > 0) return att[0].type.startsWith("image/") ? "📷 Photo" : `📎 ${att[0].name}`;
  if (m.mo) return `📦 ${m.mo}`;
  return "";
}

/** The caller's side of the visibility switch: which flag hides a message
 *  from THEM. Their own sends hide on hiddenForFrom, received on hiddenForTo. */
const visibleTo = (meId: number) => ({
  OR: [
    { fromId: meId, hiddenForFrom: false },
    { toId: meId, hiddenForTo: false },
  ],
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
      where: { toId: meId, readAt: null, hiddenForTo: false },
      _count: { _all: true },
    }),
    // newest slice of the caller's history — enough to preview every active
    // conversation without a per-contact query
    prisma.chatMessage.findMany({
      where: visibleTo(meId),
      orderBy: { id: "desc" },
      take: 1000,
      select: ROW_SELECT,
    }),
  ]);

  const unreadOf = new Map(unread.map((u) => [u.fromId, u._count._all]));
  const lastOf = new Map<number, Row>(); // partner id → newest visible message
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
        lastBody: last ? previewOf(last) : null,
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

/** The conversation between the caller and one other user, oldest first,
 *  minus anything the caller deleted for themselves. `afterId` fetches only
 *  what's new — the polling fallback's increment. */
export async function getChatThread(meId: number, otherId: number, afterId?: number): Promise<ChatMessageDTO[]> {
  const messages = await prisma.chatMessage.findMany({
    where: {
      OR: [
        { fromId: meId, toId: otherId, hiddenForFrom: false },
        { fromId: otherId, toId: meId, hiddenForTo: false },
      ],
      ...(afterId ? { id: { gt: afterId } } : {}),
    },
    orderBy: { id: afterId ? "asc" : "desc" },
    take: afterId ? undefined : 200, // a fresh open shows the latest 200
    select: ROW_SELECT,
  });
  if (!afterId) messages.reverse(); // fetched newest-first to cap, shown oldest-first
  return messages.map(toDTO);
}

/** Total unread messages for the caller — the nav badge. */
export async function getChatUnreadCount(meId: number): Promise<number> {
  return prisma.chatMessage.count({ where: { toId: meId, readAt: null, hiddenForTo: false } });
}
