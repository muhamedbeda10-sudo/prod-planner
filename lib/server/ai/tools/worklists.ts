import "server-only";
import type { AiFile } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { getSettings } from "@/lib/server/data";
import { getCutSheet } from "@/lib/server/execution";
import { orderLineError } from "@/lib/server/returns";
import { chatFile, uploadOf } from "@/lib/server/ai/files";
import {
  cancelReturn, readQueueNote, readReturn, readWorklistDates, reopenReturn, restoreQueueNote, restoreWorklistDates,
  type QueueNoteSnapshot, type WorklistDateSnapshot,
} from "@/lib/server/rowSnapshots";
import {
  addQueueNote, clearWorklistDate, deleteQueueNote, hideWorklistLine, redeliverReturn, returnToUpstream, setQueueNoteStatus, setWorklistDate,
  unhideWorklistLine, updateQueueNote,
} from "@/app/worklist/actions";
import { DEPTS, ITEMS, type Dept } from "@/lib/domain/constants";
import type { CascadeRow, CutTranche } from "@/lib/domain/execution";
import { deptPermKey } from "@/lib/domain/permissions";
import { TANK_ITEM } from "@/lib/domain/tanks";
import { cell } from "@/lib/domain/aiActions";
import { formOf, type ReadTool, type ToolCtx, type WriteTool } from "./types";

// The worklists for the assistant, beside the output it records elsewhere:
// the notes on a queue line (with photos from the chat), pieces sent back
// upstream and re-delivered, and — the admin's — the fabrication worklist's
// dates and the lines taken off a worklist. Each runs the worklist's own
// action as the person; an undo puts the rows back exactly
// (lib/server/rowSnapshots.ts) or runs the opposite action where that is
// exact (a note's text or status, a line hidden).

const TAB_OF: Record<Dept, string> = { Cut: "worklist.cut", Welding: "worklist.welding", Painting: "worklist.painting" };
const NOT_OPEN = "That worklist is not opened for you, so the assistant cannot work on it for you.";
const noKey = (dept: string) => `That needs ${dept}'s worklist key — the owner ticks it on Users & Permissions.`;
const ADMIN_ONLY = "Only an admin re-dates or takes lines off the worklists.";

const DEPT = { type: "string", enum: DEPTS, description: "The worklist: Cut (Fabrication), Welding, Painting." } as const;
const BOM = { type: "string", minLength: 1, maxLength: 80, description: "The line's BOM." } as const;
const ITEM = { type: "string", enum: ITEMS, description: "The component: CF, TC, TN, CB, AR, MB." } as const;
const ISO_OR_NONE = "^(\\d{4}-\\d{2}-\\d{2})?$";

const lineName = (l: { bom: string; mo?: string | null; item: string }) => `${l.mo || l.bom} ${l.item}`;

/** The worklist in sight and the department's key — what every note and return needs. */
function deptDenied(dept: string, ctx: ToolCtx): string | null {
  const tab = TAB_OF[dept as Dept];
  if (tab && ctx.hidden.has(tab)) return NOT_OPEN;
  return hasPerm(ctx.user, deptPermKey(dept)) ? null : noKey(dept);
}

// --------------------------------------------------------- the Cut sheet

const trancheOf = (r: CutTranche) => ({
  line: lineName(r), bom: r.bom, mo: r.mo, item: r.item, delivery: r.deliveryISO, cutDue: r.cutDueISO, qty: r.qty, remaining: r.remaining,
  // what set_worklist_date / clear_worklist_date name it by
  origISO: r.overrideOrigISO ?? r.deliveryISO,
  ...(r.overrideOrigISO !== undefined ? { redated: true } : {}),
});
const poolOf = (r: CascadeRow) => ({ line: lineName(r), bom: r.bom, mo: r.mo, item: r.item, pool: r.available, ...(r.remark ? { remark: r.remark } : {}) });
const LIST_MAX = 150;
const capped = <T, U>(rows: readonly T[], f: (r: T) => U) => ({ rows: rows.slice(0, LIST_MAX).map(f), ...(rows.length > LIST_MAX ? { more: rows.length - LIST_MAX } : {}) });

export const getCutWorklistTool: ReadTool<Record<string, never>> = {
  kind: "read",
  name: "get_cut_worklist",
  title: "Reading the fabrication worklist",
  description:
    "The fabrication (Cut) worklist as it stands today: the tranches due today, the overdue ones (each under its promised delivery date) and the ones an admin postponed — each with its origISO, what set_worklist_date and clear_worklist_date name it by (its original plan date, or \"\" for a part an admin scheduled out of a date-less line); the date-less lines with their open pool (pushed from the tracker, remarked this week, and the rest); the ⭐ priority lines, the ⏸ held orders and the lines an admin took off the list.",
  schema: { type: "object", properties: {}, additionalProperties: false },
  tabs: ["worklist.cut"],
  status: () => "Reading the fabrication worklist",
  async run(_i, ctx) {
    const s = await getCutSheet();
    return {
      ok: true,
      text: JSON.stringify({
        today: ctx.todayISO,
        dueToday: capped(s.dueNow, trancheOf),
        overdue: capped(s.overdue, trancheOf),
        postponed: capped(s.postponed, trancheOf),
        pushed: capped(s.pushed, poolOf),
        remarked: capped(s.remarked, poolOf),
        notDated: capped(s.unscheduled, poolOf),
        priority: s.priority.slice(0, LIST_MAX).map((p) => ({ line: lineName(p), bom: p.bom, mo: p.mo, item: p.item, remaining: p.remaining })),
        held: s.held.map((h) => ({ mo: h.mo, bom: h.bom })),
        hidden: s.hidden.map((h) => ({ line: lineName(h), bom: h.bom, mo: h.mo, item: h.item })),
      }),
    };
  },
};

