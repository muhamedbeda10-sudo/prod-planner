import "server-only";
import { prisma } from "@/lib/db";

// In-app chat: DIRECT messages (two users) and GROUP messages (a named group
// of members). Reads are always scoped to the CALLING user — a DM thread can
// only be fetched by one of its two ends, a group thread only by a member,
// unread counts only count what's addressed to the caller, and a message the
// caller "deleted for me" never comes back to them while everyone else keeps
// seeing it.

export type ThreadKind = "user" | "group";

export interface ChatAttachment {
  url: string; // https URL (Vercel Blob) or a data: URL (DB fallback for images)
  name: string;
  size: number; // bytes
  type: string; // MIME as uploaded
}

export interface ChatReactionDTO {
  emoji: string;
  count: number;
  mine: boolean; // the caller reacted with this emoji
}

/** The quoted head of a reply — enough to render the quote and jump to it. */
export interface ChatReplyRef {
  id: number;
  fromId: number;
  fromName: string;
  snippet: string; // short preview of the quoted message
}

export interface ChatMessageDTO {
  id: number;
  fromId: number;
  fromName: string; // shown above group bubbles
  toId: number | null;
  groupId: number | null;
  body: string;
  mo: string | null; // attached order — the client renders a chip to /trace
  attachments: ChatAttachment[];
  pinnedAt: string | null;
  replyTo: ChatReplyRef | null;
  reactions: ChatReactionDTO[];
  readAt: string | null; // DM only: when the recipient saw it (the ✓✓)
  createdAt: string; // ISO — serializable across the server/client boundary
}

export interface ChatContact {
  kind: ThreadKind;
  id: number; // userId or groupId, disambiguated by kind
  name: string;
  isAdmin: boolean; // users only
  memberCount: number; // groups only
  unread: number;
  lastBody: string | null; // latest message — the list preview
  lastAt: string | null;
  lastFromMe: boolean;
  lastFromName: string | null; // group previews say who spoke
}

const ROW_INCLUDE = {
  from: { select: { name: true } },
  reactions: { select: { userId: true, emoji: true } },
  replyTo: {
    select: {
      id: true, fromId: true, body: true, mo: true, attachments: true,
      from: { select: { name: true } },
    },
  },
} as const;

type ReplyRow = {
  id: number;
  fromId: number;
  body: string;
  mo: string | null;
  attachments: string | null;
  from: { name: string };
};

type Row = {
  id: number;
  fromId: number;
  toId: number | null;
  groupId: number | null;
  body: string;
  mo: string | null;
  attachments: string | null;
  pinnedAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
  from: { name: string };
  replyTo: ReplyRow | null;
  reactions: { userId: number; emoji: string }[];
};

function parseAttachments(json: string | null): ChatAttachment[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return []; // a corrupt blob loses its previews, never the whole thread
  }
}

function packReactions(rows: Row["reactions"], meId: number): ChatReactionDTO[] {
  const byEmoji = new Map<string, { count: number; mine: boolean }>();
  for (const r of rows) {
    const e = byEmoji.get(r.emoji) ?? { count: 0, mine: false };
    e.count += 1;
    if (r.userId === meId) e.mine = true;
    byEmoji.set(r.emoji, e);
  }
  return [...byEmoji.entries()].map(([emoji, e]) => ({ emoji, ...e }));
}

/** Short preview of a message for quotes and list rows. */
export function snippetOf(m: { body: string; mo: string | null; attachments: string | null }): string {
  if (m.body) return m.body.length > 90 ? m.body.slice(0, 90) + "…" : m.body;
  const att = parseAttachments(m.attachments);
  if (att.length > 0) return att[0].type.startsWith("image/") ? "📷 Photo" : `📎 ${att[0].name}`;
  if (m.mo) return `📦 ${m.mo}`;
  return "";
}

const toReplyRef = (r: ReplyRow | null): ChatReplyRef | null =>
  r ? { id: r.id, fromId: r.fromId, fromName: r.from.name, snippet: snippetOf(r) } : null;

