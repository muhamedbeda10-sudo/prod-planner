import "server-only";
import { recentFindings } from "@/lib/server/watchdog";
import type { ReadTool } from "./types";

// What the plant's watchdog found lately (lib/server/watchdog.ts): orders
// heading late, output under its usual, absence — so the assistant can say
// what was flagged, follow it up, and turn it into a task when asked.

export const watchFindingsTool: ReadTool<{ days?: number }> = {
  kind: "read",
  name: "get_watch_findings",
  title: "Reading the watchdog's findings",
  description: "What the plant's watchdog found on its morning runs over the last days (default 7): orders heading late against their delivery day, a stage's earned hours far under its usual, high absence and workers absent on most of their recent days — each with its day, severity, and the order when there is one. Read the live data again before you act on one.",
  cacheable: true,
  schema: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 60 } }, additionalProperties: false },
  async run(i, ctx) {
    // what a hidden screen would show stays out: absence is the Shifts tab's,
    // lateness the Plan Tracker's
    const rows = (await recentFindings(i.days ?? 7)).filter((f) => !(f.kind === "absence" && ctx.hidden.has("shifts")) && !(f.kind === "late" && ctx.hidden.has("tracker")));
    return { ok: true, text: rows.length ? JSON.stringify(rows) : "The watchdog found nothing in those days.", links: [{ label: "Inbox", href: "/inbox" }] };
  },
};

export const WATCHDOG_TOOLS = [watchFindingsTool] as const;
