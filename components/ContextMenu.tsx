"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";

// A right-click menu for a table row. The row decides what goes in it — a
// list of entries built at open time — so a new action is one more entry,
// not another button squeezed into the Status cell. An entry can ask for a
// line of text first (a reason) before it runs.
//
// Manners: it opens at the pointer and stays inside the viewport; Escape, a
// click elsewhere, a scroll or a resize close it; Enter submits a prompt.

export interface MenuAction {
  key: string;
  label: string;
  /** A glyph in front of the label — an emoji reads fine here. */
  icon?: string;
  /** The tooltip; also the explanation of a disabled entry. */
  hint?: string;
  /** A link instead of an action. */
  href?: string;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Ask for a line of text first, then run with it. */
  prompt?: { placeholder: string; submit: string; onSubmit: (text: string) => void };
}
export type MenuEntry = MenuAction | { sep: true } | { heading: string };

export interface MenuAt<T> {
  x: number;
  y: number;
  payload: T;
}

/** The open/close state of one menu: `open(e, payload)` goes on the row's
 *  onContextMenu (or a ⋯ button's onClick), `menu` is what to render. */
export function useContextMenu<T>() {
  const [menu, setMenu] = useState<MenuAt<T> | null>(null);
  const open = (e: { preventDefault: () => void; clientX: number; clientY: number }, payload: T) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, payload });
  };
  const close = useCallback(() => setMenu(null), []);
  return { menu, open, close };
}

const isSep = (e: MenuEntry): e is { sep: true } => "sep" in e;
const isHeading = (e: MenuEntry): e is { heading: string } => "heading" in e;

export function ContextMenu({ x, y, entries, onClose }: { x: number; y: number; entries: MenuEntry[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [asking, setAsking] = useState<MenuAction | null>(null);
  const [text, setText] = useState("");

  // keep the whole menu on screen — a row near the bottom opens upward
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
    setPos({ left, top });
  }, [x, y, asking]);

  // a scroll closes the menu — but not the one the opening click itself
  // causes: a ⋯ button at the far right of a wide table scrolls its
  // container into view as it takes focus, a beat after the menu is up
  useEffect(() => {
    const openedAt = Date.now();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    const onScroll = () => { if (Date.now() - openedAt > 300) onClose(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const run = (a: MenuAction) => {
    if (a.disabled) return;
    if (a.prompt) { setAsking(a); setText(""); return; }
    onClose();
    a.onSelect?.();
  };
  const submit = () => {
    if (!asking?.prompt) return;
    const p = asking.prompt;
    onClose();
    p.onSubmit(text.trim());
  };

  const item = "w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 rounded-md transition-colors";
  return createPortal(
    <div
      ref={box}
      role="menu"
      className="fixed z-[100] min-w-[14rem] max-w-[20rem] rounded-xl border bg-surface shadow-xl p-1.5 no-print"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {asking?.prompt ? (
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="p-1.5 space-y-2">
          <div className="text-xs font-bold">{asking.icon} {asking.label}</div>
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={asking.prompt.placeholder}
            maxLength={200}
            className="w-full border rounded-md px-2 py-1.5 text-sm bg-surface"
          />
          <div className="flex items-center gap-2">
            <button type="submit" className="btn btn-primary btn-sm">{asking.prompt.submit}</button>
            <button type="button" onClick={() => setAsking(null)} className="btn btn-ghost btn-sm">Back</button>
          </div>
        </form>
      ) : (
        entries.map((e, i) => {
          if (isSep(e)) return <div key={`sep${i}`} className="my-1 border-t" />;
          if (isHeading(e)) return <div key={`h${i}`} className="px-3 pt-1 pb-1.5 text-[11px] font-bold text-muted uppercase tracking-wide truncate">{e.heading}</div>;
          const tone = e.danger ? "text-bad-fg hover:bg-bad-bg" : "hover:bg-surface-2";
          const cls = `${item} ${e.disabled ? "opacity-40 cursor-not-allowed" : `${tone} cursor-pointer`}`;
          if (e.href && !e.disabled) {
            return (
              <Link key={e.key} href={e.href} role="menuitem" className={cls} title={e.hint} onClick={onClose}>
                <span className="w-5 text-center">{e.icon}</span>{e.label}
              </Link>
            );
          }
          return (
            <button key={e.key} type="button" role="menuitem" className={cls} title={e.hint} disabled={e.disabled} onClick={() => run(e)}>
              <span className="w-5 text-center">{e.icon}</span>{e.label}{e.prompt && <span className="text-muted">…</span>}
            </button>
          );
        })
      )}
    </div>,
    document.body
  );
}
