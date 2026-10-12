import "server-only";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { PrismaClient, type User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { DEFAULTS } from "@/lib/domain/constants";
import { BACKUP_ROLE, backupUrl } from "@/lib/domain/backup";

// The nightly backup's own login (lib/domain/backup.ts has the rules). The
// owner makes its password on Settings: a long random one, shown to them once
// to put in GitHub's secret and kept nowhere else — the database is sent only
// its SCRAM verifier, so the password never reaches the database or its logs.

export interface BackupLoginState {
  /** The migration made the login. */
  exists: boolean;
  /** It can log in: a password has been made, and the login not turned off since. */
  on: boolean;
  /** When its password was last made or the login turned off, and by whom. */
  changedAt: Date | null;
  changedBy: string | null;
}

export async function backupLoginState(): Promise<BackupLoginState> {
  const [role] = await prisma.$queryRaw<{ rolcanlogin: boolean }[]>`SELECT rolcanlogin FROM pg_roles WHERE rolname = ${BACKUP_ROLE}`;
  const s = await prisma.settings.findUnique({ where: { id: 1 }, select: { backupLoginAt: true, backupLoginBy: true } });
  return { exists: role !== undefined, on: role?.rolcanlogin === true, changedAt: s?.backupLoginAt ?? null, changedBy: s?.backupLoginBy ?? null };
}

/** PostgreSQL's SCRAM-SHA-256 verifier of a password (RFC 5802, RFC 7677):
 *  what the database keeps in its place, and what ALTER ROLE stores as it is
 *  when sent one. For the ASCII passwords made here SASLprep changes nothing. */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  if (!/^[\x21-\x7e]+$/.test(password)) throw new Error("Only printable ASCII passwords are hashed here.");
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** base64 and the verifier's "$" and ":" only — nothing that can end the quote it goes in. */
const VERIFIER = /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

async function noteChange(by: User, at: Date): Promise<void> {
  const change = { backupLoginAt: at, backupLoginBy: by.name };
  await prisma.settings.upsert({
    where: { id: 1 },
    create: { id: 1, leadCut: DEFAULTS.leadCut, leadWeld: DEFAULTS.leadWeld, capacityPerItem: DEFAULTS.capacityPerItem, dailyTarget: DEFAULTS.dailyTarget, ...change },
    update: change,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The login's open sessions closed, so nothing that got in with the old
 *  password stays in. Best effort: it takes the right to signal that
 *  login's sessions, and a database that withholds it still has the
 *  password changed. */
async function closeSessions(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ${BACKUP_ROLE}`;
  } catch (e) {
    console.warn("Backup: could not close the backup login's open sessions", e);
  }
}

/** One log-in with the new address: proof that it works — and Supabase's
 *  shared pooler, which can hold a login's old password for a moment after
 *  it changes, learns the new one now rather than at the night's backup.
 *  A few quick tries. "ok", or why it could not log in. */
export async function tryBackupLogin(url: string, waits: readonly number[] = [0, 2_000, 4_000]): Promise<string> {
  let why = "";
  for (const wait of waits) {
    if (wait > 0) await sleep(wait);
    const client = new PrismaClient({ datasourceUrl: url, log: [] });
    try {
      await client.$queryRawUnsafe("SELECT 1");
      return "ok";
    } catch (e) {
      why = (e instanceof Error ? e.message : String(e)).trim().split("\n").filter(Boolean).pop() ?? "it could not connect";
    } finally {
      await client.$disconnect().catch(() => {});
    }
  }
  return why;
}

export type MakeBackupPasswordResult =
  | { ok: true; url: string; pooler: boolean; tested: string }
  | { ok: false; error: string };

/** A new password for the backup's login — the old one stops working at
 *  once. The address with it is returned to be shown once, never kept. */
export async function makeBackupPassword(by: User, now = new Date()): Promise<MakeBackupPasswordResult> {
  const base = process.env.DATABASE_URL;
  if (!base) return { ok: false, error: "DATABASE_URL is not set." };
  if (!(await backupLoginState()).exists) return { ok: false, error: "The backup's login is not in the database yet — the migrations have not run." };
  // 192 random bits, letters, digits, "-" and "_" only: nothing to encode in an address
  const password = randomBytes(24).toString("base64url");
  const verifier = scramVerifier(password);
  if (!VERIFIER.test(verifier)) return { ok: false, error: "The password could not be prepared — try again." };
  try {
    await prisma.$executeRawUnsafe(`ALTER ROLE ${BACKUP_ROLE} WITH LOGIN PASSWORD '${verifier}'`);
  } catch (e) {
    console.error("Backup: could not set the backup login's password", e);
    return { ok: false, error: "The database refused to change the backup's login — see the server log." };
  }
  await closeSessions();
  await noteChange(by, now);
  const { url, pooler } = backupUrl(base, password);
  return { ok: true, url, pooler, tested: await tryBackupLogin(url) };
}

/** The backup's login turned off: it cannot log in, and its password is gone
 *  — the address in GitHub opens nothing any more. */
export async function turnOffBackupLogin(by: User, now = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await backupLoginState()).exists) return { ok: false, error: "The backup's login is not in the database yet — the migrations have not run." };
  try {
    await prisma.$executeRawUnsafe(`ALTER ROLE ${BACKUP_ROLE} WITH NOLOGIN PASSWORD NULL`);
  } catch (e) {
    console.error("Backup: could not turn the backup login off", e);
    return { ok: false, error: "The database refused to change the backup's login — see the server log." };
  }
  await closeSessions();
  await noteChange(by, now);
  return { ok: true };
}
