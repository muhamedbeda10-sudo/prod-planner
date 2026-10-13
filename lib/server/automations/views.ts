import "server-only";
import { prisma } from "@/lib/db";
import { configOf } from "./store";
import { describeAction, describeTrigger, type AutomationTrigger } from "@/lib/domain/automations";

// Automations as the pages show them — the person's own, or (for the app's
// owner) everyone's — with their last runs.

export interface AutomationRunView {
  id: number;
  cause: string;
  status: string;
  startedAt: string;
  summary: string | null;
  error: string | null;
  costUsd: number;
}

export interface AutomationView {
  id: number;
  name: string;
  owner: string;
  ownerId: number;
  enabled: boolean;
  deleted: boolean;
  trigger: string;
  action: string;
  kind: string;
  conditionSql: string | null;
  text: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastNote: string | null;
  failures: number;
  createdBy: string | null;
  /** When it runs, as the timing form edits it. */
  timing: {
    trigger: AutomationTrigger;
    times: string[];
    days: string;
    weekdays: number[];
    checkEveryMin: number;
    activeFrom: string | null;
    activeTo: string | null;
  };
  runs: AutomationRunView[];
}

const RUNS = 8;

export async function automationViews(where: { ownerId?: number }): Promise<AutomationView[]> {
  const rows = await prisma.automation.findMany({
    where,
    orderBy: [{ deletedAt: "asc" }, { id: "desc" }],
    take: 200,
    include: { owner: { select: { name: true } }, runs: { orderBy: { id: "desc" }, take: RUNS } },
  });
  const ids = [...new Set(rows.flatMap((r) => [...r.recipientIds, ...r.eventActorIds]))];
  const names = new Map((ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name]));
  return rows.map((a) => {
    const c = configOf(a);
    return {
      id: a.id, name: a.name, owner: a.owner.name, ownerId: a.ownerId, enabled: a.enabled, deleted: !!a.deletedAt,
      trigger: describeTrigger(c, c.eventActorIds.map((r) => names.get(r) ?? `#${r}`)), action: describeAction(c, c.recipientIds.map((r) => names.get(r) ?? `#${r}`)), kind: c.action,
      conditionSql: c.conditionSql, text: c.message ?? c.prompt,
      nextRunAt: a.enabled ? a.nextRunAt?.toISOString() ?? null : null, lastRunAt: a.lastRunAt?.toISOString() ?? null,
      lastStatus: a.lastStatus, lastNote: a.lastNote, failures: a.failures, createdBy: a.createdBy,
      timing: { trigger: c.trigger, times: c.times, days: c.days, weekdays: c.weekdays, checkEveryMin: c.checkEveryMin, activeFrom: c.activeFrom, activeTo: c.activeTo },
      runs: a.runs.map((r) => ({ id: r.id, cause: r.cause, status: r.status, startedAt: r.startedAt.toISOString(), summary: r.summary, error: r.error, costUsd: r.costUsd })),
    };
  });
}
