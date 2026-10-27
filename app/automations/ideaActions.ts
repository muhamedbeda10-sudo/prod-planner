"use server";

import { prisma } from "@/lib/db";
import { requireOwner, requirePerm } from "@/lib/server/auth";
import { AUTOMATIONS_KEY } from "@/lib/server/automations/store";
import { ideasForUser, suggestIdeas } from "@/lib/server/automations/ideas";
import type { IdeaView } from "@/lib/domain/automationIdeas";

// The assistant's automation ideas, above the ready-made ones: read by anyone
// who keeps automations, set aside one by one, and, for the plant's owner,
// asked for again now.

/** The ideas for the person — and whether they may ask for new ones now (the plant's owner). */
export type IdeasData = { ok: true; ideas: IdeaView[]; canSuggest: boolean } | { ok: false; error: string };

export async function automationIdeas(): Promise<IdeasData> {
  const guard = await requirePerm(AUTOMATIONS_KEY);
  if (guard.error) return { ok: false, error: guard.error };
  const user = guard.user!;
  return { ok: true, ideas: await ideasForUser(user), canSuggest: user.isOwner };
}

/** Set an idea aside — for this person alone. */
export async function dismissAutomationIdea(fd: FormData): Promise<{ ok: boolean; error?: string }> {
  const guard = await requirePerm(AUTOMATIONS_KEY);
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(fd.get("id"));
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "No such idea." };
  const me = guard.user!.id;
  const set = await prisma.automationIdea.updateMany({ where: { id, NOT: { dismissedBy: { has: me } } }, data: { dismissedBy: { push: me } } });
  if (set.count === 0 && !(await prisma.automationIdea.count({ where: { id } }))) return { ok: false, error: "That idea is gone." };
  return { ok: true };
}

/** The plant's owner: new ideas now, without waiting for the week's round. */
export async function suggestIdeasNow(): Promise<{ ok: boolean; error?: string; message?: string }> {
  const guard = await requireOwner();
  if (guard.error) return { ok: false, error: guard.error };
  try {
    const r = await suggestIdeas(new Date());
    if ("error" in r) return { ok: false, error: r.error };
    return { ok: true, message: r.made ? `${r.made} new idea${r.made === 1 ? "" : "s"}.` : "Nothing new worth suggesting right now." };
  } catch (e) {
    console.error("automation ideas: a run from Ready-made failed", e);
    return { ok: false, error: "The ideas could not be written — try again." };
  }
}
