import "server-only";
import type { User } from "@prisma/client";
import { hasPerm } from "@/lib/server/auth";
import { AI_AREA_KEY, AI_DELETE_KEY, type AiRisk } from "@/lib/domain/aiActions";
import { validateInput } from "@/lib/domain/aiInput";
import { queryDatabase } from "./sql";
import type { AiTool, AnyReadTool, AnyWriteTool } from "./types";

// Every tool the assistant has, in the one fixed order the API sees them in
// (a stable order keeps the prompt cache warm). Who gets which is decided per
// person by toolsFor: the read tools for everyone the assistant is opened to,
// a write tool only for someone the owner gave the assistant's key for its
// area — and none while the owner has paused the assistant's changes.

export const AI_TOOLS: readonly AiTool[] = [queryDatabase];

const BY_NAME = new Map<string, AiTool>(AI_TOOLS.map((t) => [t.name, t]));

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
  const key = AI_AREA_KEY[tool.area];
  if (key && !hasPerm(user, key)) return "The assistant has not been given this kind of change for you — the owner ticks it on Users & Permissions (AI assistant).";
  return null;
}

/** Why this call may not go ahead for this person, or null: the area's key,
 *  the deletions key for a deletion, and the screens behind it. */
export function callDenied(user: User, hidden: ReadonlySet<string>, tool: AiTool, input: unknown): string | null {
  if (tool.tabs?.some((t) => hidden.has(t))) return "That screen is not opened for you, so the assistant cannot work on it for you.";
  if (tool.kind === "read") return null;
  const area = areaDenied(user, tool);
  if (area) return area;
  if (riskOf(tool, input) === "destructive" && !hasPerm(user, AI_DELETE_KEY)) {
    return "The assistant may not delete anything for you — the owner can allow it on Users & Permissions (AI — deletions).";
  }
  return null;
}

/** The tools this person's assistant gets, in the fixed order. */
export function toolsFor(user: User, o: { hidden: ReadonlySet<string>; actionsPaused: boolean }): AiTool[] {
  return AI_TOOLS.filter((t) => {
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