// ------------------------------------------------------ worklist dates

interface DateInput {
  bom: string;
  mo: string;
  item: string;
  origISO: string;
  date: string;
  qty?: number;
  fromISO?: string;
}

interface LineInput {
  bom: string;
  mo: string;
  item: string;
}

const line = (i: LineInput) => ({ bom: i.bom, mo: i.mo, item: i.item });
const datesUndo = (i: LineInput, before: readonly WorklistDateSnapshot[]) => ({ tool: "restore_worklist_dates", input: { ...line(i), rows: JSON.stringify(before) } });
const dayOf = (r: WorklistDateSnapshot) => r.newDate.slice(0, 10);
const datesText = (rows: readonly WorklistDateSnapshot[]) =>
  rows.length ? rows.map((r) => `${r.origISO ? `${r.origISO} → ` : ""}${dayOf(r)}${r.qty !== null ? ` ×${cell(r.qty)}` : ""}`).join("; ") : "plan dates";

function dateAdminDenied(ctx: ToolCtx): string | null {
  if (ctx.hidden.has("worklist.cut")) return NOT_OPEN;
  return ctx.user.isAdmin ? null : ADMIN_ONLY;
}

export const setWorklistDateTool: WriteTool<DateInput> = {
  kind: "write",
  name: "set_worklist_date",
  title: "Re-date a fabrication worklist line",
  tabs: ["worklist.cut"],
  description:
    "An admin's re-dating on the fabrication worklist (the plan itself is never touched; clear_worklist_date reverts it). A plan tranche moves whole: origISO its original plan date, date the new one. A date-less line is scheduled in parts: origISO \"\", date the day and qty the pieces of its open pool (the same day again replaces that day's pieces); or fromISO the day of a part already scheduled, to move that part (its pieces with it) to date. Read get_cut_worklist first.",
  area: "tracker",
  // a part scheduled by quantity waits for the click; a whole tranche moved does not
  risk: (i) => (i.qty !== undefined ? "high" : "low"),
  schema: {
    type: "object",
    properties: {
      bom: BOM,
      mo: { type: "string", minLength: 1, maxLength: 80, description: "The line's MO." },
      item: ITEM,
      origISO: { type: "string", pattern: ISO_OR_NONE, description: "The line's original plan date as get_cut_worklist gives it, or \"\" for a date-less line." },
      date: { type: "string", format: "date", description: "The new date." },
      qty: { type: "number", minimum: 0.001, maximum: 100000, description: "Date-less line only: pieces of its pool for that date." },
      fromISO: { type: "string", format: "date", description: "Date-less line only: the day of the part to move." },
    },
    required: ["bom", "mo", "item", "origISO", "date"],
    additionalProperties: false,
  },
  parse(r) {
    const i = { ...(r as unknown as DateInput), bom: String(r.bom).trim(), mo: String(r.mo).trim(), item: String(r.item).toUpperCase() };
    if (i.origISO !== "") {
      if (i.qty !== undefined || i.fromISO !== undefined) return "A plan tranche moves whole — qty and fromISO are for a date-less line (origISO \"\").";
      if (i.origISO === i.date) return "That is its plan date already — clear_worklist_date puts it back there.";
    } else if ((i.qty === undefined) === (i.fromISO === undefined)) return "For a date-less line give qty (pieces to schedule) or fromISO (the part to move) — one of them.";
    if (i.fromISO !== undefined && i.fromISO === i.date) return "The part is on that day already.";
    return i;
  },
  async describe(i, ctx) {
    const denied = dateAdminDenied(ctx);
    if (denied) return { error: denied };
    const before = await readWorklistDates(i);
    const sheet = await getCutSheet();
    const same = (r: { bom: string; mo: string; item: string }) => r.bom === i.bom && r.mo === i.mo && r.item === i.item;
    let summary: string;
    if (i.origISO !== "") {
      const t = [...sheet.dueNow, ...sheet.overdue, ...sheet.postponed].find((r) => same(r) && (r.overrideOrigISO ?? r.deliveryISO) === i.origISO);
      if (!t) return { error: `${lineName(i)} has no open tranche promised for ${i.origISO} — read get_cut_worklist.` };
      summary = `Move ${lineName(i)}'s tranche promised for ${i.origISO} (${cell(t.remaining)} pcs open${t.deliveryISO !== i.origISO ? `, now under ${t.deliveryISO}` : ""}) to ${i.date}.`;
    } else if (i.fromISO !== undefined) {
      const part = before.find((r) => r.origISO === "" && dayOf(r) === i.fromISO);
      if (!part) return { error: `${lineName(i)} has no part scheduled on ${i.fromISO}.` };
      summary = `Move the part of ${lineName(i)} scheduled on ${i.fromISO}${part.qty !== null ? ` (${cell(part.qty)} pcs)` : ""} to ${i.date}${before.some((r) => r.origISO === "" && dayOf(r) === i.date) ? " — joining the part already there" : ""}.`;
    } else {
      const pool = [...sheet.pushed, ...sheet.remarked, ...sheet.unscheduled].find(same)?.available ?? 0;
      const there = before.find((r) => r.origISO === "" && dayOf(r) === i.date);
      const room = pool + (there?.qty ?? 0);
      if (i.qty! > room) return { error: `${lineName(i)} has ${cell(pool)} pcs not dated${there ? ` (and ${cell(there.qty ?? 0)} on ${i.date})` : ""} — not ${cell(i.qty!)}.` };
      summary = `Schedule ${cell(i.qty!)} pcs of ${lineName(i)}'s date-less pool on ${i.date}${there ? ` — replacing the ${cell(there.qty ?? 0)} pcs there` : ""}.`;
    }
    return {
      title: `${lineName(i)} → ${i.date}`,
      summary,
      changes: [{ label: `${lineName(i)} dates`, before: datesText(before), after: `${i.origISO || i.fromISO || "pool"} → ${i.date}${i.qty !== undefined ? ` ×${cell(i.qty)}` : ""}` }],
      snapshot: before,
    };
  },
  async execute(i) {
    const before = await readWorklistDates(i);
    const r = await setWorklistDate(formOf({ ...line(i), origISO: i.origISO, date: i.date, qty: i.qty, fromISO: i.fromISO }));
    return r.ok ? { ok: true, message: `${lineName(i)} is dated ${i.date}.`, undo: datesUndo(i, before) } : { ok: false, error: r.error };
  },
};

