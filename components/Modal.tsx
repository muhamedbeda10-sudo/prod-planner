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

export function Modal({
  title,
  sub,
  onClose,
  busy = false,
  width = "max-w-2xl",
  children,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  onClose: () => void;
  /** A save is running: the popup stays until it answers. */
  busy?: boolean;
  width?: string;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  useEffect(() => {
    closeRef.current = onClose;
    busyRef.current = busy;
  });

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // the first field, or the box itself
    const first = box.current?.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])");
    (first ?? box.current)?.focus();
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape" && !busyRef.current) closeRef.current(); };
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
