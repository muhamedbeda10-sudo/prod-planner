// A person's round button in the bar: their own photo, or — until they add
// one — their initials on a colour of their own.
//
// The browser shrinks a picked photo to AVATAR_PX square before it is sent,
// so what reaches the server is a small JPEG; the server still checks the
// type and the size, since a request can be made without the page.

/** The square the browser crops and shrinks a photo to, in pixels. */
export const AVATAR_PX = 256;

/** The largest photo the server takes — a 256 px JPEG is a few dozen KB. */
export const AVATAR_MAX_BYTES = 512 * 1024;

/** The types a photo may be stored as, with the extension it is saved under.
 *  SVG is not one of them: it can carry script. */
export const AVATAR_TYPES: Readonly<Record<string, string>> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

/** Why this file cannot be a photo, or null when it can. */
export function avatarFileError(type: string, size: number): string | null {
  if (!(type in AVATAR_TYPES)) return "Choose a photo (JPEG, PNG or WebP).";
  if (!(size > 0)) return "The photo is empty — choose it again.";
  if (size > AVATAR_MAX_BYTES) return "The photo is too large — choose it again so it can be made smaller.";
  return null;
}

/** "Muhamed Beda" → "MB"; one name → its first two letters; nothing → "?". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length === 1 ? [...words[0]].slice(0, 2) : [[...words[0]][0], [...words[words.length - 1]][0]];
  return letters.join("").toUpperCase();
}

const COLORS = ["#1a8150", "#2b6cb0", "#d97706", "#7c3aed", "#c2410c", "#0e7490"];

/** The same colour for the same account, every time. */
export function avatarColor(userId: number): string {
  return COLORS[Math.abs(userId) % COLORS.length];
}
