import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The nightly backup's own login (lib/server/backupLogin.ts and the owner's
// actions on Settings): the password hashed as PostgreSQL hashes it, sent as
// its SCRAM verifier only, the address made from the app's own, one log-in to
// prove it, and the owner alone — against a stubbed database.

const h = vi.hoisted(() => ({
  prisma: { $queryRaw: vi.fn(), $executeRawUnsafe: vi.fn(), settings: { findUnique: vi.fn(), upsert: vi.fn() } },
  login: vi.fn(),
  urls: [] as string[],
  user: null as { id: number; name: string; isOwner: boolean } | null,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/server/auth", () => ({ getCurrentUser: async () => h.user }));
vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    constructor(o: { datasourceUrl: string }) {
      h.urls.push(o.datasourceUrl);
    }
    $queryRawUnsafe = h.login;
    $disconnect = async () => {};
  },
}));

import type { User } from "@prisma/client";
import { makeBackupPassword, scramVerifier, tryBackupLogin, turnOffBackupLogin } from "@/lib/server/backupLogin";
import { makeBackupLogin, turnOffBackup } from "@/app/admin/settings/backupActions";

const owner = { id: 1, name: "Beda", isOwner: true } as User;
const now = new Date("2026-10-12T10:00:00Z");
const appUrl = process.env.DATABASE_URL;

afterAll(() => {
  if (appUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = appUrl;
});

beforeEach(() => {
  vi.clearAllMocks();
  h.urls.length = 0;
  h.user = owner;
  process.env.DATABASE_URL = "postgresql://postgres.abcdefgh:app-secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=5";
  h.prisma.$queryRaw.mockResolvedValue([{ rolcanlogin: false }]);
  h.prisma.settings.findUnique.mockResolvedValue(null);
  h.prisma.$executeRawUnsafe.mockResolvedValue(0);
  h.prisma.settings.upsert.mockResolvedValue({});
  h.login.mockResolvedValue([{ "?column?": 1 }]);
});

describe("the backup login's password", () => {
  it("is hashed exactly as PostgreSQL hashes it", () => {
    // made by PostgreSQL 16: CREATE ROLE … PASSWORD 'pencil' with scram-sha-256
    const pg = "SCRAM-SHA-256$4096:Bt8gcS3MvTO94eE+fZZeBQ==$6BzM5bVRPyfSq5qK8yNNA4UdgGxEftL6Oqj317IFPkM=:WfGhqC51s3j9fEHiPgwlmG+D4xjEUhbj5teAL0KdSnA=";
    expect(scramVerifier("pencil", Buffer.from("Bt8gcS3MvTO94eE+fZZeBQ==", "base64"), 4096)).toBe(pg);
    // a fresh salt each time
    expect(scramVerifier("pencil")).not.toBe(scramVerifier("pencil"));
    expect(() => scramVerifier("pâssword")).toThrow();
  });

  it("goes to the database as its verifier only, and comes back once as the backup's address", async () => {
    const r = await makeBackupPassword(owner, now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sql = h.prisma.$executeRawUnsafe.mock.calls[0][0] as string;
    expect(sql).toMatch(/^ALTER ROLE backup_reader WITH LOGIN PASSWORD 'SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+'$/);
    const u = new URL(r.url);
    const password = decodeURIComponent(u.password);
    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // the password itself never reaches the database
    expect(sql).not.toContain(password);
    expect(r).toMatchObject({ pooler: true, tested: "ok" });
    expect([u.username, u.host, u.pathname, u.search]).toEqual(["backup_reader.abcdefgh", "aws-0-eu-central-1.pooler.supabase.com:5432", "/postgres", "?sslmode=require"]);
    // the app's own password is not in it
    expect(r.url).not.toContain("app-secret");
    // logged in with it once, as the backup will
    expect(h.urls).toEqual([r.url]);
    expect(h.prisma.settings.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { backupLoginAt: now, backupLoginBy: "Beda" } }));
  });

  it("says why it could not log in with it, after a few tries", async () => {
    h.login.mockRejectedValue(new Error("Error querying the database: FATAL: password authentication failed for user \"backup_reader\""));
    expect(await tryBackupLogin("postgresql://x", [0, 0, 0])).toBe("Error querying the database: FATAL: password authentication failed for user \"backup_reader\"");
    expect(h.login).toHaveBeenCalledTimes(3);
    h.login.mockRejectedValueOnce(new Error("busy")).mockResolvedValueOnce([]);
    expect(await tryBackupLogin("postgresql://x", [0, 0, 0])).toBe("ok");
  });

  it("is refused before the migration has made the login", async () => {
    h.prisma.$queryRaw.mockResolvedValue([]);
    expect(await makeBackupPassword(owner, now)).toEqual({ ok: false, error: expect.stringContaining("migrations have not run") });
    expect(await turnOffBackupLogin(owner, now)).toEqual({ ok: false, error: expect.stringContaining("migrations have not run") });
    expect(h.prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("is taken away with the login turned off, and its open sessions closed", async () => {
    expect(await turnOffBackupLogin(owner, now)).toEqual({ ok: true });
    expect(h.prisma.$executeRawUnsafe).toHaveBeenCalledWith("ALTER ROLE backup_reader WITH NOLOGIN PASSWORD NULL");
    const sqls = h.prisma.$queryRaw.mock.calls.map((c) => (c[0] as string[]).join("?"));
    expect(sqls).toContain("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ?");
    // a database that will not close them still has the login turned off
    h.prisma.$queryRaw.mockResolvedValueOnce([{ rolcanlogin: true }]).mockRejectedValueOnce(new Error("permission denied to terminate process"));
    expect(await turnOffBackupLogin(owner, now)).toEqual({ ok: true });
    expect(h.prisma.settings.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { backupLoginAt: now, backupLoginBy: "Beda" } }));
  });
});

describe("on Settings", () => {
  it("is the owner's alone — an admin is refused, and nothing changes", async () => {
    h.user = { id: 2, name: "Admin", isOwner: false };
    expect(await makeBackupLogin()).toEqual({ ok: false, error: "Only the owner manages the backup's login." });
    expect(await turnOffBackup()).toEqual({ ok: false, error: "Only the owner manages the backup's login." });
    h.user = null;
    expect(await makeBackupLogin()).toMatchObject({ ok: false, error: expect.stringContaining("not logged in") });
    expect(h.prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    h.user = owner;
    expect(await makeBackupLogin()).toMatchObject({ ok: true, tested: "ok" });
  });
});
