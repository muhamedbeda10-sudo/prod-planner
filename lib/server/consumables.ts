import "server-only";
import { prisma } from "@/lib/db";
import { WORKER_SECTIONS } from "@/lib/domain/tanks";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { factoryDayISO, factoryDayStart } from "@/lib/domain/dates";
import { consumablesStats, previousPeriod, type ConsumablesStats } from "@/lib/domain/consumablesStats";
import {
  canEditIssue,
  departmentLabel,
  describeSnapshot,
  factoryDateTimeLabel,
  parseSnapshot,
  snapshotChanges,
} from "@/lib/domain/consumables";
import { getAllWorkers } from "./workers";

// The CONSUMABLES tab's reads. Writes are app/consumables/actions.ts.
//
// The history of a row (who changed what, and the versions an admin can
// restore) is the admin's to read: it is only loaded, and only sent to the
// browser, for an admin.

export type ConsumableRevisionAction = "edit" | "delete" | "restore";

export interface ConsumableRevisionView {
  id: number;
  action: ConsumableRevisionAction;
  /** The row before the change, in one line. */
  before: string;
  /** The row after it, in one line — null for a delete, and for the few
   *  revisions written before "after" was kept. */
  after: string | null;
  /** "Qty: 10 → 8" — what changed, field by field (empty when unknown). */
  changes: string[];
  by: string;
  atLabel: string;
  /** Whether "restore this version" can work: the before-snapshot reads back. */
  restorable: boolean;
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
  /** Newest first — admin only (empty for everyone else). */
  revisions: ConsumableRevisionView[];
  /** The viewer may correct this row: his own, or any for an admin. */
  canEdit: boolean;
  /** The optimistic-lock token an edit, delete or restore sends back: the
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

/** One line of the admin's Edits view: a change and the row it was made to. */
export interface ConsumableEditView extends ConsumableRevisionView {
  issue: {
    id: number;
    /** The row as it reads now, in one line. */
    now: string;
    issuedAtLabel: string;
    recordedBy: string;
    deleted: { by: string | null; atLabel: string } | null;
    version: string;
  };
}

export interface ConsumablesViewer {
  id: number;
  isAdmin: boolean;
  canRecord: boolean;
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

function periodBounds(fromISO: string, toISO: string): { gte: Date; lt: Date } {
  const gte = factoryDayStart(fromISO);
  const lt = factoryDayStart(addDaysISO(toISO, 1));
  if (!gte || !lt) throw new Error(`Bad consumables period ${fromISO}..${toISO}`);
  return { gte, lt };
}

function revisionView(v: { id: number; action: string; before: unknown; after: unknown; by: string; at: Date }): ConsumableRevisionView {
  const before = parseSnapshot(v.before);
  const after = parseSnapshot(v.after);
  const action: ConsumableRevisionAction = v.action === "delete" ? "delete" : v.action === "restore" ? "restore" : "edit";
  return {
    id: v.id,
    action,
    before: describeSnapshot(before),
    after: after ? describeSnapshot(after) : null,
    changes: snapshotChanges(before, after),
    by: v.by,
    atLabel: factoryDateTimeLabel(v.at),
    restorable: before !== null,
  };
}

/** The log for factory days from..to, both included, newest first. */
export async function getConsumablesData(fromISO: string, toISO: string, viewer: ConsumablesViewer): Promise<ConsumablesPageData> {
  const { gte, lt } = periodBounds(fromISO, toISO);

  const [rows, custom, workers, items] = await Promise.all([
    prisma.consumableIssue.findMany({
      where: { deletedAt: null, issuedAt: { gte, lt } },
      orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
      include: {
        worker: { select: { id: true, empId: true, name: true, active: true } },
        // the history is the admin's — not even fetched for anyone else
        ...(viewer.isAdmin ? { revisions: { orderBy: { id: "desc" as const } } } : {}),
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
      revisions: "revisions" in r && Array.isArray(r.revisions) ? r.revisions.map(revisionView) : [],
      canEdit: canEditIssue(viewer, r),
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

/** Every change made in factory days from..to — edits, deletes and restores,
 *  newest first, each with the row it was made to. The admin's view: the
 *  caller checks. Deleted rows are included, so they can be brought back. */
export async function getConsumableEdits(fromISO: string, toISO: string): Promise<ConsumableEditView[]> {
  const { gte, lt } = periodBounds(fromISO, toISO);
  const revs = await prisma.consumableIssueRevision.findMany({
    where: { at: { gte, lt } },
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take: 1000,
    include: { issue: { include: { worker: { select: { empId: true, name: true } } } } },
  });
  return revs.map((v) => {
    const i = v.issue;
    const now = {
      item: i.item, qty: i.qty.toNumber(), department: i.department,
      workerId: i.workerId, workerEmpId: i.worker.empId, workerName: i.worker.name, notes: i.notes,
    };
    return {
      ...revisionView(v),
      issue: {
        id: i.id,
        now: describeSnapshot(now),
        issuedAtLabel: factoryDateTimeLabel(i.issuedAt),
        recordedBy: i.recordedBy,
        deleted: i.deletedAt ? { by: i.deletedBy, atLabel: factoryDateTimeLabel(i.deletedAt) } : null,
        version: i.updatedAt.toISOString(),
      },
    };
  });
}

const CAIRO_HOUR = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", hour: "2-digit", hourCycle: "h23" });

/** The dashboard for factory days from..to: the period's hand-outs worked
 *  into cards, charts and tables, and the count of the period just before. */
export async function getConsumablesDashboard(fromISO: string, toISO: string): Promise<ConsumablesStats> {
  const { gte, lt } = periodBounds(fromISO, toISO);
  const prev = previousPeriod(fromISO, toISO);
  const prevBounds = periodBounds(prev.fromISO, prev.toISO);
  const [rows, previousIssues] = await Promise.all([
    prisma.consumableIssue.findMany({
      where: { deletedAt: null, issuedAt: { gte, lt } },
      select: {
        item: true, qty: true, department: true, workerId: true, issuedAt: true,
        worker: { select: { name: true, empId: true } },
      },
    }),
    prisma.consumableIssue.count({ where: { deletedAt: null, issuedAt: { gte: prevBounds.gte, lt: prevBounds.lt } } }),
  ]);
  return consumablesStats(
    rows.map((r) => ({
      item: r.item,
      qty: r.qty.toNumber(),
      department: r.department,
      departmentLabel: departmentLabel(r.department),
      workerId: r.workerId,
      workerName: r.worker.name,
      empId: r.worker.empId,
      dayISO: factoryDayISO(r.issuedAt),
      hour: Number(CAIRO_HOUR.format(r.issuedAt)) % 24,
    })),
    fromISO,
    toISO,
    previousIssues,
  );
}
