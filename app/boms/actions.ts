"use server";

import { prisma } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { computePlanReallocations } from "@/lib/server/boms";
import { requirePerm } from "@/lib/server/auth";

export interface ActionResult {
  ok: boolean;
  error?: string;
  info?: string;
}

/** Apply a BOM correction to all handover rows carrying the old code. Originals
 *  preserved in bomRaw; this is an explicit, audited change (not silent). */
export async function applyBomCorrection(formData: FormData): Promise<ActionResult> {
  const guard = await requirePerm("boms.manage");
  if (guard.error) return { ok: false, error: guard.error };
  const from = String(formData.get("from") ?? "").trim();
  const to = String(formData.get("to") ?? "").trim();
  if (!from || !to) return { ok: false, error: "Invalid codes." };
  const known = await prisma.planOrder.findFirst({ where: { bom: to } });
  if (!known) return { ok: false, error: `Code ${to} is not in Plan Orders.` };

  const rows = await prisma.handoverEntry.findMany({ where: { bom: from } });
  await prisma.$transaction(
    rows.map((r) =>
      prisma.handoverEntry.update({
        where: { id: r.id },
        data: { bom: to, bomRaw: r.bomRaw ?? from, note: "bom-corrected" },
      })
    )
  );
  revalidatePath("/boms");
  return { ok: true, info: `Corrected ${rows.length} record(s): ${from} → ${to}` };
}

/** Compute fresh reallocation proposals and store them as 'proposed' moves. */
export async function proposeReallocations(formData: FormData): Promise<ActionResult> {
  const guard = await requirePerm("boms.manage");
  if (guard.error) return { ok: false, error: guard.error };
  const planNo = Number(formData.get("planNo"));
  if (!Number.isInteger(planNo)) return { ok: false, error: "Invalid plan." };
  const proposals = await computePlanReallocations(planNo);

  await prisma.reallocationMove.deleteMany({ where: { planNo, status: "proposed" } });
  if (proposals.length > 0) {
    await prisma.reallocationMove.createMany({
      data: proposals.map((p) => ({
        planNo,
        fromBom: p.fromBom,
        toBom: p.toBom,
        dept: p.dept,
        item: p.item,
        qty: p.qty,
        date: new Date(),
        reason: `Excess ${p.fromBom} over target → deficit ${p.toBom} (same family)`,
        status: "proposed",
      })),
    });
  }
  revalidatePath("/boms");
  return { ok: true, info: `Computed ${proposals.length} reallocation proposal(s).` };
}

export async function decideMove(formData: FormData): Promise<ActionResult> {
  const guard = await requirePerm("boms.manage");
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(formData.get("id"));
  const decision = String(formData.get("decision") ?? "");
  if (!Number.isInteger(id) || (decision !== "approved" && decision !== "rejected"))
    return { ok: false, error: "Invalid decision." };
  const move = await prisma.reallocationMove.findUnique({ where: { id } });
  if (!move) return { ok: false, error: "Move not found." };
  await prisma.reallocationMove.update({
    where: { id },
    data: { status: decision, decidedAt: new Date() },
  });
  revalidatePath("/boms");
  return { ok: true };
}
