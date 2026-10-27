// A window docked down the right of the screen — the assistant or the inbox
// (components/FloatDock): as wide as the person drags it, the page taking the
// rest — kept on this browser, each window its own. However wide it is kept,
// the page beside it keeps room enough to read and work in.

export const AI_DOCK_MIN = 340;
export const AI_DOCK_MAX = 900;
export const AI_DOCK_DEFAULT = 440;
/** One press of an arrow key on the handle. */
export const AI_DOCK_STEP = 24;
/** The page beside a docked window never gets narrower than this (unless the window is at its narrowest). */
export const AI_DOCK_PAGE_MIN = 420;

/** The widest a docked window can be on a screen `screen` pixels wide. */
export function dockMax(screen = Number.POSITIVE_INFINITY): number {
  return Math.max(AI_DOCK_MIN, Math.min(AI_DOCK_MAX, screen - AI_DOCK_PAGE_MIN));
}

/** A width a docked window can take, no wider than `max` (dockMax of the screen). */
export function clampDockWidth(width: unknown, max = AI_DOCK_MAX): number {
  if (typeof width !== "number" || !Number.isFinite(width)) return Math.min(AI_DOCK_DEFAULT, max);
  return Math.round(Math.min(max, Math.max(AI_DOCK_MIN, width)));
}
