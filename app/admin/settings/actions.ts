"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/server/auth";
import { clearAllTankRecords } from "@/lib/server/tanks";
import { DEFAULTS } from "@/lib/domain/constants";

// Plant-wide settings. Right now that is the master switch for per-piece tank
// tracking; the row it lives on (Settings, id 1) also carries the lead times
// and capacity defaults.

export interface SettingsActionResult {
  ok: boolean;
  error?: string;
  /** How many tanks a clear-out removed. */
  deleted?: number;
}

// every production screen the tank layer feeds
const TANK_PATHS = [
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
];

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
  for (const p of TANK_PATHS) revalidatePath(p);
  // the nav itself gains and loses two tabs
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Delete every tank record and let serials start from 1 again — the clean slate
 * after a trial run, and the only way to reach tanks the barcode tab cannot
 * show (anything not yet painted).
 *
 * `keepQuantities` decides whether the daily log is touched at all, and it is
 * the whole decision. Keeping them says the welding and painting really
 * happened and only the serials should go; not keeping them says the work was
 * test data that should never have counted.
 */
export async function clearTankRecords(formData: FormData): Promise<SettingsActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };

  const mode = String(formData.get("mode") ?? "");
  if (mode !== "keep-quantities" && mode !== "with-quantities") {
    return { ok: false, error: "Say whether the daily-log quantities should be kept." };
  }

  try {
    const res = await prisma.$transaction((tx) =>
      clearAllTankRecords(tx, { keepQuantities: mode === "keep-quantities" })
    );
    for (const p of TANK_PATHS) revalidatePath(p);
    return { ok: true, deleted: res.deleted };
  } catch (e) {
    return { ok: false, error: `Failed to clear: ${e instanceof Error ? e.message : String(e)}` };
  }
}
