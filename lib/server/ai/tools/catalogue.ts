import "server-only";
import type { ConsumableItem, ConsumableLimit, PowderScrap } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { getCustomDepartments } from "@/lib/server/consumables";
import { deleteConsumableLimit, saveCatalogueItem, saveConsumableLimit } from "@/app/consumables/catalogueActions";
import { createPowderScrap, deletePowderScrap, restorePowderScrap, updatePowderScrap } from "@/app/consumables/powderActions";
import { canEditIssue, cleanText, matchCatalogueItem, parseQty, resolveDepartment } from "@/lib/domain/consumables";
import {
  ALL_DEPARTMENTS, FABRICATION_SECTIONS, FAB_AND_WELD_SECTIONS, LIMIT_BASES, LIMIT_PERIODS, PERIOD_LABEL, departmentsLabel, parseDepartments, serializeDepartments,
  type LimitBasis, type LimitPeriod,
} from "@/lib/domain/consumableLimits";
import { POWDER_DEPARTMENTS, SCRAP_LIMITS, describeScrap, readScrapForm, type PowderDepartment, type ScrapSnapshot } from "@/lib/domain/powderScrap";
import { WORKER_SECTIONS, isWorkerSection } from "@/lib/domain/tanks";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { cell } from "@/lib/domain/aiActions";
import type { StringSchema } from "@/lib/domain/aiInput";
import { formOf, type WriteTool } from "./types";

// The CONSUMABLES catalogue, its limits and the powder scrap for the
// assistant — the Limits and Powder views of the Consumables tab, through
// their own actions as the person. The catalogue and the limits are kept by
// whoever records hand-outs (consumables.edit) and every change of theirs is
// in the catalogue's history; a weighing is corrected by its recorder or an
// admin, and taken off (or brought back) by an admin. Items and limits are
// found with query_database ("ConsumableItem", "ConsumableLimit",
// "PowderScrap").

const TABS = ["consumables"] as const;
const PERM = "consumables.edit";
const NO_RIGHT = "Keeping the consumables catalogue, its limits and the powder scrap needs the Consumables permission — the owner ticks it on Users & Permissions.";
const ADMIN_ONLY = "Taking a weighing off, and bringing one back, is an admin's.";

const BASIS_TEXT: Record<LimitBasis, string> = { each: "each department its own", pool: "shared by the departments", person: "per worker" };
const BASIS = { type: "string", enum: [...LIMIT_BASES], description: "each = every department named has the whole number to itself; pool = one number shared by them; person = the number per worker (× each department's workers)." } as const;
const PERIOD = { type: "string", enum: [...LIMIT_PERIODS], description: "month, bimonth (2 months), quarter, fourmonth, halfyear, year — whole calendar months." } as const;
const DEPARTMENTS = {
  type: "array",
  minItems: 1,
  maxItems: 40,
  items: { type: "string", minLength: 1, maxLength: 60 },
  description: `The departments the limit covers: worker sections (${WORKER_SECTIONS.map((s) => s.code).join(", ")}), a department the log already uses (Maintenance …), or ["*"] for all departments. "All fabrication" and "All fabrication and welding" name those groups.`,
} as const;

// ------------------------------------------------------------------ helpers

/** The departments a limit names, as the Limits view stores them — or what
 *  is wrong. A department has to be one the view offers: a worker section,
 *  or one the log or a limit already uses. */
export async function readLimitDepartments(list: readonly string[]): Promise<{ departments: string } | { error: string }> {
  const folded = list.map((d) => d.trim().replace(/\s+/g, " ").toLowerCase());
  if (folded.some((d) => d === "*" || d === "all" || d === "all departments")) return { departments: ALL_DEPARTMENTS };
  const [custom, limits] = await Promise.all([getCustomDepartments(), prisma.consumableLimit.findMany({ select: { departments: true }, distinct: ["departments"] })]);
  const known = new Set([...custom, ...limits.flatMap((l) => { const d = parseDepartments(l.departments); return d === ALL_DEPARTMENTS ? [] : d; }).filter((d) => !isWorkerSection(d))]);
  const keys: string[] = [];
  for (const [n, d] of list.entries()) {
    if (folded[n] === "all fabrication") { keys.push(...FABRICATION_SECTIONS); continue; }
    if (folded[n] === "all fabrication and welding") { keys.push(...FAB_AND_WELD_SECTIONS); continue; }
    const k = resolveDepartment(d, [...known]);
    if (!isWorkerSection(k) && !known.has(k)) {
      return { error: `"${d}" is not a worker section or a department the log uses. Sections: ${WORKER_SECTIONS.map((s) => s.code).join(", ")}${known.size ? `; departments: ${[...known].join(", ")}` : ""}.` };
    }
    keys.push(k);
  }
  return { departments: serializeDepartments(keys) };
}

