"use client";

import { useEffect, useSyncExternalStore } from "react";

// What the app's floating windows — the AI assistant and the inbox — share:
// their state kept in this browser's storage (so each reopens as it was left,
// after a reload too), the phone test, one window open at a time, and the
// page behind a large window (or a phone's whole-screen one) held still.

export type FloatName = "ai" | "inbox";

const PHONE = "(max-width: 767px)";

export const isPhone = () => window.matchMedia(PHONE).matches;

function subscribePhone(cb: () => void) {
  const m = window.matchMedia(PHONE);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}

/** Whether the screen is a phone's — the server says no. */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribePhone, isPhone, () => false);
}

export interface FloatStore {
  subscribe: (cb: () => void) => () => void;
  /** The stored text ("" when none) — the snapshot the hooks compare. */
  read: () => string;
  write: (value: unknown) => void;
}

/** A window's state under one storage key — memory when storage is blocked. */
export function floatStore(key: string): FloatStore {
  const listeners = new Set<() => void>();
  let memory = "";
  const onStorage = (e: StorageEvent) => {
    if (e.key === key) listeners.forEach((l) => l());
  };
  return {
    subscribe(cb) {
      listeners.add(cb);
      if (listeners.size === 1) window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0) window.removeEventListener("storage", onStorage);
      };
    },
    read() {
      try {
        return localStorage.getItem(key) ?? memory;
      } catch {
        return memory;
      }
    },
    write(value) {
      memory = JSON.stringify(value);
      try {
        localStorage.setItem(key, memory);
      } catch {
        /* storage unavailable — holds for this page load only */
      }
      listeners.forEach((l) => l());
    },
  };
}

/** The stored object, or {} when there is none or it cannot be read. */
export function parseStored<T extends object>(raw: string): Partial<T> {
  try {
    const v = JSON.parse(raw || "null") as Partial<T> | null;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

const OPENED = "float-window-opened";

/** Tell the other windows this one opened — they close. */
export function announceOpen(name: FloatName): void {
  window.dispatchEvent(new CustomEvent<FloatName>(OPENED, { detail: name }));
}

/** Close this window when another one opens. */
export function useCloseWhenOtherOpens(name: FloatName, open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const other = (e: Event) => {
      if ((e as CustomEvent<FloatName>).detail !== name) close();
    };
    window.addEventListener(OPENED, other);
    return () => window.removeEventListener(OPENED, other);
  }, [name, open, close]);
}

// the windows holding the page still right now — the page scrolls again only
// when none does, whichever order they open and close in
const holding = new Set<FloatName>();

/** While `modal` (expanded, or on a phone), the page behind does not scroll
 *  and Escape closes the window from anywhere; docked beside the page it
 *  takes Escape from inside itself only (FloatDock). */
export function useWindowChrome(name: FloatName, shown: boolean, modal: boolean, close: () => void): void {
  useEffect(() => {
    if (modal) holding.add(name);
    else holding.delete(name);
    document.documentElement.classList.toggle("ai-modal", holding.size > 0);
    return () => {
      holding.delete(name);
      document.documentElement.classList.toggle("ai-modal", holding.size > 0);
    };
  }, [name, modal]);

  useEffect(() => {
    if (!shown || !modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [shown, modal, close]);
}
