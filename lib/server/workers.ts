import "server-only";
import { prisma } from "@/lib/db";
import { WORKER_DEPTS, isWorkerDept, type WorkerDept } from "@/lib/domain/tanks";

// The shop-floor people credited with a tank operation. They are NOT app
// accounts — a welder rarely has a login, but his name has to end up on the
// tank's record. The admin keeps the list; the worklists only read it.

export interface WorkerDTO {
  id: number;
  name: string;
  code: string | null;
  depts: WorkerDept[];
  active: boolean;
}

/** Parse the stored CSV, dropping anything that is not a known department. */
export function parseWorkerDepts(csv: string | null | undefined): WorkerDept[] {
  const seen = new Set<string>();
  const out: WorkerDept[] = [];
  for (const raw of String(csv ?? "").split(",")) {
    const d = raw.trim();
    if (isWorkerDept(d) && !seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out;
}

/** Serialize a chosen set of departments back to the stored CSV, in the fixed
 *  order of WORKER_DEPTS so the value is stable however the form was ticked. */
export function serializeWorkerDepts(depts: Iterable<string>): string {
  const chosen = new Set([...depts].map((d) => d.trim()));
  return WORKER_DEPTS.filter((d) => chosen.has(d)).join(",");
}

function toDTO(w: { id: number; name: string; code: string | null; depts: string; active: boolean }): WorkerDTO {
  return { id: w.id, name: w.name, code: w.code, depts: parseWorkerDepts(w.depts), active: w.active };
}

/** Everyone on the list, admin order (active first, then by name). */
export async function getAllWorkers(): Promise<WorkerDTO[]> {
  const rows = await prisma.worker.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] });
  return rows.map(toDTO);
}

/** The ACTIVE workers of one department — exactly what a dropdown should offer.
 *  Deactivated workers stay on the tanks they already made; they just stop
 *  being offered for new work. */
export async function getWorkersFor(dept: WorkerDept): Promise<WorkerDTO[]> {
  const rows = await prisma.worker.findMany({ where: { active: true }, orderBy: { name: "asc" } });
  return rows.map(toDTO).filter((w) => w.depts.includes(dept));
}

/** Look one worker up for an action, refusing an inactive or unknown id.
 *  `dept` is the department the action credits them in. */
export async function resolveWorker(
  id: number | null,
  dept: WorkerDept
): Promise<{ worker?: WorkerDTO; error?: string }> {
  if (id === null) return {};
  const row = await prisma.worker.findUnique({ where: { id } });
  if (!row) return { error: "الاسم ده مش موجود ف قايمة العمال — اعمل ريفريش للصفحة." };
  const dto = toDTO(row);
  if (!dto.active) return { error: `${dto.name} متوقف ف قايمة العمال — اختار اسم تاني.` };
  if (!dto.depts.includes(dept)) return { error: `${dto.name} مش مسجّل ف القسم ده.` };
  return { worker: dto };
}
