"use client";

import { useEffect } from "react";

// The row menus (hold, close, trace…) open on right-click. Android turns a
// long press into that right-click by itself; an iPhone or iPad does not, so
// there a long press is turned into one here — the same menu, by the same
// handler, whatever row it is on. The tap that ends the press is swallowed
// so it does not also open the row.

const HOLD_MS = 500;
const SLOP = 10; // px a finger may wander and still be holding

export function TouchLongPress() {
  useEffect(() => {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (!ios) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let start: { x: number; y: number } | null = null;
    const cancel = () => { if (timer) clearTimeout(timer); timer = null; start = null; };
    const swallowClick = () => {
      const stop = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
      document.addEventListener("click", stop, { capture: true, once: true });
      setTimeout(() => document.removeEventListener("click", stop, { capture: true }), 700);
    };
    const onStart = (e: TouchEvent) => {
      cancel();
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const target = e.target as Element | null;
      // a field keeps its own long press (select, paste)
      if (!target || target.closest("input, textarea, select, [contenteditable]")) return;
      start = { x: t.clientX, y: t.clientY };
      timer = setTimeout(() => {
        if (!start) return;
        const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: start.x, clientY: start.y, view: window });
        const handled = !target.dispatchEvent(ev); // a handler called preventDefault
        if (handled) { swallowClick(); navigator.vibrate?.(10); }
        cancel();
      }, HOLD_MS);
    };
    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const t = e.touches[0];
      if (Math.abs(t.clientX - start.x) > SLOP || Math.abs(t.clientY - start.y) > SLOP) cancel();
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: true });
    document.addEventListener("touchend", cancel, { passive: true });
    document.addEventListener("touchcancel", cancel, { passive: true });
    window.addEventListener("scroll", cancel, { passive: true, capture: true });
    return () => {
      cancel();
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", cancel);
      document.removeEventListener("touchcancel", cancel);
      window.removeEventListener("scroll", cancel, { capture: true });
    };
  }, []);
  return null;
}
