"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { serializeWorkerDepts } from "@/lib/server/workers";
import { normalizeEmpId } from "@/lib/domain/tanks";

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
    empId: normalizeEmpId(String(formData.get("empId") ?? "")),
    name: String(formData.get("name") ?? "").trim(),
    jobTitle: String(formData.get("jobTitle") ?? "").trim(),
    stamp: String(formData.get("stamp") ?? "").trim().toUpperCase(),
    depts: serializeWorkerDepts(formData.getAll("depts").map(String)),
  };
}

export async function createWorker(formData: FormData): Promise<WorkerActionResult> {
  const guard = await requirePerm("workers.manage");
  if (guard.error) return { ok: false, error: guard.error };

  const { empId, name, jobTitle, stamp, depts } = readForm(formData);
  if (!empId) return { ok: false, error: "Enter the worker's ID — it is what the shop floor types." };
  if (!name) return { ok: false, error: "Enter the worker's name." };
  if (!depts) return { ok: false, error: "Pick at least one stage they work in." };
  if (await prisma.worker.findUnique({ where: { empId } })) {
    return { ok: false, error: `ID ${empId} is already taken by another worker.` };
  }
  if (await prisma.worker.findUnique({ where: { name } })) {
    return { ok: false, error: "A worker with this name already exists." };
  }

  await prisma.worker.create({
    data: { empId, name, jobTitle: jobTitle || null, stamp: stamp || null, depts },
  });
  revalidateWorkers();
  return { ok: true };
}

export async function updateWorker(formData: FormData): Promise<WorkerActionResult> {
  const guard = await requirePerm("workers.manage");
  if (guard.error) return { ok: false, error: guard.error };

  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid worker." };
  const { empId, name, jobTitle, stamp, depts } = readForm(formData);
  if (!empId) return { ok: false, error: "Enter the worker's ID — it is what the shop floor types." };
  if (!name) return { ok: false, error: "Enter the worker's name." };
  if (!depts) return { ok: false, error: "Pick at least one stage they work in." };

  const idClash = await prisma.worker.findUnique({ where: { empId } });
  if (idClash && idClash.id !== id) return { ok: false, error: `ID ${empId} is already taken by another worker.` };
  const clash = await prisma.worker.findUnique({ where: { name } });
  if (clash && clash.id !== id) return { ok: false, error: "Another worker already has this name." };

  await prisma.worker.update({
    where: { id },
    data: { empId, name, jobTitle: jobTitle || null, stamp: stamp || null, depts },
  });
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
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid worker." };

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
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid worker." };

  const [onTanks, onEvents] = await Promise.all([
    prisma.tankUnit.count({
      where: { OR: [{ weldedById: id }, { testedById: id }, { paintedById: id }, { qaById: id }] },
    }),
    prisma.tankEvent.count({ where: { workerId: id } }),
  ]);
  if (onTanks > 0 || onEvents > 0) {
    return {
      ok: false,
      error: `Their name is on ${onTanks} tank(s) and ${onEvents} history entries — deactivate them instead of deleting, so the record survives.`,
    };
  }

  await prisma.worker.delete({ where: { id } });
  revalidateWorkers();
  return { ok: true };
}
