"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentUser, requireAdmin } from "@/lib/server/auth";

export interface SimActionResult {
  ok: boolean;
  error?: string;
}

const revalidate = () => {
  for (const p of ["/simulate", "/worklist/cut", "/worklist/welding", "/worklist/painting"]) revalidatePath(p);
};

/** Save (or overwrite) a named scenario — the knobs, queue and splits as one blob. */
export async function saveScenario(fd: FormData): Promise<SimActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Sign in first." };

  const name = String(fd.get("name") ?? "").trim().slice(0, 60);
  if (!name) return { ok: false, error: "Give the scenario a name." };
  let data: Prisma.InputJsonValue;
  try {
    data = JSON.parse(String(fd.get("data") ?? ""));
  } catch {
    return { ok: false, error: "Malformed scenario." };
  }
  await prisma.simScenario.upsert({
    where: { name },
    create: { name, data, savedBy: user.name },
    update: { data, savedBy: user.name },
  });
  revalidatePath("/simulate");
  return { ok: true };
}

export async function deleteScenario(fd: FormData): Promise<SimActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Sign in first." };
  await prisma.simScenario.deleteMany({ where: { name: String(fd.get("name") ?? "") } });
  revalidatePath("/simulate");
  return { ok: true };
}

/** Commit the scenario's queue as THE run order: every dept worklist shows
 *  its slice of this sequence until it is replaced or cleared. Admin only —
 *  this is the button that moves the real factory. */
export async function applyRunOrder(fd: FormData): Promise<SimActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };

  let entries: { mo: string; item: string; batchQty: number | null; batchNo: number | null }[];
  try {
    entries = JSON.parse(String(fd.get("entries") ?? ""));
    if (!Array.isArray(entries) || entries.length === 0) throw new Error();
    for (const e of entries) {
      if (typeof e.mo !== "string" || typeof e.item !== "string") throw new Error();
    }
  } catch {
    return { ok: false, error: "Malformed run order." };
  }
  if (entries.length > 500) return { ok: false, error: "Run order too long." };

  await prisma.$transaction([
    prisma.runOrderEntry.deleteMany({}),
    prisma.runOrderEntry.createMany({
      data: entries.map((e, i) => ({
        rank: i + 1,
        mo: e.mo,
        item: e.item,
        batchQty: e.batchQty ?? null,
        batchNo: e.batchNo ?? null,
        appliedBy: guard.user!.name,
      })),
    }),
  ]);
  revalidate();
  return { ok: true };
}

/** Take the run order back off the worklists. */
export async function clearRunOrder(): Promise<SimActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };
  await prisma.runOrderEntry.deleteMany({});
  revalidate();
  return { ok: true };
}
