"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/server/auth";
import { DEFAULTS } from "@/lib/domain/constants";

// Plant-wide settings. Right now that is the master switch for per-piece tank
// tracking; the row it lives on (Settings, id 1) also carries the lead times
// and capacity defaults.

export interface SettingsActionResult {
  ok: boolean;
  error?: string;
}

export async function setTankTracking(formData: FormData): Promise<SettingsActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };

  const on = formData.get("on") === "true";

  // the settings row is created on first use, like everywhere else that reads it
  await prisma.settings.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      leadCut: DEFAULTS.leadCut,
      leadWeld: DEFAULTS.leadWeld,
      capacityPerItem: DEFAULTS.capacityPerItem,
      dailyTarget: DEFAULTS.dailyTarget,
      tankTracking: on,
    },
    update: { tankTracking: on },
  });

  // the switch changes what every production screen offers, so refresh them all
  for (const p of [
    "/admin/settings",
    "/worklist/cut",
    "/worklist/welding",
    "/worklist/leak-test",
    "/worklist/painting",
    "/barcode",
    "/handover",
    "/tracker",
    "/trace",
    "/report",
    "/",
  ]) {
    revalidatePath(p);
  }
  // the nav itself gains and loses two tabs
  revalidatePath("/", "layout");
  return { ok: true };
}
