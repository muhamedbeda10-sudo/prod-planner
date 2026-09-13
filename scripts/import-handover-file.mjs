// One-off CLI import of a Daily Handover Excel file — EXACT same merge logic
// as the server (validate -> BOM classify -> multiset dedup -> insert new only).
// Usage: npx tsx scripts/import-handover-file.mjs "C:\path\to\file.xlsx"
import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { parseHandoverGrid, validateHandoverRow } from "../lib/domain/importHandover.ts";
import { buildBomClassifier } from "../lib/domain/normalizeBoms.ts";
import { dayNumber } from "../lib/domain/dates.ts";

const prisma = new PrismaClient();
const path = process.argv[2] || "C:\\Users\\DELL\\OneDrive\\Desktop\\Daily_HandOver_Welding.xlsx";
const sig = (r) => `${dayNumber(r.date)}|${r.dept}|${r.bom}|${r.item}|${r.qty}|${r.planNo}`;

const wb = XLSX.read(readFileSync(path), { cellDates: false });
const ws = wb.Sheets[wb.SheetNames[0]];
const opts = { header: 1, raw: true, defval: null, blankrows: false };
const range = XLSX.utils.decode_range(ws["!ref"]);
range.s.r = 0; range.s.c = 0;
opts.range = XLSX.utils.encode_range(range);
const { rows } = parseHandoverGrid(XLSX.utils.sheet_to_json(ws, opts));

const known = (await prisma.planOrder.findMany({ select: { bom: true }, distinct: ["bom"] })).map((r) => r.bom).filter(Boolean);
const validPlans = new Set((await prisma.plan.findMany({ select: { planNo: true } })).map((p) => p.planNo));
const classify = buildBomClassifier(known);

const desired = new Map();
let invalid = 0, corrected = 0;
const unknownBoms = new Set();
for (const row of rows) {
  if (validateHandoverRow(row) || !validPlans.has(row.planNo)) { invalid++; continue; }
  const c = classify(row.bom);
  let bom = c.clean, bomRaw = null;
  if (c.status === "corrected") { bom = c.corrected; bomRaw = c.clean; corrected++; }
  else if (c.status === "unknown" || c.status === "ambiguous") unknownBoms.add(c.clean);
  const rec = { date: row.date, dept: row.dept, bom, bomRaw, item: row.item, qty: row.qty, planNo: row.planNo };
  const k = sig(rec);
  const cur = desired.get(k);
  if (cur) cur.count++; else desired.set(k, { count: 1, rec });
}

const existing = await prisma.handoverEntry.findMany({ select: { date: true, dept: true, bom: true, item: true, qty: true, planNo: true } });
const have = new Map();
for (const e of existing) have.set(sig(e), (have.get(sig(e)) ?? 0) + 1);

const toInsert = [];
let skipped = 0;
for (const [k, { count, rec }] of desired) {
  const add = Math.max(0, count - (have.get(k) ?? 0));
  for (let i = 0; i < add; i++) toInsert.push({ ...rec, source: "import" });
  skipped += Math.min(count, have.get(k) ?? 0);
}
for (let i = 0; i < toInsert.length; i += 500) {
  await prisma.handoverEntry.createMany({ data: toInsert.slice(i, i + 500) });
}
console.log(`Added: ${toInsert.length} | skipped existing: ${skipped} | invalid: ${invalid} | corrected: ${corrected}`);
if (unknownBoms.size) console.log("Unknown BOMs (no order in the registry carries them):", [...unknownBoms].join(", "));
console.log("Total handover entries now:", await prisma.handoverEntry.count());
await prisma.$disconnect();
