import "server-only";
import { prisma } from "@/lib/db";
import { getActiveLine, ledgerItemWhere } from "./line";
import { getMasterTracker, type MasterTrackerRow } from "./masterTracker";
import { ITEMS, isPaintExempt, type Item } from "@/lib/domain/constants";
import { groupKey } from "@/lib/domain/bom";
import { toISODate } from "@/lib/domain/dates";

// One project's whole life — the Trace page. Works on a single manufacturing
// order (mo) OR a whole code (bom). Everything is netted (negative corrections
// and returns included) and covers EVERY stage (Cut → Welding → Painting / Shot
// Blast → Delivered), not just the three production departments.

export interface TracePipelineRow {
  item: Item;
  active: boolean; // the project needs this component (rule-eligible & not N/A)
  required: number; // Σ planQty − OSP over the scope's orders (0 when N/A)
  osp: number;
  cut: number;
  weld: number;
  finished: number; // Painting, or Shot Blast for the paint-exempt core (CF)
  delivered: number;
  finishLabel: "SHB" | "Paint";
}

export type TraceEventKind = "output" | "correction" | "return" | "note";

export interface TraceEvent {
  ts: number; // sort key (ms)
  dateISO: string;
  kind: TraceEventKind;
  mo: string | null;
  dept?: string; // production stage / where a note was raised
  item?: string;
  qty?: number; // signed for output/correction, positive magnitude otherwise
  by?: string | null; // who recorded it (handover.createdBy)
  source?: string;
  text?: string; // note body
  photos?: string[];
  reason?: string; // return reason
  status?: string; // note / return status
  fromDept?: string; // return
  toDept?: string; // return
  corrected?: string | null; // bomRaw when the code was auto-fixed at entry
}

export interface TraceResult {
  scope: "mo" | "bom";
  key: string; // the mo or bom queried
  bom: string; // resolved BOM (same as key in bom mode)
  exists: boolean; // appears anywhere (orders / registry / ledger)
  // identity
  members: {
    mo: string;
    soi: string | null;
    kva: string | null;
    rating: string | null;
    urgent: boolean;
    priority: boolean;
    status: string;
    planQty: number;
    complete: number; // finished sets (from the master tracker)
    remarks: string;
    months: string[];
  }[];
  kva: string | null;
  rating: string | null;
  anyUrgent: boolean;
  siblings: string[]; // same family (base + M number), bom mode only
  // where is it now
  pipeline: TracePipelineRow[];
  requiredSets: number; // Σ order qty (base-item sets)
  completeSets: number; // Σ finished sets (min across the base components)
  deliveredSets: number; // Σ delivered sets
  // story + quality
  timeline: TraceEvent[]; // newest first
  openNotes: number;
  openReturns: number;
  contributors: { name: string; qty: number }[]; // Σ positive output per person
  // raw (secondary, collapsed in the UI)
  orders: {
    id: number; planNo: number; planLabel: string; mo: string; description: string | null;
    item: string; requiredQty: number; plannerBalance: number | null; targetQty: number; remark: string;
  }[];
  ledger: {
    id: number; dateISO: string; planNo: number; planLabel: string; dept: string;
    item: string; qty: number; source: string; by: string | null; corrected: string | null;
  }[];
  ledgerCount: number;
  orderPlans: string[]; // labels of the plans this code was planned in
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export async function getTrace(scopeIn: { mo?: string; bom?: string }): Promise<TraceResult> {
  const mo = (scopeIn.mo ?? "").trim();
  const bom = (scopeIn.bom ?? "").trim();
  const isMo = !!mo;
  const scope = isMo ? { mo } : { bom };

  const line = await getActiveLine(); // the trace stays inside the line on screen
  const [orders, handover, allBoms, masters, plans, notes, returns, masterRows] = await Promise.all([
    prisma.planOrder.findMany({ where: scope, orderBy: [{ planNo: "asc" }, { mo: "asc" }, { item: "asc" }] }),
    prisma.handoverEntry.findMany({ where: { ...scope, ...ledgerItemWhere(line) }, orderBy: [{ date: "asc" }, { id: "asc" }] }),
    isMo ? Promise.resolve([]) : prisma.planOrder.findMany({ select: { bom: true }, distinct: ["bom"] }),
    prisma.masterOrder.findMany({ where: { ...scope, line } }),
    prisma.plan.findMany(),
    prisma.queueNote.findMany({ where: scope, orderBy: { createdAt: "asc" } }),
    prisma.returnEntry.findMany({ where: scope, orderBy: { date: "asc" } }),
    getMasterTracker(),
  ]);

  // ---- plan labels ("July 2026", "Setup balances", disambiguated) ----
  const planMonth = new Map(plans.map((p) => [p.planNo, `${MONTHS[p.startDate.getUTCMonth()]} ${p.startDate.getUTCFullYear()}`]));
  const monthCount = new Map<string, number>();
  for (const m of planMonth.values()) monthCount.set(m, (monthCount.get(m) ?? 0) + 1);
  const planLabel = (n: number) => {
    if (n === 0) return "Setup balances";
    const m = planMonth.get(n);
    if (!m) return `Plan ${n}`;
    return (monthCount.get(m) ?? 0) > 1 ? `${m} · P${n}` : m;
  };

  const resolvedBom = masters[0]?.bom ?? orders[0]?.bom ?? handover[0]?.bom ?? bom;

  // ---- identity: the master order(s) in scope ----
  const completeOf = new Map(masterRows.map((r) => [r.mo, r.complete]));
  const members = masters
    .map((m) => ({
      mo: m.mo,
      soi: (m.soi ?? "").trim() || null,
      kva: m.kva,
      rating: m.rating,
      urgent: m.urgent,
      priority: m.priority,
      status: m.status,
      planQty: m.planQty,
      complete: completeOf.get(m.mo) ?? 0,
      remarks: (m.remarks ?? "").trim(),
      months: (m.months || m.source || "").split(",").map((s) => s.trim()).filter(Boolean),
    }))
    .sort((a, b) => (a.mo < b.mo ? -1 : 1));

  // ---- pipeline: reuse the master-tracker computation (capped, OSP-credited) ----
  const rows: MasterTrackerRow[] = isMo
    ? masterRows.filter((r) => r.mo === mo)
    : masterRows.filter((r) => r.bom === resolvedBom);

  const pipeline: TracePipelineRow[] = ITEMS.map((it) => {
    const active = rows.some((r) => r.items[it].eligible && !r.items[it].excluded);
    let required = 0, osp = 0, cut = 0, weld = 0, paint = 0, shp = 0, delivered = 0;
    for (const r of rows) {
      const c = r.items[it];
      if (!c.eligible || c.excluded) continue;
      required += Math.max(0, r.required - c.osp);
      osp += c.osp;
      cut += c.cut; weld += c.weld; paint += c.paint; shp += c.shp; delivered += c.delivered;
    }
    return {
      item: it, active, required, osp, cut, weld,
      finished: isPaintExempt(it) ? shp : paint,
      delivered,
      finishLabel: isPaintExempt(it) ? "SHB" : "Paint",
    };
  });

  const requiredSets = rows.reduce((s, r) => s + r.required, 0);
  const completeSets = rows.reduce((s, r) => s + r.complete, 0);
  const deliveredSets = rows.reduce((s, r) => {
    // delivered sets = MIN delivered across the components the order needs
    const need = ITEMS.filter((it) => r.items[it].eligible && !r.items[it].excluded);
    if (need.length === 0) return s;
    const m = Math.min(...need.map((it) => r.items[it].delivered + r.items[it].osp));
    return s + Math.min(r.required, Math.max(0, m));
  }, 0);

  // ---- timeline: merge every kind of event, newest first ----
  const events: TraceEvent[] = [];
  for (const h of handover) {
    if (h.source === "return") continue; // shown as its ReturnEntry instead (with the reason)
    events.push({
      ts: h.date.getTime(),
      dateISO: toISODate(h.date),
      kind: h.qty < 0 ? "correction" : "output",
      mo: h.mo ?? null,
      dept: h.dept,
      item: h.item,
      qty: h.qty,
      by: h.createdBy,
      source: h.source,
      corrected: h.bomRaw && h.bomRaw !== h.bom ? h.bomRaw : null,
    });
  }
  for (const r of returns) {
    events.push({
      ts: r.date.getTime(),
      dateISO: toISODate(r.date),
      kind: "return",
      mo: r.mo ?? null,
      item: r.item,
      qty: r.qty,
      reason: r.reason,
      status: r.status,
      fromDept: r.fromDept,
      toDept: r.toDept,
    });
  }
  for (const n of notes) {
    events.push({
      ts: n.createdAt.getTime(),
      dateISO: toISODate(n.createdAt),
      kind: "note",
      mo: n.mo ?? null,
      dept: n.dept,
      item: n.item,
      text: n.text,
      photos: n.photos ? (JSON.parse(n.photos) as string[]) : [],
      status: n.status,
    });
  }
  events.sort((a, b) => b.ts - a.ts || 0);

  // ---- contributors (positive output per person) — supports productivity work ----
  const byPerson = new Map<string, number>();
  for (const h of handover) {
    if (h.qty <= 0 || !h.createdBy) continue;
    byPerson.set(h.createdBy, (byPerson.get(h.createdBy) ?? 0) + h.qty);
  }
  const contributors = [...byPerson.entries()].map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty);

