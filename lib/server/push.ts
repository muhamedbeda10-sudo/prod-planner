import "server-only";
import webpush from "web-push";
import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/server/ai/secret";

// Web Push — the notification that reaches a person's phone or computer with
// the app closed: an automation's message, a report, a suggestion waiting for
// them. Each device a person turns notifications on for is a PushSubscription;
// the browser's push service (Google's, Mozilla's, Apple's, Microsoft's)
// delivers what the app signs with its key pair. Nothing here is required for
// the inbox itself — a person without a device still finds everything there.

export interface PushMessage {
  title: string;
  body: string;
  /** Where a click opens the app. */
  url: string;
  /** The same tag replaces an earlier notification instead of piling up. */
  tag?: string;
}

/** Push services a device may name — anything else is not a push service, and
 *  the app will not post to it. */
const PUSH_HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)mozilla\.com$/, /(^|\.)mozaws\.net$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

/** A device's push address, checked: https, and one of the push services. */
export function pushEndpointOk(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/** A subscription as the browser hands it over, checked; null when it is not one. */
export function readSubscription(raw: unknown): { endpoint: string; p256dh: string; auth: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof r.endpoint === "string" ? r.endpoint : "";
  const p256dh = typeof r.keys?.p256dh === "string" ? r.keys.p256dh : "";
  const auth = typeof r.keys?.auth === "string" ? r.keys.auth : "";
  if (endpoint.length > 1000 || !pushEndpointOk(endpoint)) return null;
  if (!B64URL.test(p256dh) || p256dh.length < 40 || p256dh.length > 200 || !B64URL.test(auth) || auth.length < 10 || auth.length > 100) return null;
  return { endpoint, p256dh, auth };
}

/** The key pair, made on first use. */
async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const row = await prisma.pushKeys.findUnique({ where: { id: 1 } });
  if (row) {
    const privateKey = decryptSecret(row.privateKeyEnc);
    if (privateKey) return { publicKey: row.publicKey, privateKey };
    // unreadable — the secret behind it changed. Every device subscribed under
    // the old public key, so none of them can be reached any more: they go,
    // and a new pair is made; each person turns notifications on again.
    await prisma.$transaction([prisma.pushSubscription.deleteMany({}), prisma.pushKeys.deleteMany({})]);
  }
  const made = webpush.generateVAPIDKeys();
  try {
    await prisma.pushKeys.create({ data: { id: 1, publicKey: made.publicKey, privateKeyEnc: encryptSecret(made.privateKey) } });
    return made;
  } catch {
    // two first uses at once: the other one's pair stands
    const other = await prisma.pushKeys.findUnique({ where: { id: 1 } });
    const privateKey = other ? decryptSecret(other.privateKeyEnc) : null;
    if (!other || !privateKey) throw new Error("The push keys could not be made.");
    return { publicKey: other.publicKey, privateKey };
  }
}

/** What a device subscribes under. */
export async function pushPublicKey(): Promise<string> {
  return (await vapidKeys()).publicKey;
}

/** Who the push services may contact about the app's pushes: PUSH_SUBJECT,
 *  else the deployment's address, else the owner's email. */
async function vapidSubject(): Promise<string> {
  if (process.env.PUSH_SUBJECT) return process.env.PUSH_SUBJECT;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  const owner = await prisma.user.findFirst({ where: { isOwner: true }, select: { email: true } });
  if (!owner) throw new Error("Set PUSH_SUBJECT (a mailto: or https: address) for the push services.");
  return `mailto:${owner.email}`;
}

/** A device that keeps failing this many times in a row is dropped. */
const MAX_FAILURES = 10;
const BODY_MAX = 300;

/** Push one message to every device of one person. Devices the push service
 *  says are gone are dropped. Never throws: a push is a courtesy on top of
 *  the inbox. */
export async function pushTo(userId: number, msg: PushMessage): Promise<{ sent: number; failed: number }> {
  const devices = await prisma.pushSubscription.findMany({ where: { userId } });
  if (devices.length === 0) return { sent: 0, failed: 0 };
  let keys: { publicKey: string; privateKey: string };
  let subject: string;
  try {
    [keys, subject] = await Promise.all([vapidKeys(), vapidSubject()]);
  } catch (e) {
    console.error("push: no keys", e);
    return { sent: 0, failed: devices.length };
  }
  const payload = JSON.stringify({ title: msg.title.slice(0, 120), body: msg.body.slice(0, BODY_MAX), url: msg.url, tag: msg.tag ?? null });
  let sent = 0;
  await Promise.all(
    devices.map(async (d) => {
      try {
        await webpush.sendNotification({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, payload, {
          vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: 24 * 3600,
          urgency: "normal",
          timeout: 10_000,
        });
        sent++;
        await prisma.pushSubscription.update({ where: { id: d.id }, data: { lastOkAt: new Date(), failures: 0 } });
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410 || d.failures + 1 >= MAX_FAILURES) {
          await prisma.pushSubscription.deleteMany({ where: { id: d.id } });
        } else {
          await prisma.pushSubscription.update({ where: { id: d.id }, data: { failures: { increment: 1 } } }).catch(() => {});
        }
        if (status !== 404 && status !== 410) console.error(`push: device ${d.id} failed`, status ?? e);
      }
    }),
  );
  return { sent, failed: devices.length - sent };
}
