"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// A centred popup over a dimmed page: Escape or a click on the dim closes it
// (unless `busy` — a save in flight is not abandoned half-way), the page
// behind stops scrolling, and focus moves into it and back out when it
// closes. It is drawn straight into the page's <main> (a portal) — where the
// app's control and table styles live — so it can be opened from anywhere,
// a table row included, without breaking the markup there. Only ever
// rendered after a click, so the document is there.

const FOCUSABLE = "a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

// Keeps Tab and Shift+Tab inside `box` while it is open as a dialog: the page
// behind is only dimmed, not inert, so without this the keys walk focus out
// into it. Called from a keydown handler; a key other than Tab is left alone.
// Focus that is already outside the box (or on the box itself) goes to its
// first or last control, so the trap also recovers it.
export function trapTab(ev: KeyboardEvent, box: HTMLElement | null) {
  if (ev.key !== "Tab" || !box) return;
  const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (items.length === 0) { ev.preventDefault(); box.focus(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement as HTMLElement | null;
  const inside = active !== null && active !== box && box.contains(active);
  if (ev.shiftKey) {
    if (!inside || active === first) { ev.preventDefault(); last.focus(); }
  } else if (!inside || active === last) { ev.preventDefault(); first.focus(); }
}

export function Modal({
  title,
  sub,
  onClose,
  busy = false,
  width = "max-w-2xl",
  focusField = true,
  children,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  onClose: () => void;
  /** A save is running: the popup stays until it answers. */
  busy?: boolean;
  width?: string;
  /** Focus the first field when it opens — a form's. A list whose rows hold
   *  controls passes false: the popup itself takes the focus, so it does not
   *  open scrolled to the first row's control with the keys on it. Read when
   *  it opens; a later change is not followed. */
  focusField?: boolean;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  const focusFieldRef = useRef(focusField);
  useEffect(() => {
    closeRef.current = onClose;
    busyRef.current = busy;
  });

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // the first field (unless told not to), or the box itself
    const first = focusFieldRef.current ? box.current?.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])") : null;
    (first ?? box.current)?.focus();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && !busyRef.current) closeRef.current();
      trapTab(ev, box.current);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      before?.focus?.();
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center p-3 no-print" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
      <button type="button" aria-label="Close" tabIndex={-1} onClick={() => { if (!busy) onClose(); }} className="absolute inset-0 bg-black/45 backdrop-blur-[2px] cursor-default" />
      <div ref={box} tabIndex={-1} className={`relative w-full ${width} max-h-[92dvh] overflow-y-auto bg-surface border rounded-xl shadow-lg outline-none`}>
        <div className="sticky top-0 z-10 bg-surface border-b px-4 py-3 flex items-start gap-3">
          <div className="min-w-0">
            <div role="heading" aria-level={2} className="font-extrabold text-base leading-tight">{title}</div>
            {sub && <p className="text-xs text-muted mt-0.5">{sub}</p>}
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="ms-auto btn btn-sm btn-ghost">✕</button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>,
    document.querySelector("main") ?? document.body,
  );
}
