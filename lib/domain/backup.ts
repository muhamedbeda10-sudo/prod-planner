// The nightly backup's own database login (.github/workflows/backup.yml):
// backup_reader, made by the backup_reader migration — it reads every table
// of the app and changes nothing. Its password is made by the owner on
// Settings and kept nowhere but in GitHub's secret (lib/server/backupLogin.ts).
// Pure: the address GitHub is given.

export const BACKUP_ROLE = "backup_reader";

/** The address the backup connects with, made from the app's own: the same
 *  host and database, the user swapped for backup_reader (kept with the
 *  shared pooler's ".<project>" suffix), the pooler in SESSION mode — port
 *  5432; pg_dump cannot work through transaction mode — TLS required on
 *  Supabase, and none of the app's own options. `pooler` is false when the
 *  app's address is not Supabase's shared pooler: GitHub's machines reach
 *  only that (the direct address is IPv6). */
export function backupUrl(base: string, password: string): { url: string; pooler: boolean } {
  const u = new URL(base);
  const user = decodeURIComponent(u.username);
  const dot = user.indexOf(".");
  u.username = dot >= 0 ? `${BACKUP_ROLE}${user.slice(dot)}` : BACKUP_ROLE;
  u.password = password;
  const pooler = u.hostname.endsWith(".pooler.supabase.com");
  if (pooler) u.port = "5432";
  u.search = "";
  if (u.hostname.endsWith(".supabase.com") || u.hostname.endsWith(".supabase.co")) u.searchParams.set("sslmode", "require");
  return { url: u.toString(), pooler };
}

/** GitHub's pages for the backup — the repository's secrets and the backup
 *  workflow — when the app knows its repository (Vercel says so). */
export function backupLinks(env: { provider?: string; owner?: string; slug?: string }): { secrets: string; workflow: string } | null {
  if (env.provider !== "github" || !env.owner || !env.slug) return null;
  const ok = (s: string) => /^[A-Za-z0-9._-]+$/.test(s);
  if (!ok(env.owner) || !ok(env.slug)) return null;
  const repo = `https://github.com/${env.owner}/${env.slug}`;
  return { secrets: `${repo}/settings/secrets/actions`, workflow: `${repo}/actions/workflows/backup.yml` };
}
