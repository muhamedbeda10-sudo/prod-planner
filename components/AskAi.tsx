"use client";

import { useCallback, useEffect, useState } from "react";
import { ContextMenu, useAskAiEntry, type MenuEntry } from "@/components/ContextMenu";
import { useAiPanel } from "@/components/AiPanel";
import { oneLine, type AiTarget } from "@/lib/domain/aiExplain";
import { readAiTarget } from "@/lib/aiTarget";

// Right-click anything — a card, a chart, a table row, a figure — and "Ask
// AI" explains it: what it is, what it says now and how it is worked out
// (lib/aiTarget reads what was clicked, lib/domain/aiExplain makes it a
// question, the chat answers it at once). A row with a menu of its own
// carries the same entry at its foot (components/ContextMenu), so this
// steps aside wherever a menu already opened. The browser's own menu stays
// where it is the one people need: in a field, on text they selected, and
// on Shift + right-click. An iPhone's long press arrives here as a
// right-click too (TouchLongPress). Nothing at all for someone without the
// assistant, nor in its own window or on its own page.

interface Open {
  x: number;
  y: number;
  target: AiTarget;
  href: string | null;
}

export function AskAiAnywhere() {
  const ai = useAiPanel();
  // not on the assistant's own page: there is nothing there but the chat
  const on = !!ai?.canAsk && !ai.aiPage;
  const [menu, setMenu] = useState<Open | null>(null);
  const close = useCallback(() => setMenu(null), []);
  // [separator, Ask AI] — here first under the name, not at the foot
  const askAi = useAskAiEntry(menu?.target);

  useEffect(() => {
    if (!on) return;
    const onMenu = (e: MouseEvent) => {
      if (e.defaultPrevented || e.shiftKey || !(e.target instanceof Element)) return;
      const el = e.target;
      if (el.closest("input, textarea, select, [contenteditable]")) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;
      const target = readAiTarget(el);
      if (!target) return;
      e.preventDefault();
      const link = el.closest("a[href]");
      setMenu({ x: e.clientX, y: e.clientY, target, href: link instanceof HTMLAnchorElement ? link.href : null });
    };
    document.addEventListener("contextmenu", onMenu);
    return () => document.removeEventListener("contextmenu", onMenu);
  }, [on]);

  if (!on || !menu) return null;
  const entries: MenuEntry[] = [{ heading: oneLine(menu.target.title, 60) }, ...askAi.slice(1)];
  if (menu.href) {
    const href = menu.href;
    entries.push(
      { key: "tab", label: "Open in a new tab", icon: "↗", onSelect: () => window.open(href, "_blank", "noopener") },
      { key: "copy", label: "Copy link", icon: "🔗", onSelect: () => void navigator.clipboard?.writeText(href).catch(() => {}) },
    );
  }
  return <ContextMenu x={menu.x} y={menu.y} entries={entries} onClose={close} />;
}
