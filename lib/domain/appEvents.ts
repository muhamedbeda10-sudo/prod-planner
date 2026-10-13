import { deptLabel } from "./constants";

// What happens in the app that someone may want to hear of the moment it
// happens — the list an "on event" automation picks from. Each is recorded
// by the app's own action once it has done what was asked (lib/server/
// events.ts), with who did it, what it was about, and a sentence that says it.

export const APP_EVENT_TYPES = [
  "output.recorded",
  "order.closed",
  "order.reopened",
  "order.held",
  "order.released",
  "work.returned",
  "tank.leak_failed",
  "tank.qa_failed",
  "tank.rewelding",
  "odoo.logged",
  "consumables.issued",
  "plan.imported",
  "task.given",
  "task.done",
  "task.approved",
  "task.returned",
] as const;
export type AppEventType = (typeof APP_EVENT_TYPES)[number];

export interface AppEventDef {
  label: string;
  group: "Production" | "Orders" | "Quality" | "Stores" | "Plans" | "Tasks";
  /** What it covers, for the person choosing and for the assistant. */
  desc: string;
}

export const APP_EVENTS: Record<AppEventType, AppEventDef> = {
  "output.recorded": { label: "Output recorded", group: "Production", desc: "Someone records output — on a worklist, the Plan Tracker, the Daily log or the LV panels. The sentence names the department, the order and the quantity." },
  "order.closed": { label: "Order closed", group: "Orders", desc: "An order (MO) is closed on the Plan Tracker." },
  "order.reopened": { label: "Order reopened", group: "Orders", desc: "A closed order is reopened." },
  "order.held": { label: "Order put on hold", group: "Orders", desc: "An order is put on hold, with the reason given." },
  "order.released": { label: "Order released from hold", group: "Orders", desc: "An order on hold is released." },
  "work.returned": { label: "Work returned to the department before", group: "Production", desc: "A department sends pieces back to the one before it (rework), with the reason." },
  "tank.leak_failed": { label: "Leak test failed", group: "Quality", desc: "Tanks fail their leak test and need repair." },
  "tank.qa_failed": { label: "Quality check failed", group: "Quality", desc: "A tank is found not OK at the quality check." },
  "tank.rewelding": { label: "Tank sent back to welding", group: "Quality", desc: "A tank is sent back to welding, with the reason." },
  "odoo.logged": { label: "Odoo close-out logged", group: "Orders", desc: "A row is added to the ODOO close-out log." },
  "consumables.issued": { label: "Consumables handed out", group: "Stores", desc: "Consumables are handed out from the store — the sentence says when it was over the limit." },
  "plan.imported": { label: "A plan imported", group: "Plans", desc: "A monthly or weekly plan is imported." },
  "task.given": { label: "Task given", group: "Tasks", desc: "Someone gives a task (its title and who to)." },
  "task.done": { label: "Task marked done", group: "Tasks", desc: "Someone marks a task done, for its giver to review." },
  "task.approved": { label: "Task approved", group: "Tasks", desc: "A task's giver approves it." },
  "task.returned": { label: "Task returned for rework", group: "Tasks", desc: "A task's giver returns it for rework." },
};

export const isAppEventType = (s: string): s is AppEventType => (APP_EVENT_TYPES as readonly string[]).includes(s);

/** The screen an event's data lives on: a person who does not see that
 *  screen is not told of its events either (lib/domain/tabs.ts ids). */
export const EVENT_TAB: Partial<Record<AppEventType, string>> = {
  "odoo.logged": "odoo",
  "consumables.issued": "consumables",
  "tank.leak_failed": "worklist.leak-test",
  "tank.qa_failed": "barcode",
  "tank.rewelding": "worklist.welding",
  "plan.imported": "orders",
};

/** A task's events are its people's own: only someone on the task hears of them. */
export const isTaskEvent = (t: AppEventType): boolean => t.startsWith("task.");

/** One event as an automation sees it. */
export interface AppEventView {
  id: number;
  type: AppEventType;
  at: string;
  actorId: number | null;
  actorName: string;
  /** A task's event: its giver and its people — the only ones it may reach. */
  participants?: number[];
  /** What it is about — an MO, a tank, a task — when there is one thing. */
  subject: string | null;
  /** The sentence: "Sara closed SF01/MO/06326". */
  summary: string;
}

/** Whether an "on event" automation's filters let this event through: one of
 *  its kinds, by one of its people (none named = anyone), and — when it has
 *  one — the words it looks for, in what the event is about or its sentence. */
export function eventMatches(
  rule: { eventTypes: readonly string[]; eventActorIds: readonly number[]; eventMatch: string | null },
  e: Pick<AppEventView, "type" | "actorId" | "subject" | "summary">,
): boolean {
  if (!rule.eventTypes.includes(e.type)) return false;
  if (rule.eventActorIds.length > 0 && (e.actorId === null || !rule.eventActorIds.includes(e.actorId))) return false;
  const want = (rule.eventMatch ?? "").trim().toLowerCase();
  if (!want) return true;
  return `${e.subject ?? ""} ${e.summary}`.toLowerCase().includes(want);
}

/** The event as the row a message or a report is written from. */
export function eventRow(e: AppEventView, at: string): Record<string, unknown> {
  return { when: at, who: e.actorName, what: APP_EVENTS[e.type].label, about: e.subject ?? "", detail: e.summary };
}

/** Output as an event says it: "Recorded 5 × TANK on SF01/MO/1 — Welding",
 *  or a correction down, with the total it leaves. */
export function outputSentence(o: { qty: number; item: string; on: string; stage: string; total?: number | null }): string {
  const where = `${o.item} on ${o.on} — ${deptLabel(o.stage)}`;
  const total = o.total !== undefined && o.total !== null ? ` (total now ${o.total})` : "";
  return o.qty >= 0 ? `Recorded ${o.qty} × ${where}${total}` : `Took ${-o.qty} × ${where} off${total}`;
}
