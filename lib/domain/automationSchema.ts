// An automation's fields as the assistant writes them (JSON Schema) — for its
// automation tools and for the ideas it suggests each week. Pure.

import { AUTOMATION_ACTIONS, AUTOMATION_LIMITS, CHECK_EVERY, ESCALATE_AFTER, SCHEDULE_DAYS } from "./automations";
import { APP_EVENTS, APP_EVENT_TYPES } from "./appEvents";
import type { ObjectSchema } from "./aiInput";

const HHMM = { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" } as const;
export const AUTOMATION_PEOPLE = { type: "array", maxItems: AUTOMATION_LIMITS.recipients, items: { type: "string", minLength: 1, maxLength: 80 }, description: "Who receives it, by their name on the users list; leave out for the person alone. Include the person too if they want it as well." } as const;

export const AUTOMATION_CONFIG_PROPS: ObjectSchema["properties"] = {
  name: { type: "string", minLength: 1, maxLength: AUTOMATION_LIMITS.name, description: "A short name the person will know it by." },
  trigger: { type: "string", enum: ["schedule", "condition", "event"], description: "schedule = at times of day; condition = when a query finds new rows; event = the moment something happens in the app (eventTypes)." },
  eventTypes: {
    type: "array", minItems: 1, maxItems: AUTOMATION_LIMITS.eventTypes, items: { type: "string", enum: [...APP_EVENT_TYPES] },
    description: `event: what fires it, the moment it happens — ${APP_EVENT_TYPES.map((t) => `${t} (${APP_EVENTS[t].desc})`).join("; ")}`,
  },
  eventActors: { type: "array", maxItems: AUTOMATION_LIMITS.eventActors, items: { type: "string", minLength: 1, maxLength: 80 }, description: "event: only when one of these people does it, by their names on the users list; leave out for anyone." },
  eventActorIds: { type: "array", maxItems: AUTOMATION_LIMITS.eventActors, items: { type: "integer", minimum: 1 }, description: "Instead of eventActors: the same people by their user ids." },
  eventMatch: { type: "string", maxLength: AUTOMATION_LIMITS.eventMatch, description: "event: only when the event mentions these words — an MO, a department (Welding), a tank serial. Case does not matter." },
  times: { type: "array", minItems: 1, maxItems: AUTOMATION_LIMITS.times, items: HHMM, description: "schedule: times of day on the factory clock (Cairo), HH:MM." },
  days: { type: "string", enum: SCHEDULE_DAYS, description: "schedule: working (not Friday, not a holiday), every, or weekdays." },
  weekdays: { type: "array", minItems: 1, maxItems: 7, items: { type: "integer", minimum: 0, maximum: 6 }, description: "days = weekdays: 0 = Sunday … 6 = Saturday." },
  conditionSql: {
    type: "string", minLength: 1, maxLength: AUTOMATION_LIMITS.sql,
    description: "condition: ONE read-only SELECT (as query_database runs it) returning the rows that matter now — e.g. the orders on hold. It fires for rows that were not in the result at the previous check. Give each row a stable \"key\" column (e.g. the MO) so a row is recognised from one check to the next; at most 200 rows. Test it with query_database first.",
  },
  checkEveryMin: { type: "integer", minimum: CHECK_EVERY[0], maximum: CHECK_EVERY[CHECK_EVERY.length - 1], description: `condition: how often to check, in minutes — one of ${CHECK_EVERY.join(", ")}.` },
  activeFrom: { ...HHMM, description: "condition: check only from this time (Cairo) on working days — with activeTo." },
  activeTo: { ...HHMM, description: "condition: until this time." },
  action: { type: "string", enum: AUTOMATION_ACTIONS, description: "notify = send the message as written (no AI, no cost); report = you write a report from the live data each time; act = you prepare changes, which wait in the person's inbox for approval; task = give a task to the recipients (none: the person) — for a condition one per new row — no AI, no cost (needs the person's right to give tasks)." },
  taskDueDays: { type: "integer", minimum: 0, maximum: AUTOMATION_LIMITS.taskDueDays, description: "task: days until it is due (0 = the same day; a Friday or holiday moves to the next working day). Default 1." },
  taskUrgent: { type: "boolean", description: "task: urgent." },
  escalateAfterMin: { type: "integer", minimum: 0, maximum: ESCALATE_AFTER[ESCALATE_AFTER.length - 1], description: `condition: a row still matching this many minutes after it first did goes up to the plant's owner (and the person is told) — one of ${ESCALATE_AFTER.join(", ")}; 0 for never.` },
  message: { type: "string", minLength: 1, maxLength: AUTOMATION_LIMITS.text, description: "task: its title on the first line, what to do after it — the same blanks, and for a condition each row's own {column}. notify: the message, Markdown. {count} = how many rows fired, {rows} = them as a table (listed under it when not placed), {name} = the automation's name. For an event: {who} did it, {what} happened, {about} what it was about (an MO, a tank, a task), {detail} the app's sentence, {when}." },
  prompt: { type: "string", minLength: 1, maxLength: AUTOMATION_LIMITS.text, description: "report / act: your instruction for each run, complete on its own — you will not have this conversation then. For a condition, the rows that fired are added to it." },
  recipients: AUTOMATION_PEOPLE,
  recipientIds: { type: "array", maxItems: AUTOMATION_LIMITS.recipients, items: { type: "integer", minimum: 1 }, description: "Instead of recipients: the same people by their user ids." },
};
