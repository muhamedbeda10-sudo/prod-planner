import Link from "next/link";
import { getTrace } from "@/lib/server/trace";
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
