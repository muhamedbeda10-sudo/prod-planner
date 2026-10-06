// A sheet still loading: its header and a few rows of grey bars. No client
// code — the instant loading page draws it before any script arrives.
export function TableSkeleton({ rows = 8, cols = 7 }: { rows?: number; cols?: number }) {
  return (
    <div className="rounded-[10px] border overflow-hidden bg-surface" aria-busy="true" aria-label="Loading">
      <div className="h-9 bg-surface-2 border-b" />
      <div className="animate-pulse">
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex gap-4 px-3 h-9 items-center border-b last:border-b-0">
            {Array.from({ length: cols }, (_, c) => (
              <span key={c} className="h-3 rounded bg-surface-2" style={{ flex: c === 0 ? 1.4 : 1, opacity: 1 - r * 0.07 }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