interface ClearDateInput extends LineInput {
  origISO: string;
  date?: string;
}

export const clearWorklistDateTool: WriteTool<ClearDateInput> = {
  kind: "write",
  name: "clear_worklist_date",
  title: "Revert a fabrication line's date",
  tabs: ["worklist.cut"],
  description:
    "Revert an admin's re-dating on the fabrication worklist: a moved plan tranche (origISO its original plan date) goes back to that date; a part scheduled out of a date-less line (origISO \"\", date the day it is on — leave date out for every part) goes back into the pool.",
  area: "tracker",
  risk: "low",
  schema: {
    type: "object",
    properties: {
      bom: BOM,
      mo: { type: "string", minLength: 1, maxLength: 80 },
      item: ITEM,
      origISO: { type: "string", pattern: ISO_OR_NONE, description: "The original plan date, or \"\" for a date-less line's parts." },
      date: { type: "string", format: "date", description: "Date-less line only: the day of the part to put back." },
    },
    required: ["bom", "mo", "item", "origISO"],
    additionalProperties: false,
  },
  parse(r) {
    const i = { ...(r as unknown as ClearDateInput), bom: String(r.bom).trim(), mo: String(r.mo).trim(), item: String(r.item).toUpperCase() };
    if (i.origISO !== "" && i.date !== undefined) return "A moved plan tranche goes back whole — date is for a date-less line's part.";
    return i;
  },
  async describe(i, ctx) {
    const denied = dateAdminDenied(ctx);
    if (denied) return { error: denied };
    const before = await readWorklistDates(i);
    const going = before.filter((r) => r.origISO === i.origISO && (i.origISO !== "" || i.date === undefined || dayOf(r) === i.date));
    if (going.length === 0) return { error: `${lineName(i)} has no such date set by an admin — read get_cut_worklist.` };
    return {
      title: `${lineName(i)}: ${i.origISO ? `back to ${i.origISO}` : "back to the pool"}`,
      summary: i.origISO
        ? `Put ${lineName(i)}'s tranche back on its plan date ${i.origISO} (now ${dayOf(going[0])}).`
        : `Put ${going.length === 1 ? `the part of ${lineName(i)} on ${dayOf(going[0])}` : `${going.length} scheduled parts of ${lineName(i)}`} back into its date-less pool.`,
      changes: going.map((r) => ({ label: lineName(i), before: `${r.origISO ? `${r.origISO} → ` : ""}${dayOf(r)}${r.qty !== null ? ` ×${cell(r.qty)}` : ""}`, after: r.origISO ? r.origISO : "pool" })),
      snapshot: before,
    };
  },
  async execute(i) {
    const before = await readWorklistDates(i);
    const r = await clearWorklistDate(formOf({ ...line(i), origISO: i.origISO, date: i.date }));
    return r.ok ? { ok: true, message: `${lineName(i)}'s date is reverted.`, undo: datesUndo(i, before) } : { ok: false, error: r.error };
  },
};

interface RestoreDatesInput extends LineInput {
  rows: string;
}

function datesState(text: string): WorklistDateSnapshot[] | string {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return "The earlier dates could not be read.";
  }
  const ok = Array.isArray(v) && v.every((r) => r && typeof r === "object" && Number.isInteger(r.id) && typeof r.origISO === "string" && typeof r.newDate === "string" && typeof r.createdAt === "string");
  return ok ? (v as WorklistDateSnapshot[]) : "The earlier dates are not whole.";
}

