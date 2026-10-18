import "server-only";
import type { MachineRule } from "@prisma/client";
import { prisma } from "@/lib/db";
import { checkRule, type MachineRuleLike, type MachineRuleView, type RuleInput } from "@/lib/domain/machineRules";

// The machines' rules (MachineRule) — what each machine takes, never takes or
// is preferred for. The machine plan reads the active ones; the writes are the callers'
// to guard (machines.manage), and a rule taken off stays, inactive.

/** The active rules of a department's machines. */
export async function getActiveMachineRules(dept: string): Promise<MachineRuleLike[]> {
  return prisma.machineRule.findMany({ where: { active: true, machine: { dept } }, orderBy: { id: "asc" } });
}

/** Every rule of every machine, the retired ones too — the machines page. */
export async function getAllMachineRules(): Promise<MachineRuleView[]> {
  const rows = await prisma.machineRule.findMany({ orderBy: [{ machineId: "asc" }, { id: "asc" }] });
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() }));
}

export async function addMachineRule(machineId: number, input: RuleInput, by: string): Promise<{ ok: true; rule: MachineRule } | { ok: false; error: string }> {
  const machine = await prisma.machine.findUnique({ where: { id: machineId }, select: { id: true } });
  if (!machine) return { ok: false, error: "That machine is not on the list." };
  const c = checkRule(input);
  if (!c.ok) return c;
  const rule = await prisma.machineRule.create({ data: { machineId, ...c.rule, createdBy: by, updatedBy: by } });
  return { ok: true, rule };
}

export async function setMachineRuleActive(id: number, active: boolean, by: string): Promise<{ ok: true; rule: MachineRule } | { ok: false; error: string }> {
  const rule = await prisma.machineRule.findUnique({ where: { id } });
  if (!rule) return { ok: false, error: `Rule #${id} is not there.` };
  if (rule.active === active) return { ok: true, rule };
  return { ok: true, rule: await prisma.machineRule.update({ where: { id }, data: { active, updatedBy: by } }) };
}
