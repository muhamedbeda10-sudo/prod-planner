"use client";

/** Light/dark toggle. The initial class is applied pre-paint by the inline
 *  script in the root layout; this button just flips and persists it. The
 *  icon is chosen by CSS (dark:) so no state or effect is needed. */
export function ThemeToggle() {
  function toggle() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {}
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title="Toggle dark mode"
      className="shrink-0 rounded-md px-2.5 py-1.5 text-lg leading-none hover:bg-white/15 transition-colors"
      aria-label="Toggle dark mode"
    >
      <span className="dark:hidden">🌙</span>
      <span className="hidden dark:inline">☀️</span>
    </button>
  );
}