/** The undo of a re-dating — never offered to the model. */
export const restoreWorklistDatesTool: WriteTool<RestoreDatesInput> = {
  kind: "write",
  name: "restore_worklist_dates",
  internal: true,
  title: "Put a line's dates back",
  description: "Put a fabrication line's admin dates back exactly as they were (the undo of a re-dating).",
  area: "tracker",
  risk: "low",
  schema: {
    type: "object",
    properties: { bom: BOM, mo: { type: "string", minLength: 1, maxLength: 80 }, item: ITEM, rows: { type: "string", minLength: 2, maxLength: 100_000 } },
    required: ["bom", "mo", "item", "rows"],
    additionalProperties: false,
  },
  parse(r) {
    const i = r as unknown as RestoreDatesInput;
    const s = datesState(i.rows);
    return typeof s === "string" ? s : i;
  },
  async describe(i, ctx) {
    if (!ctx.user.isAdmin) return { error: ADMIN_ONLY };
    const then = datesState(i.rows) as WorklistDateSnapshot[];
    const now = await readWorklistDates(i);
    return {
      title: `Put ${lineName(i)}'s dates back`,
      summary: `Put ${lineName(i)}'s worklist dates back as they were.`,
      changes: [{ label: `${lineName(i)} dates`, before: datesText(now), after: datesText(then) }],
      snapshot: now,
    };
  },
  async execute(i) {
    const r = await restoreWorklistDates(i, datesState(i.rows) as WorklistDateSnapshot[]);
    return r.ok ? { ok: true, message: `${lineName(i)}'s dates are back as they were.` } : { ok: false, error: r.error };
  },
};

// --------------------------------------------------- lines off a worklist

interface HideInput {
  dept: Dept;
  bom: string;
  mo: string;
  item: string;
}

const HIDE_SCHEMA = {
  type: "object",
  properties: {
    dept: DEPT,
    bom: BOM,
    mo: { type: "string", maxLength: 80, description: "The line's MO (\"\" for a BOM-level line)." },
    item: ITEM,
  },
  required: ["dept", "bom", "mo", "item"],
  additionalProperties: false,
} as const;

const parseHide = (r: Record<string, unknown>): HideInput => ({ dept: r.dept as Dept, bom: String(r.bom).trim(), mo: String(r.mo ?? "").trim(), item: String(r.item).toUpperCase() });

async function hideCheck(i: HideInput, ctx: ToolCtx, hide: boolean): Promise<{ error: string } | { hidden: boolean }> {
  if (ctx.hidden.has(TAB_OF[i.dept])) return { error: NOT_OPEN };
  if (!ctx.user.isAdmin) return { error: ADMIN_ONLY };
  if (i.mo) {
    const o = await prisma.masterOrder.findUnique({ where: { mo: i.mo }, select: { bom: true } });
    if (!o) return { error: `${i.mo} is not in the orders registry.` };
    if (o.bom !== i.bom) return { error: `${i.mo} is BOM ${o.bom}, not ${i.bom}.` };
  }
  const hidden = (await prisma.worklistLineHide.count({ where: { dept: i.dept, bom: i.bom, mo: i.mo, item: i.item } })) > 0;
  if (hidden === hide) return { error: `${lineName(i)} is ${hide ? "off" : "on"} the ${i.dept} worklist already.` };
  return { hidden };
}

export const hideWorklistLineTool: WriteTool<HideInput> = {
  kind: "write",
  name: "hide_worklist_line",
  title: "Take a line off a worklist",
  description: "An admin's ✕ on a worklist line: it leaves that department's worklist (plans, the Daily log and the registry untouched) until it is brought back with unhide_worklist_line.",
  area: "tracker",
  risk: "low",
  schema: HIDE_SCHEMA,
  parse: parseHide,
  async describe(i, ctx) {
    const c = await hideCheck(i, ctx, true);
    if ("error" in c) return c;
    return {
      title: `Take ${lineName(i)} off the ${i.dept} worklist`,
      summary: `Take ${lineName(i)} off the ${i.dept} worklist — nothing else changes, and it can be brought back.`,
      changes: [{ label: `${lineName(i)} on ${i.dept}`, before: "on the worklist", after: "taken off" }],
      snapshot: c,
    };
  },
  async execute(i) {
    const r = await hideWorklistLine(formOf({ ...i }));
    return r.ok ? { ok: true, message: `${lineName(i)} is off the ${i.dept} worklist.`, undo: { tool: "unhide_worklist_line", input: { ...i } } } : { ok: false, error: r.error };
  },
};

export const unhideWorklistLineTool: WriteTool<HideInput> = {
  kind: "write",
  name: "unhide_worklist_line",
  title: "Bring a line back to a worklist",
  description: "Bring a line an admin took off a worklist back onto it.",
  area: "tracker",
  risk: "low",
  schema: HIDE_SCHEMA,
  parse: parseHide,
  async describe(i, ctx) {
    const c = await hideCheck(i, ctx, false);
    if ("error" in c) return c;
    return {
      title: `Bring ${lineName(i)} back to the ${i.dept} worklist`,
      summary: `Bring ${lineName(i)} back onto the ${i.dept} worklist.`,
      changes: [{ label: `${lineName(i)} on ${i.dept}`, before: "taken off", after: "on the worklist" }],
      snapshot: c,
    };
  },
  async execute(i) {
    const r = await unhideWorklistLine(formOf({ ...i }));
    return r.ok ? { ok: true, message: `${lineName(i)} is back on the ${i.dept} worklist.`, undo: { tool: "hide_worklist_line", input: { ...i } } } : { ok: false, error: r.error };
  },
};