interface LimitShape {
  departments: string;
  basis: string;
  period: string;
  qty: number;
}

export function limitText(l: LimitShape, uom: string): string {
  return `${l.qty} ${uom} ${PERIOD_LABEL[l.period as LimitPeriod] ?? l.period} — ${departmentsLabel(parseDepartments(l.departments))}, ${BASIS_TEXT[l.basis as LimitBasis] ?? l.basis}`;
}

const limitShape = (l: ConsumableLimit): LimitShape => ({ departments: l.departments, basis: l.basis, period: l.period, qty: l.qty.toNumber() });
/** A limit's departments as a tool's input names them. */
const departmentsInput = (csv: string): string[] => { const d = parseDepartments(csv); return d === ALL_DEPARTMENTS ? ["*"] : d; };

/** FormData carrying a limit's fields as the Limits form posts them. */
function limitForm(fields: Record<string, string | number | null | undefined>, l: LimitShape): FormData {
  const fd = formOf({ ...fields, basis: l.basis, period: l.period, qty: l.qty });
  const d = parseDepartments(l.departments);
  if (d === ALL_DEPARTMENTS) fd.set("allDepartments", "true");
  else for (const x of d) fd.append("departments", x);
  return fd;
}

/** A quantity by the Limits view's own rule (more than nothing, three decimals at most). */
function limitQty(q: number): number | { error: string } {
  const r = parseQty(String(q));
  return r.error ? { error: r.error } : r.qty!;
}

async function itemNamed(text: string): Promise<ConsumableItem | null> {
  const all = await prisma.consumableItem.findMany();
  return matchCatalogueItem(text, all);
}

// ------------------------------------------------------------------ items

interface ItemInput {
  id?: number;
  name?: string;
  code?: string | null;
  uom?: string;
  remark?: string | null;
  active?: boolean;
  limit?: { departments: string[]; basis: LimitBasis; period: LimitPeriod; qty: number };
}

interface ItemFields {
  name: string;
  code: string | null;
  uom: string;
  remark: string | null;
  active: boolean;
}

const itemFields = (i: ConsumableItem): ItemFields => ({ name: i.name, code: i.code, uom: i.uom, remark: i.remark, active: i.active });

/** The item as it will read, by the form's own cleaning: the name and code
 *  in one line, the code and the unit upper-case, PC when no unit is given. */
function mergedItem(prev: ItemFields | null, i: ItemInput): ItemFields {
  const opt = (v: string | null | undefined, was: string | null) => (v === undefined ? was : cleanText(v) || null);
  return {
    name: i.name !== undefined ? cleanText(i.name) : prev?.name ?? "",
    code: opt(i.code, prev?.code ?? null)?.toUpperCase() ?? null,
    uom: (i.uom !== undefined ? cleanText(i.uom).toUpperCase() : prev?.uom) || "PC",
    remark: opt(i.remark, prev?.remark ?? null),
    active: i.active ?? prev?.active ?? true,
  };
}

async function itemClash(next: ItemFields, id: number | null): Promise<string | null> {
  const clash = await prisma.consumableItem.findFirst({
    where: {
      ...(id ? { id: { not: id } } : {}),
      OR: [{ name: { equals: next.name, mode: "insensitive" } }, ...(next.code ? [{ code: { equals: next.code, mode: "insensitive" as const } }] : [])],
    },
    select: { name: true },
  });
  if (!clash) return null;
  return clash.name.toLowerCase() === next.name.toLowerCase() ? `${clash.name} is already in the catalogue.` : `The code ${next.code} is already ${clash.name}'s.`;
}

const ITEM_LABELS: [keyof ItemFields, string][] = [["name", "Name"], ["code", "Code"], ["uom", "Unit"], ["remark", "Remark"], ["active", "In the catalogue"]];

