import "server-only";
import type { AiAction, AiSettings, Prisma, User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasPerm, hiddenTabsOf } from "@/lib/server/auth";
import { runAsActor, type ActorVia } from "@/lib/server/actor";
import { factoryDayISO } from "@/lib/domain/dates";
import {
  AI_NOCONFIRM_KEY,
  AI_PROPOSAL_TTL_MS,
  executionMode,
  outcomeNote,
  sameSnapshot,
  type AiActionStatus,
  type AiActionView,
  type AiChange,
  type AiRisk,
} from "@/lib/domain/aiActions";
import { callDenied, checkToolInput, riskOf, writeToolNamed } from "./tools";
import type { AnyWriteTool, ToolCtx, WriteOutcome } from "./tools/types";

// The assistant's changes, from proposal to record (the rules are in
// lib/domain/aiActions.ts).
//
// A write tool call becomes an AiAction row. A small change for someone who
// opted into that runs at once; anything else waits as a proposal for that
// person's click. Approved, it runs only if the data still reads as it did
// when it was proposed — otherwise it is marked stale and nothing happens.
// It runs through the app's own action, as the person (runAsActor), so their
// permissions decide. What it did, and how to put it back, is kept on the row.

type Json = Prisma.InputJsonValue;

const json = (v: unknown): Json => JSON.parse(JSON.stringify(v ?? null)) as Json;

export interface CallResult {
  /** What goes back to the model. */
  text: string;
  isError: boolean;
  view: AiActionView | null;
}

/** The context a change runs in, for a person outside the chat request that
 *  proposed it (an approval click, an automation). */
export function ctxFor(user: User, o: { conversationId?: number | null; automationId?: number | null; now?: Date } = {}): ToolCtx {
  const now = o.now ?? new Date();
  return {
    user,
    hidden: hiddenTabsOf(user),
    now,
    todayISO: factoryDayISO(now),
    conversationId: o.conversationId ?? null,
    automationId: o.automationId ?? null,
  };
}

const PAUSED = "The owner has paused every change by the assistant — nothing can be changed through it right now.";

/** A write tool call: checked, described, then proposed — or, when small and
 *  the person opted into that, made at once. */
export async function handleWriteCall(
  tool: AnyWriteTool,
  raw: unknown,
  ctx: ToolCtx,
  o: { toolUseId: string | null; settings: Pick<AiSettings, "actionsPaused">; via?: ActorVia; allowAuto?: boolean },
): Promise<CallResult> {
  if (o.settings.actionsPaused) return { text: PAUSED, isError: true, view: null };
  const checked = checkToolInput(tool, raw);
  if (!checked.ok) return { text: `Invalid call — ${checked.error}`, isError: true, view: null };
  const input = checked.input;
  const denied = callDenied(ctx.user, ctx.hidden, tool, input);
  if (denied) return { text: denied, isError: true, view: null };

  let proposal;
  try {
    proposal = await tool.describe(input, ctx);
  } catch (e) {
    return { text: `Could not prepare it: ${errText(e)}`, isError: true, view: null };
  }
  if ("error" in proposal) return { text: proposal.error, isError: true, view: null };

  const risk = riskOf(tool, input);
  const mode = o.allowAuto === false ? "ask" : executionMode({ risk, noconfirm: hasPerm(ctx.user, AI_NOCONFIRM_KEY) });
  const row = await prisma.aiAction.create({
    data: {
      userId: ctx.user.id,
      conversationId: ctx.conversationId,
      toolUseId: o.toolUseId,
      automationId: ctx.automationId,
      tool: tool.name,
      input: json(input),
      title: proposal.title.slice(0, 200),
      summary: proposal.summary.slice(0, 2000),
      changes: json(proposal.changes.slice(0, 200)),
      risk,
      snapshot: json(proposal.snapshot),
      status: mode === "auto" ? "executing" : "proposed",
      auto: mode === "auto",
      expiresAt: mode === "ask" ? new Date(ctx.now.getTime() + AI_PROPOSAL_TTL_MS) : null,
      decidedAt: mode === "auto" ? ctx.now : null,
      // the model learns the outcome of an automatic change from this very
      // call, so there is nothing left to tell it later
      reportedAt: mode === "auto" ? ctx.now : null,
    },
  });

  if (mode === "ask") {
    return {
      text: `Prepared as change #${row.id}, waiting for ${ctx.user.name}'s approval in the chat — it is NOT done until they approve it. They see: "${proposal.summary}"`,
      isError: false,
      view: toView(row),
    };
  }

  const done = await runChange(row, tool, input, ctx, o.via ?? "ai");
  return {
    text: done.status === "executed" ? `Done (change #${row.id}, made without asking — a small change ${ctx.user.name} allows): ${done.result ?? proposal.summary}` : `The app refused it: ${done.error ?? "no reason given"}`,
    isError: done.status !== "executed",
    view: toView(done),
  };
}

