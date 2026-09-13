// Migration step 2: import the JSON export into PostgreSQL (run AFTER the
// schema provider was switched and `prisma db push` created the tables).
// Inserts in FK order, keeps original ids, resets the id sequences, then
// verifies row counts and qty checksums against the export manifest.
import { PrismaClient } from "@prisma/client";
import { readFile } from "node:fs/promises";

const prisma = new PrismaClient();
const DIR = "scripts/migration-data";

// FK order: Plan before PlanOrder/PlanSchedule (they reference planNo)
const TABLES = [
  ["plan", "Plan"],
  ["masterOrder", "MasterOrder"],
  ["planOrder", "PlanOrder"],
  ["planSchedule", "PlanSchedule"],
  ["handoverEntry", "HandoverEntry"],
  ["holiday", "Holiday"],
  ["returnEntry", "ReturnEntry"],
  ["queueNote", "QueueNote"],
  ["settings", "Settings"],
];

const manifest = JSON.parse(await readFile(`${DIR}/manifest.json`, "utf8"));
let failed = false;

for (const [model, table] of TABLES) {
  const rows = JSON.parse(await readFile(`${DIR}/${model}.json`, "utf8"));
  const existing = await prisma[model].count();
  if (existing > 0) {
    console.log(`SKIP ${model}: target already has ${existing} rows`);
    continue;
  }
  // batch inserts (createMany accepts ISO date strings)
  for (let i = 0; i < rows.length; i += 500) {
    await prisma[model].createMany({ data: rows.slice(i, i + 500) });
  }
  // reset the id sequence for autoincrement tables so new inserts don't collide
  const hasAutoId = rows.length > 0 && typeof rows[0].id === "number" && model !== "settings";
  if (hasAutoId) {
    await prisma.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('"${table}"','id'), COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, false)`
    );
  }

  // verify against the manifest
  const count = await prisma[model].count();
  const back = await prisma[model].findMany();
  const qtySum = back.reduce((s, r) => s + (typeof r.qty === "number" ? r.qty : 0), 0);
  const m = manifest[model];
  const ok = count === m.count && qtySum === m.qtySum;
  if (!ok) failed = true;
  console.log(`${ok ? "ok " : "!! "}${model}: ${count}/${m.count} rows, qty ${qtySum}/${m.qtySum}`);
}

console.log(failed ? "VERIFICATION FAILED" : "ALL TABLES VERIFIED ✓");
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