export const saveCatalogueItemTool: WriteTool<ItemInput> = {
  kind: "write",
  name: "save_catalogue_item",
  title: "Keep the consumables catalogue",
  description:
    "Add an item to the consumables catalogue (its name, code, unit and remark — optionally with its first limit), or change one by id: rename it, give it a code or a unit, or retire it (active false — it leaves the record form; items are never deleted). Only the fields given change.",
  area: "data",
  // a new item, a unit or a remark is small; a new name or code changes what
  // hand-outs match it, and retiring takes it off the form
  risk: (i) => (i.id === undefined || (i.name === undefined && i.code === undefined && i.active === undefined) ? "low" : "high"),
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1, description: "The item to change — leave out to add a new one." },
      name: { type: "string", minLength: 1, maxLength: 120 },
      code: { type: ["string", "null"], maxLength: 60, description: "The store's code, e.g. C-CON-DRB-04 (null clears it)." },
      uom: { type: "string", minLength: 1, maxLength: 12, description: "The unit: PC, KG, L, PAIR, BOX …" },
      remark: { type: ["string", "null"], maxLength: 200 },
      active: { type: "boolean", description: "false retires the item; true brings it back." },
      limit: {
        type: "object",
        description: "Only when adding: the item's first limit.",
        properties: { departments: DEPARTMENTS, basis: BASIS, period: PERIOD, qty: { type: "number", minimum: 0.001, maximum: 1000000 } },
        required: ["departments", "basis", "period", "qty"],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  parse(r) {
    const i = r as unknown as ItemInput;
    if (i.id === undefined && !i.name) return "Give the new item's name.";
    if (i.id !== undefined && i.limit) return "A limit goes on an item already there with save_consumable_limit.";
    if (i.id !== undefined && ["name", "code", "uom", "remark", "active"].every((k) => (i as Record<string, unknown>)[k] === undefined)) return "Say what changes on the item.";
    return i;
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const prev = i.id ? await prisma.consumableItem.findUnique({ where: { id: i.id } }) : null;
    if (i.id && !prev) return { error: `No catalogue item #${i.id}.` };
    const next = mergedItem(prev ? itemFields(prev) : null, i);
    if (!next.name) return { error: "The item needs a name." };
    const clash = await itemClash(next, prev?.id ?? null);
    if (clash) return { error: clash };
    let limitLine: string | null = null;
    if (i.limit) {
      const deps = await readLimitDepartments(i.limit.departments);
      if ("error" in deps) return deps;
      const qty = limitQty(i.limit.qty);
      if (typeof qty !== "number") return qty;
      limitLine = limitText({ departments: deps.departments, basis: i.limit.basis, period: i.limit.period, qty }, next.uom);
    }
    if (!prev) {
      return {
        title: `Add ${next.name} to the catalogue`,
        summary: `Add ${next.name}${next.code ? ` (${next.code})` : ""} to the consumables catalogue, counted in ${next.uom}${limitLine ? `, limited to ${limitLine}` : ""}.`,
        changes: [
          { label: next.name, before: "—", after: [next.code, next.uom, next.remark].filter(Boolean).join(" · ") },
          ...(limitLine ? [{ label: `Limit on ${next.name}`, before: "—", after: limitLine }] : []),
        ],
        snapshot: { adding: next.name, code: next.code },
      };
    }
    const was = itemFields(prev);
    const changes = ITEM_LABELS.filter(([k]) => was[k] !== next[k]).map(([k, l]) => ({ label: `${prev.name} — ${l}`, before: cell(was[k]), after: cell(next[k]) }));
    if (changes.length === 0) return { error: `${prev.name} reads so already.` };
    return {
      title: next.active ? `Change ${prev.name} in the catalogue` : `Retire ${prev.name}`,
      summary: `${next.active ? "Change" : "Retire"} ${prev.name} in the consumables catalogue: ${changes.map((c) => `${c.label.split(" — ")[1]} ${c.before} → ${c.after}`).join("; ")}.`,
      changes,
      snapshot: { id: prev.id, ...was },
    };
  },
  async execute(i) {
    const prev = i.id ? await prisma.consumableItem.findUnique({ where: { id: i.id } }) : null;
    if (i.id && !prev) return { ok: false, error: `No catalogue item #${i.id}.` };
    const next = mergedItem(prev ? itemFields(prev) : null, i);
    const base = { ...(prev ? { id: prev.id } : {}), name: next.name, code: next.code ?? "", uom: next.uom, remark: next.remark ?? "", active: String(next.active) };
    let fd = formOf(base);
    if (i.limit) {
      const deps = await readLimitDepartments(i.limit.departments);
      if ("error" in deps) return { ok: false, error: deps.error };
      fd = limitForm({ ...base, withLimit: "true" }, { departments: deps.departments, basis: i.limit.basis, period: i.limit.period, qty: i.limit.qty });
    }
    const r = await saveCatalogueItem(fd);
    if (!r.ok || !r.id) return { ok: false, error: r.error ?? "The catalogue refused it." };
    if (!prev) return { ok: true, message: `${next.name} is in the catalogue (#${r.id}).`, undo: { tool: "save_catalogue_item", input: { id: r.id, active: false } } };
    const was = itemFields(prev);
    return { ok: true, message: `${next.name} is saved in the catalogue.`, undo: { tool: "save_catalogue_item", input: { id: prev.id, ...was } } };
  },
};

