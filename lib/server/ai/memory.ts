import "server-only";
import { prisma } from "@/lib/db";
import { AI_MEMORY_LIMITS, cleanMemory, sameMemory } from "@/lib/domain/aiLearn";

// What the assistant keeps about one person between chats (lib/domain/
// aiLearn.ts): theirs alone — the assistant writes it for them in their chat,
// they read and delete it on the chat's memory list.

export interface AiMemoryView {
  id: number;
  text: string;
  updatedAt: string;
}

export async function memoriesOf(userId: number): Promise<AiMemoryView[]> {
  const rows = await prisma.aiMemory.findMany({ where: { userId }, orderBy: { id: "asc" }, take: AI_MEMORY_LIMITS.perUser });
  return rows.map((m) => ({ id: m.id, text: m.text, updatedAt: m.updatedAt.toISOString() }));
}

/** A line kept (or, with id, rewritten) — the same line twice is kept once,
 *  and past the limit the oldest goes. */
export async function rememberFor(userId: number, raw: unknown, id?: number): Promise<{ ok: true; id: number; text: string } | { ok: false; error: string }> {
  const clean = cleanMemory(raw);
  if ("error" in clean) return { ok: false, error: clean.error };
  return prisma.$transaction(async (tx) => {
    const mine = await tx.aiMemory.findMany({ where: { userId }, orderBy: { id: "asc" } });
    if (id !== undefined) {
      if (!mine.some((m) => m.id === id)) return { ok: false as const, error: `Memory #${id} is not yours.` };
      const m = await tx.aiMemory.update({ where: { id }, data: { text: clean.text } });
      return { ok: true as const, id: m.id, text: m.text };
    }
    const same = mine.find((m) => sameMemory(m.text, clean.text));
    if (same) return { ok: true as const, id: same.id, text: same.text };
    const over = mine.length + 1 - AI_MEMORY_LIMITS.perUser;
    if (over > 0) await tx.aiMemory.deleteMany({ where: { id: { in: mine.slice(0, over).map((m) => m.id) } } });
    const m = await tx.aiMemory.create({ data: { userId, text: clean.text } });
    return { ok: true as const, id: m.id, text: m.text };
  });
}

export async function forgetFor(userId: number, id: number): Promise<boolean> {
  const r = await prisma.aiMemory.deleteMany({ where: { id, userId } });
  return r.count > 0;
}
