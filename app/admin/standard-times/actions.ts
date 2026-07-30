"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/server/auth";
import { normFg } from "@/lib/domain/stdEngine";

export interface StdActionResult {
  ok: boolean;
  error?: string;
}

// every page whose figures are built on the standard times
function revalidate() {
  for (const p of ["/admin/standard-times", "/report", "/tracker"]) revalidatePath(p);
}

const num = (v: FormDataEntryValue | null): number => Number(String(v ?? "").trim());

/** Create or update a KVA class's stage hours (per tank). */
export async function upsertStdTier(fd: FormData): Promise<StdActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };

  const kva = num(fd.get("kva"));
  const cutMh = num(fd.get("cutMh"));
  const weldMh = num(fd.get("weldMh"));
  const shbMh = num(fd.get("shbMh"));
  const paintMh = num(fd.get("paintMh"));
  if (!Number.isInteger(kva) || kva <= 0) return { ok: false, error: "KVA must be a positive whole number." };
  for (const [label, v] of [["Fabrication", cutMh], ["Welding", weldMh], ["Shot Blast", shbMh], ["Painting", paintMh]] as const) {
    if (!Number.isFinite(v) || v < 0) return { ok: false, error: `${label} hours must be a number ≥ 0.` };
  }
  if (cutMh + weldMh + shbMh + paintMh === 0) return { ok: false, error: "A class of all zeros would price its tanks at nothing — delete the class instead." };

  await prisma.stdTime.upsert({
    where: { kva },
    create: { kva, cutMh, weldMh, shbMh, paintMh },
    update: { cutMh, weldMh, shbMh, paintMh },
  });
  revalidate();
  return { ok: true };
}

/** Delete a KVA class. FG codes still pointing at it fall back to the order's
 *  numeric KVA (nearest remaining class) — the engine handles it, but the UI
 *  warns with the count before asking. */
export async function deleteStdTier(fd: FormData): Promise<StdActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };

  const kva = num(fd.get("kva"));
  const remaining = await prisma.stdTime.count({ where: { kva: { not: kva } } });
  if (remaining === 0) return { ok: false, error: "The last class cannot be deleted — every figure in the app would go to zero." };
  await prisma.stdTime.deleteMany({ where: { kva } });
  revalidate();
  return { ok: true };
}

/** Per-stage available man-hours per WORKING DAY. */
export async function setStageCapacity(fd: FormData): Promise<StdActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };

  const dept = String(fd.get("dept") ?? "");
  if (!["Cut", "Welding", "ShotBlast", "Painting"].includes(dept)) return { ok: false, error: "Invalid stage." };
  const mhPerDay = num(fd.get("mhPerDay"));
  if (!Number.isFinite(mhPerDay) || mhPerDay < 0) return { ok: false, error: "Capacity must be a number ≥ 0." };

  await prisma.stageCapacity.upsert({
    where: { dept },
    create: { dept, mhPerDay },
    update: { mhPerDay },
  });
  revalidate();
  return { ok: true };
}

/** Map an FG code to a KVA class (create or repoint). */
export async function upsertFgMap(fd: FormData): Promise<StdActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };

  const fg = normFg(String(fd.get("fg") ?? ""));
  const kva = num(fd.get("kva"));
  if (!fg) return { ok: false, error: "Enter an FG code." };
  if (!(await prisma.stdTime.findUnique({ where: { kva } }))) {
    return { ok: false, error: `No ${kva} KVA class exists — add the class first.` };
  }
  await prisma.stdFgMap.upsert({ where: { fg }, create: { fg, kva }, update: { kva } });
  revalidate();
  return { ok: true };
}

export async function deleteFgMap(fd: FormData): Promise<StdActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };

  await prisma.stdFgMap.deleteMany({ where: { fg: normFg(String(fd.get("fg") ?? "")) } });
  revalidate();
  return { ok: true };
}
