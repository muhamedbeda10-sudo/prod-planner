"use client";

import { Moon, Sun } from "lucide-react";
import { MENU_ROW } from "@/components/ui";

/** Light/dark toggle. The initial class is applied pre-paint by the inline
 *  script in the root layout; this button just flips and persists it. The
 *  icon is chosen by CSS (dark:) so no state or effect is needed. */
export function ThemeToggle({ wide = false, row = false }: { wide?: boolean; row?: boolean }) {
  function toggle() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {}
  }

  // a row of the account menu
  if (row) {
    return (
      <button type="button" role="menuitem" onClick={toggle} className={`${MENU_ROW} tone-4`}>
        <span className="contents dark:hidden"><span className="tone-tile tone-tile-sm" aria-hidden><Moon size={15} /></span> Dark mode</span>
        <span className="hidden dark:contents"><span className="tone-tile tone-tile-sm" aria-hidden><Sun size={15} /></span> Light mode</span>
      </button>
    );
  }

  // the drawer's full-width row — on a phone the bar has no room for the icon
  if (wide) {
    return (
      <button type="button" onClick={toggle} className="btn btn-secondary w-full">
        <span className="dark:hidden inline-flex items-center gap-2"><Moon size={16} /> Dark mode</span>
        <span className="hidden dark:inline-flex items-center gap-2"><Sun size={16} /> Light mode</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={toggle}
      title="Toggle dark mode"
      className="shrink-0 rounded-md p-2 hover:bg-white/15 transition-colors"
      aria-label="Toggle dark mode"
    >
      <span className="dark:hidden"><Moon size={16} /></span>
      <span className="hidden dark:inline"><Sun size={16} /></span>
    </button>
  );
}
