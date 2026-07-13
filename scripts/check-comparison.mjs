import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { parseMonthlyPlan, applyCascade } from "../lib/domain/importMonthly.ts";

const prisma = new PrismaClient();
const wb = XLSX.read(readFileSync("C:\\Users\\DELL\\OneDrive\\Desktop\\Monthly plan.xlsx"), { cellDates: false });
const ws = wb.Sheets[wb.SheetNames[0]];
const opts = { header: 1, raw: true, defval: null, blankrows: true };
const range = XLSX.utils.decode_range(ws["!ref"]); range.s.r = 0; range.s.c = 0;
opts.range = XLSX.utils.encode_range(range);
const { rows } = parseMonthlyPlan(XLSX.utils.sheet_to_json(ws, opts));

const sums = await prisma.handoverEntry.groupBy({ by: ["mo", "dept", "item"], where: { mo: { not: null } }, _sum: { qty: true } });
const system = new Map();
for (const s of sums) if (s.mo) system.set(`${s.mo}|${s.dept}|${s.item}`, s._sum.qty ?? 0);

let cells = 0, diffs = 0;
const STAGE = [["cut","Cut"],["weld","Welding"],["paint","Painting"]];
for (const r of rows) {
  const eff = applyCascade(r.done, r.planQty);
  for (const it of ["CF","TC","TN","CB"]) for (const [k, dept] of STAGE) {
    cells++;
    const sheet = eff[k][it];
    const sys = system.get(`${r.mo}|${dept}|${it}`) ?? 0;
    if (sheet !== sys) { diffs++; if (diffs <= 5) console.log(`  diff: ${r.mo} ${it} ${dept}: sheet=${sheet} system=${sys}`); }
  }
}
console.log(`compared ${cells} cells -> ${diffs} differences ${diffs === 0 ? "(perfect self-consistency ✓)" : ""}`);
await prisma.$disconnect();
