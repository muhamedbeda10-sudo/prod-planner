import "server-only";
import type { User } from "@prisma/client";
import type { AiArea, AiChange, AiRisk } from "@/lib/domain/aiActions";
import type { ObjectSchema } from "@/lib/domain/aiInput";

// The assistant's tools, as the app defines them. Each has the JSON Schema the
// model reads, and the app checks every call against that same schema before
// it does anything (lib/domain/aiInput.ts).
//
// A READ tool answers from the app's own loaders — the same numbers the
// screens show, which SQL alone often cannot reproduce (what a line still
// owes, the machine queues, a simulated week).
//
// A WRITE tool never writes by itself. `describe` reads what the change would
// do — before → after, row by row — and the snapshot of the data it relies
// on; `execute` performs it through the app's own server action, inside
// runAsActor, so that action's validation, permission check and audit apply
// as for the person's own click. Approved later, a proposal runs only if
// `describe` still reads the same snapshot.

export interface ToolCtx {
  /** The person the assistant works for — the effective user, their own name. */
  user: User;
  /** The screens hidden from them (tab ids). A tool on one of them is closed. */
  hidden: ReadonlySet<string>;
  now: Date;
  /** The factory's working day, Cairo time (YYYY-MM-DD). */
  todayISO: string;
  conversationId: number | null;
  automationId: number | null;
}

export interface ReadResult {
  ok: boolean;
  /** What goes back to the model — compact JSON or a short sentence. */
  text: string;
}

export interface Proposal {
  /** Short, for the card's head: "Put 3 orders on hold". */
  title: string;
  /** The one sentence the person approves. */
  summary: string;
  changes: AiChange[];
  /** The data the change relies on — compared again before it runs. */
  snapshot: unknown;
}

export interface WriteOutcome {
  ok: boolean;
  /** What the app did, in a sentence. */
  message?: string;
  error?: string;
  /** The change that reverses this one, when there is one. */
  undo?: { tool: string; input: Record<string, unknown> };
}

interface ToolBase<I> {
  name: string;
  /** A few words for the "looking up / preparing" line. */
  title: string;
  description: string;
  schema: ObjectSchema;
  /** The screens whose data it reads or changes — hidden ones close it. */
  tabs?: readonly string[];
  /** Not offered to the model: a tool only the app itself calls — the undo
   *  of another change. */
  internal?: true;
  /** Only for the owner — Users & Permissions are theirs alone. */
  ownerOnly?: true;
  /** Only in a chat the person is in, never in an automation or the morning
   *  review: what must not move while nobody is watching. */
  liveOnly?: true;
  /** In the model's context from the first request — the tools nearly every
   *  question needs. Every other tool waits until the model finds it with the
   *  tool search (lib/server/ai/agent.ts), so its definition costs nothing
   *  until a question needs it. */
  loaded?: true;
  /** Further checks and normalising after the schema: the typed input, or what is wrong. */
  parse?(raw: Record<string, unknown>): I | string;
}

export interface ReadTool<I = Record<string, unknown>> extends ToolBase<I> {
  kind: "read";
  /** The line shown while it runs (defaults to the title). */
  status?(input: I): string;
  run(input: I, ctx: ToolCtx): Promise<ReadResult>;
}

export interface WriteTool<I = Record<string, unknown>> extends ToolBase<I> {
  kind: "write";
  area: AiArea;
  risk: AiRisk | ((input: I) => AiRisk);
  describe(input: I, ctx: ToolCtx): Promise<Proposal | { error: string }>;
  execute(input: I, ctx: ToolCtx): Promise<WriteOutcome>;
}

// The registry holds tools of many input types; each is called only with
// input its own schema and parse produced.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyReadTool = ReadTool<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyWriteTool = WriteTool<any>;
export type AiTool = AnyReadTool | AnyWriteTool;

/** A server action's usual answer. */
export interface ActionAnswer {
  ok: boolean;
  error?: string;
}

/** A server action's answer, with a throw turned into a refusal — so a change
 *  made of several steps knows where it stopped. */
export async function answerOf<T extends ActionAnswer>(fn: () => Promise<T>): Promise<T | ActionAnswer> {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** FormData for one of the app's server actions, built from plain values —
 *  null and undefined leave the field out, as an empty form field would. */
export function formOf(fields: Record<string, string | number | boolean | null | undefined>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    fd.set(k, String(v));
  }
  return fd;
}