// ------------------------------------------------------------------ limits

interface LimitInput {
  id?: number;
  itemId?: number;
  item?: string;
  departments?: string[];
  basis?: LimitBasis;
  period?: LimitPeriod;
  qty?: number;
}

interface PlannedLimit {
  item: ConsumableItem;
  prev: ConsumableLimit | null;
  next: LimitShape;
}

async function planLimit(i: LimitInput): Promise<PlannedLimit | { error: string }> {
  const prev = i.id ? await prisma.consumableLimit.findUnique({ where: { id: i.id } }) : null;
  if (i.id && !prev) return { error: `No consumables limit #${i.id}.` };
  const item = prev
    ? await prisma.consumableItem.findUnique({ where: { id: prev.itemId } })
    : i.itemId
      ? await prisma.consumableItem.findUnique({ where: { id: i.itemId } })
      : await itemNamed(i.item ?? "");
  if (!item) return { error: i.item ? `No catalogue item "${i.item}" — add it first with save_catalogue_item.` : "Name the catalogue item." };
  if (prev && ((i.itemId && i.itemId !== item.id) || (i.item && (await itemNamed(i.item))?.id !== item.id))) return { error: `Limit #${prev.id} is on ${item.name}, not on that item.` };
  const was = prev ? limitShape(prev) : null;
  let departments = was?.departments ?? "";
  if (i.departments) {
    const d = await readLimitDepartments(i.departments);
    if ("error" in d) return d;
    departments = d.departments;
  }
  const qty = i.qty !== undefined ? limitQty(i.qty) : was?.qty;
  if (qty === undefined) return { error: "Give the limit's quantity." };
  if (typeof qty !== "number") return qty;
  const next = { departments, basis: i.basis ?? was?.basis ?? "each", period: i.period ?? was?.period ?? "month", qty };
  if (!next.departments) return { error: "Name the departments the limit covers." };
  return { item, prev, next };
}

const sameLimit = (a: LimitShape, b: LimitShape) => a.departments === b.departments && a.basis === b.basis && a.period === b.period && a.qty === b.qty;

