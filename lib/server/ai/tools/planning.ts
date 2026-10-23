import "server-only";
import { withLine } from "@/lib/server/line";
import { getMasterTracker } from "@/lib/server/masterTracker";
import { getLvTracker } from "@/lib/server/lvTracker";
import { filterLvTracker, filterMasterTracker, lvStageStats, masterProgress, summaryStage, trackerItemStats, trackerTotals, type TrackerFilters } from "@/lib/domain/trackerSummary";
import { lvBottleneck, rowBottleneck } from "@/lib/domain/trackerView";
import type { ObjectSchema } from "@/lib/domain/aiInput";
import type { ReadTool } from "./types";

export const TRACKER_FILTER_SCHEMA: ObjectSchema = {
  type: "object", additionalProperties: false,
  properties: Object.fromEntries(["q", "month", "status", "progress", "urgent", "product", "family", "deptStage"].map((key) => [key, {
    type: "string" as const, maxLength: 160,
    description: key === "status" ? "open, closed, hold or all; default all for TR, open for LV" : key === "progress" ? "complete, inprogress or notstarted (LV aliases: done, partial, none)" : key === "deptStage" ? "TR card scope: comma-separated Cut,Welding,Painting,Delivered; last selected stage wins" : key === "urgent" ? "yes; LV also accepts no" : key === "family" ? "LV only: PNL or MB" : key === "product" ? "LV product, exactly as registered" : "The tracker's filter value; month is its exact plan label, or — for TR orders without a month",
  }])),
};

interface Input { line?: "TR" | "LV"; usePageFilters?: boolean; filters?: TrackerFilters; detailLimit?: number }
const trace = (mo: string, line: "TR" | "LV") => `/trace?mo=${encodeURIComponent(mo)}&line=${line}`;

