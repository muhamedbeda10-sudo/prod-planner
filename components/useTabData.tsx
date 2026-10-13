"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

// A pane's data, read when it shows — shared by the AI and inbox windows.

export type Loaded<T> = ({ ok: true } & T) | { ok: false; error: string };

/** A pane's data: loaded on its first showing, and again on each later
 *  showing when `fresh` — and whenever `reload` is called. `reload` is a new
 *  showing (the version moves on, so a view keyed on it starts over);
 *  `refresh` reads the same data again in place. A reply that a later read
 *  overtook is dropped. */
export function useTabData<T>(load: () => Promise<Loaded<T>>, active: boolean, fresh: boolean) {
  const [loaded, setLoaded] = useState<{ data: T; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const loadRef = useRef(load);
  const seen = useRef(false);
  const seq = useRef(0);

  const read = useCallback((bump: boolean) => {
    const n = ++seq.current;
    loadRef.current()
      .then((r) => {
        if (n !== seq.current) return;
        if (r.ok) {
          setLoaded({ data: r, at: Date.now() });
          setError(null);
          if (bump) setVersion((v) => v + 1);
        } else setError(r.error);
      })
      .catch(() => {
        if (n === seq.current) setError("Could not load — check the connection and try again.");
      });
  }, []);
  const reload = useCallback(() => read(true), [read]);
  const refresh = useCallback(() => read(false), [read]);

  useEffect(() => {
    if (!active) return;
    if (!seen.current || fresh) reload();
    seen.current = true;
  }, [active, fresh, reload]);

  return { data: loaded?.data ?? null, loadedAt: loaded?.at ?? 0, error, version, reload, refresh };
}

export function Loading({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  if (error) {
    return (
      <div className="p-4 text-sm">
        <p className="font-semibold text-bad-fg">{error}</p>
        <button type="button" className="btn btn-sm mt-2" onClick={onRetry}>Try again</button>
      </div>
    );
  }
  return (
    <div className="p-10 flex items-center justify-center gap-2 text-sm text-muted">
      <Loader2 size={16} className="animate-spin" aria-hidden /> Loading…
    </div>
  );
}

