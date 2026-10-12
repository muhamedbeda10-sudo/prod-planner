import "server-only";
import { prisma } from "@/lib/db";
import { hasPerm } from "@/lib/server/auth";
import { addHoliday, deleteHoliday } from "@/app/calendar/actions";
import { answerOf, formOf, type WriteTool } from "./types";

// The factory calendar for the assistant: days off (holidays) added, renamed
// or taken away — through the calendar's own actions as the person
// (calendar.manage). Every plan date, ETA and capacity figure counts working
// days off this calendar, so a change here moves them all. Undone by putting
// each day back as it was: a holiday under its old name, or no holiday.

const TABS = ["calendar"] as const;
const PERM = "calendar.manage";
const NO_RIGHT = "Changing the factory calendar needs the Calendar permission — the owner ticks it on Users & Permissions.";
const DAY = { type: "string", format: "date" } as const;
const at = (iso: string) => new Date(`${iso}T00:00:00Z`);
const isFriday = (iso: string) => at(iso).getUTCDay() === 5;

/** Each day's holiday name as it stands — null for a working day. */
async function namesOn(days: readonly string[]): Promise<Map<string, string | null>> {
  const rows = await prisma.holiday.findMany({ where: { date: { in: days.map(at) } }, select: { date: true, name: true } });
  const by = new Map(rows.map((r) => [r.date.toISOString().slice(0, 10), r.name]));
  return new Map(days.map((d) => [d, by.get(d) ?? null]));
}

/** The undo: each day back to the name it had, or to no holiday. */
const restoreUndo = (before: Map<string, string | null>) => ({ tool: "restore_holidays", input: { days: [...before].map(([date, name]) => ({ date, name })) } });

interface AddInput {
  days: { date: string; name: string }[];
}

export const addHolidaysTool: WriteTool<AddInput> = {
  kind: "write",
  name: "add_holidays",
  title: "Add days off to the factory calendar",
  description: "Add holidays (days off) to the factory calendar, or rename one already there — e.g. the days of Eid. Every plan date, ETA and capacity figure is counted in working days off this calendar. Fridays are off already.",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      days: {
        type: "array",
        minItems: 1,
        maxItems: 31,
        items: { type: "object", properties: { date: DAY, name: { type: "string", minLength: 1, maxLength: 80 } }, required: ["date", "name"], additionalProperties: false },
      },
    },
    required: ["days"],
    additionalProperties: false,
  },
  parse(r) {
    const days = (r.days as AddInput["days"]).map((d) => ({ date: d.date, name: d.name.trim() }));
    if (new Set(days.map((d) => d.date)).size !== days.length) return "A day is named twice.";
    return { days };
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const before = await namesOn(i.days.map((d) => d.date));
    const changing = i.days.filter((d) => before.get(d.date) !== d.name);
    if (changing.length === 0) return { error: "Every one of those days is that holiday already." };
    const fridays = changing.filter((d) => isFriday(d.date)).length;
    return {
      title: `${changing.length} day(s) off`,
      summary: `Mark ${changing.length} day(s) as holidays on the factory calendar${fridays ? ` (${fridays} of them a Friday, off already)` : ""} — plan dates and ETAs count around them.`,
      changes: changing.map((d) => ({ label: d.date, before: before.get(d.date) ?? "working day", after: d.name })),
      snapshot: Object.fromEntries(before),
    };
  },
  async execute(i) {
    const before = await namesOn(i.days.map((d) => d.date));
    let done = 0;
    for (const d of i.days) {
      const res = await answerOf(() => addHoliday(formOf({ date: d.date, name: d.name })));
      if (!res.ok) {
        if (done === 0) return { ok: false, error: res.error ?? "Refused." };
        return { ok: true, message: `Added ${done} of ${i.days.length} day(s) — stopped at ${d.date}: ${res.error ?? "refused"}.`, undo: restoreUndo(before) };
      }
      done++;
    }
    return { ok: true, message: `${done} day(s) off on the calendar.`, undo: restoreUndo(before) };
  },
};

