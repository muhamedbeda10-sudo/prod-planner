"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
/** Coming back to the page asks again at most this often. */
const SHOW_CHECK_MS = 60_000;
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

/** Load the page — this one, or the one a link opens — in the new version. */
function reload(href?: string) {
  try {
    sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
  } catch {
    /* private mode — the reload still happens */
  }
  if (href) window.location.assign(href);
  else window.location.reload();
}

const shown = (el: Element) => el.getClientRects().length > 0;
const typedIn = (el: Element) =>
  !(el as HTMLInputElement).readOnly && ((el as HTMLInputElement).value ?? (el as HTMLElement).textContent ?? "").trim() !== "";

/** Something may be half done: a modal open, or text in the box in use, in a
 *  text area (the assistant's, chat, notes) or in a form. A search box sitting
 *  empty, or a corner card, holds nothing. */
function busy(): boolean {
  if ([...document.querySelectorAll('[aria-modal="true"], dialog[open]')].some(shown)) return true;
  return [...document.querySelectorAll(TYPED)].some(
    (el) => shown(el) && typedIn(el) && (el === document.activeElement || el.matches("textarea") || el.closest("form") !== null),
  );
}

/** A plain click on a link to another page of the app — where it goes. */
function appLink(e: MouseEvent): string | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return null;
  const url = new URL(a.href, window.location.href);
  if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return null;
  return url.href;
}

export function UpdateNotice() {
  const [pending, setPending] = useState<string | null>(null);
  const [putOff, setPutOff] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  const lastInput = useRef(0);
  const pathname = usePathname();
  const shownPath = useRef(pathname);

  /** Reload now if a new version waits and nothing would be lost. */
  const reloadIfSafe = useCallback((navigated: boolean, href?: string): boolean => {
    if (!pendingRef.current) return false;
    const idleMs = navigated ? 0 : Date.now() - lastInput.current;
    if (updateStep({ navigated, idleMs, busy: busy(), sinceReloadMs: sinceReload() }) !== "reload") return false;
    reload(href);
    return true;
  }, []);

  // a page opened some other way (a button, the assistant) still comes up in
  // the new version — links are caught before they open, below
  useEffect(() => {
    if (shownPath.current === pathname) return;
    shownPath.current = pathname;
    reloadIfSafe(true);
  }, [pathname, reloadIfSafe]);

  useEffect(() => {
    if (!MINE) return;
    let stop = false;
    let lastCheck = Date.now();
    lastInput.current = Date.now();

    const check = async () => {
      lastCheck = Date.now();
      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        const v = newerVersion(MINE, await r.json().catch(() => null));
        if (stop || !v) return;
        pendingRef.current = v;
        setPending(v);
        // a minimised app counts as left alone: coming back to it after a
        // while brings the new version up at once
        reloadIfSafe(false);
      } catch {
        /* offline for a moment — the next tick asks again */
      }
    };
    const visible = () => document.visibilityState === "visible";
    const tick = () => {
      if (!visible()) return;
      if (Date.now() - lastCheck >= VERSION_CHECK_MS) void check();
      else reloadIfSafe(false);
    };
    const onShow = () => {
      if (visible() && Date.now() - lastCheck >= SHOW_CHECK_MS) void check();
    };
    const onInput = () => { lastInput.current = Date.now(); };
    // with a new version waiting, the next page opens straight in it — one load, not two
    const onClick = (e: MouseEvent) => {
      const href = pendingRef.current ? appLink(e) : null;
      if (href && reloadIfSafe(true, href)) e.preventDefault();
    };

    const t = window.setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("online", onShow);
    document.addEventListener("click", onClick, true);
    for (const e of INPUT_EVENTS) window.addEventListener(e, onInput, { passive: true });
    return () => {
      stop = true;
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("online", onShow);
      document.removeEventListener("click", onClick, true);
      for (const e of INPUT_EVENTS) window.removeEventListener(e, onInput);
    };
  }, [reloadIfSafe]);

  // a version newer still than the one put off with Later is offered again
  if (!pending || pending === putOff) return null;
  return (
    // under the bar (z-30) like the assistant's button: the phone drawer and
    // the assistant's and inbox panels cover it
    <CornerCard
      role="status"
      icon={RefreshCw}
      title="A new version of the app is ready"
      className="z-[29]"
      actions={
        <>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => reload()}>Reload now</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPutOff(pending)}>Later</button>
        </>
      }
    >
      It also updates by itself when you open another page or leave the app alone for 10 minutes, but not while you are typing.
    </CornerCard>
  );
}
