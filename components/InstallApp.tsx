"use client";

import { useEffect, useState } from "react";
import { Download, Share, X } from "lucide-react";

// "Install app" — puts the ERP on the home screen of a phone or tablet (or
// the desktop) as its own app. Android / Chrome / Edge offer the install
// themselves and this button calls it up; an iPhone or iPad only installs
// from Safari's Share menu, so there the button says how. Gone once the app
// runs installed, or where the browser can't install it.

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// The browser offers the install ONCE, early in the page's life — kept here
// so a button mounted later (the mobile drawer) can still use it.
let deferred: InstallPrompt | null = null;
const subscribers = new Set<(p: InstallPrompt | null) => void>();
const announce = (p: InstallPrompt | null) => { deferred = p; subscribers.forEach((f) => f(p)); };
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); announce(e as InstallPrompt); });
  window.addEventListener("appinstalled", () => announce(null));
}

const standalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export function InstallApp({ wide = false }: { wide?: boolean }) {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [ios, setIos] = useState(false);
  const [hint, setHint] = useState(false);

  useEffect(() => {
    // the app's one service worker (notifications) — registered up front so
    // the installed app has it from the first launch
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/notify-sw.js").catch(() => undefined);
    if (standalone()) return;
    const onChange = (p: InstallPrompt | null) => setPrompt(p);
    subscribers.add(onChange);
    // read after mount: what the browser already offered, and Safari on iOS,
    // which has no install event — only its Share menu
    const t = setTimeout(() => { setPrompt(deferred); setIos(isIos()); }, 0);
    return () => { clearTimeout(t); subscribers.delete(onChange); };
  }, []);

  if (!prompt && !ios) return null;

  async function install() {
    if (prompt) {
      await prompt.prompt();
      await prompt.userChoice.catch(() => undefined);
      announce(null); // a prompt is good for one use
      return;
    }
    setHint((v) => !v);
  }

  return (
    <span className={`relative ${wide ? "block" : "inline-flex"}`}>
      <button
        type="button"
        onClick={install}
        title="Install the app on this device"
        aria-label="Install app"
        className={wide ? "btn btn-secondary w-full" : "shrink-0 inline-flex items-center gap-1.5 rounded-md p-2 hover:bg-white/15 transition-colors text-sm font-semibold"}
      >
        <Download size={16} aria-hidden />
        <span className={wide ? "" : "hidden lg:inline"}>Install app</span>
      </button>
      {hint && (
        <span className={`absolute z-50 ${wide ? "bottom-full mb-2 inset-x-0" : "top-full mt-2 end-0 w-64"} rounded-[10px] border bg-surface text-foreground shadow-xl p-3 text-sm`} role="dialog" aria-label="How to install">
          <button type="button" onClick={() => setHint(false)} className="absolute top-1.5 end-1.5 p-1 text-muted hover:text-foreground" aria-label="Close"><X size={14} /></button>
          <b className="block mb-1">Install on iPhone / iPad</b>
          <span className="block text-muted">
            In Safari, tap <Share size={13} className="inline -mt-0.5" aria-label="Share" /> <b className="text-foreground">Share</b>, then <b className="text-foreground">Add to Home Screen</b>.
          </span>
        </span>
      )}
    </span>
  );
}
