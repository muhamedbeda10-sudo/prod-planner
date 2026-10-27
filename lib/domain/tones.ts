// The app's eight tile colours — the assistant's "What it can do" tiles,
// carried to every menu, drawer and card that gives an icon a colour of its
// own. Each is a chart colour with its own ink, defined for both themes in
// app/globals.css as .tone-1 … .tone-8.

export const TONES = 8;

/** The tone of the i-th item of a list (0-based): neighbours never share one. */
export function toneAt(i: number): string {
  return `tone-${(i % TONES) + 1}`;
}

/** A steady tone for a name: the same card wears the same colour on every
 *  screen and every visit, whatever else is listed beside it. */
export function toneFor(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return toneAt(Math.abs(h));
}
