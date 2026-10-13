import "server-only";
import type { User } from "@prisma/client";
import { hasPerm } from "@/lib/server/auth";
import { AI_AREA_KEY, AI_DELETE_KEY, type AiRisk } from "@/lib/domain/aiActions";
import { validateInput } from "@/lib/domain/aiInput";
import { queryDatabase } from "./sql";
import { TRACKER_TOOLS } from "./tracker";
import { ORDER_TOOLS } from "./orders";
import { DAILY_LOG_TOOLS } from "./dailyLog";
import { MACHINE_TOOLS } from "./machines";
import { CUT_FLOOR_TOOLS } from "./cutFloor";
import { WORKLIST_TOOLS } from "./worklists";
import { TANK_TOOLS } from "./tanks";
import { SIMULATOR_TOOLS } from "./simulator";
import { FLOOR_TOOLS } from "./floor";
import { ODOO_TOOLS } from "./odoo";
import { MATERIAL_TOOLS } from "./material";
import { PHYSICAL_TOOLS } from "./physical";
import { CONSUMABLE_TOOLS } from "./consumables";
import { CALENDAR_TOOLS } from "./calendar";
import { WORKER_TOOLS } from "./workers";
import { MACHINE_LIST_TOOLS } from "./machineList";
import { AUTOMATION_TOOLS } from "./automations";
import { TASK_TOOLS } from "./tasks";
import { CHAT_TOOLS } from "./chat";
import { PLAYBOOK_TOOLS } from "./playbook";
import { SHIFT_TOOLS } from "./shifts";
import { CATALOGUE_TOOLS } from "./catalogue";
import { SETUP_TOOLS } from "./setup";
import { USER_TOOLS } from "./users";
import { IMPORT_TOOLS } from "./imports";
import type { AiTool, AnyReadTool, AnyWriteTool } from "./types";

// Every tool the assistant has, in the one fixed order the API sees them in
// (a stable order keeps the prompt cache warm). Who gets which is decided per
// person by toolsFor: the read tools for everyone the assistant is opened to,
// a write tool only for someone the owner gave the assistant's key for its
// area — and none while the owner has paused the assistant's changes.

export const AI_TOOLS: readonly AiTool[] = [
  queryDatabase,
  ...TRACKER_TOOLS,
  ...ORDER_TOOLS,
  ...DAILY_LOG_TOOLS,
  ...WORKLIST_TOOLS,
  ...TANK_TOOLS,
  ...MACHINE_TOOLS,
  ...CUT_FLOOR_TOOLS,
  ...SIMULATOR_TOOLS,
  ...FLOOR_TOOLS,
  ...ODOO_TOOLS,
  ...MATERIAL_TOOLS,
  ...PHYSICAL_TOOLS,
  ...CONSUMABLE_TOOLS,
  ...CALENDAR_TOOLS,
  ...WORKER_TOOLS,
  ...MACHINE_LIST_TOOLS,
  ...AUTOMATION_TOOLS,
  ...TASK_TOOLS,
  ...CHAT_TOOLS,
  ...PLAYBOOK_TOOLS,
  ...SHIFT_TOOLS,
  ...CATALOGUE_TOOLS,
  ...SETUP_TOOLS,
  ...IMPORT_TOOLS,
  ...USER_TOOLS,
];

const BY_NAME = new Map<string, AiTool>(AI_TOOLS.map((t) => [t.name, t]));

const OWNER_ONLY = "Only the owner manages users and permissions.";

/** The read tools' titles — how a look-up reads in the chat's history. */
export const READ_TOOL_TITLES: Readonly<Record<string, string>> = Object.fromEntries(AI_TOOLS.filter((t) => t.kind === "read").map((t) => [t.name, t.title]));

export function toolNamed(name: string): AiTool | undefined {
  return BY_NAME.get(name);
}

export function writeToolNamed(name: string): AnyWriteTool | undefined {
  const t = BY_NAME.get(name);
  return t?.kind === "write" ? t : undefined;
}

export function readToolNamed(name: string): AnyReadTool | undefined {
  const t = BY_NAME.get(name);
  return t?.kind === "read" ? t : undefined;
}

/** The risk of one call — fixed per tool, or read off its input. */
export function riskOf(tool: AnyWriteTool, input: unknown): AiRisk {
  return typeof tool.risk === "function" ? tool.risk(input) : tool.risk;
}

/** Why the assistant may not work on this tool's area for this person, or null. */
export function areaDenied(user: User, tool: AnyWriteTool): string | null {
  if (tool.area === "playbook") return user.isAdmin ? null : "Only an admin keeps the plant's playbook — ask one.";
  if (tool.area === "users") return user.isOwner ? null : OWNER_ONLY;
  const key = AI_AREA_KEY[tool.area];
  if (key && !hasPerm(user, key)) return "The assistant has not been given this kind of change for you — the owner ticks it on Users & Permissions (AI assistant).";
  return null;
}

/** Why this call may not go ahead for this person, or null: the area's key,
 *  the deletions key for a deletion, and the screens behind it.
 *
 *  An undo needs no deletions key: it only puts the data back as it was
 *  before a change the person approved, and runs only while the data still
 *  reads as that change left it — so it never removes anything that was
 *  there before (undoing an addition removes just what was added). */
export function callDenied(user: User, hidden: ReadonlySet<string>, tool: AiTool, input: unknown, o: { undo?: boolean } = {}): string | null {
  if (tool.ownerOnly && !user.isOwner) return OWNER_ONLY;
  if (tool.needs && !hasPerm(user, tool.needs)) return "The owner has not given this person that right — it is ticked on Users & Permissions.";
  if (tool.tabs?.some((t) => hidden.has(t))) return "That screen is not opened for you, so the assistant cannot work on it for you.";
  if (tool.kind === "read") return null;
  const area = areaDenied(user, tool);
  if (area) return area;
  if (!o.undo && riskOf(tool, input) === "destructive" && !hasPerm(user, AI_DELETE_KEY)) {
    return "The assistant may not delete anything for you — the owner can allow it on Users & Permissions (AI — deletions).";
  }
  return null;
}

/** The tools this person's assistant gets, in the fixed order — fewer when
 *  it runs unattended (an automation, the morning review). */
export function toolsFor(user: User, o: { hidden: ReadonlySet<string>; actionsPaused: boolean; unattended?: boolean }): AiTool[] {
  return AI_TOOLS.filter((t) => {
    if (t.internal) return false;
    if (t.ownerOnly && !user.isOwner) return false;
    if (t.needs && !hasPerm(user, t.needs)) return false;
    if (t.liveOnly && o.unattended) return false;
    if (t.tabs?.some((x) => o.hidden.has(x))) return false;
    if (t.kind === "read") return true;
    if (o.actionsPaused) return false;
    if (areaDenied(user, t)) return false;
    // a tool that only ever deletes is offered only with the deletions key
    if (t.risk === "destructive" && !hasPerm(user, AI_DELETE_KEY)) return false;
    return true;
  });
}

/** A call's input checked against the tool's schema, then its own parse. */
export function checkToolInput<I>(tool: { schema: AiTool["schema"]; parse?: (raw: Record<string, unknown>) => I | string }, raw: unknown): { ok: true; input: I } | { ok: false; error: string } {
  const v = validateInput(tool.schema, raw);
  if (!v.ok) return v;
  if (!tool.parse) return { ok: true, input: v.value as I };
  const p = tool.parse(v.value);
  return typeof p === "string" ? { ok: false, error: p } : { ok: true, input: p };
}