// ------------------------------------------------------------ queue notes

const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

interface NoteInput {
  dept: Dept;
  bom: string;
  mo?: string;
  item: string;
  text?: string;
  photos?: number[];
}

/** The chat's photos for a note: each the person's own, in this chat, an image. */
async function notePhotos(ids: readonly number[], ctx: ToolCtx): Promise<AiFile[] | { error: string }> {
  const out: AiFile[] = [];
  for (const id of ids) {
    const f = await chatFile(ctx, id);
    if ("error" in f) return f;
    if (f.kind !== "image" || !f.type.startsWith("image/")) return { error: `File #${id} (${f.name}) is not a photo.` };
    if (f.size > MAX_PHOTO_BYTES) return { error: `${f.name} is larger than 10 MB.` };
    out.push(f);
  }
  return out;
}

export const addQueueNoteTool: WriteTool<NoteInput> = {
  kind: "write",
  name: "add_queue_note",
  title: "Add a note to a worklist line",
  description:
    "Add a note to a worklist line, as the worklist's 📝 does: what is wrong or missing on an order (missing parts, a defect, a disputed \"done\"), in the person's words, with up to 6 photos attached in this chat (their file numbers). The department's worklist shows it until it is resolved. Undo deletes it.",
  area: "tracker",
  risk: "low",
  schema: {
    type: "object",
    properties: {
      dept: { ...DEPT, description: "The worklist the note is raised on." },
      bom: BOM,
      mo: { type: "string", maxLength: 80, description: "The line's MO (leave out for a BOM-level line)." },
      item: ITEM,
      text: { type: "string", maxLength: 2000, description: "The note." },
      photos: { type: "array", items: { type: "integer", minimum: 1 }, maxItems: MAX_PHOTOS, description: "Photos attached in this chat, by file number." },
    },
    required: ["dept", "bom", "item"],
    additionalProperties: false,
  },
  parse(r) {
    const text = String(r.text ?? "").trim();
    const photos = [...new Set((r.photos as number[] | undefined) ?? [])];
    if (!text && photos.length === 0) return "A note needs its text or a photo.";
    return { dept: r.dept as Dept, bom: String(r.bom).trim(), mo: String(r.mo ?? "").trim(), item: String(r.item).toUpperCase(), ...(text ? { text } : {}), ...(photos.length ? { photos } : {}) };
  },
  async describe(i, ctx) {
    const denied = deptDenied(i.dept, ctx);
    if (denied) return { error: denied };
    if (i.mo) {
      const o = await prisma.masterOrder.findUnique({ where: { mo: i.mo }, select: { bom: true } });
      if (!o) return { error: `${i.mo} is not in the orders registry.` };
      if (o.bom !== i.bom) return { error: `${i.mo} is BOM ${o.bom}, not ${i.bom}.` };
    }
    const photos = await notePhotos(i.photos ?? [], ctx);
    if ("error" in photos) return photos;
    return {
      title: `📝 ${lineName(i)} on ${i.dept}`,
      summary: `Add a note to ${lineName(i)} on the ${i.dept} worklist${i.text ? `: "${i.text}"` : ""}${photos.length ? ` with ${photos.length} photo(s) (${photos.map((f) => f.name).join(", ")})` : ""}.`,
      changes: [{ label: `${lineName(i)} notes`, before: "—", after: `${i.text ?? ""}${photos.length ? ` 📷×${photos.length}` : ""}`.trim() }],
      snapshot: { photos: photos.map((f) => f.sha256) },
    };
  },
  async execute(i, ctx) {
    const photos = await notePhotos(i.photos ?? [], ctx);
    if ("error" in photos) return { ok: false, error: photos.error };
    const fd = formOf({ dept: i.dept, bom: i.bom, mo: i.mo ?? "", item: i.item, text: i.text ?? "" });
    for (const f of photos) fd.append("photos", uploadOf(f));
    const r = await addQueueNote(fd);
    if (!r.ok || !r.id) return { ok: false, error: r.error ?? "The note was not saved." };
    return { ok: true, message: `The note is on ${lineName(i)} (${i.dept}).`, undo: { tool: "delete_queue_note", input: { id: r.id } } };
  },
};

async function theNote(id: number, ctx: ToolCtx): Promise<QueueNoteSnapshot | { error: string }> {
  const n = await readQueueNote(id);
  if (!n) return { error: `No queue note #${id}.` };
  const denied = deptDenied(n.dept, ctx);
  return denied ? { error: denied } : n;
}

const photoCount = (n: QueueNoteSnapshot) => (n.photos ? (JSON.parse(n.photos) as unknown[]).length : 0);

