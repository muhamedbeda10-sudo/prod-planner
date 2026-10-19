"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { CENTERS, isShiftDept } from "@/lib/domain/shifts";

// The machines list: every laser, punch, press, line and cabinet the shift
// log and the worklists can name. Retiring is the way to take one out of
// service — deleting is only offered while no day has used it.

export interface MachineActionResult {
  ok: boolean;
  error?: string;
}

const PATHS = ["/admin/machines", "/shifts", "/worklist/cut", "/worklist/painting"];

function revalidate() {
  for (const p of PATHS) revalidatePath(p);
}

function readForm(formData: FormData) {
  const dept = String(formData.get("dept") ?? "").trim();
  const hoursRaw = String(formData.get("hoursPerDay") ?? "").trim();
  const hours = hoursRaw === "" ? null : Number(hoursRaw);
  return {
    code: String(formData.get("code") ?? "").trim().toUpperCase(),
    name: String(formData.get("name") ?? "").trim(),
    dept,
    center: String(formData.get("center") ?? "").trim(),
    hoursPerDay: hours,
    sortOrder: Number(formData.get("sortOrder") ?? 0) || 0,
  };
}

function validate(f: ReturnType<typeof readForm>): string | null {
  if (!f.code) return "Enter the machine's code (B4-10).";
  if (!f.name) return "Enter the machine's name.";
  if (!isShiftDept(f.dept)) return "Pick the department.";
  if (f.center && !CENTERS[f.dept].includes(f.center)) return `"${f.center}" is not a work centre of ${f.dept}.`;
  if (f.hoursPerDay !== null && (!Number.isFinite(f.hoursPerDay) || f.hoursPerDay < 0 || f.hoursPerDay > 24)) return "Hours a day must be between 0 and 24.";
  return null;
}

export async function createMachine(formData: FormData): Promise<MachineActionResult> {
  const guard = await requirePerm("machines.manage");
  if (guard.error) return { ok: false, error: guard.error };
  const f = readForm(formData);
  const bad = validate(f);
  if (bad) return { ok: false, error: bad };
  if (await prisma.machine.findUnique({ where: { code: f.code } })) return { ok: false, error: `Code ${f.code} is already taken.` };
  await prisma.machine.create({ data: f });
  revalidate();
  return { ok: true };
}

export async function updateMachine(formData: FormData): Promise<MachineActionResult> {
  const guard = await requirePerm("machines.manage");
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid machine." };
  const f = readForm(formData);
  const bad = validate(f);
  if (bad) return { ok: false, error: bad };
  const clash = await prisma.machine.findUnique({ where: { code: f.code } });
  if (clash && clash.id !== id) return { ok: false, error: `Code ${f.code} is already taken.` };
  await prisma.machine.update({ where: { id }, data: f });
  revalidate();
  return { ok: true };
}

/** Take a machine out of service / bring it back. A retired machine stays on
 *  the days it was used; it just stops being offered. */
export async function setMachineActive(formData: FormData): Promise<MachineActionResult> {
  const guard = await requirePerm("machines.manage");
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(formData.get("id"));
  const active = formData.get("active") === "true";
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid machine." };
  await prisma.machine.update({ where: { id }, data: { active } });
  revalidate();
  return { ok: true };
}

/** Delete outright — refused once any shift, downtime or Daily log row names
 *  it: deleting would strip the machine off the output recorded on it (and
 *  with it the measured rates), so it is retired instead. */
export async function deleteMachine(formData: FormData): Promise<MachineActionResult> {
  const guard = await requirePerm("machines.manage");
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid machine." };
  const [shifts, downs, output] = await Promise.all([
    prisma.shiftEntry.count({ where: { machineId: id } }),
    prisma.machineDowntime.count({ where: { machineId: id } }),
    prisma.handoverEntry.count({ where: { machineId: id } }),
  ]);
  if (shifts > 0 || downs > 0 || output > 0) {
    return { ok: false, error: `It is on ${shifts} shift row(s), ${downs} downtime row(s) and ${output} Daily log row(s) — retire it instead of deleting, so that history keeps its machine.` };
  }
  await prisma.machine.delete({ where: { id } });
  revalidate();
  return { ok: true };
}
