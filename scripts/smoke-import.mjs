import * as XLSX from "xlsx";
import { PrismaClient } from "@prisma/client";
import { parseWeeklyPlan } from "../lib/domain/importPlan.ts";

const prisma = new PrismaClient();
const PLAN = 99;
const MS = 86400000;
const start = new Date(Date.UTC(2026, 6, 11));

// Build a small grid (AoA) with header rows 1-5 blank, data from row 6.
const aoa = [];
for (let i = 0; i < 5; i++) aoa.push([]);
const r6 = new Array(30).fill(null);
r6[0] = "12011E13M12"; r6[2] = "MO-A"; r6[3] = "1000kva"; r6[4] = 6;
r6[5] = 3; r6[9] = 2; // CF day0=3, day1=2
r6[6] = 1;            // TC day0=1
r6[29] = "2 TN & TC BALANCE FROM WEEK-24";
aoa.push(r6);
const r7 = new Array(30).fill(null);
r7[2] = "MO-B"; r7[4] = 4; r7[8] = 4; // carry BOM; CB day0=4
aoa.push(r7);

const ws = XLSX.utils.aoa_to_sheet(aoa);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Plan");
const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

// Read back like the server does, parse, persist.
const wb2 = XLSX.read(buf, { cellDates: false });
const ws2 = wb2.Sheets[wb2.SheetNames[0]];
const opts = { header: 1, raw: true, defval: null, blankrows: true };
if (ws2["!ref"]) { const range = XLSX.utils.decode_range(ws2["!ref"]); range.s.r = 0; range.s.c = 0; opts.range = XLSX.utils.encode_range(range); }
const grid = XLSX.utils.sheet_to_json(ws2, opts);
const parsed = parseWeeklyPlan(grid);
console.log(`parsed: ${parsed.orders.length} orders, ${parsed.schedules.length} schedules, ${parsed.warnings.length} warnings`);

async function persist() {
  await prisma.plan.upsert({ where: { planNo: PLAN }, create: { planNo: PLAN, startDate: start }, update: { startDate: start } });
  await prisma.$transaction([
    prisma.planOrder.deleteMany({ where: { planNo: PLAN } }),
    prisma.planSchedule.deleteMany({ where: { planNo: PLAN } }),
  ]);
  await prisma.planOrder.createMany({ data: parsed.orders.map((o) => ({ planNo: PLAN, bom: o.bom, soi: o.soi, mo: o.mo, description: o.description, item: o.item, requiredQty: o.requiredQty, plannerBalance: o.plannerBalance, targetQty: o.targetQty, remark: o.remark })) });
  await prisma.planSchedule.createMany({ data: parsed.schedules.map((s) => ({ planNo: PLAN, bom: s.bom, soi: s.soi, mo: s.mo, description: s.description, item: s.item, ovenDate: new Date(start.getTime() + s.dayOffset * MS), qty: s.qty })) });
}

await persist();
console.log("after import 1:", await prisma.planOrder.count({ where: { planNo: PLAN } }), "orders,", await prisma.planSchedule.count({ where: { planNo: PLAN } }), "schedules");
await persist(); // re-import -> idempotent replace
console.log("after import 2 (idempotent):", await prisma.planOrder.count({ where: { planNo: PLAN } }), "orders,", await prisma.planSchedule.count({ where: { planNo: PLAN } }), "schedules");
const sample = await prisma.planOrder.findMany({ where: { planNo: PLAN, mo: "MO-A" }, orderBy: { item: "asc" } });
console.log("MO-A targets:", Object.fromEntries(sample.map((o) => [o.item, o.targetQty])));
console.log("MO-B bom (carried):", (await prisma.planOrder.findFirst({ where: { planNo: PLAN, mo: "MO-B" } }))?.bom);

// cleanup
await prisma.plan.delete({ where: { planNo: PLAN } });
console.log("cleaned up plan", PLAN, "-> orders now", await prisma.planOrder.count({ where: { planNo: PLAN } }));
await prisma.$disconnect();