export const deleteHolidaysTool: WriteTool<{ dates: string[] }> = {
  kind: "write",
  name: "delete_holidays",
  title: "Take days off the factory calendar",
  description: "Take holidays off the factory calendar — those days become working days again (a Friday stays off).",
  area: "data",
  risk: "destructive",
  tabs: TABS,
  schema: { type: "object", properties: { dates: { type: "array", minItems: 1, maxItems: 31, items: DAY } }, required: ["dates"], additionalProperties: false },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const before = await namesOn(i.dates);
    const off = i.dates.filter((d) => before.get(d) !== null);
    if (off.length === 0) return { error: "None of those days is a holiday." };
    return {
      title: `${off.length} holiday(s) taken off`,
      summary: `Take ${off.length} holiday(s) off the factory calendar — they become working days again.`,
      changes: off.map((d) => ({ label: d, before: before.get(d)!, after: isFriday(d) ? "Friday (off)" : "working day" })),
      snapshot: Object.fromEntries(before),
    };
  },
  async execute(i) {
    const before = await namesOn(i.dates);
    const rows = await prisma.holiday.findMany({ where: { date: { in: i.dates.map(at) } }, select: { id: true, date: true } });
    let done = 0;
    for (const r of rows) {
      const res = await answerOf(() => deleteHoliday(formOf({ id: r.id })));
      if (!res.ok) {
        if (done === 0) return { ok: false, error: res.error ?? "Refused." };
        return { ok: true, message: `Took off ${done} of ${rows.length} holiday(s) — stopped at ${r.date.toISOString().slice(0, 10)}: ${res.error ?? "refused"}.`, undo: restoreUndo(before) };
      }
      done++;
    }
    return { ok: true, message: `${done} holiday(s) taken off the calendar.`, undo: restoreUndo(before) };
  },
};

interface RestoreInput {
  days: { date: string; name: string | null }[];
}

/** The undo of either change above — never offered to the model. */
export const restoreHolidaysTool: WriteTool<RestoreInput> = {
  kind: "write",
  name: "restore_holidays",
  internal: true,
  title: "Put the calendar back",
  description: "Put days of the factory calendar back as they were: a holiday under its old name, or a working day (the undo of a calendar change).",
  area: "data",
  risk: "low",
  tabs: TABS,
  schema: {
    type: "object",
    properties: {
      days: {
        type: "array",
        minItems: 1,
        maxItems: 31,
        items: { type: "object", properties: { date: DAY, name: { type: ["string", "null"], maxLength: 80 } }, required: ["date", "name"], additionalProperties: false },
      },
    },
    required: ["days"],
    additionalProperties: false,
  },
  async describe(i, ctx) {
    if (!hasPerm(ctx.user, PERM)) return { error: NO_RIGHT };
    const now = await namesOn(i.days.map((d) => d.date));
    return {
      title: "Put the calendar back",
      summary: `Put ${i.days.length} day(s) of the factory calendar back as they were.`,
      changes: i.days.map((d) => ({ label: d.date, before: now.get(d.date) ?? "working day", after: d.name ?? "working day" })),
      snapshot: Object.fromEntries(now),
    };
  },
  async execute(i) {
    for (const d of i.days) {
      if (d.name === null) {
        const row = await prisma.holiday.findUnique({ where: { date: at(d.date) }, select: { id: true } });
        if (!row) continue;
        const res = await deleteHoliday(formOf({ id: row.id }));
        if (!res.ok) return { ok: false, error: res.error };
      } else {
        const res = await addHoliday(formOf({ date: d.date, name: d.name }));
        if (!res.ok) return { ok: false, error: res.error };
      }
    }
    return { ok: true, message: "The calendar is back as it was." };
  },
};

export const CALENDAR_TOOLS = [addHolidaysTool, deleteHolidaysTool, restoreHolidaysTool] as const;