/** Run a change that is now approved (or allowed to run unasked), as the
 *  person, and record what happened and how to undo it. */
async function runChange(row: AiAction, tool: AnyWriteTool, input: unknown, ctx: ToolCtx, via: ActorVia): Promise<AiAction> {
  let outcome: WriteOutcome;
  try {
    outcome = await runAsActor(ctx.user, via, () => tool.execute(input, ctx));
  } catch (e) {
    outcome = { ok: false, error: errText(e) };
  }
  const undo = outcome.ok && outcome.undo ? await undoPlan(outcome.undo, ctx) : null;
  return prisma.aiAction.update({
    where: { id: row.id },
    data: {
      status: outcome.ok ? "executed" : "failed",
      executedAt: outcome.ok ? new Date() : null,
      result: outcome.ok ? (outcome.message ?? null)?.slice(0, 2000) ?? null : null,
      error: outcome.ok ? null : (outcome.error ?? "The app refused the change.").slice(0, 2000),
      undo: undo ? json(undo) : undefined,
    },
  });
}

/** How to put a change back: the reversing call, and the data as the change
 *  left it — the undo runs only while it still reads so. */
async function undoPlan(u: { tool: string; input: Record<string, unknown> }, ctx: ToolCtx): Promise<{ tool: string; input: unknown; expect: unknown } | null> {
  const t = writeToolNamed(u.tool);
  if (!t) return null;
  const checked = checkToolInput(t, u.input);
  if (!checked.ok) return null;
  try {
    const d = await t.describe(checked.input, ctx);
    if ("error" in d) return null;
    return { tool: t.name, input: checked.input, expect: d.snapshot };
  } catch {
    return null;
  }
}

export interface DecideResult {
  ok: boolean;
  error?: string;
  view?: AiActionView;
  /** The undo's own record, after an undo. */
  undoView?: AiActionView;
}

const STATUS_TEXT: Partial<Record<AiActionStatus, string>> = {
  executing: "It is being run already.",
  executed: "It was done already.",
  failed: "It was tried already and the app refused it.",
  rejected: "It was rejected already.",
  stale: "It is out of date — the data changed after it was proposed.",
  expired: "It expired unanswered — ask the assistant again.",
  undone: "It was undone already.",
};

