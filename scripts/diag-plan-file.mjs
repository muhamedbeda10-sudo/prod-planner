import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import { parseWeeklyPlan } from "../lib/domain/importPlan.ts";

const path = process.argv[2] || "C:\\Users\\DELL\\OneDrive\\Desktop\\WEEK - 28 PLAN-FB UPDATED- WITH MO - SOI.xlsx";
const buf = readFileSync(path);
console.log("bytes:", buf.length);

let wb;
try {
  wb = XLSX.read(new Uint8Array(buf), { cellDates: false });
} catch (e) {
  console.log("XLSX.read FAILED:", e.message);
  process.exit(1);
}
console.log("sheets:", wb.SheetNames);
const ws = wb.Sheets[wb.SheetNames[0]];
console.log("ref:", ws["!ref"]);

const opts = { header: 1, raw: true, defval: null, blankrows: true };
const range = XLSX.utils.decode_range(ws["!ref"]);
range.s.r = 0; range.s.c = 0;
opts.range = XLSX.utils.encode_range(range);
const grid = XLSX.utils.sheet_to_json(ws, opts);
console.log("grid rows:", grid.length, "| widest row:", Math.max(...grid.map((r) => (r ? r.length : 0))));

console.log("\nfirst rows 4-9 (cols A-F + AD):");
for (let i = 3; i < 9 && i < grid.length; i++) {
  const r = grid[i] ?? [];
  console.log(`r${i + 1}: A=${JSON.stringify(r[0])} B=${JSON.stringify(r[1])} C=${JSON.stringify(r[2])} D=${JSON.stringify(r[3])} E=${JSON.stringify(r[4])} AD=${JSON.stringify(r[29])}`);
}

try {
  const t0 = Date.now();
  const parsed = parseWeeklyPlan(grid);
  console.log(`\nparse OK in ${Date.now() - t0}ms: ${parsed.orders.length} orders, ${parsed.schedules.length} schedules, ${parsed.warnings.length} warnings, orderRows=${parsed.orderRowCount}`);
  parsed.warnings.slice(0, 10).forEach((w) => console.log("  warn:", w.kind, "row", w.row, w.message));
  // sample remarks
  const rems = new Set(parsed.orders.filter((o) => o.remark).map((o) => o.remark));
  console.log("distinct remarks:", rems.size);
  [...rems].slice(0, 8).forEach((r) => console.log("  •", r));
} catch (e) {
  console.log("parseWeeklyPlan FAILED:", e.stack);
}
