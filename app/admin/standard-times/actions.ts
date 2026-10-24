"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/server/auth";
import { normFg } from "@/lib/domain/stdEngine";
import { readCentreTimes } from "@/lib/domain/centreTimes";
import { getCalibration, CAL_STAGES, type CalStage } from "@/lib/server/calibration";

export interface StdActionResult {
  ok: boolean;
  error?: string;
}

// every page whose figures are built on the standard times
function revalidate() {
  for (const p of ["/admin/standard-times", "/admin/machine-times", "/report", "/tracker", "/", "/shifts", "/cockpit", "/worklist/cut", "/worklist/welding", "/worklist/painting", "/simulate"]) revalidatePath(p);
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
  // its hours per work centre stay: unused while the class is gone, back with it (and its undo)
  await prisma.stdTime.deleteMany({ where: { kva } });
  revalidate();
  return { ok: true };
}

export interface CentreTimesResult extends StdActionResult {
  saved?: number;
  cleared?: number;
}

/** Save the planner's hours a piece per work centre. Fields are
 *  `c:<kva>:<item>:<centre>`; an empty one goes back to the estimate. */
export async function saveCentreTimes(fd: FormData): Promise<CentreTimesResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };
  const classes = new Set((await prisma.stdTime.findMany({ select: { kva: true } })).map((t) => t.kva));
  const edits = readCentreTimes(fd.entries(), classes);
  if ("error" in edits) return { ok: false, error: edits.error };
  if (edits.set.length === 0 && edits.clear.length === 0) return { ok: true, saved: 0, cleared: 0 };
  const by = guard.user?.name ?? null;
  const cleared = await prisma.$transaction(async (tx) => {
    const { count } = edits.clear.length
      ? await tx.centerStdTime.deleteMany({ where: { OR: edits.clear.map((c) => ({ kva: c.kva, item: c.item, center: c.center })) } })
      : { count: 0 };
    for (const s of edits.set) {
      await tx.centerStdTime.upsert({
        where: { kva_item_center: { kva: s.kva, item: s.item, center: s.center } },
        create: { ...s, setBy: by },
        update: { hoursPerPc: s.hoursPerPc, setBy: by },
      });
    }
    return count;
  });
  revalidate();
  return { ok: true, saved: edits.set.length, cleared };
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

/** One-click apply: rescale ONE stage's hours across every KVA class by the
 *  calibration factor. The factor is recomputed here, never read from the
 *  client — what gets applied is exactly what the table shows. */
export async function applyCalibration(fd: FormData): Promise<StdActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };

  const dept = String(fd.get("dept") ?? "") as CalStage;
  if (!CAL_STAGES.includes(dept)) return { ok: false, error: "Invalid stage." };

  const { stages } = await getCalibration();
  const cal = stages.find((s) => s.dept === dept);
  if (!cal?.ready || cal.factor === null) {
    return { ok: false, error: cal?.reason ? `Not ready to apply: ${cal.reason}.` : "Not ready to apply." };
  }

  const field = ({ Cut: "cutMh", Welding: "weldMh", ShotBlast: "shbMh", Painting: "paintMh" } as const)[dept];
  const tiers = await prisma.stdTime.findMany();
  await prisma.$transaction(
    tiers.map((t) =>
      prisma.stdTime.update({
        where: { kva: t.kva },
        data: { [field]: Math.round(t[field] * cal.factor! * 100) / 100 },
      })
    )
  );
  revalidate();
  return { ok: true };
}

// ---- LV panels: the timings sheet's LV tab ----

const LV_FIELDS = [["cutH", "Cutting"], ["bendH", "Bending"], ["weldH", "Welding"], ["shbH", "Shot blast"], ["paintH", "Paint line"]] as const;

/** Create or update one panel's standard hours per unit. */
export async function upsertLvStdTime(fd: FormData): Promise<StdActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };

  const fg = String(fd.get("fg") ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{3,}$/.test(fg)) return { ok: false, error: "Enter the panel's FG code as the sheet writes it (FG-SUSA-8569105)." };
  const hours = {} as Record<(typeof LV_FIELDS)[number][0], number>;
  for (const [f, label] of LV_FIELDS) {
    const v = num(fd.get(f));
    if (!Number.isFinite(v) || v < 0) return { ok: false, error: `${label} hours must be a number ≥ 0.` };
    hours[f] = v;
  }
  if (Object.values(hours).every((v) => v === 0)) return { ok: false, error: "A panel of all zeros would earn nothing — delete it instead." };
  const description = String(fd.get("description") ?? "").trim() || null;
  const kindRaw = String(fd.get("kind") ?? "USS").trim().toUpperCase();
  const kind = ["USS", "MB", "FP"].includes(kindRaw) ? kindRaw : "USS";

  await prisma.lvStdTime.upsert({ where: { fg }, create: { fg, description, kind, ...hours }, update: { description, kind, ...hours } });
  for (const p of ["/admin/standard-times", "/shifts"]) revalidatePath(p);
  return { ok: true };
}

export async function deleteLvStdTime(fd: FormData): Promise<StdActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };
  const fg = String(fd.get("fg") ?? "").trim().toUpperCase();
  await prisma.lvStdTime.deleteMany({ where: { fg } });
  for (const p of ["/admin/standard-times", "/shifts"]) revalidatePath(p);
  return { ok: true };
}
