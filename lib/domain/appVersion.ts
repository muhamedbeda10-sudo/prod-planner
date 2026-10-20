// A new version of the app reaching pages that are already open. Navigating
// inside the app never reloads its code, so a page — above all the installed
// app, which has no reload button — keeps running the version it was opened
// on until it is closed. The open page asks the server which version it
// serves (/api/version) and, once that differs from its own, picks up the
// new one at a moment that loses nothing: on the next page it goes to, or
// after nobody has touched it for a while (a minimised app included) — never
// under an open dialog or a box with something typed in it (the assistant's,
// chat and inbox panels stay open from page to page). Until then it only
// offers a Reload.

/** How often an open page asks the server which version it serves. */
export const VERSION_CHECK_MS = 5 * 60_000;
/** No key, click or touch for this long — in front or in the background — counts as nobody at it. */
export const IDLE_RELOAD_MS = 10 * 60_000;
/** A page reloaded for a new version this recently only offers the Reload — never a loop. */
export const RELOAD_GUARD_MS = 2 * 60_000;

/** The version the server answered, when it is a real one and not the page's own. */
export function newerVersion(mine: string, answer: unknown): string | null {
  if (!mine || !answer || typeof answer !== "object") return null;
  const served = (answer as { version?: unknown }).version;
  if (typeof served !== "string" || !served.trim() || served === mine) return null;
  return served;
}

export interface UpdateMoment {
  /** The page just went to another page of the app. */
  navigated: boolean;
  /** Since the last key, click or touch on the page. */
  idleMs: number;
  /** A dialog is open or a box has something typed in it — it may be half done. */
  busy: boolean;
  /** Since the page last reloaded itself for a new version; null when it has not. */
  sinceReloadMs: number | null;
}

/** With a new version waiting: reload now, or only offer the Reload. */
export function updateStep(m: UpdateMoment): "reload" | "offer" {
  if (m.sinceReloadMs !== null && m.sinceReloadMs >= 0 && m.sinceReloadMs < RELOAD_GUARD_MS) return "offer";
  if (m.busy) return "offer";
  return m.navigated || m.idleMs >= IDLE_RELOAD_MS ? "reload" : "offer";
}
