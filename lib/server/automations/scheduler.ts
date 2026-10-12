import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";

// The automations' clock. On a free plan the deployment's own cron runs once a
// day, so the database keeps the time instead: Supabase's pg_cron calls the
// tick endpoint every minute through pg_net, with a secret. The secret and the
// address live in Supabase Vault (encrypted, as Supabase recommends), the job
// reads them from there, and the app keeps only the secret's SHA-256 to check
// it against. When the job is not set up, a page open in the app sends a tick
// now and then instead (components/AutomationTicker) — enough during the
// working day, not at night.

const JOB = "atc-automations-tick";
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
 *  Vault, and the job — every minute. Run again, it replaces all of it (a new
 *  secret: the old one stops working at once). */
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
    await prisma.$executeRawUnsafe(`SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = $1`, JOB);
    const command = [
      "SELECT net.http_post(",
      `  url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = '${URL_NAME}'),`,
      `  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = '${SECRET_NAME}')),`,
      "  body := '{}'::jsonb,",
      "  timeout_milliseconds := 10000",
      ")",
    ].join("\n");
    await prisma.$executeRawUnsafe(`SELECT cron.schedule($1, '* * * * *', $2)`, JOB, command);
    step = "saving";
    await prisma.aiSettings.update({ where: { id: 1 }, data: { tickSecretHash: sha256(secret) } });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Failed while ${step}: ${dbError(e)}` };
  }
}

/** Take the clock away: the job goes, and the secret stops working. */
export async function removeScheduler(): Promise<{ ok: true } | { ok: false; error: string }> {
  await prisma.aiSettings.update({ where: { id: 1 }, data: { tickSecretHash: "" } });
  try {
    await prisma.$executeRawUnsafe(`SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = $1`, JOB);
    return { ok: true };
  } catch (e) {
    // no pg_cron at all: nothing scheduled to take away
    const msg = dbError(e);
    return /schema "cron" does not exist|relation "cron.job" does not exist/i.test(msg) ? { ok: true } : { ok: false, error: msg };
  }
}

export interface SchedulerStatus {
  /** The job is in pg_cron, and the app holds its secret. */
  scheduled: boolean;
  /** The last tick that ran, from anywhere. */
  lastTickAt: string | null;
  /** The job's last few runs as pg_cron saw them — what went wrong, if anything. */
  lastJobRuns: { at: string; status: string; message: string | null }[];
  error: string | null;
}

export async function schedulerStatus(): Promise<SchedulerStatus> {
  const s = await prisma.aiSettings.findUnique({ where: { id: 1 }, select: { tickSecretHash: true, lastTickAt: true } });
  const out: SchedulerStatus = { scheduled: false, lastTickAt: s?.lastTickAt?.toISOString() ?? null, lastJobRuns: [], error: null };
  try {
    const job = await prisma.$queryRawUnsafe<{ jobid: bigint }[]>(`SELECT jobid FROM cron.job WHERE jobname = $1`, JOB);
    out.scheduled = job.length > 0 && !!s?.tickSecretHash;
    if (job.length > 0) {
      const runs = await prisma.$queryRawUnsafe<{ at: Date; status: string; message: string | null }[]>(
        `SELECT start_time AS at, status, return_message AS message FROM cron.job_run_details WHERE jobid = $1 ORDER BY start_time DESC LIMIT 3`,
        job[0].jobid,
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
