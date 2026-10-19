import Link from "next/link";
import { guardTab } from "@/lib/server/auth";
import { getTrace } from "@/lib/server/trace";
import { getActiveLine } from "@/lib/server/line";
import { getLvTrace } from "@/lib/server/lvTrace";
import { LvTraceView } from "@/components/LvTraceView";
import { PageHeader } from "@/components/ui";
import { TraceSearch } from "@/components/TraceSearch";
import { TraceView } from "@/components/TraceView";
import { trackerHref } from "@/lib/domain/links";

export const dynamic = "force-dynamic";

export default async function TracePage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; bom?: string; mo?: string; view?: string }>;
}) {
  // the proxy only sees that a session cookie is there; the session itself is
  // checked here, before any order or log row is read
  await guardTab("/trace");
  const sp = await searchParams;
  const planNo = Number(sp.plan) || 0;
  const mo = (sp.mo ?? "").trim();
  const bom = (sp.bom ?? "").trim();
  // which tracker view the visitor came from — `plan` alone can't say, and the
  // tracker opens MONTHLY unless the URL asks for weekly, so a reader who
  // arrived from the weekly plan would be sent back to the wrong table
  const view = sp.view === "weekly" ? "weekly" : "";

  // no target yet → the search-first landing
  if (!bom && !mo) {
    return (
      <div className="space-y-6">
        <PageHeader title="Trace" sub="Follow one order (MO) or code (BOM) through its whole life." />
        <div className="rounded-2xl bg-surface border border-border/60 shadow-sm p-10 flex flex-col items-center gap-3 text-center">
          <div className="text-4xl">🔎</div>
          <p className="text-sm text-muted">Type a code or an order number to trace it.</p>
          <TraceSearch />
        </div>
      </div>
    );
  }

  // a panel's trace is its own shape: orders on the chain and the rows that
  // moved them, not six components in a pipeline
  if ((await getActiveLine()) === "LV") {
    const lt = await getLvTrace({ mo, bom });
    if (!lt.exists) {
      return (
        <div className="space-y-6">
          <PageHeader title={`Trace — ${lt.key}`} sub="No LV panel order or log row carries this code.">
            <Link href="/tracker" className="text-accent text-sm font-semibold">→ Back to tracker</Link>
          </PageHeader>
          <div className="rounded-2xl bg-surface border border-border/60 shadow-sm p-10 flex flex-col items-center gap-3 text-center">
            <div className="text-4xl">🤷</div>
            <p className="text-sm text-muted">Nothing found for <b>{lt.key}</b> on the panels — try another code or order, or switch the line at the top.</p>
            <TraceSearch initial={lt.key} initialMode={lt.scope} />
          </div>
        </div>
      );
    }
    return <LvTraceView t={lt} />;
  }

  const t = await getTrace({ mo, bom });

  if (!t.exists) {
    return (
      <div className="space-y-6">
        <PageHeader title={`Trace — ${t.key}`} sub="This code or order does not appear in any plan, the registry, or the log yet.">
          <Link href={trackerHref(planNo, view)} className="text-accent text-sm font-semibold">→ Back to tracker</Link>
        </PageHeader>
        <div className="rounded-2xl bg-surface border border-border/60 shadow-sm p-10 flex flex-col items-center gap-3 text-center">
          <div className="text-4xl">🤷</div>
          <p className="text-sm text-muted">Nothing found for <b>{t.key}</b> — try another code or order.</p>
          <TraceSearch initial={t.key} initialMode={t.scope} />
        </div>
      </div>
    );
  }

  return <TraceView t={t} planNo={planNo} view={view} />;
}