export const saveConsumableLimitTool: WriteTool<LimitInput> = {
  kind: "write",
  name: "save_consumable_limit",
  title: "Set a consumables limit",
  description:
    "Add a limit to a catalogue item — how much of it may be handed out, to which departments, over which period, and how the number counts — or change one by its id (only the fields given change). A hand-out over a limit then needs a reason, as on the tab.",
  area: "data",
  risk: "high",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1, description: "The limit to change — leave out to add one." },
      itemId: { type: "integer", minimum: 1 },
      item: { type: "string", minLength: 1, maxLength: 120, description: "The catalogue item's name or code (or give itemId)." },
      departments: DEPARTMENTS,
      basis: BASIS,
      period: PERIOD,
      qty: { type: "number", minimum: 0.001, maximum: 1000000, description: "How much, in the item's unit." },
    },
    additionalProperties: false,
  },
  parse(r) {
    const i = r as unknown as LimitInput;
    if (i.id === undefined) {
      if (i.itemId === undefined && !i.item) return "Name the catalogue item the limit is on.";
      if (!i.departments || !i.basis || !i.period || i.qty === undefined) return "A new limit needs its departments, basis, period and quantity.";
    } else if (i.departments === undefined && i.basis === undefined && i.period === undefined && i.qty === undefined) {
      return "Say what changes on the limit.";
    }
    return i;
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const p = await planLimit(i);
    if ("error" in p) return p;
    const was = p.prev ? limitShape(p.prev) : null;
    if (was && sameLimit(was, p.next)) return { error: `Limit #${p.prev!.id} reads so already.` };
    return {
      title: `${was ? "Change" : "Add"} a limit on ${p.item.name}`,
      summary: `${was ? "Change the" : "Add a"} limit on ${p.item.name}: ${limitText(p.next, p.item.uom)}.`,
      changes: [{ label: `Limit on ${p.item.name}`, before: was ? limitText(was, p.item.uom) : "—", after: limitText(p.next, p.item.uom) }],
      snapshot: { itemId: p.item.id, limit: was ? { id: p.prev!.id, ...was } : null },
    };
  },
  async execute(i) {
    const p = await planLimit(i);
    if ("error" in p) return { ok: false, error: p.error };
    const r = await saveConsumableLimit(limitForm({ ...(p.prev ? { id: p.prev.id } : {}), itemId: p.item.id }, p.next));
    if (!r.ok || !r.id) return { ok: false, error: r.error ?? "The limit was refused." };
    if (!p.prev) return { ok: true, message: `The limit on ${p.item.name} is set (#${r.id}).`, undo: { tool: "delete_consumable_limit", input: { id: r.id } } };
    const was = limitShape(p.prev);
    return { ok: true, message: `The limit on ${p.item.name} is changed.`, undo: { tool: "save_consumable_limit", input: { id: p.prev.id, departments: departmentsInput(was.departments), basis: was.basis, period: was.period, qty: was.qty } } };
  },
};

export const deleteConsumableLimitTool: WriteTool<{ id: number }> = {
  kind: "write",
  name: "delete_consumable_limit",
  title: "Remove a consumables limit",
  description: "Remove a limit from a catalogue item — hand-outs of it are no longer counted there. Undo sets it again.",
  area: "data",
  risk: "destructive",
  tabs: TABS,
  schema: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const l = await prisma.consumableLimit.findUnique({ where: { id: i.id }, include: { item: true } });
    if (!l) return { error: `No consumables limit #${i.id}.` };
    return {
      title: `Remove a limit on ${l.item.name}`,
      summary: `Remove the limit on ${l.item.name}: ${limitText(limitShape(l), l.item.uom)}.`,
      changes: [{ label: `Limit on ${l.item.name}`, before: limitText(limitShape(l), l.item.uom), after: "no limit" }],
      snapshot: { id: l.id, itemId: l.itemId, ...limitShape(l) },
    };
  },
  async execute(i) {
    const l = await prisma.consumableLimit.findUnique({ where: { id: i.id } });
    if (!l) return { ok: false, error: `No consumables limit #${i.id}.` };
    const r = await deleteConsumableLimit(formOf({ id: l.id }));
    if (!r.ok) return { ok: false, error: r.error };
    const was = limitShape(l);
    return { ok: true, message: "The limit is removed.", undo: { tool: "save_consumable_limit", input: { itemId: l.itemId, departments: departmentsInput(was.departments), basis: was.basis, period: was.period, qty: was.qty } } };
  },
};

// ------------------------------------------------------------------ powder scrap

const POWDER_DEPT = { type: "string", enum: [...POWDER_DEPARTMENTS], description: "PaintingTX = the transformer paint line, PaintingLV = the USS / LV panels' paint line." } as const;
const KG = { type: "number", minimum: 0.001, maximum: SCRAP_LIMITS.kgMax, description: "The powder thrown away, in kg (three decimals at most)." } as const;
const NOTES: StringSchema = { type: ["string", "null"], maxLength: SCRAP_LIMITS.notes };

const scrapOf = (s: PowderScrap): ScrapSnapshot => ({ dayISO: s.day.toISOString().slice(0, 10), department: s.department, kg: s.kg.toNumber(), notes: s.notes });

