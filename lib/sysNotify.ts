// System (OS) notifications — the browser's own pop-up with the system's
// sound, shown while the app is open but not in front: minimised, behind
// another window, or on another tab. Unlike the in-page chime it needs no
// click on the page first, only a one-time "Allow" from the user.
// Client-only module.

import { chimeOn } from "@/lib/chime";

export type NotifyPerm = NotificationPermission | "unsupported";

/** What a click on the notification should do in the app. */
export type NotifyAction =
  | { kind: "chat"; thread: { kind: "user" | "group"; id: number } }
  | { kind: "odoo" };

export function notifyPerm(): NotifyPerm {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

let reg: Promise<ServiceWorkerRegistration | null> | null = null;

// A service worker is what shows notifications on Android (the plain
// Notification constructor throws there) and routes their clicks back — and
// receives the server's pushes (lib/pushClient.ts).
export function registration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return Promise.resolve(null);
  reg ??= navigator.serviceWorker
    .register("/notify-sw.js")
    .then(() => navigator.serviceWorker.ready)
    .catch(() => null);
  return reg;
}

/** Ask for permission — call from a click. */
export async function askNotify(): Promise<NotifyPerm> {
  if (notifyPerm() === "unsupported") return "unsupported";
  const p = await Notification.requestPermission();
  if (p === "granted") void registration();
  return p;
}

/** Register the worker early when permission is already there. */
export function prepareNotify() {
  if (notifyPerm() === "granted") void registration();
}

/** Whether the app is out of sight — only then does a system alert add anything. */
export function appInBackground(): boolean {
  return document.visibilityState !== "visible" || !document.hasFocus();
}

/** Show one system notification. The same `tag` replaces instead of piling up,
 *  so two open tabs never show the same alert twice. Returns false when not
 *  allowed or not supported. */
export async function systemNotify(opts: {
  title: string;
  body: string;
  tag: string;
  url: string;
  action: NotifyAction;
}): Promise<boolean> {
  if (notifyPerm() !== "granted") return false;
  const options: NotificationOptions = {
    body: opts.body,
    tag: opts.tag,
    icon: "/brand/logo-sm.png",
    silent: !chimeOn(),
    data: { url: opts.url, action: opts.action },
  };
  const r = await registration();
  if (r) {
    try {
      await r.showNotification(opts.title, options);
      return true;
    } catch {
      /* fall through to the page-level notification */
    }
  }
  try {
    const n = new Notification(opts.title, options);
    n.onclick = () => {
      window.focus();
      n.close();
      window.dispatchEvent(new CustomEvent<NotifyAction>("notify-click", { detail: opts.action }));
    };
    return true;
  } catch {
    return false;
  }
}

/** Run `fn` when a notification is clicked (from the worker or the page). */
export function onNotifyClick(fn: (a: NotifyAction) => void): () => void {
  const fromWorker = (e: MessageEvent) => {
    const d = e.data as { type?: string; data?: { action?: NotifyAction } } | null;
    if (d?.type === "notify-click" && d.data?.action) fn(d.data.action);
  };
  const fromPage = (e: Event) => fn((e as CustomEvent<NotifyAction>).detail);
  const sw = typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : null;
  sw?.addEventListener("message", fromWorker);
  window.addEventListener("notify-click", fromPage);
  return () => {
    sw?.removeEventListener("message", fromWorker);
    window.removeEventListener("notify-click", fromPage);
  };
}
