// SETUP: seed the initial done quantities (balances) from the monthly plan's
// progress columns. Cascade applies (Paint done ⟹ Welding done ⟹ Cut done),
// capped at each order's plan qty. Entries carry no real work date — they are
// stamped 2026-07-01 (the sheet's own date) under synthetic plan 0, source
// "setup". Re-running replaces the previous setup, never the daily logs.
//
// Usage: npx tsx scripts/setup-balances.mjs "<file>"
import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { parseMonthlyPlan, applyCascade } from "../lib/domain/importMonthly.ts";

const prisma = new PrismaClient();
const file = process.argv[2] || "C:\\Users\\DELL\\OneDrive\\Desktop\\Monthly plan.xlsx";
const SETUP_PLAN = 0;
const SETUP_DATE = new Date(Date.UTC(2026, 6, 1)); // the sheet's title date (46204)

const wb = XLSX.read(readFileSync(file), { cellDates: false });
const ws = wb.Sheets[wb.SheetNames[0]];
const opts = { header: 1, raw: true, defval: null, blankrows: true };
const range = XLSX.utils.decode_range(ws["!ref"]);
range.s.r = 0; range.s.c = 0;
opts.range = XLSX.utils.encode_range(range);
const { rows, issues } = parseMonthlyPlan(XLSX.utils.sheet_to_json(ws, opts));
console.log(`parsed ${rows.length} orders`);
issues.forEach((i) => console.log("  note:", i));

const DEPT = { cut: "Cut", weld: "Welding", paint: "Painting" };
const inserts = [];
let cascadeBumps = 0;
for (const r of rows) {
  const eff = applyCascade(r.done, r.planQty);
  for (const it of ["CF", "TC", "TN", "CB"]) {
    if (eff.cut[it] > r.done.cut[it] || eff.weld[it] > r.done.weld[it]) cascadeBumps++;
    for (const s of ["cut", "weld", "paint"]) {
      const qty = eff[s][it];
      if (qty > 0) {
        inserts.push({
          date: SETUP_DATE,
          dept: DEPT[s],
          bom: r.bom,
          mo: r.mo,
          item: it,
          qty,
          planNo: SETUP_PLAN,
          source: "setup",
        });
      }
    }
  }
}

await prisma.plan.upsert({
  where: { planNo: SETUP_PLAN },
  create: { planNo: SETUP_PLAN, startDate: SETUP_DATE },
  update: { startDate: SETUP_DATE },
});
const removed = await prisma.handoverEntry.deleteMany({ where: { source: "setup" } });
for (let i = 0; i < inserts.length; i += 500) {
  await prisma.handoverEntry.createMany({ data: inserts.slice(i, i + 500) });
}

const tot = (dept) => inserts.filter((x) => x.dept === dept).reduce((s, x) => s + x.qty, 0);
console.log(`\nreplaced previous setup rows: ${removed.count}`);
console.log(`inserted: ${inserts.length} setup entries (cascade raised ${cascadeBumps} item cells)`);
console.log(`totals — Cut: ${tot("Cut")} | Welding: ${tot("Welding")} | Painting: ${tot("Painting")}`);
console.log(`log size now: ${await prisma.handoverEntry.count()}`);
await prisma.$disconnect();
