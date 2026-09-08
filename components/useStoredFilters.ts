"use client";

import { useMemo, useSyncExternalStore } from "react";

// A filter row that sticks: its value lives in this browser's storage, so a
// tab reopens narrowed the way it was left. Storage is the source of truth —
// the server renders unfiltered and the browser takes over after hydration.
// Blocked storage falls back to memory for the page load.

const listeners = new Map<string, Set<() => void>>();
const memory = new Map<string, string>();

function subscribeTo(key: string) {
  return (cb: () => void) => {
    let set = listeners.get(key);
    if (!set) { set = new Set(); listeners.set(key, set); }
    set.add(cb);
    window.addEventListener("storage", cb);
    return () => { set!.delete(cb); window.removeEventListener("storage", cb); };
  };
}

function readRaw(key: string): string {
  try { return localStorage.getItem(key) ?? memory.get(key) ?? ""; } catch { return memory.get(key) ?? ""; }
}

export function useStoredFilters<T>(key: string, parse: (raw: string) => T, empty: T): { filters: T; setFilters: (f: T) => void } {
  const subscribe = useMemo(() => subscribeTo(key), [key]);
  const raw = useSyncExternalStore(subscribe, () => readRaw(key), () => "");
  const filters = useMemo(() => (raw ? parse(raw) : empty), [raw, parse, empty]);
  const setFilters = (f: T) => {
    const next = JSON.stringify(f);
    memory.set(key, next);
    try { localStorage.setItem(key, next); } catch { /* storage unavailable — holds for this page load only */ }
    listeners.get(key)?.forEach((l) => l());
  };
  return { filters, setFilters };
}

/** A saved JSON object, or nothing — never throws on a hand-edited value. */
export function parseSaved(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const savedString = (o: Record<string, unknown>, k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