/** The person's approval: run it, if it still holds. */
export async function approveAction(id: number, user: User): Promise<DecideResult> {
  const row = await prisma.aiAction.findFirst({ where: { id, userId: user.id } });
  if (!row) return { ok: false, error: "That change is not there any more." };
  if (row.status !== "proposed") return { ok: false, error: STATUS_TEXT[row.status as AiActionStatus] ?? "It is not waiting for an approval.", view: toView(row) };
  const now = new Date();
  if (row.expiresAt && row.expiresAt < now) {
    const exp = await prisma.aiAction.update({ where: { id }, data: { status: "expired" } });
    return { ok: false, error: STATUS_TEXT.expired, view: toView(exp) };
  }
  const settings = await prisma.aiSettings.findUnique({ where: { id: 1 }, select: { actionsPaused: true } });
  if (settings?.actionsPaused) return { ok: false, error: PAUSED, view: toView(row) };

  const tool = writeToolNamed(row.tool);
  const ctx = ctxFor(user, { conversationId: row.conversationId, automationId: row.automationId, now });
  const checked = tool ? checkToolInput(tool, row.input) : null;
  const denied = !tool ? "This kind of change is no longer available." : !checked!.ok ? checked!.error : callDenied(user, ctx.hidden, tool, checked!.input);
  if (denied) return { ok: false, error: denied, view: toView(row) };

  // one approval only: the click that wins the claim runs it
  const claim = await prisma.aiAction.updateMany({ where: { id, status: "proposed" }, data: { status: "executing", decidedAt: now } });
  if (claim.count === 0) return { ok: false, error: "It is being handled already — refresh the chat." };

  const input = (checked as { ok: true; input: unknown }).input;
  let fresh;
  try {
    fresh = await tool!.describe(input, ctx);
  } catch (e) {
    fresh = { error: errText(e) };
  }
  if ("error" in fresh || !sameSnapshot(fresh.snapshot, row.snapshot)) {
    const reason = "error" in fresh ? fresh.error : "the data changed after it was proposed — ask the assistant again, it will read it afresh";
    const st = await prisma.aiAction.update({ where: { id }, data: { status: "stale", error: reason.slice(0, 2000) } });
    return { ok: false, error: `Not done: ${reason}.`, view: toView(st) };
  }
  const done = await runChange(row, tool!, input, ctx, row.automationId ? "automation" : "ai");
  return done.status === "executed" ? { ok: true, view: toView(done) } : { ok: false, error: done.error ?? "The app refused the change.", view: toView(done) };
}

/** The person's no. */
export async function rejectAction(id: number, user: User): Promise<DecideResult> {
  const r = await prisma.aiAction.updateMany({ where: { id, userId: user.id, status: "proposed" }, data: { status: "rejected", decidedAt: new Date() } });
  const row = await prisma.aiAction.findFirst({ where: { id, userId: user.id } });
  if (!row) return { ok: false, error: "That change is not there any more." };
  if (r.count === 0) return { ok: false, error: STATUS_TEXT[row.status as AiActionStatus] ?? "It is not waiting for an answer.", view: toView(row) };
  return { ok: true, view: toView(row) };
}

/** Put a change back — only while the data still reads as the change left it,
 *  so an undo never overwrites what someone did after it. */
