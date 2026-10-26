import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";

// The automations' clock. On a free plan the deployment's own cron runs once a
// day, so the database keeps the time instead: Supabase's pg_cron calls the
// tick endpoint through pg_net, with a secret. The secret and the address live
// in Supabase Vault (encrypted, as Supabase recommends), the job reads them
// from there, and the app keeps only the secret's SHA-256 to check it against.
// When the job is not set up, a page open in the app sends a tick now and then
// instead (components/AutomationTicker) — enough during the working day, not
// at night.
//
// Every call is a server function run and a dozen database reads, so the
// clock ticks every minute only through the plant's day — UTC 02:00-21:59,
// which is 04:00-23:59 Cairo in winter and 05:00-00:59 in summer — and every
// quarter hour in the small hours. Anything due then waits for the next
// quarter: a schedule outside the owner's hours is moved on, one inside them
// (no hours set) runs up to 14 minutes late, and the hourly housekeeping
// (lib/server/automations/runner.ts, minute 7) sits the night out. pg_cron
// keeps a row for every run and never clears them (the biggest table in the
// database within weeks), so a third job clears the rows older than a week
// each night.

const JOB = "atc-automations-tick";
/** The UTC hours the clock ticks every minute through; the rest is the night. */
const DAY_UTC_HOURS = { from: 2, to: 21 };
const NIGHT_UTC_HOURS = [...Array(24).keys()].filter((h) => h < DAY_UTC_HOURS.from || h > DAY_UTC_HOURS.to);
/** The jobs set-up schedules, removal takes away and the status compares against. */
const JOBS = [
  { name: JOB, schedule: `* ${DAY_UTC_HOURS.from}-${DAY_UTC_HOURS.to} * * *`, tick: true },
  { name: "atc-automations-tick-night", schedule: `*/15 ${NIGHT_UTC_HOURS.join(",")} * * *`, tick: true },
  // pg_cron's run log: a week is enough to see what went wrong
  { name: "atc-cron-cleanup", schedule: "30 2 * * *", tick: false },
] as const;
const CLEANUP_COMMAND = "DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days'";
const ALL_JOBS = JOBS.map((j) => j.name);
const TICK_JOBS = JOBS.filter((j) => j.tick).map((j) => j.name);
/** `jobname = $1 OR jobname = $2 …` for a list of names bound in that order. */
const namesAre = (names: readonly string[], column = "jobname") => names.map((_, i) => `${column} = $${i + 1}`).join(" OR ");
/** Whether the clock ticks every minute at this moment (else every quarter hour). */
export const everyMinuteAt = (at: Date) => at.getUTCHours() >= DAY_UTC_HOURS.from && at.getUTCHours() <= DAY_UTC_HOURS.to;
const SECRET_NAME = "atc_automations_tick_secret";
const URL_NAME = "atc_automations_tick_url";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Whether a request carries the tick secret ("Authorization: Bearer …"). */
export async function tickSecretOk(authorization: string | null): Promise<boolean> {
  const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(authorization ?? "");
  if (!m) return false;
  const s = await prisma.aiSettings.findUnique({ where: { id: 1 }, select: { tickSecretHash: true } });
  if (!s?.tickSecretHash) return false;
  const given = Buffer.from(sha256(m[1]), "hex");
  const kept = Buffer.from(s.tickSecretHash, "hex");
  return given.length === kept.length && timingSafeEqual(given, kept);
}

/** The tick endpoint's address: the production domain the deployment knows,
 *  else the address the owner is using. Only https, only this path. */
export function tickUrlFor(requestHost: string | null, requestProto: string | null): string | null {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || requestHost;
  if (!host || !/^[A-Za-z0-9.-]+(:\d{2,5})?$/.test(host)) return null;
  if ((requestProto ?? "https") !== "https" && !process.env.VERCEL_PROJECT_PRODUCTION_URL) return null;
  return `https://${host}/api/automations/tick`;
}

const dbError = (e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /Message:\s*`?([\s\S]*?)`?\s*$/.exec(msg) ?? /ERROR:\s*([\s\S]*)$/.exec(msg);
  return (m ? m[1] : msg).trim().slice(0, 500);
};