const toDTO = (m: Row, meId: number): ChatMessageDTO => ({
  id: m.id,
  fromId: m.fromId,
  fromName: m.from.name,
  toId: m.toId,
  groupId: m.groupId,
  body: m.body,
  mo: m.mo,
  attachments: parseAttachments(m.attachments),
  pinnedAt: m.pinnedAt?.toISOString() ?? null,
  replyTo: toReplyRef(m.replyTo),
  reactions: packReactions(m.reactions, meId),
  readAt: m.readAt?.toISOString() ?? null,
  createdAt: m.createdAt.toISOString(),
});

/** What the contact list shows for a message with no text. */
const previewOf = (m: Row): string => snippetOf(m);

/** Everything the caller can open: every active user (DMs) and every group
 *  they belong to, each carrying its unread count and latest-message preview.
 *  Unread first, then most recent conversation, then by name. */
export async function getChatContacts(meId: number): Promise<ChatContact[]> {
  const [users, memberships, dmUnread, latest] = await Promise.all([
    prisma.user.findMany({
      where: { active: true, id: { not: meId } },
      select: { id: true, name: true, isAdmin: true },
      orderBy: { name: "asc" },
    }),
    prisma.chatGroupMember.findMany({
      where: { userId: meId },
      select: {
        lastReadId: true,
        group: { select: { id: true, name: true, _count: { select: { members: true } } } },
      },
    }),
    prisma.chatMessage.groupBy({
      by: ["fromId"],
      where: { toId: meId, readAt: null, hiddenForTo: false },
      _count: { _all: true },
    }),
    // newest slice of everything the caller can see — enough to preview every
    // active conversation without a per-contact query
    prisma.chatMessage.findMany({
      where: {
        OR: [
          { fromId: meId, groupId: null, hiddenForFrom: false },
          { toId: meId, hiddenForTo: false },
          { group: { members: { some: { userId: meId } } }, hides: { none: { userId: meId } } },
        ],
      },
      orderBy: { id: "desc" },
      take: 1000,
      include: ROW_INCLUDE,
    }),
  ]);

  // group unread: everything past the member's read cursor, by someone else
  const groupUnread = new Map<number, number>();
  if (memberships.length > 0) {
    const counts = await prisma.chatMessage.groupBy({
      by: ["groupId"],
      where: {
        fromId: { not: meId },
        OR: memberships.map((m) => ({ groupId: m.group.id, id: { gt: m.lastReadId } })),
      },
      _count: { _all: true },
    });
    for (const c of counts) if (c.groupId) groupUnread.set(c.groupId, c._count._all);
  }

  const dmUnreadOf = new Map(dmUnread.map((u) => [u.fromId, u._count._all]));
  const lastDm = new Map<number, Row>(); // partner userId → newest visible message
  const lastGroup = new Map<number, Row>(); // groupId → newest visible message
  for (const m of latest as Row[]) {
    if (m.groupId) {
      if (!lastGroup.has(m.groupId)) lastGroup.set(m.groupId, m); // list is newest-first
    } else {
      const partner = m.fromId === meId ? (m.toId ?? 0) : m.fromId;
      if (!lastDm.has(partner)) lastDm.set(partner, m);
    }
  }

  const contact = (
    kind: ThreadKind,
    id: number,
    name: string,
    extra: { isAdmin?: boolean; memberCount?: number; unread: number },
    last: Row | undefined,
  ): ChatContact => ({
    kind,
    id,
    name,
    isAdmin: extra.isAdmin ?? false,
    memberCount: extra.memberCount ?? 0,
    unread: extra.unread,
    lastBody: last ? previewOf(last) : null,
    lastAt: last?.createdAt.toISOString() ?? null,
    lastFromMe: last ? last.fromId === meId : false,
    lastFromName: last && last.fromId !== meId ? last.from.name : null,
  });

  return [
    ...memberships.map((m) =>
      contact(
        "group",
        m.group.id,
        m.group.name,
        { memberCount: m.group._count.members, unread: groupUnread.get(m.group.id) ?? 0 },
        lastGroup.get(m.group.id),
      ),
    ),
    ...users.map((u) =>
      contact("user", u.id, u.name, { isAdmin: u.isAdmin, unread: dmUnreadOf.get(u.id) ?? 0 }, lastDm.get(u.id)),
    ),
  ].sort(
    (a, b) =>
      Number(!!b.unread) - Number(!!a.unread) ||
      (b.lastAt ?? "").localeCompare(a.lastAt ?? "") ||
      a.name.localeCompare(b.name),
  );
}

