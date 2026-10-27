// The assistant's list of chats beside the chat (the large window and the
// /ai page): as wide as the person drags it, or hidden — kept on this browser.
// Dragged narrower than it can go, it hides; the chat always keeps at least
// half the window.

export const AI_SIDE_MIN = 220;
export const AI_SIDE_MAX = 520;
export const AI_SIDE_DEFAULT = 300;
/** One press of an arrow key on the handle. */
export const AI_SIDE_STEP = 16;
/** Dragged below this, the list hides instead of stopping at its narrowest. */
export const AI_SIDE_HIDE_BELOW = 150;

export interface AiSideState {
  width: number;
  open: boolean;
}

export const AI_SIDE_INITIAL: AiSideState = { width: AI_SIDE_DEFAULT, open: true };

/** A width the list can take in a window `room` pixels wide. */
export function clampSideWidth(width: number, room = Number.POSITIVE_INFINITY): number {
  const max = Math.max(AI_SIDE_MIN, Math.min(AI_SIDE_MAX, Math.floor(room / 2)));
  if (!Number.isFinite(width)) return Math.min(AI_SIDE_DEFAULT, max);
  return Math.round(Math.min(max, Math.max(AI_SIDE_MIN, width)));
}

/** Where a drag of the handle leaves the list: hidden when pulled past its
 *  narrowest (keeping `before`, the width it is shown again at), else the width it reached. */
export function dragSide(width: number, room = Number.POSITIVE_INFINITY, before = AI_SIDE_DEFAULT): AiSideState {
  if (width < AI_SIDE_HIDE_BELOW) return { width: clampSideWidth(before), open: false };
  return { width: clampSideWidth(width, room), open: true };
}

/** The kept state, read back — anything unreadable is the default. */
export function parseAiSide(raw: string | null | undefined): AiSideState {
  if (!raw) return AI_SIDE_INITIAL;
  try {
    const v = JSON.parse(raw) as Partial<AiSideState> | null;
    if (!v || typeof v !== "object") return AI_SIDE_INITIAL;
    return {
      width: clampSideWidth(typeof v.width === "number" ? v.width : AI_SIDE_DEFAULT),
      open: typeof v.open === "boolean" ? v.open : true,
    };
  } catch {
    return AI_SIDE_INITIAL;
  }
}
