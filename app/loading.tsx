// The instant loading state for every page: shown the moment a tab is
// clicked while the page's data streams in, and prefetched with the link so
// navigation never waits on the server to show something. Deliberately
// plain — a few grey bars where the header and the first table will be.
export default function Loading() {
  return (
    <div className="animate-pulse space-y-4" aria-busy="true" aria-label="Loading">
      <div className="flex items-end justify-between gap-3 pb-4 border-b">
        <div className="h-7 w-64 rounded-md bg-surface-2" />
        <div className="h-8 w-48 rounded-md bg-surface-2" />
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="h-20 w-40 rounded-xl bg-surface-2" />
        <div className="h-20 w-40 rounded-xl bg-surface-2" />
        <div className="h-20 w-40 rounded-xl bg-surface-2" />
      </div>
      <div className="rounded-xl border overflow-hidden">
        <div className="h-9 bg-surface-2" />
        <div className="space-y-2 p-3">
          <div className="h-5 rounded bg-surface-2/70" />
          <div className="h-5 rounded bg-surface-2/70 w-11/12" />
          <div className="h-5 rounded bg-surface-2/70 w-10/12" />
          <div className="h-5 rounded bg-surface-2/70 w-11/12" />
        </div>
      </div>
    </div>
  );
}
