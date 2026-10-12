import { describe, expect, it } from "vitest";
import { backupLinks, backupUrl } from "./backup";

describe("backupUrl", () => {
  it("takes the app's shared-pooler address to session mode, as backup_reader, with TLS and none of the app's options", () => {
    const r = backupUrl("postgresql://postgres.abcdefgh:s3cret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=5", "Zx_9-k");
    expect(r).toEqual({ url: "postgresql://backup_reader.abcdefgh:Zx_9-k@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require", pooler: true });
    const u = new URL(r.url);
    expect([u.username, u.password, u.port, u.pathname]).toEqual(["backup_reader.abcdefgh", "Zx_9-k", "5432", "/postgres"]);
  });

  it("keeps a session-mode address as it is", () => {
    expect(backupUrl("postgresql://postgres.ref1:pw@aws-1-us-east-1.pooler.supabase.com:5432/postgres", "p").url).toBe(
      "postgresql://backup_reader.ref1:p@aws-1-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require",
    );
  });

  it("says so when the app's address is not the shared pooler GitHub can reach", () => {
    expect(backupUrl("postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres", "p")).toEqual({
      url: "postgresql://backup_reader:p@db.abcdefgh.supabase.co:5432/postgres?sslmode=require",
      pooler: false,
    });
    // a database on this machine: no TLS asked for, the port left alone
    expect(backupUrl("postgresql://atc:pw@localhost:5433/atc?schema=public", "p")).toEqual({ url: "postgresql://backup_reader:p@localhost:5433/atc", pooler: false });
  });

  it("encodes a password with characters an address cannot carry", () => {
    const u = new URL(backupUrl("postgresql://postgres.r:x@aws-0-eu.pooler.supabase.com:6543/postgres", "a@b/c#d").url);
    expect(decodeURIComponent(u.password)).toBe("a@b/c#d");
  });
});

describe("backupLinks", () => {
  it("points at the repository's secrets and the backup workflow on GitHub", () => {
    expect(backupLinks({ provider: "github", owner: "acme-co", slug: "prod.planner" })).toEqual({
      secrets: "https://github.com/acme-co/prod.planner/settings/secrets/actions",
      workflow: "https://github.com/acme-co/prod.planner/actions/workflows/backup.yml",
    });
  });

  it("gives none when the repository is not known, not on GitHub, or not a plain name", () => {
    expect(backupLinks({})).toBeNull();
    expect(backupLinks({ provider: "gitlab", owner: "a", slug: "b" })).toBeNull();
    expect(backupLinks({ provider: "github", owner: "a/../x", slug: "b" })).toBeNull();
  });
});
