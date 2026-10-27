"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect } from "react";

/** The current address's query with some parameters set (empty removes them) — for a link that changes several at once. */
export function withParams(params: URLSearchParams, set: Record<string, string | null>): string {
  const p = new URLSearchParams(params.toString());
  for (const [k, v] of Object.entries(set)) {
    if (v) p.set(k, v);
    else p.delete(k);
  }
  const s = p.toString();
  return s ? `?${s}` : "?";
}

/** Write several query parameters at once and navigate, keeping the rest of
 *  the URL and the scroll — a filter that also clears the ones it outdates. */
export function useSetParams() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return useCallback((set: Record<string, string | null>) => router.push(`${pathname}${withParams(params, set)}`, { scroll: false }), [router, pathname, params]);
}

/** Write one query parameter (an empty value removes it) and navigate,
 *  keeping the rest of the URL — the one way a control writes its state
 *  into the address. */
export function useSetParam() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return useCallback(
    (key: string, value: string) => {
      const p = new URLSearchParams(params.toString());
      if (value) p.set(key, value);
      else p.delete(key);
      router.push(`${pathname}?${p.toString()}`);
    },
    [router, pathname, params]
  );
}

/** The current address with some query parameters changed (null removes
 *  one), and a #hash — for a link or a push that keeps the rest of the page. */
export function useHrefWith() {
  const pathname = usePathname();
  const params = useSearchParams();
  return useCallback(
    (set: Record<string, string | null>, hash = "") => {
      const p = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(set)) if (v === null) p.delete(k); else p.set(k, v);
      const q = p.toString();
      return `${pathname}${q ? `?${q}` : ""}${hash ? `#${hash}` : ""}`;
    },
    [pathname, params]
  );
}

/** The Plan Tracker's closed orders: the server sends them only while the
 *  address asks (?closed=1), so the address follows the Status filter both
 *  ways — back on Open, they stop riding along on every save's re-render.
 *  True while the rows asked for are still on their way. */
export function useClosedRows(wanted: boolean, sent: boolean): boolean {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  useEffect(() => {
    if (wanted === sent) return;
    const q = withParams(params, { closed: wanted ? "1" : null });
    router.replace(q === "?" ? pathname : `${pathname}${q}`, { scroll: false });
  }, [wanted, sent, pathname, router, params]);
  return wanted && !sent;
}