/** A weighing by the Powder view's own rules — or what is wrong. */
function checkScrap(f: ScrapSnapshot, todayISO: string): ScrapSnapshot | { error: string } {
  const form: Record<string, string> = { day: f.dayISO, department: f.department, kg: String(f.kg), notes: f.notes ?? "" };
  const r = readScrapForm((n) => form[n], todayISO, addDaysISO(todayISO, -SCRAP_LIMITS.daysBack));
  return r.error ? { error: r.error } : { dayISO: r.fields!.dayISO, department: r.fields!.department, kg: r.fields!.kg, notes: r.fields!.notes };
}

const scrapForm = (s: ScrapSnapshot, extra: Record<string, string | number> = {}) => formOf({ ...extra, day: s.dayISO, department: s.department, kg: s.kg, notes: s.notes ?? "" });

interface ScrapInput {
  day: string;
  department: PowderDepartment;
  kg: number;
  notes?: string | null;
}

export const recordPowderScrapTool: WriteTool<ScrapInput> = {
  kind: "write",
  name: "record_powder_scrap",
  title: "Record a powder scrap weighing",
  description: "Record the powder-coating powder a paint line threw away, weighed in kg, for a day (today or up to a year back) — the Powder view of the Consumables tab, set against the powder handed out to that line.",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: { type: "object", properties: { day: { type: "string", format: "date" }, department: POWDER_DEPT, kg: KG, notes: NOTES }, required: ["day", "department", "kg"], additionalProperties: false },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const s = checkScrap({ dayISO: i.day, department: i.department, kg: i.kg, notes: i.notes?.trim() || null }, ctx.todayISO);
    if ("error" in s) return s;
    return {
      title: `Powder scrap: ${s.kg} kg`,
      summary: `Record ${describeScrap(s)} as powder scrap.`,
      changes: [{ label: "Powder scrap", before: "—", after: describeScrap(s) }],
      snapshot: { add: s },
    };
  },
  async execute(i, ctx) {
    const s = checkScrap({ dayISO: i.day, department: i.department, kg: i.kg, notes: i.notes?.trim() || null }, ctx.todayISO);
    if ("error" in s) return { ok: false, error: s.error };
    const r = await createPowderScrap(scrapForm(s));
    if (!r.ok) return { ok: false, error: r.error };
    // taking a weighing off is the admin's, so only an admin's can be undone from the chat
    return { ok: true, message: `Recorded (weighing #${r.id}).`, ...(r.id && ctx.user.isAdmin ? { undo: { tool: "delete_powder_scrap", input: { id: r.id } } } : {}) };
  },
};

interface CorrectScrapInput {
  id: number;
  day?: string;
  department?: PowderDepartment;
  kg?: number;
  notes?: string | null;
}

async function liveScrap(id: number): Promise<PowderScrap | null> {
  const s = await prisma.powderScrap.findUnique({ where: { id } });
  return s && !s.deletedAt ? s : null;
}

export const correctPowderScrapTool: WriteTool<CorrectScrapInput> = {
  kind: "write",
  name: "correct_powder_scrap",
  title: "Correct a powder scrap weighing",
  description: "Correct a recorded powder scrap weighing — its day, paint line, kg or notes; only the fields given change. Only its recorder or an admin may.",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: { id: { type: "integer", minimum: 1 }, day: { type: "string", format: "date" }, department: POWDER_DEPT, kg: KG, notes: NOTES },
    required: ["id"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    const row = await liveScrap(i.id);
    if (!row) return { error: `No powder scrap weighing #${i.id}.` };
    if (!canEditIssue({ id: ctx.user.id, isAdmin: ctx.user.isAdmin, canRecord: hasPerm(ctx.user, PERM) }, row)) return { error: "Only the person who recorded the weighing, or an admin, can correct it." };
    const was = scrapOf(row);
    const next = checkScrap({ dayISO: i.day ?? was.dayISO, department: i.department ?? was.department, kg: i.kg ?? was.kg, notes: i.notes === undefined ? was.notes : i.notes?.trim() || null }, ctx.todayISO);
    if ("error" in next) return next;
    if (describeScrap(next) === describeScrap(was)) return { error: `Weighing #${row.id} reads so already.` };
    return {
      title: `Correct weighing #${row.id}`,
      summary: `Correct powder scrap weighing #${row.id}: ${describeScrap(was)} → ${describeScrap(next)}.`,
      changes: [{ label: `Weighing #${row.id}`, before: describeScrap(was), after: describeScrap(next) }],
      snapshot: { id: row.id, updatedAt: row.updatedAt.toISOString() },
    };
  },
  async execute(i, ctx) {
    const row = await liveScrap(i.id);
    if (!row) return { ok: false, error: `No powder scrap weighing #${i.id}.` };
    const was = scrapOf(row);
    const next = checkScrap({ dayISO: i.day ?? was.dayISO, department: i.department ?? was.department, kg: i.kg ?? was.kg, notes: i.notes === undefined ? was.notes : i.notes?.trim() || null }, ctx.todayISO);
    if ("error" in next) return { ok: false, error: next.error };
    const r = await updatePowderScrap(scrapForm(next, { id: row.id, version: row.updatedAt.toISOString() }));
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, message: `Weighing #${row.id} corrected.`, undo: { tool: "correct_powder_scrap", input: { id: row.id, day: was.dayISO, department: was.department, kg: was.kg, notes: was.notes } } };
  },
};