export const updateQueueNoteTool: WriteTool<{ id: number; text: string }> = {
  kind: "write",
  name: "update_queue_note",
  title: "Change a note's text",
  description: "Change the text of a note on a worklist line (its photos stay). Undo puts the old text back.",
  area: "tracker",
  risk: "low",
  schema: {
    type: "object",
    properties: { id: { type: "integer", minimum: 1 }, text: { type: "string", maxLength: 2000, description: "The new text (\"\" only for a note with photos)." } },
    required: ["id", "text"],
    additionalProperties: false,
  },
  parse: (r) => ({ id: r.id as number, text: String(r.text).trim() }),
  async describe(i, ctx) {
    const n = await theNote(i.id, ctx);
    if ("error" in n) return n;
    if (n.text === i.text) return { error: "The note reads so already." };
    if (!i.text && photoCount(n) === 0) return { error: "A note needs its text or a photo — delete it instead." };
    return {
      title: `Change note #${n.id} on ${lineName(n)}`,
      summary: `Change the note on ${lineName(n)} (${n.dept}) to "${i.text}".`,
      changes: [{ label: `Note #${n.id}`, before: n.text || "—", after: i.text || "—" }],
      snapshot: n,
    };
  },
  async execute(i) {
    const before = await readQueueNote(i.id);
    if (!before) return { ok: false, error: `No queue note #${i.id}.` };
    const r = await updateQueueNote(formOf({ id: i.id, text: i.text }));
    return r.ok ? { ok: true, message: `Note #${i.id} is changed.`, undo: { tool: "update_queue_note", input: { id: i.id, text: before.text } } } : { ok: false, error: r.error };
  },
};

export const setQueueNoteStatusTool: WriteTool<{ id: number; status: "open" | "resolved" }> = {
  kind: "write",
  name: "set_queue_note_status",
  title: "Resolve or reopen a note",
  description: "Mark a note on a worklist line resolved once the issue is checked, or open it again. Undo puts it back.",
  area: "tracker",
  risk: "low",
  schema: {
    type: "object",
    properties: { id: { type: "integer", minimum: 1 }, status: { type: "string", enum: ["open", "resolved"] } },
    required: ["id", "status"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    const n = await theNote(i.id, ctx);
    if ("error" in n) return n;
    if (n.status === i.status) return { error: `Note #${n.id} is ${i.status} already.` };
    return {
      title: `${i.status === "resolved" ? "Resolve" : "Reopen"} note #${n.id} on ${lineName(n)}`,
      summary: `${i.status === "resolved" ? "Resolve" : "Reopen"} the note on ${lineName(n)} (${n.dept}): "${n.text}".`,
      changes: [{ label: `Note #${n.id}`, before: n.status, after: i.status }],
      snapshot: n,
    };
  },
  async execute(i) {
    const before = await readQueueNote(i.id);
    if (!before) return { ok: false, error: `No queue note #${i.id}.` };
    const r = await setQueueNoteStatus(formOf({ id: i.id, status: i.status }));
    return r.ok ? { ok: true, message: `Note #${i.id} is ${i.status}.`, undo: { tool: "set_queue_note_status", input: { id: i.id, status: before.status } } } : { ok: false, error: r.error };
  },
};

export const deleteQueueNoteTool: WriteTool<{ id: number }> = {
  kind: "write",
  name: "delete_queue_note",
  title: "Delete a note",
  description: "Delete a note on a worklist line for good, its photos with it. Undo brings the note's text back, not its photos.",
  area: "tracker",
  risk: "destructive",
  schema: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false },
  async describe(i, ctx) {
    const n = await theNote(i.id, ctx);
    if ("error" in n) return n;
    const photos = photoCount(n);
    return {
      title: `Delete note #${n.id} on ${lineName(n)}`,
      summary: `Delete the note on ${lineName(n)} (${n.dept}): "${n.text}"${photos ? ` — its ${photos} photo(s) are deleted with it, for good` : ""}.`,
      changes: [{ label: `Note #${n.id}`, before: `${n.text || "—"}${photos ? ` 📷×${photos}` : ""}`, after: "deleted" }],
      snapshot: n,
    };
  },
  async execute(i) {
    const before = await readQueueNote(i.id);
    if (!before) return { ok: false, error: `No queue note #${i.id}.` };
    const r = await deleteQueueNote(formOf({ id: i.id }));
    return r.ok ? { ok: true, message: `Note #${i.id} is deleted.`, undo: { tool: "restore_queue_note", input: { id: i.id, state: JSON.stringify(before) } } } : { ok: false, error: r.error };
  },
};

function noteState(i: { id: number; state: string }): QueueNoteSnapshot | string {
  let v: unknown;
  try {
    v = JSON.parse(i.state);
  } catch {
    return "The earlier note could not be read.";
  }
  const n = v as Partial<QueueNoteSnapshot> | null;
  const ok = !!n && n.id === i.id && typeof n.dept === "string" && typeof n.bom === "string" && typeof n.item === "string" && typeof n.text === "string" && typeof n.status === "string" && typeof n.createdAt === "string";
  return ok ? (n as QueueNoteSnapshot) : "The earlier note is not whole.";
}

