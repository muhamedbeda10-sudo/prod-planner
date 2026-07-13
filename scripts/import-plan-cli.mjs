// CLI weekly-plan import — same logic as the server (sheet pick + parse + idempotent replace).
// Usage: npx tsx scripts/import-plan-cli.mjs <planNo> <yyyy-mm-dd start> "<file>" [sheetName]
import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { parseWeeklyPlan } from "../lib/domain/importPlan.ts";

const prisma = new PrismaClient();
const [, , planStr, startStr, file, sheetArg] = process.argv;
const planNo = Number(planStr);
const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startStr ?? "");
if (!Number.isInteger(planNo) || !m || !file) {
  console.log('Usage: import-plan-cli.mjs <planNo> <yyyy-mm-dd> "<file>" [sheet]');
  process.exit(1);
}
const startDate = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
const MS = 86400000;

const wb = XLSX.read(readFileSync(file), { cellDates: false });
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
let name = sheetArg && wb.SheetNames.find((n) => n.trim().toLowerCase() === sheetArg.trim().toLowerCase());
if (!name) name = wb.SheetNames.find((n) => norm(n) === `week${planNo}`);
if (!name && wb.SheetNames.length === 1) name = wb.SheetNames[0];
if (!name) { console.log("No matching sheet. Available:", wb.SheetNames.join(", ")); process.exit(1); }
console.log(`sheet: ${name}`);

const ws = wb.Sheets[name];
const opts = { header: 1, raw: true, defval: null, blankrows: true };
const range = XLSX.utils.decode_range(ws["!ref"]);
range.s.r = 0; range.s.c = 0;
opts.range = XLSX.utils.encode_range(range);
const parsed = parseWeeklyPlan(XLSX.utils.sheet_to_json(ws, opts));
console.log(`parsed: ${parsed.orders.length} orders, ${parsed.schedules.length} schedules, ${parsed.warnings.length} warnings`);
if (parsed.orders.length === 0) { console.log("Nothing to import."); process.exit(1); }

await prisma.plan.upsert({ where: { planNo }, create: { planNo, startDate }, update: { startDate } });
await prisma.$transaction([
  prisma.planOrder.deleteMany({ where: { planNo } }),
  prisma.planSchedule.deleteMany({ where: { planNo } }),
]);
await prisma.planOrder.createMany({
  data: parsed.orders.map((o) => ({ planNo, bom: o.bom, soi: o.soi, mo: o.mo, description: o.description, item: o.item, requiredQty: o.requiredQty, plannerBalance: o.plannerBalance, targetQty: o.targetQty, remark: o.remark })),
});
await prisma.planSchedule.createMany({
  data: parsed.schedules.map((s) => ({ planNo, bom: s.bom, soi: s.soi, mo: s.mo, description: s.description, item: s.item, ovenDate: new Date(startDate.getTime() + s.dayOffset * MS), qty: s.qty })),
});
console.log(`Plan ${planNo} imported: ${await prisma.planOrder.count({ where: { planNo } })} orders, ${await prisma.planSchedule.count({ where: { planNo } })} schedules.`);
parsed.warnings.slice(0, 10).forEach((w) => console.log("  warn:", w.kind, "row", w.row));
await prisma.$disconnect();
