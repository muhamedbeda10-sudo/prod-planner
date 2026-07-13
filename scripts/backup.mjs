// Automatic backup — a consistent SQLite snapshot (VACUUM INTO is safe while
// the server is running) plus the uploads folder, into OneDrive so it syncs
// off-machine. Keeps the newest KEEP snapshots. Runs via backup.cmd
// (Task Scheduler daily + on logon from start-app.cmd).
import { PrismaClient } from "@prisma/client";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const DEST = "C:\\Users\\DELL\\OneDrive\\ATC-Planner-Backups";
const KEEP = 30;

const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;

await mkdir(DEST, { recursive: true });

// 1) consistent DB snapshot
const dbFile = path.join(DEST, `atc-db-${stamp}.db`);
if (existsSync(dbFile)) await rm(dbFile);
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`VACUUM INTO '${dbFile.replaceAll("\\", "/").replaceAll("'", "''")}'`);
await prisma.$disconnect();
console.log(`[${now.toISOString()}] DB snapshot -> ${dbFile}`);

// 2) note photos (mirror copy)
const uploads = path.join(process.cwd(), "uploads");
if (existsSync(uploads)) {
  await cp(uploads, path.join(DEST, "uploads"), { recursive: true, force: true });
  console.log(`[${now.toISOString()}] uploads mirrored`);
}

// 3) retention — keep the newest KEEP snapshots
const snaps = (await readdir(DEST))
  .filter((f) => /^atc-db-.*\.db$/.test(f))
  .sort()
  .reverse();
for (const old of snaps.slice(KEEP)) {
  await rm(path.join(DEST, old));
  console.log(`[${now.toISOString()}] pruned ${old}`);
}
console.log(`[${now.toISOString()}] backup done (${Math.min(snaps.length, KEEP)} snapshots kept)`);