/** The undo of a note's deletion — never offered to the model. */
export const restoreQueueNoteTool: WriteTool<{ id: number; state: string }> = {
  kind: "write",
  name: "restore_queue_note",
  internal: true,
  title: "Put a note back",
  description: "Put a deleted note on a worklist line back (the undo of its deletion).",
  area: "tracker",
  risk: "low",
  schema: { type: "object", properties: { id: { type: "integer", minimum: 1 }, state: { type: "string", minLength: 2, maxLength: 20_000 } }, required: ["id", "state"], additionalProperties: false },
  parse(r) {
    const i = { id: r.id as number, state: r.state as string };
    const s = noteState(i);
    return typeof s === "string" ? s : i;
  },
  async describe(i, ctx) {
    const then = noteState(i) as QueueNoteSnapshot;
    if (!hasPerm(ctx.user, deptPermKey(then.dept))) return { error: noKey(then.dept) };
    const now = await readQueueNote(i.id);
    return {
      title: `Put note #${i.id} back`,
      summary: `Put the note on ${lineName(then)} (${then.dept}) back: "${then.text}"${now ? "" : photoCount(then) ? " — without its photos, deleted with it" : ""}.`,
      changes: [{ label: `Note #${i.id}`, before: now ? now.text || "—" : "deleted", after: then.text || "—" }],
      snapshot: now,
    };
  },
  async execute(i) {
    const r = await restoreQueueNote(noteState(i) as QueueNoteSnapshot);
    return r.ok ? { ok: true, message: `Note #${i.id} is back.` } : { ok: false, error: r.error };
  },
};

// ---------------------------------------------------------------- returns

const UPSTREAM: Record<string, Dept> = { Welding: "Cut", Painting: "Welding" };

interface ReturnInput {
  fromDept: "Welding" | "Painting";
  bom: string;
  mo?: string;
  item: string;
  qty: number;
  reason: string;
}

/** What is waiting in the department's queue: what upstream made less what it took. */
async function waiting(i: ReturnInput): Promise<{ up: number; here: number }> {
  const scope = i.mo ? { mo: i.mo, item: i.item } : { bom: i.bom, item: i.item };
  const sums = await prisma.handoverEntry.groupBy({ by: ["dept"], where: scope, _sum: { qty: true } });
  const tot = (d: string) => sums.find((s) => s.dept === d)?._sum.qty ?? 0;
  return { up: tot(UPSTREAM[i.fromDept]), here: tot(i.fromDept) };
}

export const returnToUpstreamTool: WriteTool<ReturnInput> = {
  kind: "write",
  name: "return_to_upstream",
  title: "Send pieces back upstream",
  description:
    "Send pieces of a line BACK to the department before (Welding → Cut, Painting → Welding) when \"finished\" pieces turn out incomplete, as the worklist's ↩ does: they come off the upstream department's output and wait in its Returns list, with the reason, until re-delivered (redeliver_return). Only what waits in the queue can go back. Undo cancels the return.",
  area: "tracker",
  risk: "high",
  schema: {
    type: "object",
    properties: {
      fromDept: { type: "string", enum: ["Welding", "Painting"], description: "The department sending them back." },
      bom: BOM,
      mo: { type: "string", maxLength: 80, description: "The line's MO (leave out for a BOM-level line)." },
      item: ITEM,
      qty: { type: "number", minimum: 0.001, maximum: 100000 },
      reason: { type: "string", minLength: 1, maxLength: 500, description: "What is wrong — what the upstream department has to fix." },
    },
    required: ["fromDept", "bom", "item", "qty", "reason"],
    additionalProperties: false,
  },
  parse(r) {
    const reason = String(r.reason).trim();
    if (!reason) return "Write the reason — the upstream department needs to know what to fix.";
    const mo = String(r.mo ?? "").trim();
    return { fromDept: r.fromDept as ReturnInput["fromDept"], bom: String(r.bom).trim(), ...(mo ? { mo } : {}), item: String(r.item).toUpperCase(), qty: r.qty as number, reason };
  },
  async describe(i, ctx) {
    const denied = deptDenied(i.fromDept, ctx);
    if (denied) return { error: denied };
    if (i.item === TANK_ITEM && i.fromDept === "Painting" && (await getSettings()).tankTracking) {
      return { error: "A tank goes back to welding by its serial — use send_tank_back_to_welding." };
    }
    const lineError = await orderLineError(i.bom, i.mo ?? null);
    if (lineError) return { error: lineError };
    const w = await waiting(i);
    const free = Math.max(0, w.up - w.here);
    if (i.qty > free) return { error: `Only ${cell(free)} pcs of ${lineName(i)} wait in the ${i.fromDept} queue — cannot send back ${cell(i.qty)}.` };
    const to = UPSTREAM[i.fromDept];
    return {
      title: `↩ ${cell(i.qty)} × ${lineName(i)} back to ${to}`,
      summary: `Send ${cell(i.qty)} pcs of ${lineName(i)} back from ${i.fromDept} to ${to}: "${i.reason}". They come off ${to}'s output and wait in its Returns list until re-delivered.`,
      changes: [{ label: `${lineName(i)} ${to} output`, before: cell(w.up), after: cell(w.up - i.qty) }],
      snapshot: w,
    };
  },
  async execute(i) {
    const r = await returnToUpstream(formOf({ fromDept: i.fromDept, bom: i.bom, mo: i.mo ?? "", item: i.item, qty: i.qty, reason: i.reason }));
    if (!r.ok || !r.id) return { ok: false, error: r.error ?? "Nothing was sent back." };
    return { ok: true, message: `${cell(i.qty)} pcs of ${lineName(i)} are back with ${UPSTREAM[i.fromDept]} (return #${r.id}).`, undo: { tool: "cancel_return", input: { id: r.id } } };
  },
};

