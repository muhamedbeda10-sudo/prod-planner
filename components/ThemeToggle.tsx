"use client";

import { useEffect, useState } from "react";

/** Light/dark toggle. The initial class is applied pre-paint by the inline
 *  script in the root layout; this button just flips and persists it. */
export function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {}
    setDark(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="shrink-0 rounded-md px-2.5 py-1.5 text-lg leading-none hover:bg-white/15 transition-colors"
      aria-label="Toggle dark mode"
    >
      {dark === null ? "◐" : dark ? "☀️" : "🌙"}
    </button>
  );
}
