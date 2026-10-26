"use client";

import { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

const EDGE = 8; // px kept clear of the window's edge

/**
 * The one tooltip. Opens on hover (after a short pause) and on keyboard
 * focus, closes on leave, blur and Escape. It is drawn on the page body at a
 * fixed position measured from its trigger, so a table's scroll box or a
 * card's overflow never clips it — the reason the browser's own title is not
 * enough on wide sheets. The trigger is described by it for screen readers.
 * Once drawn it is measured: kept inside the window, and flipped to the
 * other side of its trigger where it would run off it.
 *
 * `interactive`: a card that holds a button (a chart's "about" with its Ask
 * AI) — a small dialog the trigger opens. It stays open while the pointer
 * crosses over to it and rests on it, opens on a tap too (a phone has no
 * hover), takes Tab from its trigger into it, and closes on a click
 * elsewhere, Escape, or `close` (content may be a function of it).
 */
export function Tooltip({
  content,
  children,
  side = "top",
  delay = 250,
  interactive = false,
  label,
}: {
  content: ReactNode | ((close: () => void) => ReactNode);
  children: ReactElement<Record<string, unknown>>;
  side?: "top" | "bottom";
  delay?: number;
  interactive?: boolean;
  /** The card's name for screen readers (interactive only). */
  label?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // the trigger's box when it opened, and the side asked for
  const [pos, setPos] = useState<{ x: number; top: number; bottom: number; below: boolean } | null>(null);

  const show = useCallback((now = false) => {
    if (timer.current) clearTimeout(timer.current);
    const open = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      // flip below when there is no room above (the first rows under a sticky header)
      const below = side === "bottom" || r.top < 48;
      setPos({ x: r.left + r.width / 2, top: r.top, bottom: r.bottom, below });
    };
    if (now) open();
    else timer.current = setTimeout(open, delay);
  }, [delay, side]);
  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setPos(null);
  }, []);
  // what the card's own content may call to close it
  const close = useCallback(() => setPos(null), []);
  // a card closes a beat after the pointer leaves — time to cross the gap to it
  const leave = useCallback(() => {
    if (!interactive) return hide();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setPos(null), 200);
  }, [interactive, hide]);

  // drawn: keep it inside the window — its own width, not a guess — and on
  // the other side of the trigger where this one has no room for it
  useLayoutEffect(() => {
    const el = bubble.current;
    if (!pos || !el) return;
    const { width, height } = el.getBoundingClientRect();
    const half = width / 2;
    const x = Math.max(half + EDGE, Math.min(pos.x, window.innerWidth - half - EDGE));
    let below = pos.below;
    if (below && pos.bottom + 6 + height > window.innerHeight - EDGE && pos.top - 6 - height >= EDGE) below = false;
    else if (!below && pos.top - 6 - height < EDGE) below = true;
    el.style.left = `${x}px`;
    el.style.top = `${below ? pos.bottom + 6 : pos.top - 6}px`;
    el.style.transform = below ? "translate(-50%, 0)" : "translate(-50%, -100%)";
    el.style.visibility = "visible";
  }, [pos]);

  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // focus inside the card goes back to its trigger
      if (bubble.current?.contains(document.activeElement)) ref.current?.querySelector<HTMLElement>("button, a, [tabindex]")?.focus();
      hide();
    };
    // a card: a tap or click anywhere else closes it
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !bubble.current?.contains(t)) hide();
    };
    // a scroll moves the trigger out from under the bubble — close rather than float
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

  // Tab from the trigger goes into the open card (it sits at the end of the
  // page); Tab past its last control, or Shift+Tab from its first, comes back
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!interactive || !pos || e.key !== "Tab") return;
    const items = Array.from(bubble.current?.querySelectorAll<HTMLElement>("button, a[href], [tabindex]:not([tabindex='-1'])") ?? []);
    if (items.length === 0) return;
    const inside = bubble.current?.contains(e.target as Node);
    if (!inside && !e.shiftKey) {
      e.preventDefault();
      items[0].focus();
    } else if (inside && ((e.shiftKey && e.target === items[0]) || (!e.shiftKey && e.target === items.at(-1)))) {
      e.preventDefault();
      ref.current?.querySelector<HTMLElement>("button, a, [tabindex]")?.focus();
      if (!e.shiftKey) hide();
    }
  };

  if (content === null || content === undefined || content === "") return children;
  const a11y = interactive
    ? { "aria-expanded": !!pos, "aria-haspopup": "dialog", "aria-controls": pos ? id : undefined }
    : { "aria-describedby": pos ? id : undefined };
  const trigger = isValidElement(children) ? cloneElement(children, a11y) : children;
  return (
    <span
      ref={ref}
      className="inline-flex max-w-full"
      // the card is this span's child in React's tree, so resting on it is still "in"
      onMouseEnter={() => (interactive && pos ? show(true) : show())}
      onMouseLeave={leave}
      onFocus={() => { if (!pos) show(true); }}
      // a card stays while focus is in it, or nowhere (a click on its text);
      // it goes when focus moves on to something else
      onBlur={(e) => {
        if (!interactive) return hide();
        const to = e.relatedTarget as Node | null;
        if (to && !bubble.current?.contains(to) && !ref.current?.contains(to)) hide();
      }}
      onKeyDown={onKeyDown}
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
          aria-label={interactive ? label : undefined}
          className={interactive ? "tooltip tooltip-card" : "tooltip"}
          // placed once measured (above), so it never flashes in the wrong spot
          style={{ left: pos.x, top: pos.below ? pos.bottom + 6 : pos.top - 6, transform: pos.below ? "translate(-50%, 0)" : "translate(-50%, -100%)", visibility: "hidden" }}
        >
          {typeof content === "function" ? content(close) : content}
        </span>,
        document.body,
      )}
    </span>
  );
}
