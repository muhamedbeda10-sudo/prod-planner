import Link from "next/link";
import { getCurrentUser, guardTab, hiddenTabsOf } from "@/lib/server/auth";
import { canSeePath } from "@/lib/domain/tabs";
import { getTraceMaterial } from "@/lib/server/material";
import { getUserPrefs } from "@/lib/server/userPrefs";
import { MATERIAL_PREF_KEYS, type UserPrefs } from "@/lib/domain/userPrefs";
import { TraceMaterial } from "@/components/TraceMaterial";
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

  // the order's lines of the nesting sheet — for whoever may open the MATERIAL tab
  const me = await getCurrentUser();
  const seesMaterial = canSeePath(hiddenTabsOf(me), "/material");
  const materialOf = async (members: readonly { mo: string; soi: string | null }[], code: string, scope: "mo" | "bom", key: string) => {
    if (!seesMaterial) return null;
    const [m, prefs] = await Promise.all([
      // an MO traced from the log alone has no registry row: its own MO still finds its lines
      getTraceMaterial(line, { scope, mos: [...members.map((o) => o.mo), ...(scope === "mo" ? [key] : [])], sois: members.map((o) => o.soi ?? ""), bom: code }),
      getUserPrefs(me?.id, MATERIAL_PREF_KEYS),
    ]);
    // the tab is searched for the order's MO when its parts' lines carry it
    // (closed on the ODOO log), else for its SOI, else the code
    const sois = [...new Set(members.map((o) => (o.soi ?? "").trim()).filter(Boolean))];
    const linked = scope === "mo" && m.lines.some((l) => l.orderMos.some((o) => o.toUpperCase() === key.toUpperCase()));
    const search = linked ? key : scope === "mo" && sois.length === 1 ? sois[0] : code;
    return <TraceMaterial lines={m.lines} odooByMo={m.odooByMo} product={line} prefs={prefs as UserPrefs} search={search} code={code} mos={scope === "mo" ? [key] : members.map((o) => o.mo)} />;
  };

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
    return <LvTraceView t={lt} material={await materialOf(lt.members, lt.bom, lt.scope, lt.key)} />;
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

  return <TraceView t={t} planNo={planNo} view={view} material={await materialOf(t.members, t.bom, t.scope, t.key)} />;
}
