"use server";

import { prisma } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { parseISODate } from "@/lib/domain/dates";
import { requirePerm } from "@/lib/server/auth";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

function revalidate() {
  for (const p of ["/calendar", "/"]) revalidatePath(p);
}

export async function addHoliday(formData: FormData): Promise<ActionResult> {
  const guard = await requirePerm("calendar.manage");
  if (guard.error) return { ok: false, error: guard.error };
  const date = parseISODate(String(formData.get("date") ?? ""));
  const name = String(formData.get("name") ?? "").trim();
  if (!date) return { ok: false, error: "Pick a date." };
  if (!name) return { ok: false, error: "Give the day a name (e.g. Eid al-Fitr)." };
  await prisma.holiday.upsert({
    where: { date },
    create: { date, name },
    update: { name },
  });
  revalidate();
  return { ok: true };
}

export async function deleteHoliday(formData: FormData): Promise<ActionResult> {
  const guard = await requirePerm("calendar.manage");
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid id." };
  const holiday = await prisma.holiday.findUnique({ where: { id } });
  if (!holiday) return { ok: false, error: "Holiday not found." };
  await prisma.holiday.delete({ where: { id } });
  revalidate();
  return { ok: true };
}
