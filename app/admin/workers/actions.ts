"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { serializeWorkerDepts } from "@/lib/server/workers";

// The shop-floor workers list: who can be credited with welding, testing,
// painting or checking a tank. Deactivating is the way to retire someone —
// deleting is only offered while nothing of theirs exists yet, so a finished
// tank never loses the name of the person who made it.

export interface WorkerActionResult {
  ok: boolean;
  error?: string;
}

const PATHS = ["/admin/workers", "/worklist/welding", "/worklist/leak-test", "/worklist/painting"];

function revalidateWorkers() {
  for (const p of PATHS) revalidatePath(p);
}

function readForm(formData: FormData) {
  return {
    name: String(formData.get("name") ?? "").trim(),
    code: String(formData.get("code") ?? "").trim(),
    depts: serializeWorkerDepts(formData.getAll("depts").map(String)),
  };
}

export async function createWorker(formData: FormData): Promise<WorkerActionResult> {
  const guard = await requirePerm("workers.manage");
  if (guard.error) return { ok: false, error: guard.error };

  const { name, code, depts } = readForm(formData);
  if (!name) return { ok: false, error: "اكتب اسم العامل." };
  if (!depts) return { ok: false, error: "اختار القسم اللى بيشتغل فيه على الأقل." };
  if (await prisma.worker.findUnique({ where: { name } })) {
    return { ok: false, error: "فيه عامل بنفس الاسم موجود بالفعل." };
  }

  await prisma.worker.create({ data: { name, code: code || null, depts } });
  revalidateWorkers();
  return { ok: true };
}

export async function updateWorker(formData: FormData): Promise<WorkerActionResult> {
  const guard = await requirePerm("workers.manage");
  if (guard.error) return { ok: false, error: guard.error };

  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "عامل غير صحيح." };
  const { name, code, depts } = readForm(formData);
  if (!name) return { ok: false, error: "اكتب اسم العامل." };
  if (!depts) return { ok: false, error: "اختار القسم اللى بيشتغل فيه على الأقل." };

  const clash = await prisma.worker.findUnique({ where: { name } });
  if (clash && clash.id !== id) return { ok: false, error: "فيه عامل تاني بنفس الاسم." };

  await prisma.worker.update({ where: { id }, data: { name, code: code || null, depts } });
  revalidateWorkers();
  return { ok: true };
}

/** Retire / bring back a worker. Inactive workers leave every dropdown but
 *  stay on the tanks they already made. */
export async function setWorkerActive(formData: FormData): Promise<WorkerActionResult> {
  const guard = await requirePerm("workers.manage");
  if (guard.error) return { ok: false, error: guard.error };

  const id = Number(formData.get("id"));
  const active = formData.get("active") === "on" || formData.get("active") === "true";
  if (!Number.isInteger(id)) return { ok: false, error: "عامل غير صحيح." };

  await prisma.worker.update({ where: { id }, data: { active } });
  revalidateWorkers();
  return { ok: true };
}

/** Delete a worker outright — refused the moment any tank or tank event
 *  credits them, because that record is the point of the whole feature. */
export async function deleteWorker(formData: FormData): Promise<WorkerActionResult> {
  const guard = await requirePerm("workers.manage");
  if (guard.error) return { ok: false, error: guard.error };

  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "عامل غير صحيح." };

  const [onTanks, onEvents] = await Promise.all([
    prisma.tankUnit.count({
      where: { OR: [{ weldedById: id }, { testedById: id }, { paintedById: id }, { qaById: id }] },
    }),
    prisma.tankEvent.count({ where: { workerId: id } }),
  ]);
  if (onTanks > 0 || onEvents > 0) {
    return {
      ok: false,
      error: `اسمه متسجّل على ${onTanks} تانك و${onEvents} حركة ف سجل التانكات — اعمله «إيقاف» بدل ما تمسحه علشان السجل مايضيعش.`,
    };
  }

  await prisma.worker.delete({ where: { id } });
  revalidateWorkers();
  return { ok: true };
}
