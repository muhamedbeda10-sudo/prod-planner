import "server-only";
import { cache } from "react";
import type { AiSettings, User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { aiDecision, aiVisible, monthStart, type AiDeny } from "@/lib/domain/ai";
import { decryptSecret } from "./secret";

// Who may use the assistant and how much of the month is left — read fresh
// on every question, so a switch or a cap the owner changes holds at once.

/** The settings row (the migration makes it; a database without it gets one). */
export async function getAiSettings(): Promise<AiSettings> {
  return (await prisma.aiSettings.findUnique({ where: { id: 1 } })) ?? prisma.aiSettings.create({ data: { id: 1 } });
}

/** The Claude API key in plain text — server side only, never to a browser. */
export function apiKeyOf(s: AiSettings): string | null {
  return s.apiKeyEnc ? decryptSecret(s.apiKeyEnc) : null;
}

/** US dollars spent this calendar month — by one person, or by everyone. */
export async function monthSpend(userId?: number, now = new Date()): Promise<number> {
  const agg = await prisma.aiUsage.aggregate({
    _sum: { costUsd: true },
    where: { at: { gte: monthStart(now) }, ...(userId !== undefined ? { userId } : {}) },
  });
  return agg._sum.costUsd ?? 0;
}

export interface AiStatus {
  visible: boolean;
  ok: boolean;
  reason: AiDeny | null;
  model: string;
  userSpent: number;
  /** The person's own monthly allowance (0 = none of their own). */
  userCap: number;
  plantSpent: number;
  plantCap: number;
}

export async function aiStatusFor(user: User): Promise<AiStatus> {
  const [s, access, userSpent, plantSpent] = await Promise.all([
    getAiSettings(),
    prisma.aiAccess.findUnique({ where: { userId: user.id } }),
    monthSpend(user.id),
    monthSpend(),
  ]);
  const gate = {
    isOwner: user.isOwner,
    hasKey: !!s.apiKeyEnc,
    enabled: s.enabled,
    access: access ? { enabled: access.enabled, monthlyUsd: access.monthlyUsd } : null,
    userSpent,
    plantSpent,
    plantCap: s.monthlyUsd,
  };
  const d = aiDecision(gate);
  return {
    visible: aiVisible(gate),
    ok: d.ok,
    reason: d.ok ? null : d.reason,
    model: s.model,
    userSpent,
    userCap: user.isOwner ? 0 : access?.monthlyUsd ?? 0,
    plantSpent,
    plantCap: s.monthlyUsd,
  };
}

/** Whether the AI button shows in this person's menu — one small read per
 *  page, cached for the request. */
export const aiVisibleFor = cache(async (user: User): Promise<boolean> => {
  try {
    const [s, access] = await Promise.all([
      prisma.aiSettings.findUnique({ where: { id: 1 }, select: { enabled: true, apiKeyEnc: true } }),
      user.isOwner ? null : prisma.aiAccess.findUnique({ where: { userId: user.id }, select: { enabled: true } }),
    ]);
    return aiVisible({ isOwner: user.isOwner, hasKey: !!s?.apiKeyEnc, enabled: !!s?.enabled, access: access ? { enabled: access.enabled, monthlyUsd: 0 } : null });
  } catch (e) {
    // the bar on every page reads this — a failure here only hides the button
    console.error("AI: could not read the assistant's settings", e);
    return false;
  }
});