export const deletePowderScrapTool: WriteTool<{ id: number }> = {
  kind: "write",
  name: "delete_powder_scrap",
  title: "Take a powder scrap weighing off",
  description: "Admin only. Take a powder scrap weighing off the Powder view — it stays with its history, and Undo brings it back.",
  area: "data",
  risk: "destructive",
  tabs: TABS,
  schema: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false },
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: ADMIN_ONLY };
    const row = await liveScrap(i.id);
    if (!row) return { error: `No powder scrap weighing #${i.id}.` };
    return {
      title: `Take weighing #${row.id} off`,
      summary: `Take powder scrap weighing #${row.id} (${describeScrap(scrapOf(row))}) off the Powder view.`,
      changes: [{ label: `Weighing #${row.id}`, before: describeScrap(scrapOf(row)), after: "taken off" }],
      snapshot: { id: row.id, updatedAt: row.updatedAt.toISOString() },
    };
  },
  async execute(i) {
    const row = await liveScrap(i.id);
    if (!row) return { ok: false, error: `No powder scrap weighing #${i.id}.` };
    const r = await deletePowderScrap(formOf({ id: row.id, version: row.updatedAt.toISOString() }));
    return r.ok ? { ok: true, message: `Weighing #${row.id} is taken off.`, undo: { tool: "restore_powder_scrap", input: { id: row.id } } } : { ok: false, error: r.error };
  },
};

/** The undo of taking a weighing off — never offered to the model. */
export const restorePowderScrapTool: WriteTool<{ id: number }> = {
  kind: "write",
  name: "restore_powder_scrap",
  internal: true,
  title: "Bring a powder scrap weighing back",
  description: "Bring a weighing taken off back, as it was (the undo of taking it off).",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false },
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: ADMIN_ONLY };
    const row = await prisma.powderScrap.findUnique({ where: { id: i.id } });
    if (!row || !row.deletedAt) return { error: `Weighing #${i.id} is not taken off.` };
    return {
      title: `Bring weighing #${row.id} back`,
      summary: `Bring powder scrap weighing #${row.id} (${describeScrap(scrapOf(row))}) back.`,
      changes: [{ label: `Weighing #${row.id}`, before: "taken off", after: describeScrap(scrapOf(row)) }],
      snapshot: { id: row.id, updatedAt: row.updatedAt.toISOString() },
    };
  },
  async execute(i) {
    const row = await prisma.powderScrap.findUnique({ where: { id: i.id }, select: { updatedAt: true } });
    if (!row) return { ok: false, error: `No powder scrap weighing #${i.id}.` };
    const r = await restorePowderScrap(formOf({ id: i.id, version: row.updatedAt.toISOString() }));
    return r.ok ? { ok: true, message: `Weighing #${i.id} is back.` } : { ok: false, error: r.error };
  },
};

export const CATALOGUE_TOOLS = [
  saveCatalogueItemTool,
  saveConsumableLimitTool,
  deleteConsumableLimitTool,
  recordPowderScrapTool,
  correctPowderScrapTool,
  deletePowderScrapTool,
  restorePowderScrapTool,
] as const;
