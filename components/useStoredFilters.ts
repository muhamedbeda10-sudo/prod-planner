"use client";

import type { ProductLine } from "@/lib/domain/lines";
import { useMemo, useSyncExternalStore } from "react";
import { useLineKey } from "@/components/LineContext";

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
    // another tab changed it: this tab's copy in memory is stale
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === key) memory.delete(key);
      cb();
    };
    window.addEventListener("storage", onStorage);
    return () => { set!.delete(cb); window.removeEventListener("storage", onStorage); };
  };
}

function readRaw(key: string): string {
  try { return localStorage.getItem(key) ?? memory.get(key) ?? ""; } catch { return memory.get(key) ?? ""; }
}

/** Write one stored value ("" removes it) and tell every reader of it. */
export function writeStoredValue(key: string, value: string) {
  memory.set(key, value);
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* storage unavailable — holds for this page load only */ }
  listeners.get(key)?.forEach((l) => l());
}

/** One value kept in this browser under `key` ("" when none) — the server
 *  renders without it and the browser takes over after hydration. */
export function useStoredValue(key: string): string {
  const subscribe = useMemo(() => subscribeTo(key), [key]);
  return useSyncExternalStore(subscribe, () => readRaw(key), () => "");
}

export function useStoredFilters<T>(rawKey: string, parse: (raw: string) => T, empty: T, line?: ProductLine): { filters: T; setFilters: (f: T) => void } {
  // one line's filters never apply to the other: a Product reading "Tank"
  // carried onto the panels' tab hid every panel row it had. `line` names
  // another line's filters than the screen's — set for the screen it opens.
  const key = useLineKey(rawKey, line);
  const raw = useStoredValue(key);
  const filters = useMemo(() => (raw ? parse(raw) : empty), [raw, parse, empty]);
  const setFilters = (f: T) => writeStoredValue(key, JSON.stringify(f));
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
