"use client";

import { cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * The one tooltip. Opens on hover (after a short pause) and on keyboard
 * focus, closes on leave, blur and Escape. It is drawn on the page body at a
 * fixed position measured from its trigger, so a table's scroll box or a
 * card's overflow never clips it — the reason the browser's own title is not
 * enough on wide sheets. The trigger is described by it for screen readers.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  delay = 250,
}: {
  content: ReactNode;
  children: ReactElement<{ "aria-describedby"?: string }>;
  side?: "top" | "bottom";
  delay?: number;
}) {
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);

  const show = useCallback((now = false) => {
    if (timer.current) clearTimeout(timer.current);
    const open = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      // flip below when there is no room above (the first rows under a sticky header)
      const below = side === "bottom" || r.top < 48;
      setPos({ x: r.left + r.width / 2, y: below ? r.bottom + 6 : r.top - 6, below });
    };
    if (now) open();
    else timer.current = setTimeout(open, delay);
  }, [delay, side]);
  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setPos(null);
  }, []);

  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    // a scroll moves the trigger out from under the bubble — close rather than float
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
    };
  }, [pos, hide]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  if (content === null || content === undefined || content === "") return children;
  const trigger = isValidElement(children) ? cloneElement(children, { "aria-describedby": pos ? id : undefined }) : children;
  return (
    <span
      ref={ref}
      className="inline-flex max-w-full"
      onMouseEnter={() => show()}
      onMouseLeave={hide}
      onFocus={() => show(true)}
      onBlur={hide}
    >
      {trigger}
      {pos && typeof document !== "undefined" && createPortal(
        <span
          id={id}
          role="tooltip"
          className="tooltip"
          style={{ left: pos.x, top: pos.y, transform: pos.below ? "translate(-50%, 0)" : "translate(-50%, -100%)" }}
        >
          {content}
        </span>,
        document.body,
      )}
    </span>
  );
}
