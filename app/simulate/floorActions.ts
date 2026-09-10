"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePerm } from "@/lib/server/auth";
import { parseLayout } from "@/lib/domain/floor";
import { isShiftDept } from "@/lib/domain/shifts";

// The Floor canvas's writes: the drawn layout of a department, and new
// welding partitions (a partition is a Machine row of the welding bay, so
// the shift log, the board and the worklist know it like any machine).
// Drawing the floor is the planner's job — it sits with machines.manage,
// the same key that keeps the machines list.

export interface FloorActionResult {
  ok: boolean;
  error?: string;
  /** createPartition: the new machine's id, so the canvas can place it at once. */
  id?: number;
}

function revalidate() {
  for (const p of ["/simulate", "/shifts", "/worklist/welding", "/admin/machines"]) revalidatePath(p);
}

export async function saveFloorLayout(fd: FormData): Promise<FloorActionResult> {
  const guard = await requirePerm("machines.manage");
  if (guard.error) return { ok: false, error: guard.error };
  const dept = String(fd.get("dept") ?? "");
  if (!isShiftDept(dept)) return { ok: false, error: "Pick a department." };
  let raw: unknown;
  try {
    raw = JSON.parse(String(fd.get("layout") ?? ""));
  } catch {
    return { ok: false, error: "The layout could not be read — reload the page and try again." };
  }
  const layout = parseLayout(raw);
  // a machine node has to be one of this department's machines
  const ids = layout.nodes.filter((n) => n.kind === "machine").map((n) => n.machineId!);
  if (ids.length > 0) {
    const known = await prisma.machine.findMany({ where: { id: { in: ids }, dept }, select: { id: true } });
    const ok = new Set(known.map((m) => m.id));
    layout.nodes = layout.nodes.filter((n) => n.kind !== "machine" || ok.has(n.machineId!));
  }
  await prisma.floorLayout.upsert({
    where: { dept },
    create: { dept, data: layout as object, updatedBy: guard.user?.name ?? null },
    update: { data: layout as object, updatedBy: guard.user?.name ?? null },
  });
  revalidate();
  return { ok: true };
}

/** A new partition of the welding bay: a Machine row (dept Welding, centre
 *  Zone) under the next free code W-1, W-2 … or the code typed. */
export async function createPartition(fd: FormData): Promise<FloorActionResult> {
  const guard = await requirePerm("machines.manage");
  if (guard.error) return { ok: false, error: guard.error };
  const dept = String(fd.get("dept") ?? "");
  if (!isShiftDept(dept)) return { ok: false, error: "Pick a department." };
  const name = String(fd.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Name the partition (e.g. Bay A, Tank welding 1)." };
  let code = String(fd.get("code") ?? "").trim().toUpperCase();
  const prefix = dept === "Welding" ? "W" : dept === "Painting" ? "PL" : dept === "ShotBlast" ? "SB" : "M";
  if (!code) {
    const existing = await prisma.machine.findMany({ where: { code: { startsWith: `${prefix}-` } }, select: { code: true } });
    const taken = new Set(existing.map((m) => m.code));
    let n = 1;
    while (taken.has(`${prefix}-${n}`)) n += 1;
    code = `${prefix}-${n}`;
  } else if (await prisma.machine.findUnique({ where: { code } })) {
    return { ok: false, error: `Code ${code} is already taken.` };
  }
  const center = dept === "Welding" ? "Zone" : dept === "Cut" ? "Cutting" : "Line";
  const last = await prisma.machine.aggregate({ where: { dept }, _max: { sortOrder: true } });
  const created = await prisma.machine.create({ data: { code, name, dept, center, sortOrder: (last._max.sortOrder ?? 0) + 1 } });
  revalidate();
  return { ok: true, id: created.id };
}
