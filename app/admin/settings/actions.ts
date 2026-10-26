"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/server/auth";
import { DEFAULTS } from "@/lib/domain/constants";
import { normalizeOdooTrackingStart } from "@/lib/domain/trackerOdoo";

// Plant-wide settings. Right now that is the master switch for per-piece tank
// tracking; the row it lives on (Settings, id 1) also carries the lead times
// and capacity defaults.

export interface SettingsActionResult {
  ok: boolean;
  error?: string;
}

/** The shared baseline for monthly Odoo allocation, independently of imported history. */
export async function saveOdooTrackingStart(formData: FormData): Promise<SettingsActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };
  const value = String(formData.get("date") ?? formData.get("month") ?? "").trim();
  const date = normalizeOdooTrackingStart(value);
  if (value && !date) return { ok: false, error: "Choose a valid starting date." };
  await prisma.settings.upsert({ where: { id: 1 }, create: { id: 1, odooTrackingFrom: date }, update: { odooTrackingFrom: date } });
  for (const path of ["/admin/settings", "/tracker", "/trace"]) revalidatePath(path);
  return { ok: true };
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
    "/",
  ]) {
    revalidatePath(p);
  }
  // the nav itself gains and loses two tabs
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function setMachinePlanning(formData: FormData): Promise<SettingsActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };

  const on = formData.get("on") === "true";
  await prisma.settings.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      leadCut: DEFAULTS.leadCut,
      leadWeld: DEFAULTS.leadWeld,
      capacityPerItem: DEFAULTS.capacityPerItem,
      dailyTarget: DEFAULTS.dailyTarget,
      machinePlanning: on,
    },
    update: { machinePlanning: on },
  });
  for (const p of ["/admin/settings", "/worklist/cut", "/worklist/welding", "/worklist/painting", "/worklist/machines"]) revalidatePath(p);
  // the bar's Floor tab (the worklists) and the machine pages come and go with it
  revalidatePath("/", "layout");
  return { ok: true };
}

/** The hours the plant's two shifts and the "+OT" button are worth. Every
 *  man-hour the app counts — the shift log, a machine's crew, the day's
 *  capacity — is measured with these, so they are the planner's to set. */
export async function saveShiftHours(formData: FormData): Promise<SettingsActionResult> {
  const guard = await requireAdmin();
  if (guard.error) return { ok: false, error: guard.error };

  const read = (k: string, what: string): number | { error: string } => {
    const n = Number(String(formData.get(k) ?? "").trim());
    if (!Number.isFinite(n) || n < 0 || n > 24) return { error: `${what} must be between 0 and 24 hours.` };
    return Math.round(n * 100) / 100;
  };
  const short = read("shiftShortH", "The day shift");
  const long = read("shiftLongH", "The night shift");
  const overtime = read("overtimeH", "Day overtime");
  const nightOvertime = formData.has("nightOvertimeH") ? read("nightOvertimeH", "Night overtime") : undefined;
  for (const v of [short, long, overtime, nightOvertime]) if (typeof v === "object") return { ok: false, error: v.error };
  const hours = { shiftShortH: short as number, shiftLongH: long as number, overtimeH: overtime as number, ...(typeof nightOvertime === "number" ? { nightOvertimeH: nightOvertime } : {}) };
  if (hours.shiftShortH <= 0 || hours.shiftLongH <= 0) return { ok: false, error: "A shift has to be longer than nothing." };

  await prisma.settings.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      leadCut: DEFAULTS.leadCut,
      leadWeld: DEFAULTS.leadWeld,
      capacityPerItem: DEFAULTS.capacityPerItem,
      dailyTarget: DEFAULTS.dailyTarget,
      ...hours,
    },
    update: hours,
  });
  // the day's man-hours are recomputed as they are read, so every screen that
  // shows them wants refreshing
  for (const p of ["/admin/settings", "/shifts", "/worklist/cut", "/worklist/welding", "/worklist/painting", "/admin/standard-times"]) revalidatePath(p);
  return { ok: true };
}
