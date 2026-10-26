import Link from "next/link";
import { guardTab } from "@/lib/server/auth";
import { getTrace } from "@/lib/server/trace";
import { getActiveLine, withLine } from "@/lib/server/line";
import { prisma } from "@/lib/db";
import { lineParam, type ProductLine } from "@/lib/domain/lines";
import { getLvTrace } from "@/lib/server/lvTrace";
import { LvTraceView } from "@/components/LvTraceView";
import { PageHeader } from "@/components/ui";
import { TraceSearch } from "@/components/TraceSearch";
import { TraceView } from "@/components/TraceView";
import { traceHref, trackerHref } from "@/lib/domain/links";

export const dynamic = "force-dynamic";

export default async function TracePage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; bom?: string; mo?: string; view?: string; line?: string }>;
}) {
  // the proxy only sees that a session cookie is there; the session itself is
  // checked here, before any order or log row is read
  await guardTab("/trace");
  const sp = await searchParams;
  const planNo = Number(sp.plan) || 0;
  const mo = (sp.mo ?? "").trim();
  const bom = (sp.bom ?? "").trim();
  // an order's own line — an MO belongs to one, so a trace of it opens on the
  // right side from any screen; else the line the link named (a code, or an MO
  // only in the log); else the line on screen
  const line: ProductLine = (mo ? lineParam((await prisma.masterOrder.findUnique({ where: { mo }, select: { line: true } }))?.line) : null)
    ?? lineParam(sp.line)
    ?? await getActiveLine();
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
  if (line === "LV") {
    const lt = await withLine("LV", () => getLvTrace({ mo, bom }));
    if (!lt.exists) {
      return (
        <div className="space-y-6">
          <PageHeader title={`Trace — ${lt.key}`} sub="No LV panel order or log row carries this code.">
            <Link href={trackerHref(0, undefined, "LV")} className="text-brand-ink text-sm font-semibold">→ Back to tracker</Link>
          </PageHeader>
          <div className="rounded-2xl bg-surface border border-border/60 shadow-sm p-10 flex flex-col items-center gap-3 text-center">
            <div className="text-4xl">🤷</div>
            <p className="text-sm text-muted">
              Nothing found for <b>{lt.key}</b> on the panels — try another code or order, or{" "}
              <Link href={traceHref({ [lt.scope]: lt.key, line: "TR" })} className="text-brand-ink font-semibold hover:underline">look for it on the transformers</Link>.
            </p>
            <TraceSearch initial={lt.key} initialMode={lt.scope} line="LV" />
          </div>
        </div>
      );
    }
    return <LvTraceView t={lt} />;
  }

  const t = await withLine("TR", () => getTrace({ mo, bom }));

  if (!t.exists) {
    return (
      <div className="space-y-6">
        <PageHeader title={`Trace — ${t.key}`} sub="This code or order does not appear in any plan, the registry, or the log yet.">
          <Link href={trackerHref(planNo, view, "TR")} className="text-brand-ink text-sm font-semibold">→ Back to tracker</Link>
        </PageHeader>
        <div className="rounded-2xl bg-surface border border-border/60 shadow-sm p-10 flex flex-col items-center gap-3 text-center">
          <div className="text-4xl">🤷</div>
          <p className="text-sm text-muted">
            Nothing found for <b>{t.key}</b> — try another code or order, or{" "}
            <Link href={traceHref({ [t.scope]: t.key, line: "LV" })} className="text-brand-ink font-semibold hover:underline">look for it on the panels</Link>.
          </p>
          <TraceSearch initial={t.key} initialMode={t.scope} line="TR" />
        </div>
      </div>
    );
  }

  return <TraceView t={t} planNo={planNo} view={view} />;
}
