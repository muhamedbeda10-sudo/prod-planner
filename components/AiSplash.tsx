"use client";

import { useEffect, useState } from "react";

// The app opens on the assistant: its robot fills the screen, winks, and gives
// way to the page. Drawn by the server so it covers the first paint, played by
// CSS alone (.ai-splash in globals.css) so a slow script never holds the page
// behind it; SPLASH_INIT_SCRIPT hides it before paint once it has played. A
// click or a key skips it; with reduced motion, and on paper, it never shows.
const SPLASH_KEY = "ai-splash";

export function AiSplash() {
  const [gone, setGone] = useState(false);

  useEffect(() => {
    // played already: the CSS keeps it hidden
    if (document.documentElement.dataset.splash === "off") return;
    try {
      sessionStorage.setItem(SPLASH_KEY, "1");
      localStorage.setItem(SPLASH_KEY, String(Date.now()));
    } catch {
      // storage refused: it plays again next time, nothing worse
    }
    const skip = () => setGone(true);
    window.addEventListener("keydown", skip, { once: true });
    return () => window.removeEventListener("keydown", skip);
  }, []);

  if (gone) return null;
  return (
    <div
      className="ai-splash no-print"
      aria-hidden
      onClick={() => setGone(true)}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) setGone(true);
      }}
    >
      <div className="ai-splash-stage">
        <svg className="ai-splash-bot" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 8V4H8" />
          <circle className="ai-splash-light" cx="8" cy="4" r="0.9" fill="currentColor" stroke="none" />
          <rect width="16" height="12" x="4" y="8" rx="2" />
          <path d="M2 14h2" />
          <path d="M20 14h2" />
          <path d="M9 13v2" />
          <path className="ai-splash-eye-open" d="M15 13v2" />
          <path className="ai-splash-eye-shut" d="M13.9 14.4q1.1-1 2.2 0" />
          <path className="ai-splash-smile" d="M10 17.2q2 1.3 4 0" />
        </svg>
        <p className="ai-splash-tag">AI-powered</p>
      </div>
    </div>
  );
}