/** Keep one Vault secret under a name — made, or replaced. */
async function vaultPut(name: string, value: string): Promise<void> {
  const found = await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT id::text FROM vault.secrets WHERE name = $1`, name);
  // run, not read: these return nothing (or an id) that the app does not need
  if (found.length > 0) await prisma.$executeRawUnsafe(`SELECT vault.update_secret($1::uuid, $2)`, found[0].id, value);
  else await prisma.$executeRawUnsafe(`SELECT vault.create_secret($1, $2)`, value, name);
}

/** Set the clock up: the two extensions, the secret and the address in
 *  Vault, and the jobs — the tick through the day and the night, and the run
 *  log's nightly clearing. Run again, it replaces all of it (a new secret: the
 *  old one stops working at once). */
export async function setupScheduler(tickUrl: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const secret = randomBytes(32).toString("base64url");
  let step = "enabling pg_cron";
  try {
    await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog`);
    step = "enabling pg_net";
    await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pg_net`);
    step = "keeping the secret in Vault";
    await vaultPut(SECRET_NAME, secret);
    await vaultPut(URL_NAME, tickUrl);
    step = "scheduling the job";
    await prisma.$executeRawUnsafe(`SELECT cron.unschedule(jobid) FROM cron.job WHERE ${namesAre(ALL_JOBS)}`, ...ALL_JOBS);
    const command = [
      "SELECT net.http_post(",
      `  url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = '${URL_NAME}'),`,
      `  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = '${SECRET_NAME}')),`,
      "  body := '{}'::jsonb,",
      "  timeout_milliseconds := 10000",
      ")",
    ].join("\n");
    for (const job of JOBS) await prisma.$executeRawUnsafe(`SELECT cron.schedule($1, '${job.schedule}', $2)`, job.name, job.tick ? command : CLEANUP_COMMAND);
    step = "saving";
    await prisma.aiSettings.update({ where: { id: 1 }, data: { tickSecretHash: sha256(secret) } });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Failed while ${step}: ${dbError(e)}` };
  }
}

/** Take the clock away: the jobs go, and the secret stops working. */
export async function removeScheduler(): Promise<{ ok: true } | { ok: false; error: string }> {
  await prisma.aiSettings.update({ where: { id: 1 }, data: { tickSecretHash: "" } });
  try {
    await prisma.$executeRawUnsafe(`SELECT cron.unschedule(jobid) FROM cron.job WHERE ${namesAre(ALL_JOBS)}`, ...ALL_JOBS);
    return { ok: true };
  } catch (e) {
    // no pg_cron at all: nothing scheduled to take away
    const msg = dbError(e);
    return /schema "cron" does not exist|relation "cron.job" does not exist/i.test(msg) ? { ok: true } : { ok: false, error: msg };
  }
}

export interface SchedulerStatus {
  /** The day's tick job is in pg_cron, and the app holds its secret. */
  scheduled: boolean;
  /** Scheduled, but as an earlier version of the app set it up (one job, every
   *  minute, no run-log clearing): set up again to bring it up to date. */
  outdated: boolean;
  /** The last tick that ran, from anywhere. */
  lastTickAt: string | null;
  /** The tick jobs' last few runs as pg_cron saw them — what went wrong, if anything. */
  lastJobRuns: { at: string; status: string; message: string | null }[];
  error: string | null;
}

export async function schedulerStatus(): Promise<SchedulerStatus> {
  const s = await prisma.aiSettings.findUnique({ where: { id: 1 }, select: { tickSecretHash: true, lastTickAt: true } });
  const out: SchedulerStatus = { scheduled: false, outdated: false, lastTickAt: s?.lastTickAt?.toISOString() ?? null, lastJobRuns: [], error: null };
  try {
    const jobs = await prisma.$queryRawUnsafe<{ jobname: string; schedule: string }[]>(`SELECT jobname, schedule FROM cron.job WHERE ${namesAre(ALL_JOBS)}`, ...ALL_JOBS);
    const live = new Map(jobs.map((j) => [j.jobname, j.schedule]));
    out.scheduled = live.has(JOB) && !!s?.tickSecretHash;
    out.outdated = out.scheduled && JOBS.some((j) => live.get(j.name) !== j.schedule);
    if (TICK_JOBS.some((name) => live.has(name))) {
      const runs = await prisma.$queryRawUnsafe<{ at: Date; status: string; message: string | null }[]>(
        `SELECT d.start_time AS at, d.status, d.return_message AS message FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid WHERE ${namesAre(TICK_JOBS, "j.jobname")} ORDER BY d.start_time DESC LIMIT 3`,
        ...TICK_JOBS,
      );
      out.lastJobRuns = runs.map((r) => ({ at: new Date(r.at).toISOString(), status: r.status, message: r.message }));
    }
  } catch (e) {
    const msg = dbError(e);
    if (!/schema "cron" does not exist|relation "cron\.job" does not exist/i.test(msg)) out.error = msg;
  }
  return out;
}

/** What the Automations page says about the clock: paused by the owner, or
 *  not running on time (no scheduler, and no tick from an open page lately). */
export async function automationsClock(now = new Date()): Promise<{ paused: boolean; stale: boolean }> {
  const s = await prisma.aiSettings.findUnique({ where: { id: 1 }, select: { automationsPaused: true, tickSecretHash: true, lastTickAt: true } });
  const last = s?.lastTickAt?.getTime() ?? 0;
  return { paused: !!s?.automationsPaused, stale: !s?.tickSecretHash && now.getTime() - last > 15 * 60_000 };
}
