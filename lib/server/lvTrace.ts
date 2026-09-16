import "server-only";
import { prisma } from "@/lib/db";
import { toISODate } from "@/lib/domain/dates";
import { LV_CHAIN, LV_ITEM, lvStageOf, type LvChainStage } from "@/lib/domain/lv";
import { getLvTracker, type LvTrackerRow } from "./lvTracker";

// The trace of one LV panel order (MO) or one panel code (BoM) — the
// panels' side of /trace. A transformer's trace is a pipeline of six
// components; a panel's is its orders on the chain, the ledger rows that
// moved them, and who recorded what.

export interface LvTraceEvent {
  ts: number;
  dateISO: string;
  kind: "output" | "correction";
  mo: string | null;
  stage: string;
  qty: number;
  by: string | null;
  source: string;
  note: string | null;
}

export interface LvTraceResult {
  scope: "mo" | "bom";
  key: string;
  bom: string;
  exists: boolean;
  members: LvTrackerRow[];
  /** Σ over the members, per stage, capped at each order's quantity. */
  pipeline: { stage: LvChainStage; done: number; required: number }[];
  requiredPanels: number;
  timeline: LvTraceEvent[];
  contributors: { name: string; qty: number }[];
  ledgerCount: number;
}

export async function getLvTrace(scopeIn: { mo?: string; bom?: string }): Promise<LvTraceResult> {
  const mo = (scopeIn.mo ?? "").trim().toUpperCase();
  const bom = (scopeIn.bom ?? "").trim().toUpperCase();
  const isMo = !!mo;

  const [tracker, handover] = await Promise.all([
    getLvTracker(),
    prisma.handoverEntry.findMany({
      where: { ...(isMo ? { mo } : { bom }), item: LV_ITEM },
      orderBy: [{ date: "desc" }, { id: "desc" }],
    }),
  ]);
  const members = tracker
    .filter((r) => (isMo ? r.mo.toUpperCase() === mo : r.bom.toUpperCase() === bom))
    .sort((a, b) => (a.mo < b.mo ? -1 : 1));
  const resolvedBom = members[0]?.bom ?? handover[0]?.bom ?? bom;

  const pipeline = LV_CHAIN.map((stage) => ({
    stage,
    required: members.reduce((s, r) => s + r.state.required, 0),
    done: members.reduce((s, r) => s + Math.min(lvStageOf(r.state, stage), r.state.required || Infinity), 0),
  }));

  const timeline: LvTraceEvent[] = handover.map((h) => ({
    ts: h.date.getTime(),
    dateISO: toISODate(h.date),
    kind: h.qty < 0 ? "correction" : "output",
    mo: h.mo ?? null,
    stage: h.dept,
    qty: h.qty,
    by: h.createdBy,
    source: h.source,
    note: h.note,
  }));

  const byPerson = new Map<string, number>();
  for (const h of handover) {
    if (h.qty <= 0 || !h.createdBy) continue;
    byPerson.set(h.createdBy, (byPerson.get(h.createdBy) ?? 0) + h.qty);
  }

  return {
    scope: isMo ? "mo" : "bom",
    key: isMo ? mo : bom,
    bom: resolvedBom,
    exists: members.length > 0 || handover.length > 0,
    members,
    pipeline,
    requiredPanels: pipeline[0]?.required ?? 0,
    timeline,
    contributors: [...byPerson.entries()].map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty),
    ledgerCount: handover.length,
  };
}
