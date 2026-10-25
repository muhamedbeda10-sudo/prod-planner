import "server-only";
import { prisma } from "@/lib/db";
import { WORKER_SECTIONS } from "@/lib/domain/tanks";
import { addDaysISO } from "@/lib/domain/dateSlicer";
import { factoryDayISO, factoryDayStart } from "@/lib/domain/dates";
import { consumablesStats, previousPeriod, type ConsumablesStats } from "@/lib/domain/consumablesStats";
import {
  canEditIssue,
  departmentLabel,
  departmentWorkers,
  describeSnapshot,
  factoryDateTimeLabel,
  groupLabel,
  issueWho,
  parseSnapshot,
  snapshotChanges,
} from "@/lib/domain/consumables";
import { getAllWorkers } from "./workers";
import { ALL_DEPARTMENTS, parseDepartments } from "@/lib/domain/consumableLimits";

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
  /** The one worker it went to — null for a group hand-out. */
  worker: { id: number; empId: string; name: string; active: boolean } | null;
  /** A hand-out to several workers or a whole department: its label and the
   *  workers it was for (fixed when it was recorded). */
  group: { scope: "workers" | "department"; label: string; workers: { id: number; empId: string; name: string }[] } | null;
  notes: string | null;
  issuedAtLabel: string;
  recordedBy: string;
  edited: { by: string; atLabel: string } | null;
  /** The catalogue item; null for an item typed by hand. */
  itemId: number | null;
  uom: string | null;
  /** Recorded over a limit: the reason the recorder gave and the breach as it read. */
  overLimit: { reason: string | null; note: string | null } | null;
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

const RECIPIENTS_SELECT = {
  select: { worker: { select: { id: true, empId: true, name: true } } },
  orderBy: { worker: { name: "asc" as const } },
};

function groupOf(r: { workerId: number | null; recipientScope: string; department: string; recipients: { worker: { id: number; empId: string; name: string } }[] }): ConsumableIssueView["group"] {
  if (r.workerId !== null) return null;
  const scope = r.recipientScope === "department" ? "department" : "workers";
  const workers = r.recipients.map((x) => x.worker);
  return { scope, label: groupLabel(scope, r.department, workers), workers };
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
  /** The catalogue the item dropdown offers: the active items, and any
   *  retired one a row on screen still points at (so its edit shows it). */
  catalogue: CatalogueOption[];
}