/** Whether the caller sits in a group — the gate on every group operation. */
export async function isGroupMember(meId: number, groupId: number): Promise<boolean> {
  const m = await prisma.chatGroupMember.findUnique({
    where: { groupId_userId: { groupId, userId: meId } },
    select: { id: true },
  });
  return !!m;
}

/** One conversation (DM or group), oldest first, minus anything the caller
 *  deleted for themselves. `afterId` fetches only what's new — the polling
 *  fallback's increment. Group access must be checked by the CALLER. */
export async function getChatThread(
  meId: number,
  kind: ThreadKind,
  otherId: number,
  afterId?: number,
): Promise<ChatMessageDTO[]> {
  const scope =
    kind === "group"
      ? { groupId: otherId, hides: { none: { userId: meId } } }
      : {
          OR: [
            { fromId: meId, toId: otherId, hiddenForFrom: false },
            { fromId: otherId, toId: meId, hiddenForTo: false },
          ],
        };
  const messages = await prisma.chatMessage.findMany({
    where: { ...scope, ...(afterId ? { id: { gt: afterId } } : {}) },
    orderBy: { id: afterId ? "asc" : "desc" },
    take: afterId ? undefined : 200, // a fresh open shows the latest 200
    include: ROW_INCLUDE,
  });
  if (!afterId) messages.reverse(); // fetched newest-first to cap, shown oldest-first
  return (messages as Row[]).map((m) => toDTO(m, meId));
}

/** The mutable face of a message — what can change AFTER it was sent. The
 *  poll merges this onto messages already on screen instead of re-downloading
 *  bodies and attachments (which may be inline images) every few seconds. */
export interface ChatMessageState {
  id: number;
  pinnedAt: string | null;
  readAt: string | null;
  reactions: ChatReactionDTO[];
}

/** Lightweight state of the newest slice of a thread: ids + pins + reads +
 *  reactions only — NO bodies, NO attachments. Same visibility scope as
 *  getChatThread. Group access must be checked by the CALLER. */
export async function getChatThreadState(
  meId: number,
  kind: ThreadKind,
  otherId: number,
): Promise<ChatMessageState[]> {
  const scope =
    kind === "group"
      ? { groupId: otherId, hides: { none: { userId: meId } } }
      : {
          OR: [
            { fromId: meId, toId: otherId, hiddenForFrom: false },
            { fromId: otherId, toId: meId, hiddenForTo: false },
          ],
        };
  const rows = await prisma.chatMessage.findMany({
    where: scope,
    orderBy: { id: "desc" },
    take: 200, // matches the slice a fresh open shows
    select: {
      id: true,
      pinnedAt: true,
      readAt: true,
      reactions: { select: { userId: true, emoji: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    pinnedAt: r.pinnedAt?.toISOString() ?? null,
    readAt: r.readAt?.toISOString() ?? null,
    reactions: packReactions(r.reactions, meId),
  }));
}

/** Total unread for the caller (DMs + groups) — the nav badge. */
export async function getChatUnreadCount(meId: number): Promise<number> {
  const [dm, memberships] = await Promise.all([
    prisma.chatMessage.count({ where: { toId: meId, readAt: null, hiddenForTo: false } }),
    prisma.chatGroupMember.findMany({ where: { userId: meId }, select: { groupId: true, lastReadId: true } }),
  ]);
  if (memberships.length === 0) return dm;
  const group = await prisma.chatMessage.count({
    where: {
      fromId: { not: meId },
      OR: memberships.map((m) => ({ groupId: m.groupId, id: { gt: m.lastReadId } })),
    },
  });
  return dm + group;
}
