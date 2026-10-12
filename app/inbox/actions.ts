"use server";

import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server/auth";
import { pushPublicKey, readSubscription } from "@/lib/server/push";
import { unreadInboxCount } from "@/lib/server/inbox";

// A person's own inbox — what the assistant and the automations sent them —
// and the devices they turned notifications on for. Each person reads, marks
// and clears only their own.

const NOT_LOGGED_IN = "You are not logged in — refresh the page.";
const MAX_IDS = 500;

export interface InboxActionResult {
  ok: boolean;
  error?: string;
}

const idsOk = (ids: unknown): ids is number[] => Array.isArray(ids) && ids.length <= MAX_IDS && ids.every((i) => Number.isInteger(i) && i > 0);

/** The bell's number — polled while the app is open. */
export async function pollInbox(): Promise<{ unread: number }> {
  const user = await getCurrentUser();
  if (!user) return { unread: 0 };
  return { unread: await unreadInboxCount(user.id) };
}

/** Mark items read — the ones given, or all of them. */
export async function markInboxRead(ids: number[] | "all"): Promise<InboxActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  if (ids !== "all" && !idsOk(ids)) return { ok: false, error: "Invalid items." };
  await prisma.aiInboxItem.updateMany({ where: { userId: user.id, readAt: null, ...(ids === "all" ? {} : { id: { in: ids } }) }, data: { readAt: new Date() } });
  return { ok: true };
}

/** Clear items out of the inbox — what they proposed stays on the
 *  assistant's record. */
export async function deleteInboxItems(ids: number[]): Promise<InboxActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  if (!idsOk(ids) || ids.length === 0) return { ok: false, error: "Invalid items." };
  await prisma.aiInboxItem.deleteMany({ where: { userId: user.id, id: { in: ids } } });
  return { ok: true };
}

/** The key a device subscribes under. */
export async function inboxPushKey(): Promise<{ ok: boolean; key?: string; error?: string }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  try {
    return { ok: true, key: await pushPublicKey() };
  } catch (e) {
    console.error("push: no key", e);
    return { ok: false, error: "Notifications cannot be turned on right now — try again later." };
  }
}

/** Keep this device's subscription for the person signed in on it (a device
 *  someone else used before is theirs now). */
export async function saveInboxDevice(subscriptionJson: string, userAgent: string): Promise<InboxActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  let raw: unknown;
  try {
    raw = JSON.parse(subscriptionJson);
  } catch {
    return { ok: false, error: "The browser's answer could not be read." };
  }
  const sub = readSubscription(raw);
  if (!sub) return { ok: false, error: "This browser's push service is not one the app knows." };
  const ua = String(userAgent ?? "").slice(0, 300) || null;
  await prisma.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    create: { userId: user.id, ...sub, userAgent: ua },
    update: { userId: user.id, p256dh: sub.p256dh, auth: sub.auth, userAgent: ua, failures: 0 },
  });
  return { ok: true };
}

/** Stop notifications to this device. */
export async function removeInboxDevice(endpoint: string): Promise<InboxActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  await prisma.pushSubscription.deleteMany({ where: { userId: user.id, endpoint: String(endpoint ?? "").slice(0, 1000) } });
  return { ok: true };
}