export function trackerSummaryTool(loaders = { tr: getMasterTracker, lv: getLvTracker }): ReadTool<Input> {
  return {
    kind: "read", cacheable: true, name: "get_tracker_summary", title: "Checking the production plan and priorities", tabs: ["tracker"],
    description: "The monthly Plan Tracker's exact calculated totals, stage cards and progress bottlenecks for TR or LV. Uses the SAME filters and calculations as the screen, including OSP, excluded components and the core frame's shot blast. Use for plan summaries, totals, filtered orders and production-control priorities instead of re-creating completion with SQL. usePageFilters=true means the monthly tracker currently beside this chat; explicit filters override it. Totals cover ALL matching orders; attention is a bounded list, not the total. Bottlenecks describe progress, not proven causes of delay. No due-date forecast is included; use worklists/simulator to investigate timing and capacity.",
    schema: { type: "object", additionalProperties: false, properties: {
      line: { type: "string", enum: ["TR", "LV"] }, usePageFilters: { type: "boolean" }, filters: TRACKER_FILTER_SCHEMA,
      detailLimit: { type: "integer", minimum: 1, maximum: 30 },
    } },
    async run(input, ctx) {
      if (ctx.hidden.has("tracker")) return { ok: false, text: "The tracker is not opened for this person." };
      const line = input.line ?? ctx.line ?? "TR";
      let filters: TrackerFilters = {};
      if (input.usePageFilters) {
        if (!ctx.page || ctx.page.path !== "/tracker" || ctx.page.filters.view === "weekly") return { ok: false, text: "No monthly tracker is open. Specify the scope explicitly, or use the weekly-plan tools for a weekly plan." };
        if (ctx.line && line !== ctx.line) return { ok: false, text: "The page belongs to the other production line. Specify filters explicitly instead of mixing the two scopes." };
        filters = Object.fromEntries(Object.keys(TRACKER_FILTER_SCHEMA.properties).flatMap((key) => key in ctx.page!.filters ? [[key, ctx.page!.filters[key]]] : []));
      }
      filters = { ...filters, ...input.filters };
      if (filters.status && !["open", "closed", "hold", "all"].includes(filters.status)) return { ok: false, text: "Status must be open, closed, hold or all." };
      if (filters.urgent && !["yes", "no"].includes(filters.urgent)) return { ok: false, text: "Urgency must be yes or no." };
      if (filters.progress && !["complete", "inprogress", "notstarted", "done", "partial", "none"].includes(filters.progress)) return { ok: false, text: "Unknown progress filter." };
      const limit = input.detailLimit ?? 12;
      const scope = { line, filters };
      const asOf = new Date().toISOString();
      if (line === "LV") {
        if (filters.deptStage) return { ok: false, text: "LV shows its four making stages; the transformer department filter does not apply." };
        if (filters.family && !["PNL", "MB"].includes(filters.family)) return { ok: false, text: "LV plan family must be PNL or MB." };
        filters.progress = ({ complete: "done", inprogress: "partial", notstarted: "none" } as Record<string, string>)[filters.progress ?? ""] ?? filters.progress;
        filters.status ||= "open";
        const all = await withLine("LV", () => loaders.lv());
        const rows = filterLvTracker(all, filters);
        const attention = [...rows].filter((r) => r.remaining > 0 || r.hold.onHold).sort(attentionOrder).slice(0, limit).map((r) => ({
          mo: r.mo, bom: r.bom, required: r.state.required, complete: r.complete, remaining: r.remaining,
          onHold: r.hold.onHold, urgent: r.urgent, bottleneck: lvBottleneck(r.state), href: trace(r.mo, "LV"),
        }));
        return { ok: true, text: JSON.stringify({ scope, asOf, totals: trackerTotals(rows, (r) => r.state.required), stages: lvStageStats(rows), attention, attentionTruncated: rows.filter((r) => r.remaining > 0 || r.hold.onHold).length > limit, note: "Units are panels; completion is painting, not delivery. Attention is ordered by hold, urgency, then remaining quantity. No schedule lateness or root cause is inferred." }), links: [{ label: "LV Plan Tracker", href: "/tracker" }, ...attention.map((r) => ({ label: `${r.mo} · ${r.bom}`, href: r.href }))] };
      }
      if (filters.product || filters.family || filters.urgent === "no") return { ok: false, text: "Product, plan family and non-urgent-only are LV filters. Use the transformer's search/month/status/progress/urgent filters." };
      if (filters.deptStage?.split(",").some((s) => !["Cut", "Welding", "Painting", "Delivered"].includes(s))) return { ok: false, text: "Unknown transformer department." };
      filters.progress = ({ done: "complete", partial: "inprogress", none: "notstarted" } as Record<string, string>)[filters.progress ?? ""] ?? filters.progress;
      if (filters.status === "all") filters.status = "";
      const all = await withLine("TR", () => loaders.tr());
      const rows = filterMasterTracker(all, filters);
      const attention = [...rows].filter((r) => r.remaining > 0 || r.hold.onHold || r.pendingQty).sort(attentionOrder).slice(0, limit).map((r) => ({
        mo: r.mo, bom: r.bom, required: r.required, complete: r.complete, remaining: r.remaining,
        onHold: r.hold.onHold, urgent: r.urgent, progress: masterProgress(r), bottleneck: rowBottleneck(r.required, r.items),
        pendingQuantityDecision: r.pendingQty, href: trace(r.mo, "TR"),
      }));
      return { ok: true, text: JSON.stringify({ scope, asOf, totals: trackerTotals(rows, (r) => r.required), components: trackerItemStats(rows, summaryStage(filters.deptStage)), attention, attentionTruncated: rows.filter((r) => r.remaining > 0 || r.hold.onHold || r.pendingQty).length > limit, note: "Totals count complete transformer sets; component cards count pieces. OSP reduces in-house targets; CF finishes at shot blast. Attention is ordered by hold, urgency, then remaining sets. No schedule lateness or root cause is inferred." }), links: [{ label: "Transformer Plan Tracker", href: "/tracker" }, ...attention.map((r) => ({ label: `${r.mo} · ${r.bom}`, href: r.href }))] };
    },
  };
}
export const getTrackerSummary = trackerSummaryTool();

function attentionOrder(a: { mo: string; remaining: number; urgent: boolean; hold: { onHold: boolean } }, b: typeof a) {
  return Number(b.hold.onHold) - Number(a.hold.onHold) || Number(b.urgent) - Number(a.urgent) || b.remaining - a.remaining || a.mo.localeCompare(b.mo);
}
