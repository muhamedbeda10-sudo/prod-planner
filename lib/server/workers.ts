import "server-only";
import { prisma } from "@/lib/db";
import { WORKER_DEPTS, isWorkerDept, normalizeEmpId, type WorkerDept } from "@/lib/domain/tanks";

// The shop-floor people credited with a tank operation. They are NOT app
// accounts — a welder rarely has a login, but his name has to end up on the
// tank's record. The admin keeps the list; the worklists only read it.

export interface WorkerDTO {
  id: number;
  /** The badge number — what the shop floor types to identify the man. */
  empId: string;
  name: string;
  jobTitle: string | null;
  /** The single letter beside a welder on the workforce sheet. */
  mark: string | null;
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

function toDTO(w: {
  id: number; empId: string; name: string; jobTitle: string | null; mark: string | null;
  depts: string; active: boolean;
}): WorkerDTO {
  return {
    id: w.id, empId: w.empId, name: w.name, jobTitle: w.jobTitle, mark: w.mark,
    depts: parseWorkerDepts(w.depts), active: w.active,
  };
}



/** Everyone on the list, admin order (active first, then by badge number —
 *  the sheet the admin is copying from is ordered that way). */
export async function getAllWorkers(): Promise<WorkerDTO[]> {
  const rows = await prisma.worker.findMany({ orderBy: [{ active: "desc" }, { empId: "asc" }] });
  return rows.map(toDTO);
}

/** The ACTIVE workers of one department — exactly what a dropdown should offer.
 *  Deactivated workers stay on the tanks they already made; they just stop
 *  being offered for new work. */
export async function getWorkersFor(dept: WorkerDept): Promise<WorkerDTO[]> {
  const rows = await prisma.worker.findMany({ where: { active: true }, orderBy: { empId: "asc" } });
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
  if (!row) return { error: "That worker is not on the list — refresh the page." };
  const dto = toDTO(row);
  if (!dto.active) return { error: `${dto.name} is deactivated on the workers list — pick another name.` };
  if (!dto.depts.includes(dept)) return { error: `${dto.name} is not registered for this stage.` };
  return { worker: dto };
}

/** Look a worker up by the number the technician typed. Same refusals as
 *  resolveWorker, but phrased around the badge number, because that is what
 *  the person on the floor is looking at when the message appears. */
export async function resolveWorkerByEmpId(
  rawEmpId: string,
  dept: WorkerDept
): Promise<{ worker?: WorkerDTO; error?: string }> {
  const empId = normalizeEmpId(rawEmpId);
  if (!empId) return {};
  const row = await prisma.worker.findUnique({ where: { empId } });
  if (!row) return { error: `No worker has the ID ${empId}.` };
  const dto = toDTO(row);
  if (!dto.active) return { error: `${empId} — ${dto.name} is deactivated on the workers list.` };
  if (!dto.depts.includes(dept)) return { error: `${empId} — ${dto.name} is not registered for this stage.` };
  return { worker: dto };
}
