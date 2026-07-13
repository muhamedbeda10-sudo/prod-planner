import * as XLSX from "xlsx";
import { PrismaClient } from "@prisma/client";
import { parseHandoverGrid, validateHandoverRow } from "../lib/domain/importHandover.ts";
import { dayNumber } from "../lib/domain/dates.ts";

const prisma = new PrismaClient();
const sig = (r) => `${dayNumber(r.date)}|${r.dept}|${r.bom}|${(r.mo ?? "").trim()}|${r.item}|${r.qty}|${r.planNo}`;

const aoa = [
  ["Date", "DEPT", "BOM", "MO", "Item", "QTY", "Week"],
  [46213, "Cut", "14002E11M11", "PF01/MO/31429", "CB", 5, 28],
  [46213, "Cut", "14002E11M11", "PF01/MO/34489", "CB", 2, 28],
];
const ws = XLSX.utils.aoa_to_sheet(aoa);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Daily Logs");
const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

async function merge(buffer) {
  const wb2 = XLSX.read(buffer, { cellDates: false });
  const ws2 = wb2.Sheets[wb2.SheetNames[0]];
  const opts = { header: 1, raw: true, defval: null, blankrows: false };
  const range = XLSX.utils.decode_range(ws2["!ref"]); range.s.r = 0; range.s.c = 0;
  opts.range = XLSX.utils.encode_range(range);
  const { rows, hasMoColumn } = parseHandoverGrid(XLSX.utils.sheet_to_json(ws2, opts));
  console.log("hasMoColumn:", hasMoColumn, "| parsed:", rows.length, "| invalid:", rows.filter(r => validateHandoverRow(r)).length);
  const existing = await prisma.handoverEntry.findMany({ select: { date: true, dept: true, bom: true, mo: true, item: true, qty: true, planNo: true } });
  const have = new Map();
  for (const e of existing) have.set(sig(e), (have.get(sig(e)) ?? 0) + 1);
  const desired = new Map();
  for (const r of rows) {
    const rec = { date: r.date, dept: r.dept, bom: r.bom, mo: r.mo, item: r.item, qty: r.qty, planNo: r.planNo };
    const k = sig(rec);
    const cur = desired.get(k);
    if (cur) cur.count++; else desired.set(k, { count: 1, rec });
  }
  const inserts = [];
  for (const [k, { count, rec }] of desired) {
    const add = Math.max(0, count - (have.get(k) ?? 0));
    for (let i = 0; i < add; i++) inserts.push({ ...rec, source: "import-smoke" });
  }
  if (inserts.length) await prisma.handoverEntry.createMany({ data: inserts });
  return inserts.length;
}

console.log("import #1 added:", await merge(buf), "(expect 2)");
console.log("import #2 (same file) added:", await merge(buf), "(expect 0)");
const saved = await prisma.handoverEntry.findMany({ where: { source: "import-smoke" }, select: { bom: true, mo: true, item: true, qty: true } });
console.log("saved with MO:", JSON.stringify(saved));
await prisma.handoverEntry.deleteMany({ where: { source: "import-smoke" } });
console.log("cleaned up ->", await prisma.handoverEntry.count(), "entries remain");
await prisma.$disconnect();
