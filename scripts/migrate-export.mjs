// Migration step 1: export EVERY table from SQLite to JSON (run while the
// schema still points at sqlite). Produces scripts/migration-data/*.json
// plus a manifest with row counts and qty checksums for verification.
import { PrismaClient } from "@prisma/client";
import { mkdir, writeFile } from "node:fs/promises";

const prisma = new PrismaClient();
const DIR = "scripts/migration-data";
await mkdir(DIR, { recursive: true });

const TABLES = [
  "plan",
  "planOrder",
  "planSchedule",
  "handoverEntry",
  "masterOrder",
  "holiday",
  "returnEntry",
  "queueNote",
  "settings",
];

const manifest = {};
for (const t of TABLES) {
  const rows = await prisma[t].findMany();
  await writeFile(`${DIR}/${t}.json`, JSON.stringify(rows));
  const qtySum = rows.reduce((s, r) => s + (typeof r.qty === "number" ? r.qty : 0), 0);
  manifest[t] = { count: rows.length, qtySum };
  console.log(`${t}: ${rows.length} rows${qtySum ? ` (qty sum ${qtySum})` : ""}`);
}
await writeFile(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 1));
console.log("export complete");
await prisma.$disconnect();
