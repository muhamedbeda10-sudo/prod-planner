import "server-only";
import { prisma } from "@/lib/db";
import { normalizeEmpId, sectionDept, type WorkerDept, type WorkerSection } from "@/lib/domain/tanks";
import { factoryDayISO, toISODate } from "@/lib/domain/dates";
import { parseWorkerSections, serializeWorkerDepts } from "@/lib/domain/workers";

export { parseWorkerSections, serializeWorkerDepts };

// The shop-floor people credited with a tank operation. They are NOT app
// accounts — a welder rarely has a login, but his name has to end up on the
// tank's record. The admin keeps the list; the worklists only read it.

export interface WorkerDTO {
  id: number;
  /** The badge number — what the shop floor types to identify the man. */
  empId: string;
  name: string;
  jobTitle: string | null;
  /** The welder's stamp — the letter he punches into every tank he welds. */
  stamp: string | null;
  /** The sections the man is registered in (Laser Cutting TX, Welding USS/LV …). */
  sections: WorkerSection[];
  /** The departments those sections record on — what the dropdowns and the shift log ask for. */
  depts: WorkerDept[];
  active: boolean;
  /** ISO day he is away until (inclusive), null when at work. */
  vacationUntil: string | null;
  /** Away today — the column on the workers page, absent by default on the shift log. */
  onVacation: boolean;
}

function toDTO(w: {
  id: number; empId: string; name: string; jobTitle: string | null; stamp: string | null;
  depts: string; active: boolean; vacationUntil: Date | null;
}): WorkerDTO {
  const sections = parseWorkerSections(w.depts);
  const vacationUntil = w.vacationUntil ? toISODate(w.vacationUntil) : null;
  return {
    id: w.id, empId: w.empId, name: w.name, jobTitle: w.jobTitle, stamp: w.stamp,
    sections, depts: [...new Set(sections.map(sectionDept))], active: w.active,
    vacationUntil, onVacation: vacationUntil !== null && vacationUntil >= factoryDayISO(new Date()),
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
  return rows.map(toDTO).filter((w) => w.depts.includes(dept) && !w.onVacation);
}

/** The ACTIVE workers of one department INCLUDING those on vacation — the
 *  shift roster lists them (absent by default) so the day still adds up. */
export async function getRosterFor(dept: WorkerDept): Promise<WorkerDTO[]> {
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
