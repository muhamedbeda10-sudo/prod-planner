// Automatic backup — a consistent PostgreSQL dump (pg_dump custom format,
// safe while the server is running) plus the uploads folder, into OneDrive so
// it syncs off-machine. Keeps the newest KEEP snapshots. Runs via backup.cmd
// (Task Scheduler daily + on logon from start-app.cmd).
//
// Restore: pg_restore -U postgres -h localhost -d prodplanner --clean <file>
import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const DEST = "C:\\Users\\DELL\\OneDrive\\ATC-Planner-Backups";
const PG_DUMP = "D:\\SYS\\pgsql\\bin\\pg_dump.exe";
const PWFILE = "D:\\SYS\\pgsql\\pwfile.txt";
const KEEP = 30;

const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;

await mkdir(DEST, { recursive: true });

// 1) consistent DB dump (custom format — compressed, restorable table-by-table)
const dbFile = path.join(DEST, `atc-pg-${stamp}.dump`);
if (existsSync(dbFile)) await rm(dbFile);
const password = (await readFile(PWFILE, "utf8")).trim();
execFileSync(PG_DUMP, ["-U", "postgres", "-h", "localhost", "-d", "prodplanner", "-Fc", "-f", dbFile], {
  env: { ...process.env, PGPASSWORD: password },
});
console.log(`[${now.toISOString()}] DB dump -> ${dbFile}`);

// 2) note photos (mirror copy)
const uploads = path.join(process.cwd(), "uploads");
if (existsSync(uploads)) {
  await cp(uploads, path.join(DEST, "uploads"), { recursive: true, force: true });
  console.log(`[${now.toISOString()}] uploads mirrored`);
}

// 3) retention — keep the newest KEEP dumps (old SQLite .db snapshots are
// left untouched as the pre-migration archive)
const snaps = (await readdir(DEST))
  .filter((f) => /^atc-pg-.*\.dump$/.test(f))
  .sort()
  .reverse();
for (const old of snaps.slice(KEEP)) {
  await rm(path.join(DEST, old));
  console.log(`[${now.toISOString()}] pruned ${old}`);
}
console.log(`[${now.toISOString()}] backup done (${Math.min(snaps.length, KEEP)} dumps kept)`);
