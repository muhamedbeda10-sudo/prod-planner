import "server-only";
import { prisma } from "@/lib/db";
import { deliverToInbox } from "./inbox";

// A message from one person to colleagues' inboxes — what the inbox's own
// action, the assistant's send_message and a shared answer all go through:
// the same recipients' check, the same hour's cap.

/** A message one person may send to colleagues' inboxes: how many at once,
 *  and how many in an hour — each one reaches phones. */
export const MESSAGE_LIMITS = { to: 20, anHour: 60 } as const;

/** A message from a person to colleagues' inboxes (and their devices), as
 *  the person: the recipients checked to be active, the hour's cap held, and
 *  the items delivered with the person named as the sender. The ids of the
 *  items made, or what is wrong. The caller checks the permission and the
 *  words' length. */
export async function sendMessageFromPerson(me: { id: number; name: string }, o: { to: readonly number[]; title: string; body: string; fromName?: string }): Promise<{ ok: true; ids: number[] } | { ok: false; error: string }> {
  const to = [...new Set(o.to.filter((n) => Number.isInteger(n) && n > 0 && n !== me.id))];
  if (to.length === 0 || to.length > MESSAGE_LIMITS.to) return { ok: false, error: `Name 1 to ${MESSAGE_LIMITS.to} people.` };
  const [people, lastHour] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: to }, active: true }, select: { id: true } }),
    prisma.aiInboxItem.count({ where: { fromUserId: me.id, createdAt: { gte: new Date(Date.now() - 3_600_000) } } }),
  ]);
  if (people.length !== to.length) return { ok: false, error: "One of them is not an active user." };
  if (lastHour + people.length > MESSAGE_LIMITS.anHour) return { ok: false, error: `That is more than ${MESSAGE_LIMITS.anHour} messages in an hour — wait a while.` };
  const ids = await deliverToInbox(people.map((p) => ({ userId: p.id, kind: "message" as const, title: o.title, body: o.body, fromName: o.fromName ?? me.name, fromUserId: me.id })));
  return { ok: true, ids };
}
