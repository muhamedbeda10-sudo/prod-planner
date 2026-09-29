import "server-only";
import { prisma } from "@/lib/db";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { factoryDayISO, factoryDayStart } from "@/lib/domain/dates";
import {
  ALL_DEPARTMENTS, PERIOD_LABEL, checkAgainstLimits, coversDepartment, departmentsLabel, exceedances, isLimitBasis, isLimitPeriod,
  parseDepartments, periodWindow, standings, windowsSpan, type LimitBasis, type LimitBreach, type LimitPeriod, type LimitRule, type LimitUse,
} from "@/lib/domain/consumableLimits";

// The CONSUMABLES catalogue and limits — the reads. The rules are pure in
// lib/domain/consumableLimits.ts; this file turns rows into them and counts
// the hand-outs in the windows they need.

export interface LimitDTO {
  id: number;
  departments: typeof ALL_DEPARTMENTS | string[];
  departmentsLabel: string;
  basis: LimitBasis;
  period: LimitPeriod;
  qty: number;
}

export interface CatalogueItemDTO {
  id: number;
  code: string | null;
  name: string;
  uom: string;
  remark: string | null;
  active: boolean;
  limits: LimitDTO[];
}

type LimitRow = { id: number; itemId: number; departments: string; basis: string; period: string; qty: { toNumber(): number } };

export function toRule(l: LimitRow): LimitRule {
  return {
    id: l.id, itemId: l.itemId, departments: parseDepartments(l.departments),
    basis: isLimitBasis(l.basis) ? l.basis : "pool", period: isLimitPeriod(l.period) ? l.period : "week", qty: l.qty.toNumber(),
  };
}

function toLimitDTO(l: LimitRow): LimitDTO {
  const r = toRule(l);
  return { id: r.id, departments: r.departments === ALL_DEPARTMENTS ? ALL_DEPARTMENTS : [...r.departments], departmentsLabel: departmentsLabel(r.departments), basis: r.basis, period: r.period, qty: r.qty };
}

/** The whole catalogue (active first, then by name), each item with its limits. */
export async function getCatalogue(opts: { activeOnly?: boolean } = {}): Promise<CatalogueItemDTO[]> {
  const items = await prisma.consumableItem.findMany({
    where: opts.activeOnly ? { active: true } : undefined,
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { limits: { orderBy: { id: "asc" } } },
  });
  return items.map((i) => ({ id: i.id, code: i.code, name: i.name, uom: i.uom, remark: i.remark, active: i.active, limits: i.limits.map(toLimitDTO) }));
}

/** The limit rules of active items (all of them, or the items given). */
export async function loadRules(itemIds?: number[]): Promise<LimitRule[]> {
  const rows = await prisma.consumableLimit.findMany({
    where: { item: { active: true }, ...(itemIds ? { itemId: { in: itemIds } } : {}) },
  });
  return rows.map(toRule);
}

const CAIRO_DAY = (d: Date) => factoryDayISO(d);

/** Catalogue hand-outs in factory days from..to, as the limits count them. */
export async function loadUses(fromISO: string, toISO: string, opts: { itemIds?: number[]; excludeIssueId?: number } = {}): Promise<LimitUse[]> {
  const gte = factoryDayStart(fromISO);
  const lt = factoryDayStart(addDaysISO(toISO, 1));
  if (!gte || !lt) return [];
  const rows = await prisma.consumableIssue.findMany({
    where: {
      deletedAt: null,
      itemId: opts.itemIds ? { in: opts.itemIds } : { not: null },
      issuedAt: { gte, lt },
      ...(opts.excludeIssueId ? { id: { not: opts.excludeIssueId } } : {}),
    },
    select: { itemId: true, department: true, workerId: true, issuedAt: true, qty: true },
  });
  return rows.map((r) => ({ itemId: r.itemId!, department: r.department, workerId: r.workerId, dayISO: CAIRO_DAY(r.issuedAt), qty: r.qty.toNumber() }));
}

/** Would this hand-out break a limit? The rules of the item that cover the
 *  department, each counted in its own window around the day. */
export async function checkIssueLimits(c: { itemId: number | null; department: string; workerId: number; qty: number; dayISO: string; excludeIssueId?: number }): Promise<LimitBreach[]> {
  if (c.itemId === null) return [];
  const rules = (await loadRules([c.itemId])).filter((r) => coversDepartment(r, c.department));
  const span = windowsSpan(rules, c.dayISO);
  if (!span) return [];
  const uses = await loadUses(span.from, span.to, { itemIds: [c.itemId], excludeIssueId: c.excludeIssueId });
  return checkAgainstLimits(rules, uses, { itemId: c.itemId, department: c.department, workerId: c.workerId, dayISO: c.dayISO, qty: c.qty });
}

