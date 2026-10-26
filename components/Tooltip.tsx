"use client";

import { cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * The one tooltip. Opens on hover (after a short pause) and on keyboard
 * focus, closes on leave, blur and Escape. It is drawn on the page body at a
 * fixed position measured from its trigger, so a table's scroll box or a
 * card's overflow never clips it — the reason the browser's own title is not
 * enough on wide sheets. The trigger is described by it for screen readers.
 *
 * `interactive`: a card that holds a button (a chart's "about" with its Ask
 * AI). It stays open while the pointer crosses over to it and rests on it,
 * keeps focus moving into it, opens on a tap too (a phone has no hover), and
 * closes on a tap or click elsewhere.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  delay = 250,
  interactive = false,
}: {
  content: ReactNode;
  children: ReactElement<{ "aria-describedby"?: string }>;
  side?: "top" | "bottom";
  delay?: number;
  interactive?: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);

  const show = useCallback((now = false) => {
    if (timer.current) clearTimeout(timer.current);
    const open = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      // flip below when there is no room above (the first rows under a sticky header)
      const below = side === "bottom" || r.top < 48;
      // centred on the trigger, but never past the window's edge (half its widest)
      const half = interactive ? 190 : 160;
      const x = Math.max(half + 8, Math.min(r.left + r.width / 2, window.innerWidth - half - 8));
      setPos({ x, y: below ? r.bottom + 6 : r.top - 6, below });
    };
    if (now) open();
    else timer.current = setTimeout(open, delay);
  }, [delay, side, interactive]);
  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setPos(null);
  }, []);
  // a card closes a beat after the pointer leaves — time to cross the gap to it
  const leave = useCallback(() => {
    if (!interactive) return hide();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setPos(null), 200);
  }, [interactive, hide]);

  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    // a scroll moves the trigger out from under the bubble — close rather than float
    // a card: a tap or click anywhere else closes it
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !bubble.current?.contains(t)) hide();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    if (interactive) window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [pos, hide, interactive]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  if (content === null || content === undefined || content === "") return children;
  const trigger = isValidElement(children) ? cloneElement(children, { "aria-describedby": pos ? id : undefined }) : children;
  return (
    <span
      ref={ref}
      className="inline-flex max-w-full"
      // the card is this span's child in React's tree, so resting on it is still "in"
      onMouseEnter={() => (interactive && pos ? show(true) : show())}
      onMouseLeave={leave}
      onFocus={() => show(true)}
      // focus moving into the card keeps it open
      onBlur={(e) => { if (!(interactive && bubble.current?.contains(e.relatedTarget as Node | null))) leave(); }}
      // a tap opens it (never a click inside it, which would reopen what its button closed)
      onClick={interactive ? (e) => { if (!bubble.current?.contains(e.target as Node)) show(true); } : undefined}
    >
      {trigger}
      {pos && typeof document !== "undefined" && createPortal(
        <span
          ref={bubble}
          id={id}
          // a card holds a button, which a tooltip may not
          role={interactive ? "dialog" : "tooltip"}
          className={interactive ? "tooltip tooltip-card" : "tooltip"}
          style={{ left: pos.x, top: pos.y, transform: pos.below ? "translate(-50%, 0)" : "translate(-50%, -100%)" }}
        >
          {content}
        </span>,
        document.body,
      )}
    </span>
  );
}