export interface CatalogueOption {
  id: number;
  code: string | null;
  name: string;
  uom: string;
  active: boolean;
  /** The departments its limits cover ("*" = all) — the dropdown lists the
   *  items meant for the department picked first. */
  departments: typeof ALL_DEPARTMENTS | string[];
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
  // groupBy: Prisma's `distinct` dedupes in memory after fetching every row
  const rows = await prisma.consumableIssue.groupBy({
    by: ["department"],
    where: { deletedAt: null, department: { notIn: SECTION_CODES } },
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

  const [rows, custom, workers, items, catalogue] = await Promise.all([
    prisma.consumableIssue.findMany({
      where: { deletedAt: null, issuedAt: { gte, lt } },
      orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
      include: {
        worker: { select: { id: true, empId: true, name: true, active: true } },
        recipients: RECIPIENTS_SELECT,
        catalog: { select: { uom: true } },
        // the history is the admin's — not even fetched for anyone else
        ...(viewer.isAdmin ? { revisions: { orderBy: { id: "desc" as const } } } : {}),
      },
    }),
    getCustomDepartments(),
    getAllWorkers(),
    prisma.consumableIssue.groupBy({
      by: ["item"],
      where: { deletedAt: null },
      orderBy: { item: "asc" },
      take: 500,
    }),
    prisma.consumableItem.findMany({
      orderBy: { name: "asc" },
      select: { id: true, code: true, name: true, uom: true, active: true, limits: { select: { departments: true } } },
    }),
  ]);

  // the dropdown: active items, and the retired ones a row on screen points at
  const onScreen = new Set(rows.map((r) => r.itemId).filter((x): x is number => x !== null));
  const catalogueOptions: CatalogueOption[] = catalogue
    .filter((c) => c.active || onScreen.has(c.id))
    .map((c) => {
      const all = c.limits.some((l) => parseDepartments(l.departments) === ALL_DEPARTMENTS);
      const depts = [...new Set(c.limits.flatMap((l) => { const d = parseDepartments(l.departments); return d === ALL_DEPARTMENTS ? [] : d; }))];
      return { id: c.id, code: c.code, name: c.name, uom: c.uom, active: c.active, departments: all ? ALL_DEPARTMENTS : depts };
    });

  return {
    catalogue: catalogueOptions,
    entries: rows.map((r) => ({
      id: r.id,
      item: r.item,
      qty: r.qty.toNumber(),
      department: r.department,
      departmentLabel: departmentLabel(r.department),
      worker: r.worker,
      group: groupOf(r),
      notes: r.notes,
      issuedAtLabel: factoryDateTimeLabel(r.issuedAt),
      recordedBy: r.recordedBy,
      edited: r.editedAt && r.editedBy ? { by: r.editedBy, atLabel: factoryDateTimeLabel(r.editedAt) } : null,
      itemId: r.itemId,
      uom: r.catalog?.uom ?? null,
      overLimit: r.overLimit ? { reason: r.overLimitReason, note: r.overLimitNote } : null,
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
    include: { issue: { include: { worker: { select: { empId: true, name: true } }, recipients: RECIPIENTS_SELECT } } },
  });
  return revs.map((v) => {
    const i = v.issue;
    const who = issueWho(i);
    const now = {
      item: i.item, qty: i.qty.toNumber(), department: i.department,
      workerId: i.workerId ?? 0, workerEmpId: who.empId, workerName: who.name, notes: i.notes,
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
 *  into cards, charts and tables, and the count of the period just before.
 *  A group hand-out is one hand-out, to "the group" of its department — one
 *  entry among the workers, not a hand-out per man. */
export async function getConsumablesDashboard(fromISO: string, toISO: string): Promise<ConsumablesStats> {
  const { gte, lt } = periodBounds(fromISO, toISO);
  const prev = previousPeriod(fromISO, toISO);
  const prevBounds = periodBounds(prev.fromISO, prev.toISO);
  const [rows, previousCount, allWorkers, first] = await Promise.all([
    prisma.consumableIssue.findMany({
      where: { deletedAt: null, issuedAt: { gte, lt } },
      select: {
        item: true, qty: true, department: true, workerId: true, issuedAt: true,
        worker: { select: { name: true, empId: true } },
      },
    }),
    prisma.consumableIssue.count({ where: { deletedAt: null, issuedAt: { gte: prevBounds.gte, lt: prevBounds.lt } } }),
    getAllWorkers(),
    prisma.consumableIssue.findFirst({ where: { deletedAt: null }, orderBy: { issuedAt: "asc" }, select: { issuedAt: true } }),
  ]);
  // the period before is only a comparison if the log already ran for all
  // of it — against a part of one, "▲ 400%" is the log's start, not the store
  const previousIssues = first && factoryDayISO(first.issuedAt) <= prev.fromISO ? previousCount : null;
  // hand-outs are the department's: every row counts under its department
  // (an older row's worker is not read), one stand-in id per department
  const groupIds = new Map<string, number>();
  const groupId = (department: string) => {
    if (!groupIds.has(department)) groupIds.set(department, -(groupIds.size + 1));
    return groupIds.get(department)!;
  };
  return consumablesStats(
    rows.map((r) => ({
      item: r.item,
      qty: r.qty.toNumber(),
      department: r.department,
      departmentLabel: departmentLabel(r.department),
      workerId: groupId(r.department),
      workerName: departmentLabel(r.department),
      empId: "",
      dayISO: factoryDayISO(r.issuedAt),
      hour: Number(CAIRO_HOUR.format(r.issuedAt)) % 24,
    })),
    fromISO,
    toISO,
    previousIssues,
    { headcount: departmentWorkers(allWorkers) },
  );
}
