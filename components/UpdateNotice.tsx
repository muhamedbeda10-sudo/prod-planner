"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { CornerCard } from "@/components/primitives";
import { VERSION_CHECK_MS, newerVersion, updateStep } from "@/lib/domain/appVersion";

// A new version of the app reaching a page that is already open (see
// lib/domain/appVersion.ts): the page asks the server now and then which
// version it serves, and once that is a new one it reloads itself when that
// loses nothing — and meanwhile offers a Reload in the corner.

const MINE = process.env.APP_VERSION ?? "";
const TICK_MS = 60_000;
const RELOADED_KEY = "app-update-reloaded";
const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
/** Boxes people type into — a tick box, a button or a picked date holds nothing half done. */
const TYPED = 'textarea, [contenteditable="true"], input:not([type]), input[type="text"], input[type="number"], input[type="email"], input[type="tel"], input[type="url"], input[type="password"]';

function sinceReload(): number | null {
  try {
    const t = Number(sessionStorage.getItem(RELOADED_KEY));
    return t > 0 ? Date.now() - t : null;
  } catch {
    return null;
  }
}

function reload() {
  try {
    sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
  } catch {
    /* private mode — the reload still happens */
  }
  window.location.reload();
}

const shown = (el: Element) => el.getClientRects().length > 0;
const typedIn = (el: Element) =>
  !(el as HTMLInputElement).readOnly && ((el as HTMLInputElement).value ?? (el as HTMLElement).textContent ?? "").trim() !== "";

/** Something may be half done: a modal open, the box in use holding text, a
 *  draft in a text area (the assistant's, chat, notes) or a form being filled.
 *  A search box sitting empty, or a corner card, holds nothing. */
function busy(): boolean {
  if ([...document.querySelectorAll('[aria-modal="true"], dialog[open]')].some(shown)) return true;
  const a = document.activeElement;
  if (a?.matches(TYPED) && typedIn(a)) return true;
  if ([...document.querySelectorAll("textarea")].some((t) => shown(t) && typedIn(t))) return true;
  return [...document.querySelectorAll("form")].some((f) => shown(f) && [...f.querySelectorAll(TYPED)].some(typedIn));
}

export function UpdateNotice() {
  const [ready, setReady] = useState(false);
  const [later, setLater] = useState(false);
  const pending = useRef<string | null>(null);
  const lastInput = useRef(0);
  const pathname = usePathname();
  const shownPath = useRef(pathname);

  // the next page someone opens comes up in the new version
  useEffect(() => {
    if (shownPath.current === pathname) return;
    shownPath.current = pathname;
    if (pending.current && updateStep({ navigated: true, idleMs: 0, busy: busy(), sinceReloadMs: sinceReload() }) === "reload") reload();
  }, [pathname]);

  useEffect(() => {
    if (!MINE) return;
    let stop = false;
    let lastCheck = Date.now();
    lastInput.current = Date.now();

    // a minimised app counts as left alone: coming back to it after a while
    // brings the new version up at once
    const decide = () => {
      if (!pending.current) return;
      if (updateStep({ navigated: false, idleMs: Date.now() - lastInput.current, busy: busy(), sinceReloadMs: sinceReload() }) === "reload") reload();
    };
    const check = async () => {
      lastCheck = Date.now();
      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        const v = newerVersion(MINE, await r.json().catch(() => null));
        if (stop || !v) return;
        // a version newer still than one put off with Later is offered again
        if (v !== pending.current) setLater(false);
        pending.current = v;
        setReady(true);
        decide();
      } catch {
        /* offline for a moment — the next tick asks again */
      }
    };
    const tick = () => {
      if (Date.now() - lastCheck >= VERSION_CHECK_MS) void check();
      else decide();
    };
    const onShow = () => {
      if (document.visibilityState === "visible") void check();
    };
    const onInput = () => { lastInput.current = Date.now(); };

    const t = window.setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("online", onShow);
    for (const e of INPUT_EVENTS) window.addEventListener(e, onInput, { passive: true });
    return () => {
      stop = true;
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("online", onShow);
      for (const e of INPUT_EVENTS) window.removeEventListener(e, onInput);
    };
  }, []);

  if (!ready || later) return null;
  return (
    // under the bar (z-30) like the assistant's button: the phone drawer and
    // the assistant's and inbox panels cover it
    <CornerCard
      role="status"
      live
      icon={RefreshCw}
      title="A new version of the app is ready"
      className="z-[29]"
      actions={
        <>
          <button type="button" className="btn btn-sm btn-primary" onClick={reload}>Reload now</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setLater(true)}>Later</button>
        </>
      }
    >
      It also updates by itself when you open another page or leave the app alone for 10 minutes, but not while you are typing.
    </CornerCard>
  );
}
