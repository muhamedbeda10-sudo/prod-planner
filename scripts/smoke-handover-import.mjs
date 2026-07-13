// Verifies the multiset merge: same file twice = no dupes; grown file adds only new.
import * as XLSX from "xlsx";
import { PrismaClient } from "@prisma/client";
import { parseHandoverGrid, validateHandoverRow } from "../lib/domain/importHandover.ts";
import { dayNumber } from "../lib/domain/dates.ts";

const prisma = new PrismaClient();
const sig = (r) => `${dayNumber(r.date)}|${r.dept}|${r.bom}|${r.item}|${r.qty}|${r.planNo}`;

function buildFile(rows) {
  const aoa = [["Date", "DEPT", "BOM", "Item", "QTY", "Week"], ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Daily HandOver");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
function readGrid(buf) {
  const wb = XLSX.read(buf, { cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const opts = { header: 1, raw: true, defval: null, blankrows: false };
  const range = XLSX.utils.decode_range(ws["!ref"]); range.s.r = 0; range.s.c = 0;
  opts.range = XLSX.utils.encode_range(range);
  return XLSX.utils.sheet_to_json(ws, opts);
}

// Merge logic mirrored from the server (existing across all sources, insert diff).
async function merge(buf) {
  const { rows } = parseHandoverGrid(readGrid(buf));
  const plans = new Set((await prisma.plan.findMany({ select: { planNo: true } })).map((p) => p.planNo));
  const desired = new Map();
  for (const r of rows) {
    if (validateHandoverRow(r) || !plans.has(r.planNo)) continue;
    const rec = { date: r.date, dept: r.dept, bom: r.bom, item: r.item, qty: r.qty, planNo: r.planNo };
    const k = sig(rec);
    const cur = desired.get(k);
    if (cur) cur.count++; else desired.set(k, { count: 1, rec });
  }
  const existing = await prisma.handoverEntry.findMany({ select: { date: true, dept: true, bom: true, item: true, qty: true, planNo: true } });
  const have = new Map();
  for (const e of existing) have.set(sig(e), (have.get(sig(e)) ?? 0) + 1);
  const inserts = [];
  for (const [k, { count, rec }] of desired) {
    const add = Math.max(0, count - (have.get(k) ?? 0));
    for (let i = 0; i < add; i++) inserts.push({ ...rec, source: "import-smoke" });
  }
  for (let i = 0; i < inserts.length; i += 500) await prisma.handoverEntry.createMany({ data: inserts.slice(i, i + 500) });
  return inserts.length;
}

const TESTBOM = "12011E14M12"; // known bom; use a distinctive date to isolate
const D = 47000; // far-future serial so it won't collide with seed
const base = [
  [D, "Cut", TESTBOM, "TN", 999, 27],
  [D, "Welding", TESTBOM, "CF", 998, 27],
];
const cleanup = () => prisma.handoverEntry.deleteMany({ where: { source: "import-smoke" } });

await cleanup();
const start = await prisma.handoverEntry.count();
console.log("start count:", start);

let added = await merge(buildFile(base));
console.log("import #1 added:", added, "(expect 2)");
let after1 = await prisma.handoverEntry.count();

added = await merge(buildFile(base)); // same file again
console.log("import #2 (same file) added:", added, "(expect 0)");
let after2 = await prisma.handoverEntry.count();

const grown = [...base, [D, "Cut", TESTBOM, "CB", 997, 27]]; // one new row
added = await merge(buildFile(grown));
console.log("import #3 (grown file) added:", added, "(expect 1)");
let after3 = await prisma.handoverEntry.count();

console.log(`counts: ${start} -> ${after1} -> ${after2} -> ${after3}`);
console.log(after1 === start + 2 && after2 === after1 && after3 === after2 + 1 ? "PASS ✓" : "FAIL ✗");
await cleanup();
console.log("cleaned up -> ", await prisma.handoverEntry.count());
await prisma.$disconnect();