export interface LimitHint {
  ruleId: number;
  label: string;
  used: number;
  limit: number;
  /** What is left before this hand-out; negative when the window is already over. */
  left: number;
}

/** The record form's hint: where each rule covering the item, department and
 *  worker stands today — "Welding TX · a week: 12 of 15 used". */
export async function limitHints(itemId: number, department: string, workerId: number | null, dayISO: string): Promise<LimitHint[]> {
  const rules = (await loadRules([itemId])).filter((r) => coversDepartment(r, department));
  const span = windowsSpan(rules, dayISO);
  if (!span) return [];
  const uses = await loadUses(span.from, span.to, { itemIds: [itemId] });
  return rules.map((r) => {
    const w = periodWindow(r.period, dayISO);
    let used = 0;
    for (const u of uses) {
      if (u.dayISO < w.from || u.dayISO > w.to || !coversDepartment(r, u.department)) continue;
      if (r.basis === "person" && u.workerId !== workerId) continue;
      used += u.qty;
    }
    used = Math.round(used * 1000) / 1000;
    const who = r.basis === "person" ? `${departmentsLabel(r.departments)}, per person` : departmentsLabel(r.departments);
    return { ruleId: r.id, label: `${who} · ${r.qty} ${PERIOD_LABEL[r.period]}`, used, limit: r.qty, left: Math.round((r.qty - used) * 1000) / 1000 };
  });
}

// ---------------------------------------------------------------- the dashboard

export interface AlarmRow {
  ruleId: number;
  itemId: number;
  item: string;
  code: string | null;
  uom: string;
  period: LimitPeriod;
  basis: LimitBasis;
  departmentsLabel: string;
  windowLabel: string;
  limit: number;
  used: number;
  ratio: number;
  /** Per-person rules: the workers over their number. */
  over: { name: string; empId: string; used: number }[];
  /** Per-person rules: who took the most. */
  top: { name: string; empId: string } | null;
}

export interface ExceedanceRow {
  item: string;
  code: string | null;
  period: LimitPeriod;
  basis: LimitBasis;
  departmentsLabel: string;
  windowLabel: string;
  windowFrom: string;
  limit: number;
  used: number;
  worker: { name: string; empId: string } | null;
}

export interface OverLimitIssue {
  id: number;
  dayISO: string;
  item: string;
  qty: number;
  department: string;
  worker: { name: string; empId: string };
  reason: string | null;
  note: string | null;
  recordedBy: string;
}

export interface LimitDashboard {
  /** Every rule in its current window (today's day, week, month, quarter). */
  board: AlarmRow[];
  /** Windows in the slicer's period that ended (or stand) over a limit. */
  exceedances: ExceedanceRow[];
  /** Hand-outs in the slicer's period recorded over a limit, with the reason. */
  overLimitIssues: OverLimitIssue[];
  /** Hand-outs in the period of items not in the catalogue — no limit counts them. */
  uncatalogued: number;
}

