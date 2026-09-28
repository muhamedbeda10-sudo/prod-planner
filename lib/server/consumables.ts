import "server-only";
import { prisma } from "@/lib/db";
import { WORKER_SECTIONS } from "@/lib/domain/tanks";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { factoryDayStart } from "@/lib/domain/dates";
import { departmentLabel, factoryDateTimeLabel } from "@/lib/domain/consumables";
import { getAllWorkers } from "./workers";

// The CONSUMABLES tab's reads. Writes are app/consumables/actions.ts.

export interface ConsumableRevisionView {
  id: number;
  action: "edit" | "delete";
  /** The row as it stood before the change, in words. */
  before: string;
  by: string;
  atLabel: string;
}

export interface ConsumableIssueView {
  id: number;
  item: string;
  qty: number;
  department: string;
  departmentLabel: string;
  worker: { id: number; empId: string; name: string; active: boolean };
  notes: string | null;
  issuedAtLabel: string;
  recordedBy: string;
  edited: { by: string; atLabel: string } | null;
  revisions: ConsumableRevisionView[];
  /** The optimistic-lock token an admin's edit or delete sends back: the
   *  row's updatedAt when the page was drawn. */
  version: string;
}

export interface ConsumableWorkerOption {
  id: number;
  empId: string;
  name: string;
  sections: string[];
}

export interface ConsumablesPageData {
  entries: ConsumableIssueView[];
  /** The worker sections (in the workers page's order), then the departments
   *  typed on earlier rows, alphabetically. */
  departments: { sections: { code: string; label: string; group: string }[]; custom: string[] };
  /** Who the dropdown offers: active and at work today. */
  workers: ConsumableWorkerOption[];
  /** Items typed before — suggestions for the free-text item box. */
  knownItems: string[];
}

/** The snapshot kept on a revision. */
export interface ConsumableSnapshot {
  item: string;
  qty: number;
  department: string;
  workerId: number;
  workerEmpId: string;
  workerName: string;
  notes: string | null;
}

function describeSnapshot(raw: unknown): string {
  const s = (raw ?? {}) as Partial<ConsumableSnapshot>;
  const parts = [
    `${s.qty ?? "?"} × ${s.item ?? "?"}`,
    s.department ? departmentLabel(s.department) : null,
    s.workerName ? `${s.workerEmpId ?? ""} ${s.workerName}`.trim() : null,
    s.notes ? `“${s.notes}”` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

const SECTION_CODES = WORKER_SECTIONS.map((s) => s.code as string);

/** The departments typed on live rows that are not worker sections. A
 *  department whose every row was deleted leaves the dropdown with them. */
export async function getCustomDepartments(): Promise<string[]> {
  const rows = await prisma.consumableIssue.findMany({
    where: { deletedAt: null, department: { notIn: SECTION_CODES } },
    select: { department: true },
    distinct: ["department"],
    orderBy: { department: "asc" },
  });
  return rows.map((r) => r.department);
}

/** The log for factory days from..to, both included, newest first. */
export async function getConsumablesData(fromISO: string, toISO: string): Promise<ConsumablesPageData> {
  const gte = factoryDayStart(fromISO);
  const lt = factoryDayStart(addDaysISO(toISO, 1));
  if (!gte || !lt) throw new Error(`Bad consumables period ${fromISO}..${toISO}`);

  const [rows, custom, workers, items] = await Promise.all([
    prisma.consumableIssue.findMany({
      where: { deletedAt: null, issuedAt: { gte, lt } },
      orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
      include: {
        worker: { select: { id: true, empId: true, name: true, active: true } },
        revisions: { orderBy: { id: "desc" } },
      },
    }),
    getCustomDepartments(),
    getAllWorkers(),
    prisma.consumableIssue.findMany({
      where: { deletedAt: null },
      select: { item: true },
      distinct: ["item"],
      orderBy: { item: "asc" },
      take: 500,
    }),
  ]);

  return {
    entries: rows.map((r) => ({
      id: r.id,
      item: r.item,
      qty: r.qty.toNumber(),
      department: r.department,
      departmentLabel: departmentLabel(r.department),
      worker: r.worker,
      notes: r.notes,
      issuedAtLabel: factoryDateTimeLabel(r.issuedAt),
      recordedBy: r.recordedBy,
      edited: r.editedAt && r.editedBy ? { by: r.editedBy, atLabel: factoryDateTimeLabel(r.editedAt) } : null,
      revisions: r.revisions.map((v) => ({
        id: v.id,
        action: v.action === "delete" ? "delete" : "edit",
        before: describeSnapshot(v.before),
        by: v.by,
        atLabel: factoryDateTimeLabel(v.at),
      })),
      version: r.updatedAt.toISOString(),
    })),
    departments: {
      sections: WORKER_SECTIONS.map((s) => ({ code: s.code, label: s.label, group: s.group })),
      custom,
    },
    workers: workers
      .filter((w) => w.active && !w.onVacation)
      .map((w) => ({ id: w.id, empId: w.empId, name: w.name, sections: [...w.sections] })),
    knownItems: items.map((i) => i.item),
  };
}
