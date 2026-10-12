// Turning the server's pushes on and off for this device — the browser's push
// subscription under the app's key, kept on the server for the person signed
// in. Client-only module.

import { notifyPerm, registration, type NotifyPerm } from "@/lib/sysNotify";
import { inboxPushKey, removeInboxDevice, saveInboxDevice } from "@/app/inbox/actions";

export type PushState = NotifyPerm | "on";

/** Whether this browser can receive pushes at all. */
function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && notifyPerm() !== "unsupported";
}

/** The key as the browser wants it. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Where this device stands: on, off (asked or not yet), blocked, or not possible. */
export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const perm = notifyPerm();
  if (perm !== "granted") return perm;
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "granted";
}

/** Ask, subscribe and tell the server — call from a click. The error to show,
 *  or null when it is on. */
export async function turnPushOn(): Promise<string | null> {
  if (!pushSupported()) return "This browser cannot receive notifications. On an iPhone, add the app to the Home Screen first and open it from there.";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "Notifications are blocked for this site — allow them in the browser's site settings, then try again.";
  const reg = await registration();
  if (!reg) return "The browser would not start the notifications helper — reload the page and try again.";
  const key = await inboxPushKey();
  if (!key.ok || !key.key) return key.error ?? "Notifications cannot be turned on right now.";
  let sub = await reg.pushManager.getSubscription();
  // a subscription made under another key (the app's key changed) cannot be reached
  if (sub && sub.options.applicationServerKey) {
    const was = new Uint8Array(sub.options.applicationServerKey);
    const now = keyBytes(key.key);
    if (was.length !== now.length || was.some((b, i) => b !== now[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key.key) });
  const saved = await saveInboxDevice(JSON.stringify(sub.toJSON()), navigator.userAgent);
  return saved.ok ? null : saved.error ?? "The device could not be saved.";
}

/** Stop pushes to this device. */
export async function turnPushOff(): Promise<void> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await removeInboxDevice(sub.endpoint);
  await sub.unsubscribe();
}