export async function undoAction(id: number, user: User): Promise<DecideResult> {
  const row = await prisma.aiAction.findFirst({ where: { id, userId: user.id } });
  if (!row) return { ok: false, error: "That change is not there any more." };
  const plan = row.undo as { tool?: string; input?: unknown; expect?: unknown } | null;
  if (row.status !== "executed" || !plan?.tool || row.undoneAt) return { ok: false, error: "This change cannot be undone.", view: toView(row) };
  const settings = await prisma.aiSettings.findUnique({ where: { id: 1 }, select: { actionsPaused: true } });
  if (settings?.actionsPaused) return { ok: false, error: PAUSED, view: toView(row) };

  const tool = writeToolNamed(plan.tool);
  const now = new Date();
  const ctx = ctxFor(user, { conversationId: row.conversationId, automationId: row.automationId, now });
  const checked = tool ? checkToolInput(tool, plan.input) : null;
  const denied = !tool ? "This kind of change is no longer available." : !checked!.ok ? checked!.error : callDenied(user, ctx.hidden, tool, checked!.input);
  if (denied) return { ok: false, error: denied, view: toView(row) };
  const input = (checked as { ok: true; input: unknown }).input;

  let d;
  try {
    d = await tool!.describe(input, ctx);
  } catch (e) {
    d = { error: errText(e) };
  }
  if ("error" in d) return { ok: false, error: `It cannot be undone now: ${d.error}`, view: toView(row) };
  if (!sameSnapshot(d.snapshot, plan.expect)) {
    return { ok: false, error: "It was changed again after the assistant's change — undoing it now would overwrite that. Change it by hand instead.", view: toView(row) };
  }
  // one undo only
  const claim = await prisma.aiAction.updateMany({ where: { id, undoneAt: null, status: "executed" }, data: { undoneAt: now } });
  if (claim.count === 0) return { ok: false, error: "It is being undone already — refresh the chat." };

  const undoRow = await prisma.aiAction.create({
    data: {
      userId: user.id,
      conversationId: row.conversationId,
      automationId: row.automationId,
      tool: tool!.name,
      input: json(input),
      title: `Undo: ${row.title}`.slice(0, 200),
      summary: d.summary.slice(0, 2000),
      changes: json(d.changes),
      risk: riskOf(tool!, input),
      snapshot: json(d.snapshot),
      status: "executing",
      decidedAt: now,
      undoOfId: row.id,
      // the original's own note tells the assistant it was undone
      reportedAt: now,
    },
  });
  const done = await runChange(undoRow, tool!, input, ctx, "ai");
  if (done.status !== "executed") {
    await prisma.aiAction.update({ where: { id }, data: { undoneAt: null } });
    return { ok: false, error: done.error ?? "The app refused to undo it.", view: toView(row), undoView: toView(done) };
  }
  const undone = await prisma.aiAction.update({ where: { id }, data: { status: "undone", reportedAt: null } });
  return { ok: true, view: toView(undone), undoView: toView(done) };
}

/** Proposals nobody answered in time. */
export async function expireProposals(now = new Date()): Promise<number> {
  const r = await prisma.aiAction.updateMany({ where: { status: "proposed", expiresAt: { lt: now } }, data: { status: "expired" } });
  return r.count;
}

const FINAL: AiActionStatus[] = ["executed", "failed", "rejected", "stale", "expired", "undone"];

/** What happened to the chat's proposals since the assistant last heard —
 *  for the system message of the person's next question. Marked told only
 *  once that question is answered (markOutcomesTold), so a question that
 *  fails does not swallow them. */
export async function pendingOutcomes(conversationId: number): Promise<{ ids: number[]; notes: string[] }> {
  await expireProposals();
  const rows = await prisma.aiAction.findMany({
    where: { conversationId, reportedAt: null, status: { in: FINAL }, undoOfId: null },
    orderBy: { id: "asc" },
    select: { id: true, title: true, status: true, result: true, error: true },
  });
  return { ids: rows.map((r) => r.id), notes: rows.map((r) => outcomeNote({ ...r, status: r.status as AiActionStatus })) };
}

export async function markOutcomesTold(ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.aiAction.updateMany({ where: { id: { in: [...ids] } }, data: { reportedAt: new Date() } });
}

/** The changes of one conversation, by the tool call that proposed them,
 *  and the undo records that put them back — for the chat's cards. */
export async function actionsOfConversation(conversationId: number): Promise<AiActionView[]> {
  await expireProposals();
  const rows = await prisma.aiAction.findMany({ where: { conversationId }, orderBy: { id: "asc" } });
  return rows.map(toView);
}

/** A row as the chat shows it. */
export function toView(r: AiAction): AiActionView {
  const undo = r.undo as { tool?: string } | null;
  return {
    id: r.id,
    toolUseId: r.toolUseId,
    tool: r.tool,
    title: r.title,
    summary: r.summary,
    changes: Array.isArray(r.changes) ? (r.changes as unknown as AiChange[]) : [],
    risk: r.risk as AiRisk,
    status: r.status as AiActionStatus,
    auto: r.auto,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt?.toISOString() ?? null,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    executedAt: r.executedAt?.toISOString() ?? null,
    result: r.result,
    error: r.error,
    canUndo: r.status === "executed" && !!undo?.tool && !r.undoneAt,
    undoneAt: r.undoneAt?.toISOString() ?? null,
    automationId: r.automationId,
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