  // ---- family siblings (bom mode) ----
  const fam = !isMo && resolvedBom ? groupKey(resolvedBom.toUpperCase()) : "";
  const siblings = isMo
    ? []
    : [...new Set(allBoms.map((b) => b.bom))].filter((b) => b !== resolvedBom && groupKey(b.toUpperCase()) === fam).sort();

  const remarksByMo = new Map(masters.map((m) => [m.mo, (m.remarks ?? "").trim()]));

  return {
    scope: isMo ? "mo" : "bom",
    key: isMo ? mo : bom,
    bom: resolvedBom,
    exists: orders.length > 0 || masters.length > 0 || handover.length > 0,
    members,
    kva: members.find((m) => m.kva)?.kva ?? null,
    rating: members.find((m) => m.rating)?.rating ?? null,
    anyUrgent: members.some((m) => m.urgent),
    siblings,
    pipeline,
    requiredSets,
    completeSets,
    deliveredSets,
    timeline: events,
    openNotes: notes.filter((n) => n.status === "open").length,
    openReturns: returns.filter((r) => r.status === "open").length,
    contributors,
    orders: orders.map((o) => ({
      id: o.id, planNo: o.planNo, planLabel: planLabel(o.planNo), mo: o.mo, description: o.description,
      item: o.item, requiredQty: o.requiredQty, plannerBalance: o.plannerBalance ?? null, targetQty: o.targetQty,
      remark: remarksByMo.get(o.mo) || "",
    })),
    ledger: handover.map((h) => ({
      id: h.id, dateISO: toISODate(h.date), planNo: h.planNo, planLabel: planLabel(h.planNo), dept: h.dept,
      item: h.item, qty: h.qty, source: h.source, by: h.createdBy, corrected: h.bomRaw && h.bomRaw !== h.bom ? h.bomRaw : null,
    })),
    ledgerCount: handover.length,
    orderPlans: [...new Set(orders.map((o) => o.planNo))].sort((a, b) => a - b).map(planLabel),
  };
}
