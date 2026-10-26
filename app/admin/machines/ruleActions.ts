"use server";

import { revalidatePath } from "next/cache";
import { requirePerm } from "@/lib/server/auth";
import { addMachineRule, setMachineRuleActive } from "@/lib/server/machineRules";

// The machines' rules — what each takes, never takes, or is preferred for —
// kept with the machines list (machines.manage). The machine plan follows them.

export interface RuleActionResult {
  ok: boolean;
  error?: string;
  id?: number;
}

const num = (v: FormDataEntryValue | null): number | null => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

function revalidate() {
  for (const p of ["/admin/machines", "/worklist/cut", "/worklist/welding", "/worklist/painting"]) revalidatePath(p);
}

export async function createMachineRule(fd: FormData): Promise<RuleActionResult> {
  const guard = await requirePerm("machines.manage");
  if (guard.error) return { ok: false, error: guard.error };
  const machineId = Number(fd.get("machineId"));
  if (!Number.isInteger(machineId) || machineId <= 0) return { ok: false, error: "Pick the machine." };
  const r = await addMachineRule(machineId, {
    effect: String(fd.get("effect") ?? ""),
    item: String(fd.get("item") ?? ""),
    line: String(fd.get("line") ?? ""),
    minThicknessMm: num(fd.get("minThicknessMm")),
    maxThicknessMm: num(fd.get("maxThicknessMm")),
    material: String(fd.get("material") ?? ""),
    minKva: num(fd.get("minKva")),
    maxKva: num(fd.get("maxKva")),
    note: String(fd.get("note") ?? ""),
  }, guard.user!.name);
  if (!r.ok) return { ok: false, error: r.error };
  revalidate();
  return { ok: true, id: r.rule.id };
}

/** Take a rule off (it stays, inactive) or put it back. */
export async function setMachineRuleOn(fd: FormData): Promise<RuleActionResult> {
  const guard = await requirePerm("machines.manage");
  if (guard.error) return { ok: false, error: guard.error };
  const id = Number(fd.get("id"));
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "Invalid rule." };
  const r = await setMachineRuleActive(id, fd.get("active") === "true", guard.user!.name);
  if (!r.ok) return { ok: false, error: r.error };
  revalidate();
  return { ok: true, id };
}
