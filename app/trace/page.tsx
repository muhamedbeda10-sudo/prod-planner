import Link from "next/link";
import { getTrace } from "@/lib/server/trace";
import { PageHeader } from "@/components/ui";
import { TraceSearch } from "@/components/TraceSearch";
import { TraceView } from "@/components/TraceView";

export const dynamic = "force-dynamic";

export default async function TracePage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; bom?: string; mo?: string }>;
}) {
  const sp = await searchParams;
  const planNo = Number(sp.plan) || 0;
  const mo = (sp.mo ?? "").trim();
  const bom = (sp.bom ?? "").trim();

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
          <Link href={planNo ? `/tracker?plan=${planNo}` : "/tracker"} className="text-accent text-sm font-semibold">→ Back to tracker</Link>
        </PageHeader>
        <div className="rounded-2xl bg-surface border border-border/60 shadow-sm p-10 flex flex-col items-center gap-3 text-center">
          <div className="text-4xl">🤷</div>
          <p className="text-sm text-muted">Nothing found for <b>{t.key}</b> — try another code or order.</p>
          <TraceSearch initial={t.key} initialMode={t.scope} />
        </div>
      </div>
    );
  }

  return <TraceView t={t} planNo={planNo} />;
}
