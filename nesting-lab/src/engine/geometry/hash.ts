// Stable fingerprint of a part's geometry (FNV-1a over rounded coordinates),
// so a placement can always be traced back to the exact contour it was made from.

import type { Loop } from "./types";

export function geometryHash(outer: Loop, holes: Loop[] = []): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const mix = (n: number) => {
    const v = Math.round(n * 1000);
    for (let i = 0; i < 4; i++) {
      const byte = (v >>> (i * 8)) & 0xff;
      h1 ^= byte;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 ^= byte;
      h2 = Math.imul(h2, 0x01000193 + 2) >>> 0;
    }
  };
  const loop = (l: Loop) => {
    mix(l.segs.length);
    for (const s of l.segs) {
      mix(s.kind === "arc" ? 2 : 1);
      mix(s.a.x);
      mix(s.a.y);
      mix(s.b.x);
      mix(s.b.y);
      if (s.kind === "arc") {
        mix(s.center.x);
        mix(s.center.y);
        mix(s.r);
        mix(s.ccw ? 1 : 0);
        mix(s.full ? 1 : 0);
      }
    }
  };
  loop(outer);
  mix(holes.length);
  for (const h of holes) loop(h);
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).toUpperCase();
}
