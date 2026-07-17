"use server";

import { revalidatePath } from "next/cache";
import { importWeeklyPlan, type ImportResult } from "@/lib/server/import";
import { parseISODate } from "@/lib/domain/dates";
import { requirePerm } from "@/lib/server/auth";

export async function importPlanAction(formData: FormData): Promise<ImportResult> {
  const guard = await requirePerm("plans.import");
  if (guard.error) return { ok: false, error: guard.error };
  const file = formData.get("file");
  const planNo = Number(formData.get("planNo"));
  const startStr = String(formData.get("startDate") ?? "");

  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose an Excel file." };
  if (!Number.isInteger(planNo) || planNo <= 0) return { ok: false, error: "Enter a valid plan number." };
  const startDate = parseISODate(startStr);
  if (!startDate) return { ok: false, error: "Enter the real week start date (not taken from the file)." };

  const sheet = String(formData.get("sheet") ?? "").trim() || undefined;

  try {
    const buffer = await file.arrayBuffer();
    const res = await importWeeklyPlan(buffer, planNo, startDate, sheet);
    if (res.ok) revalidatePath("/import");
    return res;
  } catch (e) {
    // never crash the page — surface the failure as a readable message
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Import failed: ${msg}` };
  }
}