async function theReturn(id: number, ctx: ToolCtx, dept: "fromDept" | "toDept") {
  const ret = await readReturn(id);
  if (!ret) return { error: `No return #${id}.` };
  const denied = deptDenied(ret[dept], ctx);
  return denied ? { error: denied } : ret;
}

/** The undo of sending pieces back — never offered to the model. */
export const cancelReturnTool: WriteTool<{ id: number }> = {
  kind: "write",
  name: "cancel_return",
  internal: true,
  title: "Cancel a return",
  description: "Cancel pieces sent back upstream while they still wait in its Returns list (the undo of return_to_upstream).",
  area: "tracker",
  risk: "low",
  schema: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false },
  async describe(i, ctx) {
    const ret = await theReturn(i.id, ctx, "fromDept");
    if ("error" in ret) return ret;
    if (ret.status !== "open") return { error: "Those pieces were re-delivered since — the return stays." };
    return {
      title: `Cancel return #${ret.id}`,
      summary: `Cancel the return of ${cell(ret.qty)} pcs of ${lineName(ret)} from ${ret.fromDept} to ${ret.toDept} — they go back on ${ret.toDept}'s output.`,
      changes: [{ label: `Return #${ret.id}`, before: `${cell(ret.qty)} pcs open`, after: "cancelled" }],
      snapshot: ret,
    };
  },
  async execute(i) {
    const r = await cancelReturn(i.id);
    return r.ok ? { ok: true, message: `Return #${i.id} is cancelled.` } : { ok: false, error: r.error };
  },
};

export const redeliverReturnTool: WriteTool<{ id: number }> = {
  kind: "write",
  name: "redeliver_return",
  title: "Re-deliver returned pieces",
  description: "The pieces sent back are fixed: they go back on the upstream department's output, and on to the next department at once; the return is closed. As the Returns list's ✓ does. Undo opens the return again.",
  area: "tracker",
  risk: "high",
  schema: { type: "object", properties: { id: { type: "integer", minimum: 1, description: "The return's number (ReturnEntry.id)." } }, required: ["id"], additionalProperties: false },
  async describe(i, ctx) {
    const ret = await theReturn(i.id, ctx, "toDept");
    if ("error" in ret) return ret;
    if (ret.status !== "open") return { error: `Return #${ret.id} is re-delivered already.` };
    return {
      title: `✓ Re-deliver return #${ret.id}`,
      summary: `${cell(ret.qty)} pcs of ${lineName(ret)} sent back from ${ret.fromDept} ("${ret.reason}") are fixed: back on ${ret.toDept}'s output and on to ${ret.fromDept}.`,
      changes: [{ label: `Return #${ret.id}`, before: "open", after: "re-delivered" }],
      snapshot: ret,
    };
  },
  async execute(i) {
    const r = await redeliverReturn(formOf({ id: i.id }));
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, message: `Return #${i.id} is re-delivered.`, ...(r.ledgerId ? { undo: { tool: "reopen_return", input: { id: i.id, ledgerId: r.ledgerId } } } : {}) };
  },
};

/** The undo of a re-delivery — never offered to the model. */
export const reopenReturnTool: WriteTool<{ id: number; ledgerId: number }> = {
  kind: "write",
  name: "reopen_return",
  internal: true,
  title: "Open a return again",
  description: "Take a re-delivery back: its Daily log row goes and the return is open again (the undo of redeliver_return).",
  area: "tracker",
  risk: "low",
  schema: {
    type: "object",
    properties: { id: { type: "integer", minimum: 1 }, ledgerId: { type: "integer", minimum: 1 } },
    required: ["id", "ledgerId"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    const ret = await theReturn(i.id, ctx, "toDept");
    if ("error" in ret) return ret;
    if (ret.status !== "resolved") return { error: `Return #${ret.id} is open already.` };
    const row = await prisma.handoverEntry.findUnique({ where: { id: i.ledgerId }, select: { id: true, qty: true, dept: true, source: true } });
    if (!row) return { error: "The re-delivery's Daily log row is gone." };
    return {
      title: `Open return #${ret.id} again`,
      summary: `Take back the re-delivery of ${cell(ret.qty)} pcs of ${lineName(ret)}: off ${ret.toDept}'s output again, the return open.`,
      changes: [{ label: `Return #${ret.id}`, before: "re-delivered", after: "open" }],
      snapshot: { ret, row },
    };
  },
  async execute(i) {
    const r = await reopenReturn(i.id, i.ledgerId);
    return r.ok ? { ok: true, message: `Return #${i.id} is open again.` } : { ok: false, error: r.error };
  },
};

export const WORKLIST_TOOLS = [
  getCutWorklistTool,
  setWorklistDateTool,
  clearWorklistDateTool,
  restoreWorklistDatesTool,
  hideWorklistLineTool,
  unhideWorklistLineTool,
  addQueueNoteTool,
  updateQueueNoteTool,
  setQueueNoteStatusTool,
  deleteQueueNoteTool,
  restoreQueueNoteTool,
  returnToUpstreamTool,
  cancelReturnTool,
  redeliverReturnTool,
  reopenReturnTool,
] as const;
