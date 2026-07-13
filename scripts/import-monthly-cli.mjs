// CLI monthly-plan import — same logic as the server (upsert by MO).
// Usage: npx tsx scripts/import-monthly-cli.mjs "<file>" [sourceLabel]
import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { PrismaClient } from "@prisma/client";
import { parseMonthlyPlan } from "../lib/domain/importMonthly.ts";

const prisma = new PrismaClient();
const file = process.argv[2] || "C:\\Users\\DELL\\OneDrive\\Desktop\\Monthly plan.xlsx";
const source = process.argv[3] || basename(file);

const wb = XLSX.read(readFileSync(file), { cellDates: false });
const ws = wb.Sheets[wb.SheetNames[0]];
const opts = { header: 1, raw: true, defval: null, blankrows: true };
const range = XLSX.utils.decode_range(ws["!ref"]);
range.s.r = 0; range.s.c = 0;
opts.range = XLSX.utils.encode_range(range);
const { rows, issues, headerRow } = parseMonthlyPlan(XLSX.utils.sheet_to_json(ws, opts));
console.log(`header row: ${headerRow} | parsed orders: ${rows.length}`);
issues.forEach((i) => console.log("  note:", i));

const existing = new Set((await prisma.masterOrder.findMany({ select: { mo: true } })).map((o) => o.mo));
const toAdd = rows.filter((r) => !existing.has(r.mo));
if (toAdd.length) {
  await prisma.masterOrder.createMany({
    data: toAdd.map((r) => ({
      mo: r.mo, soi: r.soi, urgent: r.urgent, customer: r.customer, fgCode: r.fgCode,
      bom: r.bom, kva: r.kva, rating: r.rating, secItem: r.secItem, planQty: r.planQty,
      colorRal: r.colorRal, remarks: r.remarks, source,
    })),
  });
}
console.log(`added: ${toAdd.length} | already existed: ${rows.length - toAdd.length} | registry total: ${await prisma.masterOrder.count()}`);
const urgent = await prisma.masterOrder.count({ where: { urgent: true } });
console.log(`urgent orders: ${urgent}`);
await prisma.$disconnect();
