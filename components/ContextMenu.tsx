"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useAiPanel } from "@/components/AiPanel";
import { pageName, readAiTarget } from "@/lib/aiTarget";
import { explainQuestion, type AiTarget } from "@/lib/domain/aiExplain";
import { toneAt } from "@/lib/domain/tones";

// A right-click menu for a table row. The row decides what goes in it — a
// list of entries built at open time — so a new action is one more entry,
// not another button squeezed into the Status cell. An entry can ask for a
// line of text first (a reason) before it runs.
//
// Every menu ends with "Ask AI" for whoever has the assistant: it explains
// the row (or whatever it was opened on) in a new chat, answered at once.
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
  /** What it was opened on — read for "Ask AI" only if it is picked. */
  target: Element | null;
}

/** The open/close state of one menu: `open(e, payload)` goes on the row's
 *  onContextMenu (or a ⋯ button's onClick), `menu` is what to render. */
export function useContextMenu<T>() {
  const [menu, setMenu] = useState<MenuAt<T> | null>(null);
  const open = (e: { preventDefault: () => void; clientX: number; clientY: number; target?: EventTarget | null }, payload: T) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, payload, target: e.target instanceof Element ? e.target : null });
  };
  const close = useCallback(() => setMenu(null), []);
  return { menu, open, close };
}

const isSep = (e: MenuEntry): e is { sep: true } => "sep" in e;
const isHeading = (e: MenuEntry): e is { heading: string } => "heading" in e;

/** "Ask AI": explain what `read` finds in a new chat, answered at once —
 *  null for someone without the assistant, or with nothing to read. */
export function useAskAiEntry(read: (() => AiTarget | null) | null): MenuAction | null {
  const ai = useAiPanel();
  if (!read || !ai?.canAsk) return null;
  return {
    key: "ask-ai", label: "Ask AI", icon: "✨", hint: "Explain this: what it is, what it says now and how it is worked out",
    onSelect: () => {
      const t = read();
      if (t) ai.ask(explainQuestion(t, pageName()), { explain: true });
    },
  };
}

export function ContextMenu({ x, y, entries: own, target, onClose }: { x: number; y: number; entries: MenuEntry[]; target?: Element | null; onClose: () => void }) {
  const askAi = useAskAiEntry(target ? () => readAiTarget(target) : null);
  const entries: MenuEntry[] = askAi ? [...own, ...(own.length ? [{ sep: true } as const] : []), askAi] : own;
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

  // the keyboard starts on the first entry (the ⋯ button, Shift+F10), and
  // Tab walks the rest — without scrolling the page under the menu
  useEffect(() => {
    box.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus({ preventScroll: true });
  }, []);

  // a scroll closes the menu — but not the one the opening click itself
  // causes: a ⋯ button at the far right of a wide table scrolls its
  // container into view as it takes focus, a beat after the menu is up
  useEffect(() => {
    const openedAt = Date.now();
    // the Escape is the menu's — marked handled first, so a window under it stays
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    const onScroll = () => { if (Date.now() - openedAt > 300) onClose(); };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey, true);
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

  return createPortal(
    <div
      ref={box}
      role="menu"
      className="menu-panel animate-[drawerfade_0.14s_ease-out] fixed z-[100] min-w-[14rem] max-w-[20rem] rounded-xl border bg-surface shadow-xl p-1.5 no-print"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {asking?.prompt ? (
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="p-1.5 space-y-2">
          <div className="text-xs font-bold">{asking.icon} {asking.label}</div>
          <input
            autoFocus
            aria-label={asking.label}
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
          // each entry a soft tile in a colour of its own — the glyph is an emoji, which keeps its own
          const cls = `menu-row menu-row-sm ${e.danger ? "menu-row-danger" : toneAt(i)}`;
          const glyph = <span className="tone-tile tone-tile-sm tone-tile-soft text-sm" aria-hidden>{e.icon}</span>;
          if (e.href && !e.disabled) {
            return (
              <Link key={e.key} href={e.href} role="menuitem" className={cls} title={e.hint} onClick={onClose}>
                {glyph}{e.label}
              </Link>
            );
          }
          return (
            <button key={e.key} type="button" role="menuitem" className={cls} title={e.hint} disabled={e.disabled} onClick={() => run(e)}>
              {glyph}{e.label}{e.prompt && <span className="text-muted">…</span>}
            </button>
          );
        })
      )}
    </div>,
    document.body
  );
}