export async function getLimitDashboard(fromISO: string, toISO: string, todayISO: string): Promise<LimitDashboard> {
  const [items, rules] = await Promise.all([
    prisma.consumableItem.findMany({ select: { id: true, name: true, code: true, uom: true } }),
    loadRules(),
  ]);
  const itemOf = new Map(items.map((i) => [i.id, i]));

  // the uses both views need: today's widest window, and the slicer's period
  // widened to the whole windows it touches
  const cur = windowsSpan(rules, todayISO);
  const rangeFrom = rules.length ? [fromISO, ...rules.map((r) => periodWindow(r.period, fromISO).from)].sort()[0] : fromISO;
  const rangeTo = rules.length ? [toISO, ...rules.map((r) => periodWindow(r.period, toISO).to)].sort().at(-1)! : toISO;
  const spanFrom = [rangeFrom, cur?.from ?? rangeFrom].sort()[0];
  const spanTo = [rangeTo, cur?.to ?? rangeTo].sort().at(-1)!;

  const gte = factoryDayStart(fromISO)!;
  const lt = factoryDayStart(addDaysISO(toISO, 1))!;
  const [uses, flagged, uncatalogued] = await Promise.all([
    loadUses(spanFrom, spanTo),
    prisma.consumableIssue.findMany({
      where: { deletedAt: null, overLimit: true, issuedAt: { gte, lt } },
      orderBy: { issuedAt: "desc" },
      take: 200,
      select: { id: true, issuedAt: true, item: true, qty: true, department: true, overLimitReason: true, overLimitNote: true, recordedBy: true, worker: { select: { name: true, empId: true } } },
    }),
    prisma.consumableIssue.count({ where: { deletedAt: null, itemId: null, issuedAt: { gte, lt } } }),
  ]);

  const workerIds = [...new Set(uses.map((u) => u.workerId))];
  const workers = await prisma.worker.findMany({ where: { id: { in: workerIds } }, select: { id: true, name: true, empId: true } });
  const workerOf = new Map(workers.map((w) => [w.id, { name: w.name, empId: w.empId }]));
  const unknown = { name: "?", empId: "" };

  const board: AlarmRow[] = standings(rules, uses, todayISO).map((s) => {
    const it = itemOf.get(s.itemId);
    return {
      ruleId: s.ruleId, itemId: s.itemId, item: it?.name ?? "?", code: it?.code ?? null, uom: it?.uom ?? "",
      period: s.period, basis: s.basis, departmentsLabel: s.departmentsLabel, windowLabel: s.windowLabel,
      limit: s.limit, used: s.used, ratio: s.ratio,
      over: s.over.map((o) => ({ ...(workerOf.get(o.workerId) ?? unknown), used: o.used })),
      top: s.topWorkerId === null ? null : workerOf.get(s.topWorkerId) ?? null,
    };
  }).sort((a, b) => b.ratio - a.ratio || a.item.localeCompare(b.item));

  const ex: ExceedanceRow[] = exceedances(rules, uses.filter((u) => u.dayISO >= rangeFrom && u.dayISO <= rangeTo), fromISO, toISO).map((e) => {
    const it = itemOf.get(e.itemId);
    return {
      item: it?.name ?? "?", code: it?.code ?? null, period: e.period, basis: e.basis, departmentsLabel: e.departmentsLabel,
      windowLabel: e.windowLabel, windowFrom: e.window.from, limit: e.limit, used: e.used,
      worker: e.workerId === null ? null : workerOf.get(e.workerId) ?? unknown,
    };
  });

  return {
    board,
    exceedances: ex,
    overLimitIssues: flagged.map((f) => ({
      id: f.id, dayISO: CAIRO_DAY(f.issuedAt), item: f.item, qty: f.qty.toNumber(), department: f.department,
      worker: f.worker, reason: f.overLimitReason, note: f.overLimitNote, recordedBy: f.recordedBy,
    })),
    uncatalogued,
  };
}

// ---------------------------------------------------------------- the Limits view

export interface CatalogueChangeView {
  id: number;
  item: string;
  entity: "item" | "limit";
  action: "create" | "update" | "delete";
  /** What changed, in words. */
  text: string;
  by: string;
  atLabel: string;
}

function describeLimitJson(raw: unknown): string {
  const l = (raw ?? {}) as { departments?: string; basis?: string; period?: string; qty?: number };
  if (!l.departments) return "—";
  const d = departmentsLabel(parseDepartments(l.departments));
  const per = isLimitPeriod(l.period ?? "") ? PERIOD_LABEL[l.period as LimitPeriod] : l.period;
  return `${l.qty} ${per} · ${d}${l.basis === "person" ? " (per person)" : ""}`;
}

function describeItemJson(raw: unknown): string {
  const i = (raw ?? {}) as { code?: string | null; name?: string; uom?: string; remark?: string | null; active?: boolean };
  return [i.name, i.code, i.uom, i.remark ? `“${i.remark}”` : null, i.active === false ? "retired" : null].filter(Boolean).join(" · ");
}

/** The latest changes to the catalogue and its limits, newest first. */
export async function getCatalogueChanges(take = 60, labelOf: (d: Date) => string): Promise<CatalogueChangeView[]> {
  const rows = await prisma.consumableCatalogueChange.findMany({ orderBy: [{ at: "desc" }, { id: "desc" }], take });
  const names = new Map((await prisma.consumableItem.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.itemId))] } }, select: { id: true, name: true } })).map((i) => [i.id, i.name]));
  return rows.map((r) => {
    const entity = r.entity === "limit" ? "limit" : "item";
    const action = r.action === "create" ? "create" : r.action === "delete" ? "delete" : "update";
    const show = entity === "limit" ? describeLimitJson : describeItemJson;
    const text = action === "create" ? `added ${show(r.after)}` : action === "delete" ? `removed ${show(r.before)}` : `${show(r.before)} → ${show(r.after)}`;
    return { id: r.id, item: names.get(r.itemId) ?? "?", entity, action, text, by: r.by, atLabel: labelOf(r.at) };
  });
}

/** Where each rule stands right now, keyed by rule — the Limits view's bars. */
export async function getCurrentStandings(todayISO: string): Promise<Record<number, { used: number; limit: number; windowLabel: string; overWorkers: number }>> {
  const rules = await loadRules();
  const span = windowsSpan(rules, todayISO);
  if (!span) return {};
  const uses = await loadUses(span.from, span.to);
  return Object.fromEntries(standings(rules, uses, todayISO).map((s) => [s.ruleId, { used: s.used, limit: s.limit, windowLabel: s.windowLabel, overWorkers: s.over.length }]));
}
