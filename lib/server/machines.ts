import "server-only";
import { prisma } from "@/lib/db";

// The machines list — one row per laser, punch, press, line or cabinet. The
// admin keeps it; the shift log and the worklists read it.

export interface MachineDTO {
  id: number;
  code: string;
  name: string;
  dept: string;
  center: string;
  hoursPerDay: number | null;
  active: boolean;
  sortOrder: number;
}

function toDTO(m: { id: number; code: string; name: string; dept: string; center: string; hoursPerDay: number | null; active: boolean; sortOrder: number }): MachineDTO {
  return { id: m.id, code: m.code, name: m.name, dept: m.dept, center: m.center, hoursPerDay: m.hoursPerDay, active: m.active, sortOrder: m.sortOrder };
}

const ORDER = [{ dept: "asc" as const }, { sortOrder: "asc" as const }, { code: "asc" as const }];

/** Every machine, admin order: by department, then the sheet's order. */
export async function getAllMachines(): Promise<MachineDTO[]> {
  const rows = await prisma.machine.findMany({ orderBy: ORDER });
  return rows.map(toDTO);
}

/** The ACTIVE machines of one department — what a dropdown offers. A retired
 *  machine stays on the days it was used; it just stops being offered. */
export async function getMachinesFor(dept: string): Promise<MachineDTO[]> {
  const rows = await prisma.machine.findMany({ where: { dept, active: true }, orderBy: ORDER });
  return rows.map(toDTO);
}
