"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// The app's popup for adding and recording. Every "add" / "record" form
// opens in one of these over the page rather than unfolding inline: the page
// underneath stays where it was, the form has the whole width it needs, and
// Escape or a click outside puts it away. Portalled to <body>, so a form
// opened from inside the nav or a table cell sits above everything and reads
// in the page's own text colour.

export function Modal({
  title,
  sub,
  onClose,
  children,
  width = "max-w-3xl",
  busy = false,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  /** A Tailwind max-width class for the panel. */
  width?: string;
  /** While saving, Escape and the backdrop do not close it. */
  busy?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  // the latest close and busy, without re-running the effects on each render
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  useEffect(() => { closeRef.current = onClose; busyRef.current = busy; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busyRef.current) closeRef.current(); };
    window.addEventListener("keydown", onKey);
    // focus the first field once, on opening — not the close button
    box.current?.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[65] grid place-items-center p-3 text-left font-normal" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" onClick={() => !busy && onClose()} className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" />
      <div ref={box} className={`relative w-full ${width} max-h-[92vh] overflow-y-auto bg-surface text-foreground border rounded-xl shadow-lg`}>
        <div className="flex items-start gap-3 px-4 pt-4 pb-2 border-b">
          <div className="min-w-0">
            <div className="font-extrabold text-base">{title}</div>
            {sub && <div className="text-xs text-muted mt-0.5">{sub}</div>}
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="ms-auto btn btn-sm btn-ghost">✕</button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
